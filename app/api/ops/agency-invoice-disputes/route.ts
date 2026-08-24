/**
 * GET /api/ops/agency-invoice-disputes — coda di segnalazioni prezzo
 * dell'agenzia in attesa di approvazione ITS. Filtro opzionale
 * ?status=pending|approved|rejected (default: pending) e ?agency_id=.
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  const tenantId = auth.membership.tenant_id;
  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? "pending";
  const agencyId = url.searchParams.get("agency_id");

  let query = auth.admin
    .from("agency_invoice_disputes")
    .select(
      "id, agency_id, service_id, agency_invoice_id, original_price_cents, proposed_price_cents, agency_note, status, created_at, resolved_at, resolution_note, " +
      "agencies(name), services(customer_name, customer_first_name, customer_last_name, date, booking_service_kind)"
    )
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false })
    .limit(200);

  if (status !== "all") query = query.eq("status", status);
  if (agencyId) query = query.eq("agency_id", agencyId);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, disputes: data ?? [] });
}
