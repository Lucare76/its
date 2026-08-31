/**
 * FASE A — telemetria "safe" per il router LLM di Mario (§26).
 *
 * Stesso spirito di lib/mcp/audit.ts::mcpAuditLog (console.info JSON strutturato),
 * ma per la DECISIONE di routing stessa (non l'esecuzione del tool, gia'
 * coperta da mcp_audit_logs). Non persiste su DB in FASE A: nessuna tabella
 * nuova, solo log strutturato.
 *
 * MAI loggato: confirmationToken, messaggio utente completo, PII cliente.
 */
import { getMarioLlmModel } from "./llm-client";
import type { MarioRouterDecision, MarioLlmFallbackReason } from "./llm-router";
import type { LlmUsage } from "./llm-client";
import type { MarioSessionStoreKind } from "./session-context";
import { persistMarioLlmUsage } from "./usage-log";

export type MarioLlmRouteLogInput = {
  tenantId: string;
  userId: string;
  /** McpContext.requestId — uuid non sensibile, per correlare le righe usage. */
  requestId?: string;
  role: string;
  step: number;
  decision: MarioRouterDecision;
  usage: LlmUsage | null;
  fallbackUsed: boolean;
  fallbackReason?: MarioLlmFallbackReason;
  latencyMs: number;
  /** FASE A.1 §17 — quale backend ha servito il contesto in questo turno. */
  sessionStore?: MarioSessionStoreKind;
  /** true se il contesto breve conteneva almeno un riferimento utile. */
  contextLoaded?: boolean;
  /** true se al momento del routing c'era una conferma in sospeso (mai il token). */
  pendingConfirmation?: boolean;
  /** SANITIZZATO — path/codici degli issue Zod quando fallback_reason ===
   *  "invalid_schema": diagnostica della prossima divergenza di envelope del
   *  modello SENZA conoscere il contenuto (mai valori, mai PII, mai raw LLM). */
  schemaIssuePaths?: string[];
  schemaIssueCodes?: string[];
  /** true quando il router e' stato invocato in shadow mode (§28): la
   *  decisione e' stata solo osservata, non ha guidato la risposta. */
  shadow?: boolean;
};

export function logMarioLlmRoute(input: MarioLlmRouteLogInput): void {
  const line = {
    ts: new Date().toISOString(),
    scope: "mario_llm_route",
    tenant_id: input.tenantId,
    user_id: input.userId,
    role: input.role,
    step: input.step,
    shadow: input.shadow ?? false,
    action: input.decision.action,
    tool_name: input.decision.action === "tool_call" ? input.decision.tool_name : null,
    confidence: "confidence" in input.decision ? input.decision.confidence ?? null : null,
    model: getMarioLlmModel(),
    latency_ms: input.latencyMs,
    fallback_used: input.fallbackUsed,
    fallback_reason: input.fallbackReason ?? null,
    input_tokens: input.usage?.inputTokens ?? null,
    output_tokens: input.usage?.outputTokens ?? null,
    session_store: input.sessionStore ?? null,
    context_loaded: input.contextLoaded ?? null,
    pending_confirmation: input.pendingConfirmation ?? null,
    schema_issue_paths: input.schemaIssuePaths ?? null,
    schema_issue_codes: input.schemaIssueCodes ?? null,
  };
  console.info(JSON.stringify(line));

  // FASE A.2 — cost tracking: una riga mario_llm_usage per chiamata LLM REALE.
  // Shadow mode escluso (diagnostico, non guida risposte → non è una "chiamata
  // AI" per l'utente). Fire-and-forget: mai await, mai throw (§18/§19).
  if (input.shadow) return;
  const hasUsage = input.usage != null;
  const attemptedButFailed =
    !hasUsage && input.fallbackReason != null && ATTEMPTED_FAILURE_REASONS.has(input.fallbackReason);
  if (!hasUsage && !attemptedButFailed) return; // es. no_api_key: nessuna chiamata avvenuta

  void persistMarioLlmUsage({
    tenantId: input.tenantId,
    userId: input.userId,
    requestId: input.requestId ?? null,
    model: getMarioLlmModel(),
    action: input.decision.action,
    fallbackUsed: input.fallbackUsed,
    failed: attemptedButFailed,
    inputTokens: input.usage?.inputTokens ?? 0,
    outputTokens: input.usage?.outputTokens ?? 0,
    latencyMs: input.latencyMs,
  });
}

// Reason di fallback in cui il provider È stato contattato ma non ha
// restituito usage affidabile (§16): riga `failed` con 0 token, costo null.
// `no_api_key` / `invalid_json` / `invalid_schema` NON sono qui: le prime non
// contattano il provider, le seconde hanno `usage` valido (token consumati).
const ATTEMPTED_FAILURE_REASONS: ReadonlySet<MarioLlmFallbackReason> = new Set([
  "timeout",
  "network_error",
  "http_error",
  "empty_response",
  "unknown_error",
]);
