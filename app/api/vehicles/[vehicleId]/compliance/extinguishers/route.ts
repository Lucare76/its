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
    .from("vehicle_extinguishers")
    .select("*")
    .eq("tenant_id", tenant_id)
    .eq("vehicle_id", vehicleId)
    .order("expiry_date", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ items: data ?? [] });
}

export async function POST(request: NextRequest, { params }: Ctx) {
  const { vehicleId } = await params;
  const ctx = await authorizePricingRequest(request, ["admin", "operator"]);
  if (ctx instanceof NextResponse) return ctx;
  const { admin, user, membership: { tenant_id } } = ctx;

  const body = await request.json().catch(() => ({}));
  const { serial_number, last_revision_date, expiry_date, document_path, notes } = body;

  if (!expiry_date) {
    return NextResponse.json({ error: "expiry_date obbligatorio" }, { status: 400 });
  }

  const { data: inserted, error } = await admin
    .from("vehicle_extinguishers")
    .insert({
      tenant_id,
      vehicle_id: vehicleId,
      serial_number: serial_number ?? null,
      last_revision_date: last_revision_date ?? null,
      expiry_date,
      document_path: document_path ?? null,
      notes: notes ?? null,
      active: true,
      created_by: user.id,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await admin.from("vehicle_compliance_history").insert({
    tenant_id,
    vehicle_id: vehicleId,
    compliance_type: "extinguisher",
    action: "created",
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
  const { id, serial_number, last_revision_date, expiry_date, document_path, notes, active } = body;

  if (!id) return NextResponse.json({ error: "id obbligatorio" }, { status: 400 });

  const { data: oldRow } = await admin
    .from("vehicle_extinguishers")
    .select("expiry_date, active")
    .eq("id", id)
    .eq("tenant_id", tenant_id)
    .maybeSingle();

  const { data: updated, error } = await admin
    .from("vehicle_extinguishers")
    .update({
      serial_number: serial_number ?? null,
      last_revision_date: last_revision_date ?? null,
      expiry_date,
      document_path: document_path ?? null,
      notes: notes ?? null,
      ...(active !== undefined ? { active } : {}),
    })
    .eq("id", id)
    .eq("tenant_id", tenant_id)
    .eq("vehicle_id", vehicleId)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!updated) return NextResponse.json({ error: "Record non trovato" }, { status: 404 });

  const action =
    active === false ? "archived"
    : document_path && document_path !== (oldRow as { document_path?: string } | null)?.document_path
      ? "uploaded"
      : "renewed";

  await admin.from("vehicle_compliance_history").insert({
    tenant_id,
    vehicle_id: vehicleId,
    compliance_type: "extinguisher",
    action,
    old_expiry_date: oldRow?.expiry_date ?? null,
    new_expiry_date: expiry_date,
    ref_id: id,
    performed_by: user.id,
  });

  return NextResponse.json({ item: updated });
}
