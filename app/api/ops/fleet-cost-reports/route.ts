import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

function monthKey(date: string) {
  return date.slice(0, 7);
}

function yearKey(date: string) {
  return date.slice(0, 4);
}

export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  const { searchParams } = new URL(request.url);
  const period = searchParams.get("period") === "yearly" ? "yearly" : "monthly";
  const selectedYear = searchParams.get("year") ?? new Date().toISOString().slice(0, 4);

  const [{ data: vehicles, error: vehiclesError }, { data: maintenance, error: maintenanceError }, { data: fuel, error: fuelError }, { data: kmLogs, error: kmError }] = await Promise.all([
    auth.admin.from("vehicles").select("id, label, plate, license_number, km").eq("tenant_id", auth.membership.tenant_id).order("label"),
    auth.admin.from("vehicle_maintenance").select("vehicle_id, maintenance_date, cost").eq("tenant_id", auth.membership.tenant_id),
    auth.admin.from("vehicle_fuel").select("vehicle_id, fuel_date, cost").eq("tenant_id", auth.membership.tenant_id).eq("approval_status", "approved"),
    auth.admin.from("vehicle_km_logs").select("vehicle_id, start_at, start_km, end_km"),
  ]);

  const error = vehiclesError || maintenanceError || fuelError || kmError;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const vehicleIds = new Set((vehicles ?? []).map((vehicle) => vehicle.id));
  const summary = (vehicles ?? []).map((vehicle) => ({
    vehicle_id: vehicle.id,
    label: vehicle.label,
    plate: vehicle.plate ?? null,
    license_number: vehicle.license_number ?? null,
    km_snapshot: vehicle.km ?? null,
    maintenance_cost: 0,
    fuel_cost: 0,
    total_cost: 0,
    logged_km: 0,
  }));
  const summaryMap = new Map(summary.map((row) => [row.vehicle_id, row]));
  const timelineMap = new Map<string, { period: string; maintenance_cost: number; fuel_cost: number; logged_km: number }>();

  const ensureTimeline = (vehicleId: string, key: string) => {
    const timelineKey = `${vehicleId}:${key}`;
    const existing = timelineMap.get(timelineKey);
    if (existing) return existing;
    const created = { period: key, maintenance_cost: 0, fuel_cost: 0, logged_km: 0 };
    timelineMap.set(timelineKey, created);
    return created;
  };

  for (const row of maintenance ?? []) {
    if (!vehicleIds.has(row.vehicle_id)) continue;
    if (!row.maintenance_date.startsWith(selectedYear)) continue;
    const bucket = period === "yearly" ? yearKey(row.maintenance_date) : monthKey(row.maintenance_date);
    const amount = Number(row.cost ?? 0);
    const summaryRow = summaryMap.get(row.vehicle_id);
    if (summaryRow) {
      summaryRow.maintenance_cost += amount;
      summaryRow.total_cost += amount;
    }
    ensureTimeline(row.vehicle_id, bucket).maintenance_cost += amount;
  }

  for (const row of fuel ?? []) {
    if (!vehicleIds.has(row.vehicle_id)) continue;
    if (!row.fuel_date.startsWith(selectedYear)) continue;
    const bucket = period === "yearly" ? yearKey(row.fuel_date) : monthKey(row.fuel_date);
    const amount = Number(row.cost ?? 0);
    const summaryRow = summaryMap.get(row.vehicle_id);
    if (summaryRow) {
      summaryRow.fuel_cost += amount;
      summaryRow.total_cost += amount;
    }
    ensureTimeline(row.vehicle_id, bucket).fuel_cost += amount;
  }

  for (const row of kmLogs ?? []) {
    if (!vehicleIds.has(row.vehicle_id)) continue;
    if (!row.start_at.startsWith(selectedYear)) continue;
    const endKm = typeof row.end_km === "number" ? row.end_km : null;
    const km = endKm !== null ? Math.max(0, endKm - Number(row.start_km ?? 0)) : 0;
    const bucket = period === "yearly" ? yearKey(row.start_at) : monthKey(row.start_at);
    const summaryRow = summaryMap.get(row.vehicle_id);
    if (summaryRow) summaryRow.logged_km += km;
    ensureTimeline(row.vehicle_id, bucket).logged_km += km;
  }

  const timeline = Array.from(timelineMap.entries()).map(([key, value]) => {
    const [vehicle_id] = key.split(":");
    const vehicle = summaryMap.get(vehicle_id);
    return {
      vehicle_id,
      label: vehicle?.label ?? "Veicolo",
      plate: vehicle?.plate ?? null,
      ...value,
      total_cost: value.maintenance_cost + value.fuel_cost,
    };
  }).sort((left, right) => left.period.localeCompare(right.period) || left.label.localeCompare(right.label));

  const totals = summary.reduce((acc, row) => {
    acc.maintenance_cost += row.maintenance_cost;
    acc.fuel_cost += row.fuel_cost;
    acc.total_cost += row.total_cost;
    acc.logged_km += row.logged_km;
    return acc;
  }, { maintenance_cost: 0, fuel_cost: 0, total_cost: 0, logged_km: 0 });

  return NextResponse.json({
    ok: true,
    period,
    year: selectedYear,
    summary: summary.sort((left, right) => right.total_cost - left.total_cost || left.label.localeCompare(right.label)),
    timeline,
    totals,
  });
}
