/**
 * DELETE /api/admin/agency-reviews/[id]
 * Elimina una sessione di revisione (solo admin/operator/supervisor).
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

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
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

  const { error } = await admin
    .from("agency_review_sessions")
    .delete()
    .eq("id", id)
    .eq("tenant_id", membership.tenant_id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
