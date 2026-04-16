/**
 * POST /api/ops/new-booking
 * Crea una nuova prenotazione da admin o operatore.
 * Simile a /api/agency/bookings ma:
 *  - Accetta ruoli admin e operator
 *  - Agency fatturazione opzionale (dropdown + inline creation gestito lato client)
 *  - Status "new" diretto, senza workflow approvazione
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { agencyBookingCreateSchema } from "@/lib/validation";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { buildServiceLabelShort } from "@/lib/service-label";
import { auditLog } from "@/lib/server/ops-audit";

export const runtime = "nodejs";

type BookingKind = z.infer<typeof agencyBookingCreateSchema>["booking_service_kind"];

function vesselFromKind(kind: BookingKind, transportCode: string, busCityOrigin?: string) {
  if (kind === "formula_snav") return "SNAV";
  if (kind === "formula_medmar") return "MEDMAR";
  if (kind === "transfer_airport_hotel" || kind === "transfer_airport_hotel_exclusive")
    return transportCode ? `Volo ${transportCode}` : "Transfer aeroporto";
  if (kind === "transfer_train_hotel" || kind === "transfer_train_hotel_exclusive")
    return transportCode ? transportCode : "Transfer stazione";
  if (kind === "transfer_port_hotel") return "Transfer porto";
  if (kind === "bus_city_hotel") return busCityOrigin?.trim() ? `Bus da ${busCityOrigin.trim()}` : "Bus";
  return "Escursione";
}

export async function POST(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;
    const tenantId = auth.membership.tenant_id;

    const payload = await request.json().catch(() => null);
    const parsed = agencyBookingCreateSchema.safeParse(payload);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Payload non valido." }, { status: 400 });
    }

    const d = parsed.data;
    const bookingKind = d.booking_service_kind;
    const transportCodeOut = (d.transport_code ?? "").trim();
    const transportCodeReturn = (d.transport_code_return ?? "").trim();
    const transportCode = transportCodeOut && transportCodeReturn
      ? `${transportCodeOut} / ${transportCodeReturn}`
      : transportCodeOut || transportCodeReturn;
    const busCityOrigin = (d.bus_city_origin ?? "").trim();
    const excursionTitle = (d.excursion_title ?? "").trim();
    const customerName = `${(d.customer_first_name ?? "").trim()} ${d.customer_last_name.trim()}`.trim();
    const notes = d.notes.trim();

    // Valida hotel
    const { data: hotelData } = await auth.admin
      .from("hotels")
      .select("id, name")
      .eq("tenant_id", tenantId)
      .eq("id", d.hotel_id)
      .maybeSingle();
    if (!hotelData?.id) {
      return NextResponse.json({ error: "Hotel non valido per il tenant corrente." }, { status: 400 });
    }

    // Risolve agenzia fatturazione (opzionale)
    let agencyId: string | null = null;
    let billingPartyName: string | null = null;
    if (d.agency_id) {
      const { data: agencyData } = await auth.admin
        .from("agencies")
        .select("id, name")
        .eq("tenant_id", tenantId)
        .eq("id", d.agency_id)
        .maybeSingle();
      if (agencyData?.id) {
        agencyId = agencyData.id;
        billingPartyName = agencyData.name;
      }
    }

    // Data/ora arrivo deve precedere partenza
    const arrivalMs = new Date(`${d.arrival_date}T${d.arrival_time}:00`).getTime();
    const departureMs = new Date(`${d.departure_date}T${d.departure_time}:00`).getTime();
    if (departureMs < arrivalMs) {
      return NextResponse.json({ error: "La data di partenza non può essere precedente all'arrivo." }, { status: 400 });
    }

    const insert = {
      tenant_id: tenantId,
      agency_id: agencyId,
      billing_party_name: billingPartyName,
      is_draft: false,
      status: "new",
      date: d.arrival_date,
      time: d.arrival_time,
      service_type: bookingKind === "excursion" ? "bus_tour" : "transfer",
      direction: "arrival",
      vessel: vesselFromKind(bookingKind, transportCode, busCityOrigin),
      pax: d.pax,
      hotel_id: d.hotel_id,
      customer_name: customerName,
      customer_first_name: (d.customer_first_name ?? "").trim() || null,
      customer_last_name: d.customer_last_name.trim(),
      customer_email: (d.customer_email ?? "").trim() || null,
      phone: d.customer_phone.trim(),
      notes,
      booking_service_kind: bookingKind,
      arrival_date: d.arrival_date,
      arrival_time: d.arrival_time,
      departure_date: d.departure_date,
      departure_time: d.departure_time,
      transport_code: transportCode || null,
      bus_city_origin: busCityOrigin || null,
      meeting_point: bookingKind === "bus_city_hotel"
        ? buildServiceLabelShort({ kind: "bus_city_hotel", busCityOrigin: busCityOrigin || null })
        : null,
      include_ferry_tickets: d.include_ferry_tickets ?? false,
      ferry_details: {
        outbound_code: (d.ferry_outbound_code ?? "").trim() || null,
        return_code: (d.ferry_return_code ?? "").trim() || null
      },
      excursion_details: bookingKind === "excursion" ? { title: excursionTitle } : {},
      agency_quoted_price_cents: d.agency_quoted_price_cents ?? null,
      created_by_user_id: auth.user.id,
    };

    let serviceId: string | null = null;

    const { data: firstInsert, error: insertError } = await auth.admin
      .from("services")
      .insert(insert)
      .select("id")
      .single();

    if (!insertError && firstInsert?.id) {
      serviceId = firstInsert.id;
    } else {
      // Fallback senza campi opzionali estesi
      const { data: fallback, error: fallbackError } = await auth.admin
        .from("services")
        .insert({
          tenant_id: tenantId,
          is_draft: false,
          status: "new",
          date: d.arrival_date,
          time: d.arrival_time,
          service_type: bookingKind === "excursion" ? "bus_tour" : "transfer",
          direction: "arrival",
          vessel: vesselFromKind(bookingKind, transportCode, busCityOrigin),
          pax: d.pax,
          hotel_id: d.hotel_id,
          customer_name: customerName,
          phone: d.customer_phone.trim(),
          notes,
          agency_id: agencyId,
          billing_party_name: billingPartyName,
        })
        .select("id")
        .single();
      if (fallbackError || !fallback?.id) {
        return NextResponse.json({ error: fallbackError?.message ?? "Inserimento non riuscito." }, { status: 500 });
      }
      serviceId = fallback.id;
    }

    await auth.admin.from("status_events").insert({
      tenant_id: tenantId,
      service_id: serviceId,
      status: "new",
      by_user_id: auth.user.id
    });

    auditLog({
      event: "ops_booking_created",
      tenantId,
      userId: auth.user.id,
      role: auth.membership.role,
      serviceId,
      outcome: "created",
      details: { booking_kind: bookingKind, agency_id: agencyId, hotel_id: d.hotel_id }
    });

    return NextResponse.json({ ok: true, id: serviceId });
  } catch (error) {
    auditLog({ event: "ops_booking_create_failed", level: "error", details: { message: error instanceof Error ? error.message : "Unknown error" } });
    return NextResponse.json({ error: "Errore interno server." }, { status: 500 });
  }
}
