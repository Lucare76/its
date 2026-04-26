/**
 * DELETE /api/admin/agency-reviews/[id]
 * Elimina una sessione di revisione (solo admin/operator/supervisor).
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const auth = await authorizePricingRequest(request, ["admin", "operator"]);
  if (auth instanceof NextResponse) return auth;

  const { error } = await auth.admin
    .from("agency_review_sessions")
    .delete()
    .eq("id", id)
    .eq("tenant_id", auth.membership.tenant_id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
