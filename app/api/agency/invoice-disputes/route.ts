/**
 * POST /api/agency/invoice-disputes — l'agenzia segnala un prezzo che
 * ritiene sbagliato su una riga dell'estratto conto già inviata (una
 * prenotazione con agency_quoted_price_cents valorizzato). Crea una
 * contestazione "pending"; la risoluzione (approva/rifiuta) è solo lato ITS
 * — vedi app/api/ops/agency-invoice-disputes/[id]/resolve/route.ts.
 * GET /api/agency/invoice-disputes — l'agenzia vede lo stato delle proprie.
 *
 * Distinta dal meccanismo services.approval_status/price_mismatch (quello
 * scatta quando l'agenzia INSERISCE una nuova prenotazione con un prezzo che
 * non combacia col listino interno — verso opposto: qui è l'agenzia a
 * proporre una correzione su una riga già fatturata).
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizeServiceRoleRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

type AgencyExtra = { agency_id?: string | null };

async function authorizeAgencyOnly(request: NextRequest) {
  const auth = await authorizeServiceRoleRequest<"agency", AgencyExtra>(
    request,
    {
      roles: ["agency"],
      membershipFields: ["agency_id"],
      auditPrefix: "agency_invoice_dispute",
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

export async function POST(request: NextRequest) {
  const auth = await authorizeAgencyOnly(request);
  if (auth instanceof NextResponse) return auth;
  return NextResponse.json(
    {
      error:
        "Le correzioni vanno raccolte e inviate dall’intero estratto conto con “Invia revisione estratto conto”.",
    },
    { status: 409 },
  );
}
export async function GET(request: NextRequest) {
  const auth = await authorizeAgencyOnly(request);
  if (auth instanceof NextResponse) return auth;
  const { admin, tenantId, agencyId } = auth;

  const { data, error } = await admin
    .from("agency_invoice_disputes")
    .select(
      "id, agency_invoice_id, service_id, original_price_cents, proposed_price_cents, agency_note, status, resolution_note, created_at, resolved_at",
    )
    .eq("tenant_id", tenantId)
    .eq("agency_id", agencyId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, disputes: data ?? [] });
}
