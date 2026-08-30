/**
 * FASE A — wrapper minimo server-side per la chiamata LLM del router Mario.
 *
 * Audit: nessun SDK AI installato nel progetto (@anthropic-ai/sdk, openai
 * non sono in package.json) e nessun wrapper condiviso — ogni chiamante
 * esistente (lib/server/pdf-extract-haiku.ts, app/api/ops/piano-giorno/
 * ai-plan/route.ts, ecc.) fa una fetch diretta a Anthropic per conto proprio,
 * modello hardcodato, nessun timeout, nessun retry. Questo modulo riusa lo
 * STESSO endpoint/pattern di autenticazione (ANTHROPIC_API_KEY server-side,
 * mai al client), ma:
 *  - modello configurabile via MARIO_LLM_MODEL (§4), non hardcodato;
 *  - timeout esplicito via AbortController (§16, assente altrove nel repo);
 *  - nessun retry (§16 "no retry infinito"): un solo tentativo, poi
 *    l'errore tipizzato risale al chiamante che decide il fallback.
 *
 * Astrazione provider (§25): lib/server/mario-assistant/llm-router.ts dipende
 * dal tipo `LlmCompletion`, non da "fetch verso Anthropic" — cambiare
 * provider in futuro significa scrivere una nuova funzione con questa firma,
 * non toccare il router.
 */

export type LlmUsage = { inputTokens: number; outputTokens: number };

export type LlmCompletionResult = {
  text: string;
  usage: LlmUsage;
};

export type LlmCompletion = (params: {
  system: string;
  user: string;
  maxOutputTokens: number;
  timeoutMs: number;
}) => Promise<LlmCompletionResult>;

export const DEFAULT_MARIO_LLM_MODEL = "claude-haiku-4-5-20251001";

export function getMarioLlmModel(): string {
  return process.env.MARIO_LLM_MODEL?.trim() || DEFAULT_MARIO_LLM_MODEL;
}

export function isMarioLlmEnabled(): boolean {
  return process.env.MARIO_LLM_ENABLED === "true";
}

export function isMarioLlmShadowMode(): boolean {
  return process.env.MARIO_LLM_SHADOW_MODE === "true";
}

export type MarioLlmErrorReason = "no_api_key" | "http_error" | "timeout" | "network_error" | "empty_response";

export class MarioLlmError extends Error {
  readonly reason: MarioLlmErrorReason;
  constructor(reason: MarioLlmErrorReason, message: string) {
    super(message);
    this.name = "MarioLlmError";
    this.reason = reason;
  }
}

/** Implementazione di default: Anthropic Messages API, stesso schema di
 *  autenticazione già in produzione altrove nel repo. */
export const callAnthropicMario: LlmCompletion = async ({ system, user, maxOutputTokens, timeoutMs }) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new MarioLlmError("no_api_key", "ANTHROPIC_API_KEY non configurata.");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: getMarioLlmModel(),
        max_tokens: maxOutputTokens,
        system,
        messages: [{ role: "user", content: user }],
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new MarioLlmError("timeout", "Timeout chiamata LLM router Mario.");
    }
    throw new MarioLlmError("network_error", "Errore di rete verso il provider LLM.");
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new MarioLlmError("http_error", `Errore HTTP ${res.status} dal provider LLM.`);
  }

  const data = (await res.json()) as {
    content?: Array<{ text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const text = data.content?.map((b) => b.text ?? "").join("") ?? "";
  if (!text.trim()) throw new MarioLlmError("empty_response", "Risposta vuota dal provider LLM.");

  return {
    text,
    usage: {
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
    },
  };
};
