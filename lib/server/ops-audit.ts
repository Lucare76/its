import { createClient, type SupabaseClient } from "@supabase/supabase-js";

type AuditLevel = "info" | "warn" | "error";

type AuditPayload = {
  event: string;
  level?: AuditLevel;
  tenantId?: string | null;
  userId?: string | null;
  serviceId?: string | null;
  inboundEmailId?: string | null;
  duplicate?: boolean;
  outcome?: string | null;
  parserKey?: string | null;
  parsingQuality?: string | null;
  role?: string | null;
  details?: Record<string, unknown>;
};

function safeDetails(details?: Record<string, unknown>) {
  if (!details) return undefined;
  const entries = Object.entries(details).filter(([, value]) => value !== undefined);
  return Object.fromEntries(entries);
}

let auditAdminClient: SupabaseClient | null = null;

function getAuditAdminClient() {
  if (auditAdminClient) return auditAdminClient;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) return null;
  auditAdminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  return auditAdminClient;
}

async function persistAuditEvent(event: Record<string, unknown>) {
  const admin = getAuditAdminClient();
  if (!admin) return;
  try {
    await admin.from("ops_audit_events").insert({
      tenant_id: event.tenant_id,
      event: event.event,
      level: event.level,
      user_id: event.user_id,
      role: event.role,
      service_id: event.service_id,
      inbound_email_id: event.inbound_email_id,
      duplicate: event.duplicate,
      outcome: event.outcome,
      parser_key: event.parser_key,
      parsing_quality: event.parsing_quality,
      details: event.details,
      created_at: event.ts
    });
  } catch {
    // Keep audit fire-and-forget and never break the primary flow.
  }
}

export function auditLog(payload: AuditPayload) {
  const level = payload.level ?? "info";
  const event = {
    ts: new Date().toISOString(),
    scope: "beta_ops",
    event: payload.event,
    level,
    tenant_id: payload.tenantId ?? null,
    user_id: payload.userId ?? null,
    role: payload.role ?? null,
    service_id: payload.serviceId ?? null,
    inbound_email_id: payload.inboundEmailId ?? null,
    duplicate: payload.duplicate ?? false,
    outcome: payload.outcome ?? null,
    parser_key: payload.parserKey ?? null,
    parsing_quality: payload.parsingQuality ?? null,
    details: safeDetails(payload.details) ?? null
  };

  void persistAuditEvent(event);

  if (level === "error") {
    console.error(JSON.stringify(event));
    return;
  }
  if (level === "warn") {
    console.warn(JSON.stringify(event));
    return;
  }
  console.info(JSON.stringify(event));
}
