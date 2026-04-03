/**
 * POST /api/invoices/[id]/mark-paid
 * Marca un estratto conto come pagato.
 */

import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorizePricingRequest(request, ["admin", "operator"]);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const tenantId = auth.membership.tenant_id;
  const userId = auth.user?.id ?? null;

  let body: { payment_note?: string } = {};
  try { body = (await request.json()) as typeof body; } catch { /* opzionale */ }

  const { error } = await (auth.admin as any)
    .from("agency_invoices")
    .update({
      status: "paid",
      paid_at: new Date().toISOString(),
      paid_by_user_id: userId,
      payment_note: body.payment_note ?? null
    })
    .eq("id", id)
    .eq("tenant_id", tenantId);

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
