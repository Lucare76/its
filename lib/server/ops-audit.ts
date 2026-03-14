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
