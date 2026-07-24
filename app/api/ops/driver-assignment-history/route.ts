import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

type HistoryRow = {
  id: string;
  service_date: string;
  service_id: string | null;
  group_id: string | null;
  change_type: string;
  from_driver_profile_id: string | null;
  to_driver_profile_id: string | null;
  from_vehicle_label: string | null;
  to_vehicle_label: string | null;
  features: Record<string, unknown> | null;
  operator_id: string;
  created_at: string;
};

type DriverProfile = {
  id: string;
  full_name: string;
  phone?: string | null;
};

type ServiceRow = {
  id: string;
  date: string | null;
  time: string | null;
  customer_name: string | null;
  pax: number | null;
  direction: string | null;
  hotel_id: string | null;
  vessel: string | null;
  zone: string | null;
};

type MembershipRow = {
  user_id: string;
  full_name: string | null;
  email: string | null;
};

type PatternRow = {
  driver_profile_id: string;
  pattern_key: string;
  total_count: number;
  correction_count: number;
  last_updated_at: string;
};

const CHANGE_LABELS: Record<string, string> = {
  auto_assign_accepted: "Auto-assign accettato",
  driver_swap: "Cambio autista",
  vehicle_binding: "Cambio mezzo",
  resolution_suggestion: "Risoluzione conflitto",
};

function asDate(value: string | null, fallback: string) {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : fallback;
}

function rangeFromParams(request: NextRequest) {
  const today = new Date();
  const endFallback = today.toISOString().slice(0, 10);
  const startDate = new Date(today);
  startDate.setUTCDate(startDate.getUTCDate() - 30);
  const startFallback = startDate.toISOString().slice(0, 10);
  return {
    start: asDate(request.nextUrl.searchParams.get("start"), startFallback),
    end: asDate(request.nextUrl.searchParams.get("end"), endFallback),
  };
}

function stringFromFeature(features: Record<string, unknown> | null, key: string) {
  const value = features?.[key];
  return typeof value === "string" ? value : null;
}

export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  const tenantId = auth.membership.tenant_id;
  const { start, end } = rangeFromParams(request);
  const driverId = request.nextUrl.searchParams.get("driver_id")?.trim() ?? "";
  const changeType = request.nextUrl.searchParams.get("change_type")?.trim() ?? "";

  let historyQuery = auth.admin
    .from("driver_assignment_history")
    .select("id, service_date, service_id, group_id, change_type, from_driver_profile_id, to_driver_profile_id, from_vehicle_label, to_vehicle_label, features, operator_id, created_at")
    .eq("tenant_id", tenantId)
    .gte("service_date", start)
    .lte("service_date", end)
    .order("service_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(500);

  if (driverId) {
    historyQuery = historyQuery.or(`to_driver_profile_id.eq.${driverId},from_driver_profile_id.eq.${driverId}`);
  }
  if (changeType) {
    historyQuery = historyQuery.eq("change_type", changeType);
  }

  const [
    historyResult,
    driversResult,
    patternsResult,
  ] = await Promise.all([
    historyQuery,
    auth.admin.from("driver_profiles").select("id, full_name, phone").eq("tenant_id", tenantId).order("full_name"),
    auth.admin.from("assignment_learned_patterns").select("driver_profile_id, pattern_key, total_count, correction_count, last_updated_at").eq("tenant_id", tenantId).limit(5000),
  ]);

  const error = historyResult.error ?? driversResult.error ?? patternsResult.error;
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  const rows = (historyResult.data ?? []) as HistoryRow[];
  const drivers = (driversResult.data ?? []) as DriverProfile[];
  const driverById = new Map(drivers.map((driver) => [driver.id, driver]));

  const serviceIds = Array.from(new Set(rows.map((row) => row.service_id).filter(Boolean))) as string[];
  const operatorIds = Array.from(new Set(rows.map((row) => row.operator_id).filter(Boolean)));

  const [servicesResult, membershipsResult] = await Promise.all([
    serviceIds.length
      ? auth.admin.from("services").select("id, date, time, customer_name, pax, direction, hotel_id, vessel, zone").eq("tenant_id", tenantId).in("id", serviceIds)
      : Promise.resolve({ data: [], error: null }),
    operatorIds.length
      ? auth.admin.from("memberships").select("user_id, full_name, email").eq("tenant_id", tenantId).in("user_id", operatorIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (servicesResult.error) return NextResponse.json({ ok: false, error: servicesResult.error.message }, { status: 500 });
  if (membershipsResult.error) return NextResponse.json({ ok: false, error: membershipsResult.error.message }, { status: 500 });

  const serviceById = new Map(((servicesResult.data ?? []) as ServiceRow[]).map((service) => [service.id, service]));
  const operatorById = new Map(((membershipsResult.data ?? []) as MembershipRow[]).map((membership) => [membership.user_id, membership]));

  const enriched = rows.map((row) => {
    const service = row.service_id ? serviceById.get(row.service_id) ?? null : null;
    const operator = operatorById.get(row.operator_id) ?? null;
    const fromDriver = row.from_driver_profile_id ? driverById.get(row.from_driver_profile_id) ?? null : null;
    const toDriver = row.to_driver_profile_id ? driverById.get(row.to_driver_profile_id) ?? null : null;
    return {
      id: row.id,
      service_date: row.service_date,
      created_at: row.created_at,
      change_type: row.change_type,
      change_label: CHANGE_LABELS[row.change_type] ?? row.change_type,
      from_driver_profile_id: row.from_driver_profile_id,
      to_driver_profile_id: row.to_driver_profile_id,
      from_driver_name: fromDriver?.full_name ?? null,
      to_driver_name: toDriver?.full_name ?? null,
      from_vehicle_label: row.from_vehicle_label,
      to_vehicle_label: row.to_vehicle_label,
      operator_name: operator?.full_name ?? operator?.email ?? row.operator_id,
      service: service ? {
        id: service.id,
        time: service.time,
        customer_name: service.customer_name,
        pax: service.pax,
        direction: service.direction,
        vessel: service.vessel,
        zone: service.zone,
      } : null,
      pattern_key: stringFromFeature(row.features, "pattern_key"),
      macro_category: stringFromFeature(row.features, "macro_category"),
      time_slot: stringFromFeature(row.features, "time_slot"),
      features: row.features ?? {},
    };
  });

  const summaryByDriver = new Map<string, { driver_profile_id: string; driver_name: string; total: number; swaps_in: number; swaps_out: number; vehicle_changes: number; last_change_at: string | null }>();
  for (const row of rows) {
    for (const id of [row.to_driver_profile_id, row.from_driver_profile_id].filter(Boolean) as string[]) {
      const existing = summaryByDriver.get(id) ?? {
        driver_profile_id: id,
        driver_name: driverById.get(id)?.full_name ?? "Autista non indicato",
        total: 0,
        swaps_in: 0,
        swaps_out: 0,
        vehicle_changes: 0,
        last_change_at: null,
      };
      existing.total += 1;
      if (row.to_driver_profile_id === id && row.from_driver_profile_id !== id) existing.swaps_in += 1;
      if (row.from_driver_profile_id === id && row.to_driver_profile_id !== id) existing.swaps_out += 1;
      if (row.change_type === "vehicle_binding") existing.vehicle_changes += 1;
      if (!existing.last_change_at || row.created_at > existing.last_change_at) existing.last_change_at = row.created_at;
      summaryByDriver.set(id, existing);
    }
  }

  const patterns = ((patternsResult.data ?? []) as PatternRow[])
    .filter((pattern) => !driverId || pattern.driver_profile_id === driverId)
    .map((pattern) => ({
      ...pattern,
      driver_name: driverById.get(pattern.driver_profile_id)?.full_name ?? "Autista non indicato",
      correction_rate: pattern.total_count > 0 ? pattern.correction_count / pattern.total_count : 0,
    }))
    .sort((a, b) => b.total_count - a.total_count)
    .slice(0, 25);

  return NextResponse.json({
    ok: true,
    range: { start, end },
    drivers,
    filters: {
      change_types: Object.entries(CHANGE_LABELS).map(([value, label]) => ({ value, label })),
    },
    totals: {
      rows: rows.length,
      driver_swaps: rows.filter((row) => row.change_type === "driver_swap").length,
      vehicle_bindings: rows.filter((row) => row.change_type === "vehicle_binding").length,
      auto_assign_accepted: rows.filter((row) => row.change_type === "auto_assign_accepted").length,
      resolution_suggestions: rows.filter((row) => row.change_type === "resolution_suggestion").length,
      drivers_touched: summaryByDriver.size,
    },
    by_driver: [...summaryByDriver.values()].sort((a, b) => b.total - a.total),
    patterns,
    rows: enriched,
  });
}
