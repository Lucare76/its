/**
 * GET /api/admin/agency-reviews
 * Lista sessioni di revisione del tenant (operatore/admin).
 * Filtri: ?status=pending|approved|modified|all (default: all recenti)
 */
import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

function adminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

export async function GET(request: NextRequest) {
  const admin = adminClient();
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return NextResponse.json({ error: "Non autenticato." }, { status: 401 });

  const { data: { user }, error: authErr } = await admin.auth.getUser(authHeader.slice(7));
  if (authErr || !user) return NextResponse.json({ error: "Sessione non valida." }, { status: 401 });

  const { data: membership } = await admin
    .from("memberships")
    .select("tenant_id, role")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!membership || !["admin", "operator", "supervisor"].includes(membership.role as string)) {
    return NextResponse.json({ error: "Non autorizzato." }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const statusFilter = searchParams.get("status");

  let query = admin
    .from("agency_review_sessions")
    .select("id, agency_name, report_type, target_date, status, modifications, agency_notes, reviewed_at, created_at, services")
    .eq("tenant_id", membership.tenant_id)
    .order("created_at", { ascending: false })
    .limit(100);

  if (statusFilter && statusFilter !== "all") {
    query = query.eq("status", statusFilter);
  }

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ sessions: data ?? [] });
}
