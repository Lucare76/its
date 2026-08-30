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

export type MarioLlmRouteLogInput = {
  tenantId: string;
  userId: string;
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
  };
  console.info(JSON.stringify(line));
}
