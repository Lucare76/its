import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { authorizeServiceRoleRequest } from "@/lib/server/pricing-auth";
import { verifyAgencyActionToken } from "@/lib/server/agency-action-token";
export async function statementPaymentAuth(
  request: NextRequest,
  token?: string,
) {
  if (token) {
    const p = verifyAgencyActionToken(token);
    if (!p || p.act !== "invoice_review" || !p.iid)
      return NextResponse.json({ error: "Link non valido." }, { status: 403 });
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(
      /^["']|["']$/g,
      "",
    );
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim().replace(
      /^["']|["']$/g,
      "",
    );
    if (!url || !key)
      return NextResponse.json(
        { error: "Configurazione non disponibile." },
        { status: 503 },
      );
    return {
      admin: createClient(url, key, { auth: { persistSession: false } }),
      tenantId: p.tid,
      agencyId: p.aid,
      invoiceId: p.iid,
    };
  }
  const auth = await authorizeServiceRoleRequest<
    "agency",
    { agency_id: string }
  >(request, { roles: ["agency"], membershipFields: ["agency_id"] });
  if (auth instanceof NextResponse) return auth;
  if (!auth.membership.agency_id)
    return NextResponse.json(
      { error: "Agenzia non collegata." },
      { status: 403 },
    );
  return {
    admin: auth.admin,
    tenantId: auth.membership.tenant_id,
    agencyId: auth.membership.agency_id,
    invoiceId: null,
  };
}
