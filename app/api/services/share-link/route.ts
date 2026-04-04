import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { getRequestAppUrl } from "@/lib/app-url";

export const runtime = "nodejs";

const payloadSchema = z.object({
  service_id: z.string().uuid(),
  expires_in_hours: z.number().int().min(1).max(24 * 30).optional().default(24 * 7)
});

function appBaseUrl(request: NextRequest) {
  return getRequestAppUrl(request.headers);
}

function newShareToken() {
  return crypto.randomBytes(24).toString("hex");
}

async function requireOperator(request: NextRequest) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const authHeader = request.headers.get("authorization");
  if (!supabaseUrl || !serviceRoleKey) {
    return { error: NextResponse.json({ error: "Server env missing" }, { status: 500 }) };
  }
  if (!authHeader?.startsWith("Bearer ")) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const token = authHeader.slice("Bearer ".length);
  const {
    data: { user },
    error: authError
  } = await admin.auth.getUser(token);
  if (authError || !user) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  const { data: membership, error: membershipError } = await admin
    .from("memberships")
    .select("tenant_id, role")
    .eq("user_id", user.id)
    .maybeSingle();
  if (membershipError || !membership?.tenant_id || !["admin", "operator"].includes(membership.role)) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }

  return {
    admin,
    tenantId: membership.tenant_id
  };
}

export async function POST(request: NextRequest) {
  const auth = await requireOperator(request);
  if ("error" in auth) return auth.error;

  const parsed = payloadSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid payload" }, { status: 400 });
  }

  const token = newShareToken();
  const expiresAt = new Date(Date.now() + parsed.data.expires_in_hours * 60 * 60 * 1000).toISOString();

  const { data, error } = await auth.admin
    .from("services")
    .update({
      share_token: token,
      share_expires_at: expiresAt
    })
    .eq("id", parsed.data.service_id)
    .eq("tenant_id", auth.tenantId)
    .select("id, share_token, share_expires_at")
    .maybeSingle();

  if (error || !data?.share_token) {
    return NextResponse.json({ error: "Service not found" }, { status: 404 });
  }

  const base = appBaseUrl(request);
  const shareUrl = base ? `${base}/share/service/${data.share_token}` : `/share/service/${data.share_token}`;

  return NextResponse.json({
    ok: true,
    share_token: data.share_token,
    share_expires_at: data.share_expires_at,
    share_url: shareUrl
  });
}

export async function DELETE(request: NextRequest) {
  const auth = await requireOperator(request);
  if ("error" in auth) return auth.error;

  const parsed = z
    .object({ service_id: z.string().uuid() })
    .safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const { error } = await auth.admin
    .from("services")
    .update({
      share_token: null,
      share_expires_at: null
    })
    .eq("id", parsed.data.service_id)
    .eq("tenant_id", auth.tenantId);

  if (error) {
    return NextResponse.json({ error: "Revoke failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

