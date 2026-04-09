import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

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

async function signIn(email, password) {
  const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const result = await client.auth.signInWithPassword({ email, password });
  if (result.error || !result.data.user?.id) {
    throw new Error(result.error?.message ?? "Login fallito");
  }
  return result.data.user.id;
}

async function chunkedDelete(admin, table, column, ids, tenantId) {
  if (!ids.length) return 0;
  let total = 0;
  for (let index = 0; index < ids.length; index += 100) {
    const batch = ids.slice(index, index + 100);
    const query = admin.from(table).delete().in(column, batch);
    const scoped = tenantId ? query.eq("tenant_id", tenantId) : query;
    const { error, count } = await scoped.select("id", { count: "exact", head: true });
    if (error) throw new Error(`${table}: ${error.message}`);
    total += count ?? 0;
  }
  return total;
}

async function chunkedDeleteOptional(admin, table, column, ids, tenantId) {
  try {
    return await chunkedDelete(admin, table, column, ids, tenantId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/Could not find the table/i.test(message) || /does not exist/i.test(message)) {
      return 0;
    }
    throw error;
  }
}

async function main() {
  loadDotEnvLocal();

  const required = [
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "PDF_PREVIEW_USER_EMAIL",
    "PDF_PREVIEW_USER_PASSWORD"
  ];
  for (const key of required) {
    if (!process.env[key]) throw new Error(`Env mancante: ${key}`);
  }

  const userId = await signIn(process.env.PDF_PREVIEW_USER_EMAIL, process.env.PDF_PREVIEW_USER_PASSWORD);
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const membershipResult = await admin.from("memberships").select("tenant_id, role").eq("user_id", userId).maybeSingle();
  if (membershipResult.error || !membershipResult.data?.tenant_id) {
    throw new Error(membershipResult.error?.message ?? "Membership non trovata");
  }
  const tenantId = membershipResult.data.tenant_id;

  const inboundResult = await admin
    .from("inbound_emails")
    .select("id")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: true });
  if (inboundResult.error) throw new Error(inboundResult.error.message);
  const inboundIds = (inboundResult.data ?? []).map((row) => row.id);

  const servicesResult = await admin
    .from("services")
    .select("id")
    .eq("tenant_id", tenantId)
    .in("inbound_email_id", inboundIds.length ? inboundIds : ["00000000-0000-0000-0000-000000000000"]);
  if (servicesResult.error) throw new Error(servicesResult.error.message);
  const serviceIds = (servicesResult.data ?? []).map((row) => row.id);

  const summaryBefore = {
    inbound_emails: inboundIds.length,
    services: serviceIds.length
  };

  const deleted = {
    assignments: await chunkedDelete(admin, "assignments", "service_id", serviceIds, tenantId),
    status_events: await chunkedDelete(admin, "status_events", "service_id", serviceIds, tenantId),
    service_pricing: await chunkedDeleteOptional(admin, "service_pricing", "service_id", serviceIds, tenantId),
    inbound_booking_imports_by_service: await chunkedDeleteOptional(admin, "inbound_booking_imports", "service_id", serviceIds, tenantId),
    inbound_booking_imports_by_email: await chunkedDeleteOptional(admin, "inbound_booking_imports", "inbound_email_id", inboundIds, tenantId),
    services: await chunkedDelete(admin, "services", "id", serviceIds, tenantId),
    inbound_emails: await chunkedDelete(admin, "inbound_emails", "id", inboundIds, tenantId)
  };

  const [remainingInbound, remainingServices] = await Promise.all([
    admin.from("inbound_emails").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId),
    admin.from("services").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId)
  ]);

  console.log(
    JSON.stringify(
      {
        ok: true,
        tenant_id: tenantId,
        before: summaryBefore,
        deleted,
        after: {
          inbound_emails: remainingInbound.count ?? null,
          services: remainingServices.count ?? null
        }
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
