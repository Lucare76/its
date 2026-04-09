import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { runEmailOperationalImport } from "../lib/server/email-test-import";

function loadDotEnvLocal() {
  const envPath = path.resolve(".env.local");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim().replace(/^"|"$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

async function signIn(email: string, password: string) {
  const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const signInResult = await client.auth.signInWithPassword({ email, password });
  if (signInResult.error || !signInResult.data.user?.id) {
    throw new Error(signInResult.error?.message ?? "Login fallito");
  }
  return signInResult.data.user.id;
}

async function main() {
  loadDotEnvLocal();

  process.env.EMAIL_IMAP_MARK_SEEN = process.env.EMAIL_IMAP_MARK_SEEN || "false";
  process.env.EMAIL_IMAP_MAX_MESSAGES = process.env.EMAIL_IMAP_MAX_MESSAGES || "10";

  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Env Supabase mancanti.");
  }

  const email = process.env.PDF_PREVIEW_USER_EMAIL || "admin@demo.com";
  const password = process.env.PDF_PREVIEW_USER_PASSWORD || "demo123";
  const userId = await signIn(email, password);

  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const membershipResult = await admin
    .from("memberships")
    .select("tenant_id, role")
    .eq("user_id", userId)
    .maybeSingle();
  if (membershipResult.error || !membershipResult.data?.tenant_id || !membershipResult.data.role) {
    throw new Error(membershipResult.error?.message ?? "Membership non trovata.");
  }

  const tenantId = membershipResult.data.tenant_id;
  const [beforeInbound, beforeServices] = await Promise.all([
    admin.from("inbound_emails").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId),
    admin.from("services").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId)
  ]);

  const result = await runEmailOperationalImport({
    admin,
    user: { id: userId },
    membership: {
      tenant_id: tenantId,
      role: membershipResult.data.role
    }
  });

  const [afterInbound, afterServices, latestInbound, latestService] = await Promise.all([
    admin.from("inbound_emails").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId),
    admin.from("services").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId),
    admin
      .from("inbound_emails")
      .select("id, subject, from_email, created_at, parsed_json")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    admin
      .from("services")
      .select("id, inbound_email_id, is_draft, status, customer_name, created_at, notes")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
  ]);

  console.log(
    JSON.stringify(
      {
        ...result,
        tenant_id: tenantId,
        inbound_before: beforeInbound.count ?? null,
        inbound_after: afterInbound.count ?? null,
        services_before: beforeServices.count ?? null,
        services_after: afterServices.count ?? null,
        latest_inbound: latestInbound.data ?? null,
        latest_service: latestService.data ?? null
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
