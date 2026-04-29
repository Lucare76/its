import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { type SupabaseClient } from "@supabase/supabase-js";
import { type MedmarRoute } from "@/lib/medmar-ar/types";

export const runtime = "nodejs";

function getLegDirection(route: string): "arrival" | "departure" {
  return (
    route === "ischia_pozzuoli" ||
    route === "casamicciola_pozzuoli" ||
    route === "ischia_napoli" ||
    route === "casamicciola_napoli"
  ) ? "departure" : "arrival";
}

function getVesselKeyword(route: string) {
  return route.includes("napoli") ? "napoli" : "pozzuoli";
}

function normalizeTime(value: string | null | undefined) {
  return value ? value.slice(0, 5) : null;
}

function bookingCandidateTimes(
  booking: Pick<BookingRow, "time" | "departure_time" | "arrival_time" | "outbound_time" | "return_time">,
  direction: "arrival" | "departure"
) {
  if (direction === "arrival") {
    return [
      normalizeTime(booking.time),
      normalizeTime(booking.arrival_time),
      normalizeTime(booking.outbound_time),
    ].filter(Boolean);
  }

  return [
    normalizeTime(booking.departure_time),
    normalizeTime(booking.return_time),
    normalizeTime(booking.time),
  ].filter(Boolean);
}

type LegWithTicket = {
  id: string;
  ticket_id: string;
  leg_type: "outbound" | "return";
  leg_time: string | null;
  leg_route: string;
  price_per_pax_cents: number;
  status: string;
  medmar_ar_tickets: {
    voucher_number: string;
    travel_date: string;
    route: string;
    pax_count: number;
    ticket_mode: string;
  } | Array<{
    voucher_number: string;
    travel_date: string;
    route: string;
    pax_count: number;
    ticket_mode: string;
  }> | null;
};

type BookingRow = {
  id: string;
  customer_name: string | null;
  phone: string | null;
  pax: number | null;
  date: string;
  time: string | null;
  departure_time: string | null;
  arrival_time: string | null;
  outbound_time: string | null;
  return_time: string | null;
  vessel: string | null;
  booking_service_kind: string | null;
  direction: "arrival" | "departure";
  hotels: { name: string | null } | Array<{ name: string | null }> | null;
};

type LegVerifyRow = {
  id: string;
  tenant_id: string;
  status: string;
  price_per_pax_cents: number;
  ticket_id: string;
  leg_time: string | null;
  leg_route: string;
  medmar_ar_tickets: {
    travel_date: string;
  } | Array<{ travel_date: string }> | null;
};

type BookingVerifyRow = {
  id: string;
  customer_name: string | null;
  pax: number | null;
  tenant_id: string;
  date: string;
  direction: "arrival" | "departure";
  status: string;
  time: string | null;
  departure_time: string | null;
  arrival_time: string | null;
  outbound_time: string | null;
  return_time: string | null;
  vessel: string | null;
};

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
  value_cents: number;
  hours_to_expiry: number;
  urgency: "critical" | "high" | "normal";
}

export async function GET(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor", "autista"]);
    if (auth instanceof NextResponse) return auth;
    const admin = auth.admin as SupabaseClient;
    const { membership } = auth;
    const tenantId = membership.tenant_id;

    const today = new Date().toISOString().slice(0, 10);

    const { data: legs, error: legsErr } = await admin
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

    for (const leg of (legs ?? []) as LegWithTicket[]) {
      const ticket = Array.isArray(leg.medmar_ar_tickets) ? leg.medmar_ar_tickets[0] : leg.medmar_ar_tickets;
      if (!ticket) continue;

      const travelDate = ticket.travel_date;
      const legTimeStr = normalizeTime(leg.leg_time);
      const travelDt = new Date(`${travelDate}T${legTimeStr ?? "23:59"}:00`);
      const hoursToExpiry = (travelDt.getTime() - Date.now()) / (1000 * 60 * 60);
      const urgency: MatchOpportunity["urgency"] =
        hoursToExpiry < 24 ? "critical" : hoursToExpiry < 48 ? "high" : "normal";

      const direction = getLegDirection(leg.leg_route);
      const vesselKeyword = getVesselKeyword(leg.leg_route);

      const { data: bookings } = await admin
        .from("services")
        .select(`
          id, customer_name, phone, pax, date, time, departure_time, arrival_time, outbound_time, return_time,
          direction, vessel, booking_service_kind, hotels!left(name)
        `)
        .eq("tenant_id", tenantId)
        .eq("date", travelDate)
        .eq("direction", direction)
        .neq("status", "cancelled")
        .eq("is_draft", false)
        .ilike("vessel", `%medmar%`)
        .ilike("vessel", `%${vesselKeyword}%`);

      const { data: alreadyAssigned } = await admin
        .from("medmar_ar_ticket_legs")
        .select("reassigned_booking_id")
        .eq("tenant_id", tenantId)
        .eq("status", "reassigned")
        .not("reassigned_booking_id", "is", null);

      const assignedIds = new Set((alreadyAssigned ?? []).map((r) => r.reassigned_booking_id));

      const matchedBookings = ((bookings ?? []) as BookingRow[])
        .filter((b) => !assignedIds.has(b.id))
        .filter((b) => {
          if (!legTimeStr) return true;
          return bookingCandidateTimes(b, direction).includes(legTimeStr);
        })
        .map((b) => ({
          id: b.id,
          customer_name: b.customer_name,
          phone: b.phone,
          pax: b.pax,
          hotel_name: Array.isArray(b.hotels) ? b.hotels[0]?.name ?? null : b.hotels?.name ?? null,
          date: b.date,
          time: normalizeTime(direction === "departure" ? b.departure_time ?? b.return_time ?? b.time : b.arrival_time ?? b.outbound_time ?? b.time),
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

    opportunities.sort((a, b) => {
      const urgOrder = { critical: 0, high: 1, normal: 2 };
      const diff = urgOrder[a.urgency] - urgOrder[b.urgency];
      return diff !== 0 ? diff : b.value_cents - a.value_cents;
    });

    return NextResponse.json({
      ok: true,
      opportunities,
      total_available: opportunities.length,
      total_value_cents: opportunities.reduce((sum, item) => sum + item.value_cents, 0),
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Errore interno." }, { status: 500 });
  }
}

const reassignSchema = z.object({
  leg_id: z.string().uuid(),
  booking_id: z.string().uuid(),
});

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor", "autista"]);
  if (auth instanceof NextResponse) return auth;
  const admin = auth.admin as SupabaseClient;
  const { membership, user } = auth;
  const tenantId = membership.tenant_id;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "JSON non valido." }, { status: 400 });
  }

  const parsed = reassignSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: parsed.error.issues[0]?.message ?? "Dati non validi." }, { status: 400 });
  }

  const { leg_id, booking_id } = parsed.data;

  try {
    const { data: legData } = await admin
      .from("medmar_ar_ticket_legs")
      .select(`
        id, tenant_id, status, price_per_pax_cents, ticket_id, leg_time, leg_route,
        medmar_ar_tickets!inner (travel_date)
      `)
      .eq("id", leg_id)
      .eq("tenant_id", tenantId)
      .maybeSingle();

    const leg = legData as LegVerifyRow | null;
    if (!leg) return NextResponse.json({ ok: false, error: "Tratta non trovata." }, { status: 404 });
    if (leg.status !== "available_for_reassignment") {
      return NextResponse.json({ ok: false, error: "Tratta non disponibile per riassegnazione." }, { status: 409 });
    }

    const ticket = Array.isArray(leg.medmar_ar_tickets) ? leg.medmar_ar_tickets[0] : leg.medmar_ar_tickets;
    if (!ticket) {
      return NextResponse.json({ ok: false, error: "Ticket collegato non trovato." }, { status: 404 });
    }

    const { data: bookingData } = await admin
      .from("services")
      .select("id, customer_name, pax, tenant_id, date, direction, status, time, departure_time, arrival_time, outbound_time, return_time, vessel")
      .eq("id", booking_id)
      .eq("tenant_id", tenantId)
      .neq("status", "cancelled")
      .maybeSingle();

    const booking = bookingData as BookingVerifyRow | null;
    if (!booking) return NextResponse.json({ ok: false, error: "Prenotazione non trovata." }, { status: 404 });

    const expectedDirection = getLegDirection(leg.leg_route as MedmarRoute);
    if (booking.date !== ticket.travel_date || booking.direction !== expectedDirection) {
      return NextResponse.json({ ok: false, error: "Prenotazione non compatibile con la tratta da recuperare." }, { status: 409 });
    }

    const legTime = normalizeTime(leg.leg_time);
    if (legTime) {
      const candidateTimes = bookingCandidateTimes(booking, expectedDirection);
      if (!candidateTimes.includes(legTime)) {
        return NextResponse.json({ ok: false, error: "Orario prenotazione non compatibile con la tratta da recuperare." }, { status: 409 });
      }
    }

    const vesselKeyword = getVesselKeyword(leg.leg_route);
    if (!booking.vessel?.toLowerCase().includes("medmar") || !booking.vessel.toLowerCase().includes(vesselKeyword)) {
      return NextResponse.json({ ok: false, error: "Nave prenotazione non compatibile con la tratta da recuperare." }, { status: 409 });
    }

    const { error: updErr } = await admin
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
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Errore interno." }, { status: 500 });
  }
}
