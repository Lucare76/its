import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { parseRole } from "@/lib/rbac";

export const runtime = "nodejs";

async function authorize(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/^["']|["']$/g, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim().replace(/^["']|["']$/g, "");
  if (!url || !key) return null;
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const { data: { user } } = await admin.auth.getUser(authHeader.slice(7));
  if (!user) return null;
  const { data: membership } = await admin
    .from("memberships")
    .select("tenant_id, role")
    .eq("user_id", user.id)
    .maybeSingle();
  const role = parseRole(membership?.role);
  if (!membership?.tenant_id || !role || !["admin", "operator"].includes(role)) return null;
  return { admin, tenantId: membership.tenant_id };
}

/**
 * PATCH /api/agency/statement/[id]
 * Body: { payment_status: "paid" | "unpaid" | "waived" }
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await authorize(request);
  if (!ctx) return NextResponse.json({ error: "Non autorizzato." }, { status: 403 });

  const { id } = await params;
  const body = await request.json().catch(() => null) as { payment_status?: string } | null;
  const status = body?.payment_status;
  if (!status || !["paid", "unpaid", "waived"].includes(status)) {
    return NextResponse.json({ error: "payment_status non valido." }, { status: 400 });
  }

  const update: Record<string, unknown> = { agency_payment_status: status };
  if (status === "paid") {
    update.agency_paid_at = new Date().toISOString().slice(0, 10);
  } else {
    update.agency_paid_at = null;
  }

  const { error } = await ctx.admin
    .from("services")
    .update(update)
    .eq("id", id)
    .eq("tenant_id", ctx.tenantId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
