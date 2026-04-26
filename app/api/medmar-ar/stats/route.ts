/**
 * GET /api/medmar-ar/stats?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD
 * KPI, trend mensile, breakdown per tratta e per operatore
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { type SupabaseClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

type TicketRow = {
  id: string;
  travel_date: string;
  route: string;
  pax_count: number;
  ticket_mode: "round_trip" | "single_outbound" | "single_return";
  total_price_cents: number;
  unit_price_cents: number;
  issuing_operator_id: string | null;
};

type LegRow = {
  id: string;
  ticket_id: string;
  leg_type: string;
  leg_time: string | null;
  leg_route: string;
  price_per_pax_cents: number;
  status: string;
  reassigned_booking_id: string | null;
};

type MemberRow = {
  user_id: string;
  full_name: string | null;
};

export interface MedmarArStats {
  period: { from: string; to: string };
  kpi: {
    total_tickets: number;
    total_pax: number;
    total_value_cents: number;
    by_mode: {
      round_trip: number;
      single_outbound: number;
      single_return: number;
    };
    legs: {
      total: number;
      used: number;
      available: number;
      reassigned: number;
      lost: number;
      not_applicable: number;
    };
    value_lost_cents: number;
    value_recovered_cents: number;
    net_loss_cents: number;
    loss_traffic_light: "green" | "yellow" | "red";
  };
  monthly_trend: Array<{
    month: string;        // "2025-01"
    tickets: number;
    value_cents: number;
    lost_cents: number;
    recovered_cents: number;
  }>;
  by_route: Array<{
    route: string;
    tickets: number;
    value_cents: number;
    lost_cents: number;
  }>;
  by_operator: Array<{
    operator_id: string;
    operator_name: string;
    tickets: number;
    round_trip_count: number;
    lost_cents: number;
  }>;
  expiring_legs: Array<{
    id: string;
    ticket_id: string;
    leg_route: string;
    leg_time: string | null;
    travel_date: string;
    value_cents: number;
    has_match: boolean;
    hours_to_expiry: number;
  }>;
}

export async function GET(request: NextRequest) {
  try {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor", "autista"]);
  if (auth instanceof NextResponse) return auth;
  const admin = auth.admin as SupabaseClient;
  const tenantId = auth.membership.tenant_id;

  const url = new URL(request.url);
  const today = new Date().toISOString().slice(0, 10);
  const firstOfYear = `${today.slice(0, 4)}-01-01`;
  const dateFrom = url.searchParams.get("date_from") ?? firstOfYear;
  const dateTo = url.searchParams.get("date_to") ?? today;

  // ── Biglietti nel periodo ──────────────────────────────────────────────────
  const { data: tickets } = await admin
    .from("medmar_ar_tickets")
    .select("id, travel_date, route, pax_count, ticket_mode, total_price_cents, unit_price_cents, issuing_operator_id")
    .eq("tenant_id", tenantId)
    .gte("travel_date", dateFrom)
    .lte("travel_date", dateTo)
    .eq("is_test_data", false);

  const ticketList = (tickets ?? []) as TicketRow[];

  // ── Legs nel periodo ──────────────────────────────────────────────────────
  const ticketIds = ticketList.map((t) => t.id);
  let legList: LegRow[] = [];
  if (ticketIds.length > 0) {
    const { data: legs } = await admin
      .from("medmar_ar_ticket_legs")
      .select("id, ticket_id, leg_type, leg_time, leg_route, price_per_pax_cents, status, reassigned_booking_id")
      .eq("tenant_id", tenantId)
      .in("ticket_id", ticketIds);
    legList = (legs ?? []) as LegRow[];
  }

  // ── KPI ───────────────────────────────────────────────────────────────────
  const byMode = { round_trip: 0, single_outbound: 0, single_return: 0 };
  for (const t of ticketList) byMode[t.ticket_mode] = (byMode[t.ticket_mode] ?? 0) + 1;

  const legsKpi = { total: 0, used: 0, available: 0, reassigned: 0, lost: 0, not_applicable: 0 };
  let valueLostCents = 0;
  let valueRecoveredCents = 0;

  for (const l of legList) {
    legsKpi.total++;
    legsKpi[l.status as keyof typeof legsKpi] = (legsKpi[l.status as keyof typeof legsKpi] ?? 0) + 1;
    if (l.status === "lost") {
      const ticket = ticketList.find((t) => t.id === l.ticket_id);
      valueLostCents += l.price_per_pax_cents * (ticket?.pax_count ?? 1);
    }
    if (l.status === "reassigned") {
      const ticket = ticketList.find((t) => t.id === l.ticket_id);
      valueRecoveredCents += l.price_per_pax_cents * (ticket?.pax_count ?? 1);
    }
  }

  const netLoss = valueLostCents - valueRecoveredCents;
  const lossTrafficLight: "green" | "yellow" | "red" =
    netLoss < 20000 ? "green" : netLoss < 50000 ? "yellow" : "red";

  const totalValue = ticketList.reduce((s, t) => s + t.total_price_cents, 0);
  const totalPax = ticketList.reduce((s, t) => s + t.pax_count, 0);

  // ── Trend mensile ─────────────────────────────────────────────────────────
  const monthMap: Record<string, { tickets: number; value: number; lost: number; recovered: number }> = {};
  for (const t of ticketList) {
    const m = t.travel_date.slice(0, 7);
    if (!monthMap[m]) monthMap[m] = { tickets: 0, value: 0, lost: 0, recovered: 0 };
    monthMap[m].tickets++;
    monthMap[m].value += t.total_price_cents;
  }
  for (const l of legList) {
    const ticket = ticketList.find((t) => t.id === l.ticket_id);
    if (!ticket) continue;
    const m = ticket.travel_date.slice(0, 7);
    if (!monthMap[m]) monthMap[m] = { tickets: 0, value: 0, lost: 0, recovered: 0 };
    if (l.status === "lost") monthMap[m].lost += l.price_per_pax_cents * ticket.pax_count;
    if (l.status === "reassigned") monthMap[m].recovered += l.price_per_pax_cents * ticket.pax_count;
  }
  const monthly_trend = Object.entries(monthMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, d]) => ({
      month,
      tickets: d.tickets,
      value_cents: d.value,
      lost_cents: d.lost,
      recovered_cents: d.recovered,
    }));

  // ── Per tratta ────────────────────────────────────────────────────────────
  const routeMap: Record<string, { tickets: number; value: number; lost: number }> = {};
  for (const t of ticketList) {
    if (!routeMap[t.route]) routeMap[t.route] = { tickets: 0, value: 0, lost: 0 };
    routeMap[t.route].tickets++;
    routeMap[t.route].value += t.total_price_cents;
  }
  for (const l of legList) {
    if (l.status !== "lost") continue;
    const ticket = ticketList.find((t) => t.id === l.ticket_id);
    if (!ticket) continue;
    if (!routeMap[ticket.route]) routeMap[ticket.route] = { tickets: 0, value: 0, lost: 0 };
    routeMap[ticket.route].lost += l.price_per_pax_cents * ticket.pax_count;
  }
  const by_route = Object.entries(routeMap).map(([route, d]) => ({
    route, tickets: d.tickets, value_cents: d.value, lost_cents: d.lost,
  }));

  // ── Per operatore ─────────────────────────────────────────────────────────
  const operatorIds = [...new Set(ticketList.map((t) => t.issuing_operator_id).filter(Boolean))] as string[];
  let operatorNames: Record<string, string> = {};
  if (operatorIds.length > 0) {
    const { data: members } = await admin
      .from("memberships")
      .select("user_id, full_name")
      .eq("tenant_id", tenantId)
      .in("user_id", operatorIds);
    for (const m of (members ?? []) as MemberRow[]) operatorNames[m.user_id] = m.full_name ?? m.user_id;
  }

  const opMap: Record<string, { tickets: number; rt: number; lost: number }> = {};
  for (const t of ticketList) {
    const oid = t.issuing_operator_id ?? "unknown";
    if (!opMap[oid]) opMap[oid] = { tickets: 0, rt: 0, lost: 0 };
    opMap[oid].tickets++;
    if (t.ticket_mode === "round_trip") opMap[oid].rt++;
  }
  for (const l of legList) {
    if (l.status !== "lost") continue;
    const ticket = ticketList.find((t) => t.id === l.ticket_id);
    if (!ticket) continue;
    const oid = ticket.issuing_operator_id ?? "unknown";
    if (!opMap[oid]) opMap[oid] = { tickets: 0, rt: 0, lost: 0 };
    opMap[oid].lost += l.price_per_pax_cents * ticket.pax_count;
  }
  const by_operator = Object.entries(opMap).map(([oid, d]) => ({
    operator_id: oid,
    operator_name: operatorNames[oid] ?? oid,
    tickets: d.tickets,
    round_trip_count: d.rt,
    lost_cents: d.lost,
  }));

  // ── Legs in scadenza (< 48h, ancora disponibili) ──────────────────────────
  const expiringLegs = legList
    .filter((l) => l.status === "available_for_reassignment")
    .map((l) => {
      const ticket = ticketList.find((t) => t.id === l.ticket_id);
      if (!ticket) return null;
      const travelDt = new Date(`${ticket.travel_date}T${l.leg_time ? String(l.leg_time).slice(0, 5) : "23:59"}:00`);
      const hoursLeft = (travelDt.getTime() - Date.now()) / (1000 * 60 * 60);
      return {
        id: l.id,
        ticket_id: l.ticket_id,
        leg_route: l.leg_route,
        leg_time: l.leg_time ? String(l.leg_time).slice(0, 5) : null,
        travel_date: ticket.travel_date,
        value_cents: l.price_per_pax_cents * ticket.pax_count,
        has_match: false, // semplificato — il matching engine ha il dettaglio
        hours_to_expiry: Math.max(0, hoursLeft),
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null && x.hours_to_expiry < 48)
    .sort((a, b) => a.hours_to_expiry - b.hours_to_expiry);

  const stats: MedmarArStats = {
    period: { from: dateFrom, to: dateTo },
    kpi: {
      total_tickets: ticketList.length,
      total_pax: totalPax,
      total_value_cents: totalValue,
      by_mode: byMode,
      legs: legsKpi,
      value_lost_cents: valueLostCents,
      value_recovered_cents: valueRecoveredCents,
      net_loss_cents: netLoss,
      loss_traffic_light: lossTrafficLight,
    },
    monthly_trend,
    by_route,
    by_operator,
    expiring_legs: expiringLegs,
  };

  return NextResponse.json({ ok: true, stats });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Errore interno." }, { status: 500 });
  }
}
