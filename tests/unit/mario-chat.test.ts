import { describe, it, expect } from "vitest";
import {
  addTurnToSession,
  emptySessionBucket,
  formatTokens,
  formatUsd,
  hasPendingConfirmation,
  trimHistory,
  type MarioChatMessage,
} from "@/lib/mario-chat";

const asst = (over: Partial<MarioChatMessage>): MarioChatMessage => ({
  id: over.id ?? "a",
  role: "assistant",
  text: over.text ?? "x",
  ts: 0,
  ...over,
});
const user = (id: string): MarioChatMessage => ({ id, role: "user", text: "hi", ts: 0 });

describe("mario-chat — formatUsd (§9/§14)", () => {
  it("importo minuscolo: almeno 4-5 decimali", () => {
    expect(formatUsd(0.00012)).toBe("$0.000120");
    expect(formatUsd(0.00012, { compact: true })).toBe("$0.0001");
    expect(formatUsd(0.002)).toBe("$0.00200"); // <0.01 non-compact → 5 decimali
  });
  it("aggregati: 2-4 decimali in compact", () => {
    expect(formatUsd(0.4218, { compact: true })).toBe("$0.422");
    expect(formatUsd(12.5, { compact: true })).toBe("$12.50");
  });
  it("zero e null", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(null)).toBeNull();
    expect(formatUsd(undefined)).toBeNull();
    expect(formatUsd(Number.NaN)).toBeNull();
  });
});

describe("mario-chat — formatTokens", () => {
  it("separatore migliaia", () => {
    expect(formatTokens(18420)).toBe("18.420");
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(null)).toBe("0");
  });
});

describe("mario-chat — hasPendingConfirmation", () => {
  it("true se l'ultimo turno assistente è mario_llm_pending_confirmation", () => {
    expect(hasPendingConfirmation([user("u"), asst({ intent: "mario_llm_pending_confirmation" })])).toBe(true);
  });
  it("false dopo la conferma (ultimo turno = confirmed)", () => {
    expect(
      hasPendingConfirmation([
        asst({ id: "1", intent: "mario_llm_pending_confirmation" }),
        user("u2"),
        asst({ id: "2", intent: "mario_llm_confirmed" }),
      ]),
    ).toBe(false);
  });
  it("ignora i turni assistente ancora pending", () => {
    expect(hasPendingConfirmation([asst({ intent: "mario_llm_pending_confirmation", pending: true })])).toBe(false);
  });
});

describe("mario-chat — trimHistory (§3)", () => {
  it("taglia ai piu' recenti", () => {
    const msgs = Array.from({ length: 40 }, (_, i) => user(`u${i}`));
    expect(trimHistory(msgs, 30)).toHaveLength(30);
    expect(trimHistory(msgs, 30)[0]!.id).toBe("u10");
  });
});

describe("mario-chat — addTurnToSession (§13)", () => {
  it("somma i turni con chiamata LLM", () => {
    let s = emptySessionBucket();
    s = addTurnToSession(s, { llmCalled: true, calls: 1, model: "m", inputTokens: 1000, outputTokens: 200, costUsd: 0.002, fallbackUsed: false });
    s = addTurnToSession(s, { llmCalled: true, calls: 2, model: "m", inputTokens: 500, outputTokens: 50, costUsd: 0.001, fallbackUsed: true });
    expect(s).toEqual({ calls: 3, inputTokens: 1500, outputTokens: 250, costUsd: 0.003 });
  });
  it("ignora i turni senza chiamata LLM (fast-path)", () => {
    const s0 = { calls: 1, inputTokens: 10, outputTokens: 2, costUsd: 0.0001 };
    expect(addTurnToSession(s0, null)).toBe(s0);
    expect(addTurnToSession(s0, { llmCalled: false } as never)).toBe(s0);
  });
  it("costUsd null (tariffe assenti) non inventa un costo", () => {
    let s = { calls: 1, inputTokens: 10, outputTokens: 2, costUsd: 0.0001 };
    s = addTurnToSession(s, { llmCalled: true, calls: 1, model: "m", inputTokens: 5, outputTokens: 1, costUsd: null, fallbackUsed: false });
    expect(s).toEqual({ calls: 2, inputTokens: 15, outputTokens: 3, costUsd: 0.0001 });
  });
});
