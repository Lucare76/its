import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const tenantId = auth.membership.tenant_id;

  const { data: quote } = await auth.admin
    .from("service_quotes")
    .select("status")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .single();

  if (!quote) return NextResponse.json({ error: "Preventivo non trovato." }, { status: 404 });
  if (quote.status === "confirmed") {
    return NextResponse.json({ error: "Un preventivo confermato non può essere cancellato da qui." }, { status: 409 });
  }
  if (quote.status === "cancelled") {
    return NextResponse.json({ error: "Preventivo già cancellato." }, { status: 409 });
  }

  const now = new Date().toISOString();
  const { error } = await auth.admin
    .from("service_quotes")
    .update({ status: "cancelled", cancelled_at: now, updated_at: now })
    .eq("id", id)
    .eq("tenant_id", tenantId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
