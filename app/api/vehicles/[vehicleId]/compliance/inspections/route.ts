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
    .from("vehicle_inspections")
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
  const {
    inspection_date,
    expiry_date,
    inspection_center,
    outcome,
    outcome_notes,
    document_path,
    notes,
  } = body;

  if (!inspection_date || !expiry_date) {
    return NextResponse.json({ error: "inspection_date e expiry_date obbligatori" }, { status: 400 });
  }

  const VALID_OUTCOMES = ["passed", "failed", "pending"];
  if (outcome && !VALID_OUTCOMES.includes(outcome)) {
    return NextResponse.json({ error: "outcome non valido" }, { status: 400 });
  }

  const { data: oldRow } = await admin
    .from("vehicle_inspections")
    .select("expiry_date")
    .eq("tenant_id", tenant_id)
    .eq("vehicle_id", vehicleId)
    .eq("is_current", true)
    .maybeSingle();

  await admin
    .from("vehicle_inspections")
    .update({ is_current: false })
    .eq("tenant_id", tenant_id)
    .eq("vehicle_id", vehicleId)
    .eq("is_current", true);

  const { data: inserted, error } = await admin
    .from("vehicle_inspections")
    .insert({
      tenant_id,
      vehicle_id: vehicleId,
      inspection_date,
      expiry_date,
      inspection_center: inspection_center ?? null,
      outcome: outcome ?? null,
      outcome_notes: outcome_notes ?? null,
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
    compliance_type: "inspection",
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
  const {
    id,
    inspection_date,
    expiry_date,
    inspection_center,
    outcome,
    outcome_notes,
    document_path,
    notes,
  } = body;

  if (!id) return NextResponse.json({ error: "id obbligatorio" }, { status: 400 });

  const { data: updated, error } = await admin
    .from("vehicle_inspections")
    .update({
      inspection_date,
      expiry_date,
      inspection_center: inspection_center ?? null,
      outcome: outcome ?? null,
      outcome_notes: outcome_notes ?? null,
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
      compliance_type: "inspection",
      action: "uploaded",
      ref_id: id,
      performed_by: user.id,
    });
  }

  return NextResponse.json({ item: updated });
}
