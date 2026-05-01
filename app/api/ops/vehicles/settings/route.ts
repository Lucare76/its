import { NextRequest, NextResponse } from "next/server";
import { authorizeServiceRoleRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const auth = await authorizeServiceRoleRequest(request, {
    roles: ["admin", "supervisor", "operator"],
    auditPrefix: "vehicle_settings",
  });
  if (auth instanceof NextResponse) return auth;
  const { admin, membership } = auth;

  const body = (await request.json()) as Record<string, unknown>;
  const { vehicle_id, ...fields } = body;

  if (!vehicle_id || typeof vehicle_id !== "string") {
    return NextResponse.json({ ok: false, error: "vehicle_id richiesto" }, { status: 400 });
  }

  const { error } = await admin
    .from("vehicles")
    .update(fields)
    .eq("id", vehicle_id)
    .eq("tenant_id", membership.tenant_id);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
