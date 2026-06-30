import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { buildServiceQuoteVoucherHtml } from "@/lib/server/service-quote-voucher";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;

  try {
    const html = await buildServiceQuoteVoucherHtml(auth.admin, auth.membership.tenant_id, id);
    return NextResponse.json({ ok: true, html });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Anteprima voucher non disponibile." },
      { status: 404 },
    );
  }
}
