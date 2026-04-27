import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

function diffDays(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00Z`);
  const b = new Date(`${to}T00:00:00Z`);
  return Math.floor((b.getTime() - a.getTime()) / 86400000);
}

export async function GET(request: NextRequest) {
  const ctx = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (ctx instanceof NextResponse) return ctx;
  const { admin, membership: { tenant_id } } = ctx;

  const today = new Date().toISOString().slice(0, 10);

  const [insurancesRes, inspectionsRes, extinguishersRes, driversRes] = await Promise.all([
    admin.from("vehicle_insurances").select("expiry_date").eq("tenant_id", tenant_id).eq("is_current", true),
    admin.from("vehicle_inspections").select("expiry_date").eq("tenant_id", tenant_id).eq("is_current", true),
    admin.from("vehicle_extinguishers").select("expiry_date").eq("tenant_id", tenant_id).eq("active", true),
    admin.from("driver_profiles").select("tachograph_card_expiry").eq("tenant_id", tenant_id).eq("active", true),
  ]);

  let expired = 0;
  let critical = 0;

  const check = (expiry: string | null) => {
    if (!expiry) return;
    const days = diffDays(today, expiry);
    if (days < 0) expired++;
    else if (days <= 7) critical++;
  };

  for (const row of insurancesRes.data ?? []) check(row.expiry_date);
  for (const row of inspectionsRes.data ?? []) check(row.expiry_date);
  for (const row of extinguishersRes.data ?? []) check(row.expiry_date);
  for (const row of driversRes.data ?? []) check(row.tachograph_card_expiry);

  return NextResponse.json({ expired, critical, total: expired + critical });
}
