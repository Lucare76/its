/**
 * POST /api/agency/invoices/[id]/review — riscontro dell'agenzia (loggata)
 * sull'INTERO estratto conto in un'unica chiamata (mai una email per riga
 * contestata):
 *   { action: "approve" }                              — tutto corretto
 *   { action: "dispute", corrections: [{service_id, proposed_price_cents, note}] } — correzioni in blocco
 * Equivalente autenticato di POST /api/agency/statement-token (usato dalle
 * agenzie senza account, via link con token nell'email).
 */
import { NextRequest, NextResponse } from "next/server";
import { reviewStatement } from "@/lib/server/agency-statement-review";
import { authorizeServiceRoleRequest } from "@/lib/server/pricing-auth";
import { getRequestAppUrl } from "@/lib/app-url";

export const runtime = "nodejs";

type AgencyExtra = { agency_id?: string | null };

async function authorizeAgencyOnly(request: NextRequest) {
  const auth = await authorizeServiceRoleRequest<"agency", AgencyExtra>(
    request,
    {
      roles: ["agency"],
      membershipFields: ["agency_id"],
      auditPrefix: "agency_invoice_review",
    },
  );
  if (auth instanceof NextResponse) return auth;
  const agencyId = auth.membership.agency_id ?? null;
  if (!agencyId) {
    return NextResponse.json(
      { error: "Nessuna agenzia collegata a questo account." },
      { status: 403 },
    );
  }
  return {
    admin: auth.admin,
    user: auth.user,
    tenantId: auth.membership.tenant_id,
    agencyId,
  };
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authorizeAgencyOnly(request);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  return reviewStatement(
    auth.admin,
    auth.tenantId,
    auth.agencyId,
    id,
    await request.json().catch(() => null),
    auth.user.id,
    getRequestAppUrl(request.headers),
  );
}
