import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ vehicleId: string }> };

export async function GET(request: NextRequest, { params }: Ctx) {
  const { vehicleId } = await params;
  const ctx = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (ctx instanceof NextResponse) return ctx;
  const { admin, membership: { tenant_id } } = ctx;

  const { data, error } = await admin
    .from("vehicle_tachographs")
    .select("*")
    .eq("tenant_id", tenant_id)
    .eq("vehicle_id", vehicleId)
    .order("expiry_date", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ items: data ?? [] });
}

export async function POST(request: NextRequest, { params }: Ctx) {
  const { vehicleId } = await params;
  const ctx = await authorizePricingRequest(request, ["admin", "operator"]);
  if (ctx instanceof NextResponse) return ctx;
  const { admin, user, membership: { tenant_id } } = ctx;

  const body = await request.json().catch(() => ({}));
  const { calibration_date, expiry_date, center, certificate_number, document_path, notes } = body;

  if (!calibration_date || !expiry_date) {
    return NextResponse.json({ error: "calibration_date e expiry_date obbligatori" }, { status: 400 });
  }

  const { data: oldRow } = await admin
    .from("vehicle_tachographs")
    .select("expiry_date")
    .eq("tenant_id", tenant_id)
    .eq("vehicle_id", vehicleId)
    .eq("is_current", true)
    .maybeSingle();

  await admin
    .from("vehicle_tachographs")
    .update({ is_current: false })
    .eq("tenant_id", tenant_id)
    .eq("vehicle_id", vehicleId)
    .eq("is_current", true);

  const { data: inserted, error } = await admin
    .from("vehicle_tachographs")
    .insert({
      tenant_id,
      vehicle_id: vehicleId,
      calibration_date,
      expiry_date,
      center: center ?? null,
      certificate_number: certificate_number ?? null,
      document_path: document_path ?? null,
      notes: notes ?? null,
      is_current: true,
      created_by: user.id,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await admin.from("vehicle_compliance_history").insert({
    tenant_id,
    vehicle_id: vehicleId,
    compliance_type: "tachograph",
    action: oldRow ? "renewed" : "created",
    old_expiry_date: oldRow?.expiry_date ?? null,
    new_expiry_date: expiry_date,
    ref_id: inserted.id,
    performed_by: user.id,
  });

  return NextResponse.json({ item: inserted }, { status: 201 });
}
