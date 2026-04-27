import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

type StatusLevel = "expired" | "critical" | "warning" | "missing" | "ok";

const STATUS_RANK: Record<StatusLevel, number> = {
  expired: 0,
  critical: 1,
  warning: 2,
  missing: 3,
  ok: 4,
};

function diffDays(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00Z`);
  const b = new Date(`${to}T00:00:00Z`);
  return Math.floor((b.getTime() - a.getTime()) / 86400000);
}

function expiryStatus(daysLeft: number | null): StatusLevel {
  if (daysLeft === null) return "missing";
  if (daysLeft < 0) return "expired";
  if (daysLeft <= 7) return "critical";
  if (daysLeft <= 30) return "warning";
  return "ok";
}

function worstStatus(statuses: StatusLevel[]): StatusLevel {
  return statuses.reduce<StatusLevel>(
    (worst, s) => (STATUS_RANK[s] < STATUS_RANK[worst] ? s : worst),
    "ok"
  );
}

export async function GET(request: NextRequest) {
  const ctx = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (ctx instanceof NextResponse) return ctx;
  const { admin, membership: { tenant_id } } = ctx;

  const today = new Date().toISOString().slice(0, 10);

  const [vehiclesRes, insurancesRes, inspectionsRes, extinguishersRes] = await Promise.all([
    admin.from("vehicles")
      .select("id, label, plate, active, habitual_driver_profile_id")
      .eq("tenant_id", tenant_id)
      .order("label"),
    admin.from("vehicle_insurances")
      .select("vehicle_id, expiry_date, company, policy_number")
      .eq("tenant_id", tenant_id)
      .eq("is_current", true),
    admin.from("vehicle_inspections")
      .select("vehicle_id, expiry_date, outcome")
      .eq("tenant_id", tenant_id)
      .eq("is_current", true),
    admin.from("vehicle_extinguishers")
      .select("vehicle_id, expiry_date")
      .eq("tenant_id", tenant_id)
      .eq("active", true),
  ]);

  const vehicles = vehiclesRes.data ?? [];
  const insurances = insurancesRes.data ?? [];
  const inspections = inspectionsRes.data ?? [];
  const extinguishers = extinguishersRes.data ?? [];

  // Tachograph data for habitual drivers
  const profileIds = [
    ...new Set(vehicles.map((v) => v.habitual_driver_profile_id).filter(Boolean) as string[]),
  ];
  let tachByProfile: Record<string, string | null> = {};
  if (profileIds.length > 0) {
    const { data: drivers } = await admin
      .from("driver_profiles")
      .select("id, tachograph_card_expiry")
      .in("id", profileIds);
    for (const d of drivers ?? []) {
      tachByProfile[d.id] = d.tachograph_card_expiry ?? null;
    }
  }

  // Build lookup maps
  const insuranceMap = new Map<string, (typeof insurances)[0]>();
  for (const ins of insurances) insuranceMap.set(ins.vehicle_id, ins);

  const inspectionMap = new Map<string, (typeof inspections)[0]>();
  for (const ins of inspections) inspectionMap.set(ins.vehicle_id, ins);

  // Extinguishers: earliest expiry per vehicle
  const extMap = new Map<string, { expiry_date: string; count: number }>();
  for (const ext of extinguishers) {
    const existing = extMap.get(ext.vehicle_id);
    if (!existing || ext.expiry_date < existing.expiry_date) {
      extMap.set(ext.vehicle_id, { expiry_date: ext.expiry_date, count: (existing?.count ?? 0) + 1 });
    } else {
      existing.count++;
    }
  }

  const items = vehicles.map((v) => {
    const insurance = insuranceMap.get(v.id) ?? null;
    const inspection = inspectionMap.get(v.id) ?? null;
    const ext = extMap.get(v.id) ?? null;
    const tachExpiry = v.habitual_driver_profile_id
      ? (tachByProfile[v.habitual_driver_profile_id] ?? null)
      : null;

    const insuranceDays = insurance ? diffDays(today, insurance.expiry_date) : null;
    const inspectionDays = inspection ? diffDays(today, inspection.expiry_date) : null;
    const extDays = ext ? diffDays(today, ext.expiry_date) : null;
    const tachDays = tachExpiry ? diffDays(today, tachExpiry) : null;

    return {
      vehicle_id: v.id,
      label: v.label,
      plate: v.plate,
      active: v.active,
      insurance: insurance
        ? {
            expiry_date: insurance.expiry_date,
            company: insurance.company,
            days_left: insuranceDays,
            status: expiryStatus(insuranceDays),
          }
        : null,
      inspection: inspection
        ? {
            expiry_date: inspection.expiry_date,
            outcome: inspection.outcome,
            days_left: inspectionDays,
            status: expiryStatus(inspectionDays),
          }
        : null,
      extinguisher: ext
        ? {
            expiry_date: ext.expiry_date,
            count: ext.count,
            days_left: extDays,
            status: expiryStatus(extDays),
          }
        : null,
      tachograph: tachExpiry
        ? {
            expiry_date: tachExpiry,
            days_left: tachDays,
            status: expiryStatus(tachDays),
          }
        : null,
      worst_status: worstStatus([
        expiryStatus(insuranceDays),
        expiryStatus(inspectionDays),
        expiryStatus(extDays),
        expiryStatus(tachDays),
      ]),
    };
  });

  return NextResponse.json({ items, today });
}
