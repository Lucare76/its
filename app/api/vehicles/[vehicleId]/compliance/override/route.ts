import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ vehicleId: string }> };

export async function POST(request: NextRequest, { params }: Ctx) {
  const { vehicleId } = await params;
  const ctx = await authorizePricingRequest(request, ["admin", "operator"]);
  if (ctx instanceof NextResponse) return ctx;
  const { admin, user, membership: { tenant_id } } = ctx;

  const body = await request.json().catch(() => ({}));
  const { until, reason, clear } = body as {
    until?: string;
    reason?: string;
    clear?: boolean;
  };

  // Verify vehicle belongs to tenant
  const { data: vehicle } = await admin
    .from("vehicles")
    .select("id, label")
    .eq("id", vehicleId)
    .eq("tenant_id", tenant_id)
    .maybeSingle();

  if (!vehicle) return NextResponse.json({ error: "Veicolo non trovato" }, { status: 404 });

  if (clear) {
    await admin
      .from("vehicles")
      .update({
        compliance_override_until: null,
        compliance_override_reason: null,
        compliance_override_by: null,
      })
      .eq("id", vehicleId)
      .eq("tenant_id", tenant_id);

    await admin.from("vehicle_compliance_history").insert({
      tenant_id,
      vehicle_id: vehicleId,
      compliance_type: "insurance",
      action: "cleared",
      notes: "Override operativo rimosso",
      performed_by: user.id,
    });

    return NextResponse.json({ ok: true, override: null });
  }

  if (!until || !reason?.trim()) {
    return NextResponse.json(
      { error: "until e reason obbligatori" },
      { status: 400 }
    );
  }

  const overrideDate = new Date(until);
  if (isNaN(overrideDate.getTime()) || overrideDate <= new Date()) {
    return NextResponse.json(
      { error: "until deve essere una data futura valida" },
      { status: 400 }
    );
  }

  await admin
    .from("vehicles")
    .update({
      compliance_override_until: overrideDate.toISOString(),
      compliance_override_reason: reason.trim(),
      compliance_override_by: user.id,
    })
    .eq("id", vehicleId)
    .eq("tenant_id", tenant_id);

  await admin.from("vehicle_compliance_history").insert({
    tenant_id,
    vehicle_id: vehicleId,
    compliance_type: "insurance",
    action: "overridden",
    notes: `Override fino al ${until}: ${reason.trim()}`,
    performed_by: user.id,
  });

  return NextResponse.json({
    ok: true,
    override: {
      until: overrideDate.toISOString(),
      reason: reason.trim(),
      by: user.id,
    },
  });
}
