import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { diffDays, expiryStatus, inspectionExpiryStatus, insuranceExpiryStatus, worstStatus } from "@/lib/vehicle-compliance";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const ctx = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (ctx instanceof NextResponse) return ctx;
  const { admin, membership: { tenant_id } } = ctx;

  const today = new Date().toISOString().slice(0, 10);

  const [vehiclesRes, insurancesRes, inspectionsRes, extinguishersRes, tachographsRes] = await Promise.all([
    admin.from("vehicles")
      .select("id, label, plate, active, capacity, compliance_override_until, compliance_override_reason")
      .eq("tenant_id", tenant_id)
      .order("capacity", { ascending: false })
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
    admin.from("vehicle_tachographs")
      .select("vehicle_id, expiry_date, calibration_date")
      .eq("tenant_id", tenant_id)
      .eq("is_current", true),
  ]);

  const vehicles = vehiclesRes.data ?? [];
  const insurances = insurancesRes.data ?? [];
  const inspections = inspectionsRes.data ?? [];
  const extinguishers = extinguishersRes.data ?? [];
  const tachographs = tachographsRes.data ?? [];

  // Build lookup maps
  const insuranceMap = new Map<string, (typeof insurances)[0]>();
  for (const ins of insurances) insuranceMap.set(ins.vehicle_id, ins);

  const inspectionMap = new Map<string, (typeof inspections)[0]>();
  for (const ins of inspections) inspectionMap.set(ins.vehicle_id, ins);

  const tachographMap = new Map<string, (typeof tachographs)[0]>();
  for (const t of tachographs) tachographMap.set(t.vehicle_id, t);

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
    const tach = tachographMap.get(v.id) ?? null;

    const insuranceDays = insurance ? diffDays(today, insurance.expiry_date) : null;
    const insuranceStatus = insurance ? insuranceExpiryStatus(insurance.expiry_date, today) : ("missing" as const);
    const inspectionDays = inspection ? diffDays(today, inspection.expiry_date) : null;
    const inspectionStatus = inspection ? inspectionExpiryStatus(inspection.expiry_date, today) : ("missing" as const);
    const extDays = ext ? diffDays(today, ext.expiry_date) : null;
    const tachDays = tach ? diffDays(today, tach.expiry_date) : null;

    const overrideUntil = v.compliance_override_until
      ? new Date(v.compliance_override_until)
      : null;
    const overrideActive = overrideUntil ? overrideUntil > new Date() : false;

    return {
      vehicle_id: v.id,
      label: v.label,
      plate: v.plate,
      capacity: v.capacity,
      active: v.active,
      compliance_override: overrideActive
        ? {
            until: v.compliance_override_until,
            reason: v.compliance_override_reason,
          }
        : null,
      insurance: insurance
        ? {
            expiry_date: insurance.expiry_date,
            company: insurance.company,
            days_left: insuranceDays,
            status: insuranceStatus,
          }
        : null,
      inspection: inspection
        ? {
            expiry_date: inspection.expiry_date,
            outcome: inspection.outcome,
            days_left: inspectionDays,
            status: inspectionStatus,
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
      tachograph: tach
        ? {
            expiry_date: tach.expiry_date,
            days_left: tachDays,
            status: expiryStatus(tachDays),
          }
        : null,
      worst_status: overrideActive
        ? "ok"
        : worstStatus([
            insuranceStatus,
            inspectionStatus,
            expiryStatus(extDays),
            expiryStatus(tachDays),
          ]),
    };
  });

  return NextResponse.json({ items, today });
}
