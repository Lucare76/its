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
    .from("vehicle_insurances")
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
  const { company, policy_number, expiry_date, annual_amount_cents, document_path, notes } = body;

  if (!company || !expiry_date) {
    return NextResponse.json({ error: "company e expiry_date obbligatori" }, { status: 400 });
  }

  // Get old expiry before archiving
  const { data: oldRow } = await admin
    .from("vehicle_insurances")
    .select("expiry_date")
    .eq("tenant_id", tenant_id)
    .eq("vehicle_id", vehicleId)
    .eq("is_current", true)
    .maybeSingle();

  // Archive previous current record
  await admin
    .from("vehicle_insurances")
    .update({ is_current: false })
    .eq("tenant_id", tenant_id)
    .eq("vehicle_id", vehicleId)
    .eq("is_current", true);

  const { data: inserted, error } = await admin
    .from("vehicle_insurances")
    .insert({
      tenant_id,
      vehicle_id: vehicleId,
      company,
      policy_number: policy_number ?? null,
      expiry_date,
      annual_amount_cents: annual_amount_cents ?? null,
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
    compliance_type: "insurance",
    action: oldRow ? "renewed" : "created",
    old_expiry_date: oldRow?.expiry_date ?? null,
    new_expiry_date: expiry_date,
    ref_id: inserted.id,
    performed_by: user.id,
  });

  return NextResponse.json({ item: inserted }, { status: 201 });
}

export async function PUT(request: NextRequest, { params }: Ctx) {
  const { vehicleId } = await params;
  const ctx = await authorizePricingRequest(request, ["admin", "operator"]);
  if (ctx instanceof NextResponse) return ctx;
  const { admin, user, membership: { tenant_id } } = ctx;

  const body = await request.json().catch(() => ({}));
  const { id, company, policy_number, expiry_date, annual_amount_cents, document_path, notes } = body;

  if (!id) return NextResponse.json({ error: "id obbligatorio" }, { status: 400 });

  const { data: updated, error } = await admin
    .from("vehicle_insurances")
    .update({
      company,
      policy_number: policy_number ?? null,
      expiry_date,
      annual_amount_cents: annual_amount_cents ?? null,
      document_path: document_path ?? null,
      notes: notes ?? null,
    })
    .eq("id", id)
    .eq("tenant_id", tenant_id)
    .eq("vehicle_id", vehicleId)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!updated) return NextResponse.json({ error: "Record non trovato" }, { status: 404 });

  if (document_path) {
    await admin.from("vehicle_compliance_history").insert({
      tenant_id,
      vehicle_id: vehicleId,
      compliance_type: "insurance",
      action: "uploaded",
      ref_id: id,
      performed_by: user.id,
    });
  }

  return NextResponse.json({ item: updated });
}
