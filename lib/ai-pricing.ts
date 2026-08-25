/**
 * Prezzi modelli AI (USD per 1M token) — fonte: Anthropic pricing corrente.
 * Aggiorna questa mappa se cambia il modello usato in produzione
 * (vedi MODEL in lib/server/pdf-extract-haiku.ts).
 */
export const AI_PRICING: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5-20251001": { input: 1.0, output: 5.0 },
  "claude-haiku-4-5": { input: 1.0, output: 5.0 }
};

/**
 * Tasso di cambio USD → EUR usato solo per la visualizzazione in dashboard.
 * Approssimativo e statico (nessuna dipendenza da un servizio FX esterno):
 * aggiornalo manualmente se si scosta troppo dal cambio reale.
 */
export const USD_TO_EUR_RATE = 0.92;

export function calcAiCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = AI_PRICING[model];
  if (!pricing) throw new Error(`Prezzo non configurato per modello: ${model}`);
  return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
}

export function usdToEur(usd: number): number {
  return usd * USD_TO_EUR_RATE;
}
