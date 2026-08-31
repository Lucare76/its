/**
 * FASE A.2 — persistenza fire-and-forget del cost tracking LLM di Mario.
 *
 * Scrive UNA riga su public.mario_llm_usage per OGNI chiamata LLM reale
 * (chiamato da telemetry.ts::logMarioLlmRoute, che scatta una volta per
 * invocazione di routeMarioWithLlm). Il fast-path deterministico non passa
 * di qui → nessuna riga → nessun costo, nessun incremento "chiamate AI".
 *
 * Osservabilità, non percorso critico (§18/§19): non attende mai, non lancia
 * mai, se il salvataggio fallisce Mario continua. Nessun prompt, nessuna
 * risposta, nessun token di conferma, nessuna PII (§10/§25).
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { calcMarioLlmCost } from "./pricing";

export type MarioLlmUsageEntry = {
  tenantId: string;
  userId: string;
  requestId?: string | null;
  model: string;
  /** Esito del router: tool_call | clarification | answer | fallback. */
  action?: string | null;
  fallbackUsed: boolean;
  /** true = il provider ha fallito PRIMA di restituire usage affidabile (§16):
   *  token/costo non vengono inventati. */
  failed?: boolean;
  inputTokens?: number | null;
  outputTokens?: number | null;
  latencyMs?: number | null;
};

let client: SupabaseClient | null = null;

function getAdmin(): SupabaseClient | null {
  if (client) return client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/^["']|["']$/g, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim().replace(/^["']|["']$/g, "");
  if (!url || !key) return null;
  client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}

export async function persistMarioLlmUsage(entry: MarioLlmUsageEntry): Promise<void> {
  const admin = getAdmin();
  if (!admin) return;

  const failed = entry.failed ?? false;
  const inputTokens = failed ? 0 : Math.max(0, Math.trunc(entry.inputTokens ?? 0));
  const outputTokens = failed ? 0 : Math.max(0, Math.trunc(entry.outputTokens ?? 0));

  // Nessuna riga se non c'è nulla di utile da tracciare: chiamata non fallita
  // ma senza alcun token (es. provider non chiamato per no_api_key).
  if (!failed && inputTokens === 0 && outputTokens === 0) return;

  const cost = failed ? null : calcMarioLlmCost(entry.model, inputTokens, outputTokens);

  try {
    await admin.from("mario_llm_usage").insert({
      tenant_id: entry.tenantId,
      user_id: entry.userId,
      request_id: entry.requestId ?? null,
      model: entry.model,
      action: entry.action ?? null,
      fallback_used: entry.fallbackUsed,
      failed,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      input_cost_usd: cost?.inputCostUsd ?? null,
      output_cost_usd: cost?.outputCostUsd ?? null,
      total_cost_usd: cost?.totalCostUsd ?? null,
      latency_ms: entry.latencyMs ?? null,
    });
  } catch (err) {
    console.warn("[mario-llm-usage] insert non riuscito (osservabilità, non bloccante):", err instanceof Error ? err.message : err);
  }
}
