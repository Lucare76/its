import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ vehicleId: string }> };

export async function POST(request: NextRequest, { params }: Ctx) {
  const { vehicleId } = await params;
  const ctx = await authorizePricingRequest(request, ["admin", "operator"]);
  if (ctx instanceof NextResponse) return ctx;
  const { admin, membership: { tenant_id } } = ctx;

  const body = await request.json().catch(() => ({}));
  const { document_path } = body as { document_path?: string };

  if (!document_path) {
    return NextResponse.json({ error: "document_path obbligatorio" }, { status: 400 });
  }

  const { error } = await admin
    .from("vehicles")
    .update({
      libretto_document_path: document_path,
      libretto_uploaded_at: new Date().toISOString(),
    })
    .eq("id", vehicleId)
    .eq("tenant_id", tenant_id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await admin.from("vehicle_compliance_history").insert({
    tenant_id,
    vehicle_id: vehicleId,
    compliance_type: "libretto",
    action: "uploaded",
    notes: document_path,
  });

  return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest, { params }: Ctx) {
  const { vehicleId } = await params;
  const ctx = await authorizePricingRequest(request, ["admin", "operator"]);
  if (ctx instanceof NextResponse) return ctx;
  const { admin, membership: { tenant_id } } = ctx;

  await admin
    .from("vehicles")
    .update({ libretto_document_path: null, libretto_uploaded_at: null })
    .eq("id", vehicleId)
    .eq("tenant_id", tenant_id);

  return NextResponse.json({ ok: true });
}
