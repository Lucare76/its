import { describe, it, expect, afterEach, vi } from "vitest";
import { calcMarioLlmCost, resolveMarioLlmRates, isMarioLlmPricingConfigured } from "@/lib/server/mario-assistant/pricing";

afterEach(() => vi.unstubAllEnvs());

describe("calcMarioLlmCost — §9/§24 Caso A", () => {
  it("tariffe test input=1/M output=5/M, 1000 in + 200 out → total 0.002", () => {
    vi.stubEnv("MARIO_LLM_INPUT_USD_PER_MILLION", "1");
    vi.stubEnv("MARIO_LLM_OUTPUT_USD_PER_MILLION", "5");
    const c = calcMarioLlmCost("qualsiasi-modello", 1000, 200);
    expect(c).not.toBeNull();
    expect(c!.inputCostUsd).toBeCloseTo(0.001, 12);
    expect(c!.outputCostUsd).toBeCloseTo(0.001, 12);
    expect(c!.totalCostUsd).toBeCloseTo(0.002, 12);
  });

  it("env override ha priorità sulla mappa AI_PRICING", () => {
    vi.stubEnv("MARIO_LLM_INPUT_USD_PER_MILLION", "2");
    vi.stubEnv("MARIO_LLM_OUTPUT_USD_PER_MILLION", "10");
    expect(resolveMarioLlmRates("claude-haiku-4-5-20251001")).toEqual({ inputPerMillion: 2, outputPerMillion: 10 });
  });

  it("senza env usa AI_PRICING per il modello noto (haiku 4.5 = 1/5)", () => {
    expect(resolveMarioLlmRates("claude-haiku-4-5-20251001")).toEqual({ inputPerMillion: 1, outputPerMillion: 5 });
    expect(isMarioLlmPricingConfigured("claude-haiku-4-5-20251001")).toBe(true);
  });

  it("§8 modello sconosciuto e nessuna env → null (mai un costo inventato)", () => {
    expect(resolveMarioLlmRates("modello-mai-visto")).toBeNull();
    expect(calcMarioLlmCost("modello-mai-visto", 1000, 200)).toBeNull();
    expect(isMarioLlmPricingConfigured("modello-mai-visto")).toBe(false);
  });

  it("env parziale (solo input) non è configurazione valida → fallback mappa/null", () => {
    vi.stubEnv("MARIO_LLM_INPUT_USD_PER_MILLION", "3");
    expect(resolveMarioLlmRates("modello-mai-visto")).toBeNull();
  });

  it("precisione: non arrotonda presto (valori molto piccoli)", () => {
    vi.stubEnv("MARIO_LLM_INPUT_USD_PER_MILLION", "1");
    vi.stubEnv("MARIO_LLM_OUTPUT_USD_PER_MILLION", "5");
    const c = calcMarioLlmCost("m", 12, 3);
    expect(c!.totalCostUsd).toBeCloseTo(12 / 1_000_000 + (3 / 1_000_000) * 5, 15);
  });
});
