import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { INSURANCE_GRACE_DAYS, addDays, diffDays, expiryStatus, inspectionExpiryStatus, insuranceExpiryStatus, insuranceSuspensionStatus, worstStatus } from "@/lib/vehicle-compliance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: NextRequest) {
  const ctx = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (ctx instanceof NextResponse) return ctx;
  const { admin, membership: { tenant_id } } = ctx;

  const today = new Date().toISOString().slice(0, 10);

  const [vehiclesRes, insurancesRes, archivedRes, inspectionsRes, extinguishersRes, tachographsRes, graceRes] = await Promise.all([
    admin.from("vehicles")
      .select("id, label, plate, active, capacity, insurance_expiry, road_tax_expiry, compliance_override_until, compliance_override_reason")
      .eq("tenant_id", tenant_id)
      .order("capacity", { ascending: false })
      .order("label"),
    admin.from("vehicle_insurances")
      .select("vehicle_id, expiry_date, company, policy_number, suspended_from, suspended_until, reactivated_on")
      .eq("tenant_id", tenant_id)
      .eq("is_current", true),
    admin.from("vehicle_insurances")
      .select("vehicle_id, expiry_date, company")
      .eq("tenant_id", tenant_id).eq("is_current", false)
      .order("created_at", { ascending: false }),
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
    admin.from("vehicle_compliance_grace_periods")
      .select("compliance_type, grace_days")
      .eq("tenant_id", tenant_id)
      .eq("compliance_type", "insurance")
      .maybeSingle(),
  ]);

  const queryError = [vehiclesRes, insurancesRes, archivedRes, inspectionsRes, extinguishersRes, tachographsRes, graceRes]
    .find(result => result.error)?.error;
  if (queryError) return NextResponse.json({ error: queryError.message }, { status: 500 });

  const vehicles = vehiclesRes.data ?? [];
  const insurances = insurancesRes.data ?? [];
  const inspections = inspectionsRes.data ?? [];
  const extinguishers = extinguishersRes.data ?? [];
  const tachographs = tachographsRes.data ?? [];
  const insuranceGraceDays = graceRes.data?.grace_days ?? INSURANCE_GRACE_DAYS;

  // Build lookup maps
  const insuranceMap = new Map<string, (typeof insurances)[0]>();
  for (const ins of insurances) insuranceMap.set(ins.vehicle_id, ins);
  const archivedMap = new Map<string, NonNullable<typeof archivedRes.data>[number]>();
  for (const row of archivedRes.data ?? []) if (!archivedMap.has(row.vehicle_id)) archivedMap.set(row.vehicle_id, row);

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
    const archived = !insurance ? archivedMap.get(v.id) : null;
    const inspection = inspectionMap.get(v.id) ?? null;
    const ext = extMap.get(v.id) ?? null;
    const tach = tachographMap.get(v.id) ?? null;
    const roadTaxDays = v.road_tax_expiry ? diffDays(today, v.road_tax_expiry) : null;
    const roadTaxStatus = v.road_tax_expiry ? expiryStatus(roadTaxDays) : ("missing" as const);

    // Earlier vehicle forms saved the expiry directly on vehicles. Keep it visible
    // until a current policy record supersedes that legacy value.
    const insuranceExpiry = insurance?.expiry_date ?? archived?.expiry_date ?? v.insurance_expiry;
    const insuranceDays = insuranceExpiry ? diffDays(today, insuranceExpiry) : null;
    const suspensionStatus = insuranceSuspensionStatus(today, insurance?.suspended_from, insurance?.suspended_until, insurance?.reactivated_on);
    const insuranceStatus = archived ? "missing" as const : suspensionStatus === "suspended" ? "critical" as const
      : insuranceExpiry ? insuranceExpiryStatus(insuranceExpiry, today, insuranceGraceDays) : ("missing" as const);
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
      insurance: insuranceExpiry
        ? {
            expiry_date: insuranceExpiry,
            effective_expiry_date: addDays(insuranceExpiry, insuranceGraceDays),
            company: insurance?.company ?? archived?.company ?? null,
            source: insurance ? "policy" : archived ? "archived_policy" : "legacy_vehicle",
            suspension_status: suspensionStatus,
            suspended_from: insurance?.suspended_from ?? null,
            suspended_until: insurance?.suspended_until ?? null,
            reactivated_on: insurance?.reactivated_on ?? null,
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
      road_tax: v.road_tax_expiry
        ? {
            expiry_date: v.road_tax_expiry,
            days_left: roadTaxDays,
            status: roadTaxStatus,
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
            roadTaxStatus,
            expiryStatus(extDays),
            expiryStatus(tachDays),
          ]),
    };
  });

  return NextResponse.json({ items, today, insurance_grace_days: insuranceGraceDays }, {
    headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate",
    },
  });
}
