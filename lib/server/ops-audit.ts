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
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/^["']|["']$/g, "");
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim().replace(/^["']|["']$/g, "");
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

function buildAuditEvent(payload: AuditPayload) {
  const level = payload.level ?? "info";
  return {
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
}

function logAuditEventToConsole(event: ReturnType<typeof buildAuditEvent>) {
  if (event.level === "error") {
    console.error(JSON.stringify(event));
    return;
  }
  if (event.level === "warn") {
    console.warn(JSON.stringify(event));
    return;
  }
  console.info(JSON.stringify(event));
}

export function auditLog(payload: AuditPayload) {
  const event = buildAuditEvent(payload);
  void persistAuditEvent(event);
  logAuditEventToConsole(event);
}

/**
 * Variante awaited di `auditLog`. A differenza di `persistAuditEvent`
 * (fire-and-forget, errori sempre inghiottiti — vedi commento li'), qui un
 * eventuale fallimento dell'insert viene loggato (mai lanciato: non deve mai
 * rompere il flusso principale del chiamante) cosi' da restare diagnosticabile
 * dai log invece di sparire silenziosamente. `tenant_id` e' NOT NULL sulla
 * tabella `ops_audit_events`: un payload senza `tenantId` fallisce sempre
 * l'insert (era esattamente la causa per cui il cron retry Medmar non
 * scriveva mai un evento, indipendentemente da awaited/fire-and-forget).
 */
export async function auditLogAwaited(payload: AuditPayload): Promise<void> {
  const event = buildAuditEvent(payload);
  const admin = getAuditAdminClient();
  // tenant_id e' NOT NULL sulla tabella: senza un tenant reale l'insert fallirebbe sempre
  // (es. run del cron senza alcun candidato/tenant coinvolto) — si evita il tentativo inutile,
  // il console.log resta comunque l'unica traccia per quel caso, che non ha nulla di attore-specifico da salvare.
  if (admin && event.tenant_id) {
    const result = await admin.from("ops_audit_events").insert({
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
    if (result.error) {
      console.error("[auditLogAwaited] insert fallito:", JSON.stringify({ event: event.event, error: result.error }));
    }
  }
  logAuditEventToConsole(event);
}
