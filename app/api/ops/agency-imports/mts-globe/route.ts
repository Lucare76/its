import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { buildMtsGlobePreview, confirmMtsGlobeImport } from "@/lib/server/agency-imports/mts-globe-import";
import { auditLog } from "@/lib/server/ops-audit";

export const runtime = "nodejs";

const payloadSchema = z.object({
  mode: z.enum(["preview", "confirm"]),
  rows: z.array(z.record(z.string(), z.unknown())).min(1).max(5000),
  source_import_id: z.string().uuid().optional().nullable(),
  // Correzioni hotel manuali dell'operatore: chiave "voucherNo#rowIndex"
  // (o "#from"/"#to" per Intermedio) -> hotel_id scelto. Applicate sia in
  // preview (per mostrare l'effetto) sia in confirm (per sbloccare WARNING).
  hotel_corrections: z.record(z.string(), z.string().uuid()).optional().default({}),
  // Correzione orario manuale per i leg Intermedio (hotel->hotel) privi di
  // orario nel file: chiave "voucherNo#rowIndex#time" -> "HH:MM".
  time_corrections: z.record(z.string(), z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)).optional().default({}),
  // Correzione orario di GRUPPO per i leg Intermedio: chiave "Grouping Id"
  // (MAI Voucher No) -> "HH:MM", propagata a tutti i voucher che condividono
  // lo stesso Grouping Id. Una correzione specifica in time_corrections per
  // lo stesso leg ha priorita' su questa.
  group_time_corrections: z.record(z.string(), z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)).optional().default({})
});

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator"]);
  if (auth instanceof NextResponse) return auth;

  const parsed = payloadSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Payload non valido." }, { status: 400 });
  }

  const tenantId = auth.membership.tenant_id;

  if (parsed.data.mode === "preview") {
    const preview = await buildMtsGlobePreview(
      auth.admin,
      tenantId,
      parsed.data.rows,
      parsed.data.hotel_corrections,
      parsed.data.time_corrections,
      parsed.data.group_time_corrections
    );
    return NextResponse.json({ ok: true, ...preview });
  }

  const result = await confirmMtsGlobeImport(
    auth.admin,
    tenantId,
    auth.user.id ?? null,
    parsed.data.rows,
    parsed.data.source_import_id ?? null,
    parsed.data.hotel_corrections,
    parsed.data.time_corrections,
    parsed.data.group_time_corrections
  );

  auditLog({
    event: "mts_globe_import_confirmed",
    tenantId,
    userId: auth.user.id ?? null,
    role: auth.membership.role,
    outcome: result.failedBookings.length > 0 ? "partial" : "ok",
    details: {
      imported_booking_count: result.importedBookingCount,
      imported_service_count: result.importedServiceCount,
      skipped_duplicate_count: result.skippedDuplicateCount,
      failed_bookings: result.failedBookings
    }
  });

  return NextResponse.json({ ok: true, ...result });
}
