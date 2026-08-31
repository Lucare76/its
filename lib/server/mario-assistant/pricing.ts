/**
 * FASE A.2 — tariffe LLM per il cost tracking dell'Assistente Mario.
 *
 * SERVER-ONLY. I prezzi non stanno mai in NEXT_PUBLIC_* (§8) né hardcodati
 * nella business logic. Ordine di risoluzione delle tariffe:
 *   1. env MARIO_LLM_INPUT_USD_PER_MILLION / MARIO_LLM_OUTPUT_USD_PER_MILLION
 *      (entrambe presenti e numeri finiti >= 0);
 *   2. mappa condivisa AI_PRICING[model] (lib/ai-pricing.ts, già usata
 *      dall'import prenotazioni);
 *   3. nessuna → costo = null (UI mostra i token, mai un costo inventato).
 *
 * I costi calcolati vengono PERSISTITI sulla riga mario_llm_usage: gli
 * aggregati sono poi semplici SUM di valori già memorizzati (nessun ricalcolo,
 * le righe storiche mantengono la tariffa applicata al momento).
 */
import { AI_PRICING } from "@/lib/ai-pricing";

export type MarioLlmRates = { inputPerMillion: number; outputPerMillion: number };

export type MarioLlmCost = {
  inputCostUsd: number;
  outputCostUsd: number;
  totalCostUsd: number;
};

function parseRateEnv(raw: string | undefined): number | null {
  if (raw == null || raw.trim() === "") return null; // env vuota = non configurata
  const n = Number(raw.trim());
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Tariffe correnti per il modello, o null se non configurate da nessuna fonte. */
export function resolveMarioLlmRates(model: string): MarioLlmRates | null {
  const envIn = parseRateEnv(process.env.MARIO_LLM_INPUT_USD_PER_MILLION);
  const envOut = parseRateEnv(process.env.MARIO_LLM_OUTPUT_USD_PER_MILLION);
  if (envIn != null && envOut != null) {
    return { inputPerMillion: envIn, outputPerMillion: envOut };
  }
  const mapped = AI_PRICING[model];
  if (mapped) return { inputPerMillion: mapped.input, outputPerMillion: mapped.output };
  return null;
}

/** true se esiste una tariffa applicabile al modello (per il segnale UI). */
export function isMarioLlmPricingConfigured(model: string): boolean {
  return resolveMarioLlmRates(model) !== null;
}

/**
 * Costo di UNA chiamata. Ritorna null se le tariffe non sono configurate
 * (§8: non bloccare Mario, registra comunque i token, costo = null).
 * Precisione piena: nessun arrotondamento qui (§9).
 */
export function calcMarioLlmCost(model: string, inputTokens: number, outputTokens: number): MarioLlmCost | null {
  const rates = resolveMarioLlmRates(model);
  if (!rates) return null;
  const inSafe = Math.max(0, Math.trunc(inputTokens || 0));
  const outSafe = Math.max(0, Math.trunc(outputTokens || 0));
  const inputCostUsd = (inSafe / 1_000_000) * rates.inputPerMillion;
  const outputCostUsd = (outSafe / 1_000_000) * rates.outputPerMillion;
  return { inputCostUsd, outputCostUsd, totalCostUsd: inputCostUsd + outputCostUsd };
}
