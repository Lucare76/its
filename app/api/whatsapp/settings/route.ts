import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient, getTenantWhatsAppSettings } from "@/lib/server/whatsapp";

export const runtime = "nodejs";

const payloadSchema = z.object({
  default_template: z.string().min(1).max(120),
  template_language: z.string().min(2).max(20),
  enable_2h_reminder: z.boolean(),
  allow_text_fallback: z.boolean()
});

async function requireAdminMembership(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch {
    return { error: NextResponse.json({ error: "Server env missing" }, { status: 500 }) };
  }

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

  if (membershipError || !membership?.tenant_id) {
    return { error: NextResponse.json({ error: "Tenant not found" }, { status: 404 }) };
  }
  if (membership.role !== "admin") {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }

  return { admin, membership };
}

export async function GET(request: NextRequest) {
  const auth = await requireAdminMembership(request);
  if ("error" in auth) return auth.error;

  const settings = await getTenantWhatsAppSettings(auth.admin, auth.membership.tenant_id);
  return NextResponse.json({ ok: true, settings });
}

export async function POST(request: NextRequest) {
  const auth = await requireAdminMembership(request);
  if ("error" in auth) return auth.error;

  const parsed = payloadSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid payload" }, { status: 400 });
  }

  const toSave = {
    tenant_id: auth.membership.tenant_id,
    default_template: parsed.data.default_template.trim(),
    template_language: parsed.data.template_language.trim().replace("-", "_"),
    enable_2h_reminder: parsed.data.enable_2h_reminder,
    allow_text_fallback: parsed.data.allow_text_fallback,
    updated_at: new Date().toISOString()
  };

  const { error } = await auth.admin.from("tenant_whatsapp_settings").upsert(toSave, { onConflict: "tenant_id" });
  if (error) {
    return NextResponse.json({ error: "Failed to save settings" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, settings: toSave });
}
