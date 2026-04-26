/**
 * GET /api/admin/agency-reviews
 * Lista sessioni di revisione del tenant (operatore/admin).
 * Filtri: ?status=pending|approved|modified|all (default: all recenti)
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
  const auth = await authorizePricingRequest(request, ["admin", "operator"]);
  if (auth instanceof NextResponse) return auth;

  const { searchParams } = new URL(request.url);
  const statusFilter = searchParams.get("status");

  let query = auth.admin
    .from("agency_review_sessions")
    .select("id, agency_name, report_type, target_date, status, modifications, agency_notes, reviewed_at, created_at, services")
    .eq("tenant_id", auth.membership.tenant_id)
    .order("created_at", { ascending: false })
    .limit(100);

  if (statusFilter && statusFilter !== "all") {
    query = query.eq("status", statusFilter);
  }

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ sessions: data ?? [] });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Errore interno." }, { status: 500 });
  }
}
