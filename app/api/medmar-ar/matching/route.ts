/**
 * GET  /api/medmar-ar/matching         — opportunità di recupero (legs disponibili + prenotazioni matchate)
 * POST /api/medmar-ar/matching          — esegui riassegnazione
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

export interface MatchOpportunity {
  leg: {
    id: string;
    ticket_id: string;
    leg_type: "outbound" | "return";
    leg_time: string | null;
    leg_route: string;
    price_per_pax_cents: number;
    status: string;
    ticket: {
      voucher_number: string;
      travel_date: string;
      route: string;
      pax_count: number;
      ticket_mode: string;
    } | null;
  };
  matched_bookings: Array<{
    id: string;
    customer_name: string | null;
    phone: string | null;
    pax: number | null;
    hotel_name: string | null;
    date: string;
    time: string | null;
    vessel: string | null;
    booking_service_kind: string | null;
  }>;
  value_cents: number;       // valore economico recuperabile
  hours_to_expiry: number;   // ore rimaste prima della data viaggio
  urgency: "critical" | "high" | "normal";
}

export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request);
  if (auth instanceof NextResponse) return auth;
  const { admin, membership } = auth;
  const tenantId = membership.tenant_id;

  const today = new Date().toISOString().slice(0, 10);

  // 1. Legs disponibili per riassegnazione con data futura
  const { data: legs, error: legsErr } = await (admin as any)
    .from("medmar_ar_ticket_legs")
    .select(`
      id, leg_type, leg_time, leg_route, price_per_pax_cents, status,
      ticket_id,
      medmar_ar_tickets!inner (
        voucher_number, travel_date, route, pax_count, ticket_mode
      )
    `)
    .eq("tenant_id", tenantId)
    .eq("status", "available_for_reassignment")
    .gte("medmar_ar_tickets.travel_date", today)
    .order("medmar_ar_tickets.travel_date");

  if (legsErr) return NextResponse.json({ ok: false, error: legsErr.message }, { status: 500 });

  const opportunities: MatchOpportunity[] = [];

  for (const leg of (legs ?? []) as any[]) {
    const ticket = Array.isArray(leg.medmar_ar_tickets)
      ? leg.medmar_ar_tickets[0]
      : leg.medmar_ar_tickets;

    if (!ticket) continue;

    const travelDate: string = ticket.travel_date;
    const legTimeStr: string | null = leg.leg_time ? String(leg.leg_time).slice(0, 5) : null;

    // Calcola urgenza
    const travelDt = new Date(`${travelDate}T${legTimeStr ?? "23:59"}:00`);
    const hoursToExpiry = (travelDt.getTime() - Date.now()) / (1000 * 60 * 60);
    const urgency: MatchOpportunity["urgency"] =
      hoursToExpiry < 24 ? "critical" : hoursToExpiry < 48 ? "high" : "normal";

    // 2. Cerca prenotazioni compatibili: stessa data, tratta compatibile, stesso orario
    // La tratta determina la direzione: *_ischia / *_casamicciola = arrivo; inverso = partenza
    const isArrival = leg.leg_route.includes("ischia") || leg.leg_route.includes("casamicciola");
    const direction = isArrival ? "arrival" : "departure";

    const vesselKeyword = leg.leg_route.includes("napoli") ? "napoli" : "pozzuoli";

    let bookingsQuery = (admin as any)
      .from("services")
      .select(`
        id, customer_name, phone, pax, date, time, vessel, booking_service_kind,
        hotels!left(name)
      `)
      .eq("tenant_id", tenantId)
      .eq("date", travelDate)
      .eq("direction", direction)
      .neq("status", "cancelled")
      .eq("is_draft", false)
      .ilike("vessel", `%medmar%`)
      .ilike("vessel", `%${vesselKeyword}%`);

    if (legTimeStr) {
      bookingsQuery = bookingsQuery.eq("time", `${legTimeStr}:00`);
    }

    const { data: bookings } = await bookingsQuery;

    // 3. Filtra prenotazioni già coperte da un leg riassegnato
    const { data: alreadyAssigned } = await (admin as any)
      .from("medmar_ar_ticket_legs")
      .select("reassigned_booking_id")
      .eq("tenant_id", tenantId)
      .eq("status", "reassigned")
      .not("reassigned_booking_id", "is", null);

    const assignedIds = new Set((alreadyAssigned ?? []).map((r: any) => r.reassigned_booking_id));

    const matchedBookings = (bookings ?? [])
      .filter((b: any) => !assignedIds.has(b.id))
      .map((b: any) => ({
        id: b.id,
        customer_name: b.customer_name,
        phone: b.phone,
        pax: b.pax,
        hotel_name: Array.isArray(b.hotels) ? b.hotels[0]?.name ?? null : b.hotels?.name ?? null,
        date: b.date,
        time: b.time,
        vessel: b.vessel,
        booking_service_kind: b.booking_service_kind,
      }));

    if (matchedBookings.length > 0 || hoursToExpiry < 48) {
      opportunities.push({
        leg: {
          id: leg.id,
          ticket_id: leg.ticket_id,
          leg_type: leg.leg_type,
          leg_time: legTimeStr,
          leg_route: leg.leg_route,
          price_per_pax_cents: leg.price_per_pax_cents,
          status: leg.status,
          ticket,
        },
        matched_bookings: matchedBookings,
        value_cents: leg.price_per_pax_cents * (ticket.pax_count ?? 1),
        hours_to_expiry: Math.max(0, hoursToExpiry),
        urgency,
      });
    }
  }

  // Ordina: critico > alto > normale, poi per valore
  opportunities.sort((a, b) => {
    const urgOrder = { critical: 0, high: 1, normal: 2 };
    const diff = urgOrder[a.urgency] - urgOrder[b.urgency];
    return diff !== 0 ? diff : b.value_cents - a.value_cents;
  });

  return NextResponse.json({
    ok: true,
    opportunities,
    total_available: opportunities.length,
    total_value_cents: opportunities.reduce((s, o) => s + o.value_cents, 0),
  });
}

const reassignSchema = z.object({
  leg_id: z.string().uuid(),
  booking_id: z.string().uuid(),
});

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request);
  if (auth instanceof NextResponse) return auth;
  const { admin, membership, user } = auth;
  const tenantId = membership.tenant_id;

  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ ok: false, error: "JSON non valido." }, { status: 400 }); }

  const parsed = reassignSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ ok: false, error: parsed.error.issues[0]?.message ?? "Dati non validi." }, { status: 400 });

  const { leg_id, booking_id } = parsed.data;

  // Verifica leg
  const { data: leg } = await (admin as any)
    .from("medmar_ar_ticket_legs")
    .select("id, tenant_id, status, price_per_pax_cents, ticket_id")
    .eq("id", leg_id)
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (!leg) return NextResponse.json({ ok: false, error: "Tratta non trovata." }, { status: 404 });
  if (leg.status !== "available_for_reassignment") {
    return NextResponse.json({ ok: false, error: "Tratta non disponibile per riassegnazione." }, { status: 409 });
  }

  // Verifica prenotazione
  const { data: booking } = await (admin as any)
    .from("services")
    .select("id, customer_name, pax")
    .eq("id", booking_id)
    .eq("tenant_id", tenantId)
    .neq("status", "cancelled")
    .maybeSingle();

  if (!booking) return NextResponse.json({ ok: false, error: "Prenotazione non trovata." }, { status: 404 });

  // Aggiorna leg
  const { error: updErr } = await (admin as any)
    .from("medmar_ar_ticket_legs")
    .update({
      status: "reassigned",
      reassigned_booking_id: booking_id,
      status_changed_at: new Date().toISOString(),
      status_changed_by: user.id,
    })
    .eq("id", leg_id)
    .eq("tenant_id", tenantId);

  if (updErr) return NextResponse.json({ ok: false, error: updErr.message }, { status: 500 });

  return NextResponse.json({
    ok: true,
    leg_id,
    booking_id,
    customer_name: booking.customer_name,
    value_recovered_cents: leg.price_per_pax_cents * (booking.pax ?? 1),
  });
}
