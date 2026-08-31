import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const inserted: Array<Record<string, unknown>> = [];
let insertBehavior: "ok" | "throw" = "ok";

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => ({
      insert: (row: Record<string, unknown>) => {
        if (insertBehavior === "throw") return Promise.reject(new Error("db down"));
        inserted.push(row);
        return Promise.resolve({ data: null, error: null });
      },
    }),
  }),
}));

import { persistMarioLlmUsage } from "@/lib/server/mario-assistant/usage-log";

beforeEach(() => {
  inserted.length = 0;
  insertBehavior = "ok";
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://x.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "svc-key");
  vi.stubEnv("MARIO_LLM_INPUT_USD_PER_MILLION", "1");
  vi.stubEnv("MARIO_LLM_OUTPUT_USD_PER_MILLION", "5");
});
afterEach(() => vi.unstubAllEnvs());

const base = {
  tenantId: "tenant-a",
  userId: "user-1",
  requestId: "req-1",
  model: "claude-haiku-4-5-20251001",
  fallbackUsed: false,
};

describe("persistMarioLlmUsage — §10 dati salvati", () => {
  it("chiamata normale: token + costi calcolati, nessun campo sensibile", async () => {
    await persistMarioLlmUsage({ ...base, action: "tool_call", inputTokens: 1000, outputTokens: 200, latencyMs: 120 });
    expect(inserted).toHaveLength(1);
    const row = inserted[0]!;
    expect(row).toMatchObject({
      tenant_id: "tenant-a",
      user_id: "user-1",
      request_id: "req-1",
      model: "claude-haiku-4-5-20251001",
      action: "tool_call",
      fallback_used: false,
      failed: false,
      input_tokens: 1000,
      output_tokens: 200,
      latency_ms: 120,
    });
    expect(Number(row.total_cost_usd)).toBeCloseTo(0.002, 10);
    // §25 — MAI prompt/response/token/PII
    const keys = Object.keys(row).join(",");
    expect(keys).not.toMatch(/prompt|response|answer|message|confirmation|api_key|phone|customer|email/i);
  });

  it("§16 Caso D: failed=true → 0 token, costi null, nessun costo inventato", async () => {
    await persistMarioLlmUsage({ ...base, failed: true, fallbackUsed: true, inputTokens: 999, outputTokens: 999 });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ failed: true, input_tokens: 0, output_tokens: 0, input_cost_usd: null, output_cost_usd: null, total_cost_usd: null });
  });

  it("§17 non-failed ma 0 token (provider non chiamato) → nessuna riga", async () => {
    await persistMarioLlmUsage({ ...base, inputTokens: 0, outputTokens: 0 });
    expect(inserted).toHaveLength(0);
  });

  it("§8 tariffe non configurate → riga con token ma costi null", async () => {
    vi.stubEnv("MARIO_LLM_INPUT_USD_PER_MILLION", "");
    vi.stubEnv("MARIO_LLM_OUTPUT_USD_PER_MILLION", "");
    await persistMarioLlmUsage({ ...base, model: "modello-mai-visto", inputTokens: 500, outputTokens: 50 });
    expect(inserted[0]).toMatchObject({ input_tokens: 500, total_cost_usd: null });
  });

  it("§19 insert che fallisce non propaga: Mario continua", async () => {
    insertBehavior = "throw";
    await expect(persistMarioLlmUsage({ ...base, inputTokens: 100, outputTokens: 10 })).resolves.toBeUndefined();
  });
});
