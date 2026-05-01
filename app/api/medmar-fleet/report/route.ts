import { NextRequest, NextResponse } from "next/server";
import { authorizeServiceRoleRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

function getMondayOfWeek(iso: string): string {
  const d = new Date(iso);
  const day = d.getDay(); // 0=Sun, 1=Mon
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d.toISOString().slice(0, 10);
}

function addDays(iso: string, days: number): string {
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function GET(request: NextRequest) {
  const auth = await authorizeServiceRoleRequest(request, {
    roles: ["admin", "supervisor", "operator"],
    auditPrefix: "medmar_fleet",
  });
  if (auth instanceof NextResponse) return auth;
  const { admin, membership } = auth;
  const tenantId = membership.tenant_id;

  const url = new URL(request.url);
  const today = new Date().toISOString().slice(0, 10);
  const rawWeekStart = url.searchParams.get("week_start") ?? today;
  const weekStart = getMondayOfWeek(rawWeekStart);
  const weekEnd = addDays(weekStart, 6);

  const { data: tickets, error } = await admin
    .from("medmar_fleet_tickets")
    .select("id, travel_date, route, ticket_mode, price_cents, status, outbound_used, return_used")
    .eq("tenant_id", tenantId)
    .gte("travel_date", weekStart)
    .lte("travel_date", weekEnd)
    .neq("status", "cancelled")
    .order("travel_date", { ascending: true });

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  const rows = tickets ?? [];

  // Group by day
  const byDay: Record<string, {
    date: string;
    count: number;
    round_trip: number;
    single: number;
    total_cents: number;
    by_route: Record<string, { count: number; total_cents: number }>;
  }> = {};

  for (let i = 0; i < 7; i++) {
    const d = addDays(weekStart, i);
    byDay[d] = { date: d, count: 0, round_trip: 0, single: 0, total_cents: 0, by_route: {} };
  }

  const routeTotals: Record<string, { count: number; total_cents: number }> = {};
  let grandTotal = 0;
  let grandCount = 0;
  let totalRoundTrip = 0;
  let totalSingle = 0;

  for (const t of rows) {
    const day = byDay[t.travel_date];
    if (!day) continue;
    day.count++;
    day.total_cents += t.price_cents ?? 0;
    grandTotal += t.price_cents ?? 0;
    grandCount++;
    if (t.ticket_mode === "round_trip") {
      day.round_trip++;
      totalRoundTrip++;
    } else {
      day.single++;
      totalSingle++;
    }
    const r = t.route as string;
    if (!day.by_route[r]) day.by_route[r] = { count: 0, total_cents: 0 };
    day.by_route[r].count++;
    day.by_route[r].total_cents += t.price_cents ?? 0;
    if (!routeTotals[r]) routeTotals[r] = { count: 0, total_cents: 0 };
    routeTotals[r].count++;
    routeTotals[r].total_cents += t.price_cents ?? 0;
  }

  return NextResponse.json({
    ok: true,
    week_start: weekStart,
    week_end: weekEnd,
    days: Object.values(byDay),
    route_totals: routeTotals,
    grand_total_cents: grandTotal,
    grand_count: grandCount,
    total_round_trip: totalRoundTrip,
    total_single: totalSingle,
  });
}
