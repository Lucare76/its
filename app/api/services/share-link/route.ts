import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getRequestAppUrl } from "@/lib/app-url";
import { authorizeServiceRoleRequest } from "@/lib/server/pricing-auth";

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
  const auth = await authorizeServiceRoleRequest(request, {
    roles: ["admin", "operator"],
    auditPrefix: "service_share"
  });
  if (auth instanceof NextResponse) {
    return { error: auth };
  }

  return {
    admin: auth.admin,
    tenantId: auth.membership.tenant_id
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

  if (error) {
    // HARDENING SPRINT 1 — FASE 8/9: distinguish a real DB/schema error (500,
    // logged server-side for operators) from "no matching service" (404).
    // Never log the token/customer data here, only the Postgres error
    // message and the service id (a UUID, not personal data).
    console.error("[share-link] update failed", { service_id: parsed.data.service_id, message: error.message });
    return NextResponse.json({ error: "Errore interno" }, { status: 500 });
  }
  if (!data?.share_token) {
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
    console.error("[share-link] revoke failed", { service_id: parsed.data.service_id, message: error.message });
    return NextResponse.json({ error: "Revoke failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
