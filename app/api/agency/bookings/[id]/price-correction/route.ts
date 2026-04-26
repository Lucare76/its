/**
 * POST /api/agency/bookings/[id]/price-correction
 * L'operatore corregge il prezzo di una prenotazione con approval_status = "price_mismatch"
 * e notifica l'agenzia via email con il prezzo aggiornato.
 *
 * Body: { corrected_price_cents: number; operator_notes?: string }
 * Auth: admin | operator | supervisor
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { sendAgencyPriceCorrectionEmail } from "@/lib/server/agency-approval-email";
import { buildServiceLabelShort } from "@/lib/service-label";
import { auditLog } from "@/lib/server/ops-audit";

export const runtime = "nodejs";

const bodySchema = z.object({
  corrected_price_cents: z.number().int().positive(),
  operator_notes: z.string().max(1000).optional(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: serviceId } = await params;
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  const tenantId = auth.membership.tenant_id;

  const payload = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Payload non valido." },
      { status: 400 },
    );
  }

  const { corrected_price_cents, operator_notes } = parsed.data;

  type ServiceRow = {
    approval_status: string | null;
    customer_name: string | null;
    pax: number;
    arrival_date: string;
    arrival_time: string | null;
    departure_date: string;
    departure_time: string | null;
    booking_service_kind: string | null;
    transport_code: string | null;
    bus_city_origin: string | null;
    agency_quoted_price_cents: number | null;
    email_confirmation_to: string | null;
    hotels: { name?: string } | Array<{ name?: string }> | null;
    agencies: { name?: string; contact_email?: string; booking_email?: string } | Array<{ name?: string; contact_email?: string; booking_email?: string }> | null;
  };

  const { data: serviceRaw, error: fetchErr } = await auth.admin
    .from("services")
    .select(
      "id, tenant_id, approval_status, customer_name, customer_first_name, customer_last_name, " +
      "pax, arrival_date, arrival_time, departure_date, departure_time, " +
      "booking_service_kind, transport_code, bus_city_origin, " +
      "agency_quoted_price_cents, email_confirmation_to, " +
      "hotels(name), agencies(name, contact_email, booking_email)",
    )
    .eq("id", serviceId)
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (fetchErr || !serviceRaw) {
    return NextResponse.json({ error: "Servizio non trovato." }, { status: 404 });
  }
  const service = serviceRaw as unknown as ServiceRow;

  if (service.approval_status !== "price_mismatch") {
    return NextResponse.json(
      { error: "Il servizio non è in stato price_mismatch." },
      { status: 409 },
    );
  }

  const quotedPriceCents = service.agency_quoted_price_cents as number | null;
  if (quotedPriceCents == null) {
    return NextResponse.json(
      { error: "Prezzo originale agenzia non disponibile." },
      { status: 422 },
    );
  }

  // Aggiorna il servizio con il prezzo corretto
  const now = new Date().toISOString();
  const { error: updateErr } = await auth.admin
    .from("services")
    .update({
      approval_status: "price_corrected",
      agency_price_cents: corrected_price_cents,
      final_price_cents: corrected_price_cents,
      approval_notes: operator_notes ?? null,
      approval_resolved_at: now,
    } as never)
    .eq("id", serviceId)
    .eq("tenant_id", tenantId);

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  // Risolve destinatario email — preferenza: email_confirmation_to, poi agency contact email
  const agencyRow = Array.isArray(service.agencies)
    ? (service.agencies[0] as { name?: string; contact_email?: string; booking_email?: string } | undefined)
    : (service.agencies as { name?: string; contact_email?: string; booking_email?: string } | null | undefined);

  const agencyName = agencyRow?.name ?? null;
  const emailTo =
    (service.email_confirmation_to as string | null) ??
    agencyRow?.booking_email ??
    agencyRow?.contact_email ??
    null;

  const hotelRow = Array.isArray(service.hotels)
    ? (service.hotels[0] as { name?: string } | undefined)
    : (service.hotels as { name?: string } | null | undefined);
  const hotelName = hotelRow?.name ?? "Hotel N/D";

  const bookingKind = service.booking_service_kind as Parameters<typeof buildServiceLabelShort>[0]["kind"] | null;
  const serviceCtx = {
    kind: bookingKind ?? "transfer_port_hotel",
    transportCode: (service.transport_code as string | null) ?? null,
    busCityOrigin: (service.bus_city_origin as string | null) ?? null,
    excursionTitle: null,
    hotelName,
  };

  const emailResult = await sendAgencyPriceCorrectionEmail({
    to: emailTo,
    customerName: (service.customer_name as string | null) ?? "Cliente",
    agencyName,
    serviceCtx,
    arrivalDate: service.arrival_date as string,
    arrivalTime: (service.arrival_time as string) ?? "00:00",
    departureDate: service.departure_date as string,
    departureTime: (service.departure_time as string) ?? "00:00",
    hotelName,
    pax: service.pax as number,
    quotedPriceCents,
    correctedPriceCents: corrected_price_cents,
    operatorNotes: operator_notes ?? null,
  });

  auditLog({
    event: "agency_booking_price_corrected",
    tenantId,
    userId: auth.user.id,
    role: auth.membership.role,
    serviceId,
    outcome: "updated",
    details: {
      quoted_price_cents: quotedPriceCents,
      corrected_price_cents,
      email_status: emailResult.status,
      email_to: emailTo ?? "—",
    },
  });

  return NextResponse.json({
    ok: true,
    corrected_price_cents,
    email: { to: emailTo, status: emailResult.status, error: emailResult.error },
  });
}
