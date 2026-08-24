/**
 * GET /api/agency/invoices — estratti conto ricevuti dall'agenzia loggata.
 * Sola lettura: la generazione/invio resta esclusivamente lato ITS
 * (app/api/invoices/route.ts). Le righe (invoice_data) sono usate dalla
 * pagina /agency/statement per mostrare il dettaglio e permettere la
 * contestazione prezzo (POST /api/agency/invoice-disputes).
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizeServiceRoleRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

type AgencyExtra = { agency_id?: string | null };

export async function GET(request: NextRequest) {
  const auth = await authorizeServiceRoleRequest<"agency", AgencyExtra>(request, {
    roles: ["agency"],
    membershipFields: ["agency_id"],
    auditPrefix: "agency_invoices_list",
  });
  if (auth instanceof NextResponse) return auth;

  const agencyId = auth.membership.agency_id ?? null;
  if (!agencyId) {
    return NextResponse.json({ error: "Nessuna agenzia collegata a questo account." }, { status: 403 });
  }

  const tenantId = auth.membership.tenant_id;

  const { data, error } = await auth.admin
    .from("agency_invoices")
    .select("id, period_from, period_to, status, total_cents, services_count, invoice_data, created_at, sent_at, agency_review_status, agency_reviewed_at")
    .eq("tenant_id", tenantId)
    .eq("agency_id", agencyId)
    .order("period_from", { ascending: false })
    .limit(100);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, invoices: data ?? [] });
}
