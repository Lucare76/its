import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { auditLog } from "@/lib/server/ops-audit";
import { buildBookingAncillaryDetails } from "@/lib/booking-ancillaries";
import {
  recalculateDirectFormulaPickupForEdit,
  type FormulaPickupEditState,
} from "@/lib/server/recalculate-formula-pickup";

export const runtime = "nodejs";

const replaceSchema = z.object({
  customer_first_name: z.string().max(80).optional(),
  customer_last_name: z.string().min(1).max(80),
  customer_phone: z.string().min(6).max(30),
  pax: z.number().int().min(1).max(99),
  infant_count: z.number().int().min(0).max(16).default(0),
  pet_count: z.number().int().min(0).max(10).default(0),
  pet_notes: z.string().max(240).optional().or(z.literal("")),
  hotel_id: z.string().uuid(),
  arrival_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  arrival_time: z.string().regex(/^\d{2}:\d{2}$/),
  departure_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  departure_time: z.string().regex(/^\d{2}:\d{2}$/),
  transport_code: z.string().max(80).optional().nullable(),
  bus_city_origin: z.string().max(120).optional().nullable(),
  notes: z.string().max(2000),
  agency_id: z.union([z.string().uuid(), z.literal(""), z.null()]).optional().transform((v) => v === "" ? null : v),
  agency_quoted_price_cents: z.number().int().optional().nullable(),
}).superRefine((value, ctx) => {
  if ((value.pet_count ?? 0) > 0 && (!value.pet_notes || value.pet_notes.trim().length < 2)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Indica tipo/taglia animale. Sono ammessi solo animali fino a 10 kg.",
      path: ["pet_notes"]
    });
  }
});

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorizePricingRequest(request, ["admin", "operator"]);
  if (auth instanceof NextResponse) return auth;

  const { id: serviceId } = await params;
  const tenantId = auth.membership.tenant_id;

  if (!serviceId || serviceId === "undefined") {
    return NextResponse.json({ ok: false, error: "ID pratica non valido." }, { status: 400 });
  }

  // Verifica esistenza + tenant in un'unica query
  const { data: existing, error: fetchErr } = await auth.admin
    .from("services")
    .select("id, tenant_id, status, booking_service_kind, direction, hotel_id, agency_id, billing_party_name, orario_barca, departure_date, departure_time, date")
    .eq("id", serviceId)
    .maybeSingle();

  if (fetchErr) {
    auditLog({ event: "ops_service_replace_fetch_error", tenantId, userId: auth.user.id, serviceId, level: "error", details: { error: fetchErr.message } });
    return NextResponse.json({ ok: false, error: "Errore durante la ricerca della pratica." }, { status: 500 });
  }

  if (!existing) {
    auditLog({ event: "ops_service_replace_not_found", tenantId, userId: auth.user.id, serviceId, level: "warn" });
    return NextResponse.json({ ok: false, error: "Pratica non trovata. Potrebbe essere stata eliminata." }, { status: 404 });
  }

  if (existing.tenant_id !== tenantId) {
    auditLog({ event: "ops_service_replace_wrong_tenant", tenantId, userId: auth.user.id, serviceId, level: "warn" });
    return NextResponse.json({ ok: false, error: "Pratica non trovata." }, { status: 404 });
  }

  const parsed = replaceSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: parsed.error.issues[0]?.message ?? "Dati non validi." }, { status: 400 });
  }

  const d = parsed.data;
  const customerName = d.customer_first_name
    ? `${d.customer_first_name} ${d.customer_last_name}`.trim()
    : d.customer_last_name;

  const update: Record<string, unknown> = {
    customer_name: customerName,
    customer_last_name: d.customer_last_name,
    phone: d.customer_phone,
    pax: d.pax,
    hotel_id: d.hotel_id,
    arrival_date: d.arrival_date,
    arrival_time: d.arrival_time,
    departure_date: d.departure_date,
    departure_time: d.departure_time,
    date: d.arrival_date,
    time: d.arrival_time,
    notes: d.notes.trim(),
    ferry_details: buildBookingAncillaryDetails(d),
    transport_code: d.transport_code ?? null,
    bus_city_origin: d.bus_city_origin ?? null,
    // Ripristina status a "new" se era cancellato (sostituzione esplicita)
    ...(existing.status === "cancelled" ? { status: "new" } : {}),
  };
  if (d.customer_first_name !== undefined) update.customer_first_name = d.customer_first_name;
  if (d.agency_id !== undefined) update.agency_id = d.agency_id ?? null;
  if (d.agency_quoted_price_cents !== undefined) update.agency_quoted_price_cents = d.agency_quoted_price_cents ?? null;

  // Step B — ricalcolo write-time pickup Formula direct: hotel_id/departure_date/
  // departure_time sono SEMPRE presenti nel replacement finale (campi
  // obbligatori dello schema, mai "invariato"). billing_party_name invece non
  // viene mai scritto da questo endpoint quando cambia agency_id (gap
  // preesistente, fuori scope qui — solo agency_id viene persistito, vedi
  // `update.agency_id` sopra): per il RESOLVER usiamo comunque il nome
  // dell'agenzia FINALE (risolto dal nuovo agency_id, se cambiato) — mai
  // quello del service precedente — senza però scrivere questo valore
  // risolto nella colonna billing_party_name, per non alterare il dominio A
  // (treno/aereo) che quella colonna già usa in lettura per kind diversi da
  // Formula, esplicitamente fuori scope in questo Step.
  let replaceBillingPartyName = existing.billing_party_name as string | null;
  if (d.agency_id !== undefined) {
    if (d.agency_id) {
      const { data: agencyRow } = await auth.admin
        .from("agencies")
        .select("name")
        .eq("id", d.agency_id)
        .eq("tenant_id", tenantId)
        .maybeSingle();
      replaceBillingPartyName = agencyRow?.name ?? null;
    } else {
      replaceBillingPartyName = null;
    }
  }
  const replaceCurrentPickupState: FormulaPickupEditState = {
    booking_service_kind: existing.booking_service_kind as string | null,
    direction: existing.direction as string | null,
    hotel_id: existing.hotel_id as string | null,
    billing_party_name: existing.billing_party_name as string | null,
    orario_barca: existing.orario_barca as string | null,
    departure_date: existing.departure_date as string | null,
    departure_time: existing.departure_time as string | null,
    date: existing.date as string | null,
  };
  const replaceFinalPickupState: FormulaPickupEditState = {
    ...replaceCurrentPickupState,
    hotel_id: d.hotel_id,
    billing_party_name: replaceBillingPartyName,
    departure_date: d.departure_date,
    departure_time: d.departure_time,
  };
  const replacePickupRecalc = await recalculateDirectFormulaPickupForEdit(
    auth.admin,
    replaceCurrentPickupState,
    replaceFinalPickupState
  );
  if (replacePickupRecalc) {
    update.pickup_hotel = replacePickupRecalc.pickup_hotel;
    update.pickup_alert = replacePickupRecalc.pickup_alert;
  }

  const { error } = await auth.admin
    .from("services")
    .update(update)
    .eq("id", serviceId)
    .eq("tenant_id", tenantId);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  auditLog({
    event: "ops_service_replaced",
    tenantId,
    userId: auth.user.id,
    role: auth.membership.role,
    serviceId,
    outcome: "replaced",
    details: { fields: Object.keys(update), prev_status: existing.status }
  });

  return NextResponse.json({ ok: true, id: serviceId });
}
