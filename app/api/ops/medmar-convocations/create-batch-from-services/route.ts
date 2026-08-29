import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { isValidIsoDate, formatIsoDateItalian } from "@/lib/medmar-date";
import { generateMedmarRowsWithCoverage, type GeneratedRowWithCoverage } from "@/lib/server/medmar-generate-with-coverage";
import { buildMedmarConvocationTemplateParams } from "@/lib/medmar-convocation-template";
import { auditLog } from "@/lib/server/ops-audit";

export const runtime = "nodejs";

// Turns a slice of the "Genera dal gestionale" preview (STEP 2 coverage) into
// a REAL medmar_convocation_batch + medmar_convocation_rows, using the exact
// same row shape the Excel upload writes — so the existing /send route,
// retry, logs, and audit all apply unchanged. Never sends WhatsApp itself;
// the caller must follow up with POST .../send using the returned batchId.
const bodySchema = z.object({
  date: z.string(),
  mode: z.enum(["new", "changed"]),
});

function selectRowsForMode(rows: GeneratedRowWithCoverage[], mode: "new" | "changed"): GeneratedRowWithCoverage[] {
  const wantedStatus = mode === "new" ? "new" : "changed";
  // Belt-and-suspenders: "Invia solo nuove" must never include changed/sent/
  // invalid rows, and vice versa — even though coverage_status already
  // encodes this, mode selection is re-asserted explicitly here.
  return rows.filter((r) => r.status === "pronto" && r.coverage_status === wantedStatus);
}

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Dati non validi" }, { status: 400 });
  }
  const { date, mode } = parsed.data;
  if (!isValidIsoDate(date)) {
    return NextResponse.json({ error: "Parametro date non valido: atteso formato YYYY-MM-DD" }, { status: 400 });
  }

  const tenantId = auth.membership.tenant_id;
  const userId = auth.user.id;

  // Recompute server-side from the same canonical source as the GET preview
  // — never trust row data the client could have sent back stale/edited.
  const generated = await generateMedmarRowsWithCoverage(auth.admin, tenantId, date);
  if ("error" in generated) {
    return NextResponse.json({ error: generated.error }, { status: 500 });
  }

  const selected = selectRowsForMode(generated.rows, mode);
  if (selected.length === 0) {
    return NextResponse.json({ ok: true, batchId: null, count: 0 });
  }

  const label = `Generato dal gestionale — ${formatIsoDateItalian(date)} (${mode === "new" ? "nuove" : "aggiornate"})`;

  const { data: batch, error: batchError } = await auth.admin
    .from("medmar_convocation_batches")
    .insert({
      tenant_id: tenantId,
      created_by: userId,
      file_name: `gestionale-${date}-${mode}.json`,
      label,
      status: "validating",
      total_rows: selected.length,
    })
    .select("id")
    .single();

  if (batchError || !batch?.id) {
    return NextResponse.json({ error: batchError?.message ?? "Errore creazione batch" }, { status: 500 });
  }

  const batchId = batch.id as string;

  const dbRows = selected.map((row, i) => ({
    tenant_id: tenantId,
    batch_id: batchId,
    service_id: row.service_id,
    row_index: i + 1,
    inviare: true,
    phone_raw: row.phone_raw,
    phone_e164: row.phone_e164,
    customer_name: row.customer_name,
    travel_date: row.travel_date,
    travel_date_iso: row.travel_date_iso,
    hotel: row.hotel,
    passengers: row.passengers,
    pickup_time: row.pickup_time,
    departure_time: row.departure_time,
    generated_message: row.generated_message,
    template_payload: buildMedmarConvocationTemplateParams({
      customerName: row.customer_name,
      departureDateLabel: row.travel_date,
      hotel: row.hotel,
      passengers: row.passengers,
      pickupTime: row.pickup_time,
      vesselTime: row.departure_time,
    }),
    // Selection already happened via mode filtering above — rows go
    // straight to "da_inviare" so the client can call /send immediately.
    status: "da_inviare",
    error_message: null,
  }));

  const { error: insertError } = await auth.admin.from("medmar_convocation_rows").insert(dbRows);
  if (insertError) {
    return NextResponse.json({ error: "Errore inserimento righe: " + insertError.message }, { status: 500 });
  }

  await auth.admin
    .from("medmar_convocation_batches")
    .update({ status: "ready", updated_at: new Date().toISOString() })
    .eq("id", batchId);

  auditLog({
    event: "medmar_convocation_batch_created_from_services",
    tenantId,
    userId,
    role: auth.membership.role,
    outcome: "ok",
    details: { batch_id: batchId, date, mode, count: selected.length },
  });

  return NextResponse.json({ ok: true, batchId, count: selected.length });
}
