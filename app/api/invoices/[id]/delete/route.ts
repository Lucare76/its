/**
 * DELETE /api/invoices/[id]/delete
 * Elimina un estratto conto (solo se in stato "draft").
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorizePricingRequest(request, ["admin", "operator"]);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const tenantId = auth.membership.tenant_id;
  const admin = auth.admin as any;

  // Verifica che esista e sia una bozza
  const { data: invoice } = await admin
    .from("agency_invoices")
    .select("id, status")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .single();

  if (!invoice) {
    return NextResponse.json({ ok: false, error: "Estratto conto non trovato." }, { status: 404 });
  }
  if (invoice.status !== "draft") {
    return NextResponse.json({ ok: false, error: "Solo le bozze possono essere eliminate." }, { status: 400 });
  }

  const { error } = await admin
    .from("agency_invoices")
    .delete()
    .eq("id", id)
    .eq("tenant_id", tenantId);

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
