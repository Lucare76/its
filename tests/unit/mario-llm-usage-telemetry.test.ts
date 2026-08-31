import { describe, it, expect, beforeEach, vi } from "vitest";

const persist = vi.fn();
vi.mock("@/lib/server/mario-assistant/usage-log", () => ({
  persistMarioLlmUsage: (...args: unknown[]) => persist(...args),
}));

import { logMarioLlmRoute, type MarioLlmRouteLogInput } from "@/lib/server/mario-assistant/telemetry";

function base(over: Partial<MarioLlmRouteLogInput> = {}): MarioLlmRouteLogInput {
  return {
    tenantId: "tenant-a",
    userId: "user-1",
    requestId: "req-1",
    role: "operator",
    step: 0,
    decision: { action: "fallback" },
    usage: null,
    fallbackUsed: false,
    latencyMs: 42,
    ...over,
  };
}

beforeEach(() => {
  persist.mockReset();
  vi.spyOn(console, "info").mockImplementation(() => {});
});

describe("logMarioLlmRoute → persistMarioLlmUsage (§16)", () => {
  it("§24 Caso C: usage presente + invalid_schema → persistito con failed=false e token reali", () => {
    logMarioLlmRoute(base({ usage: { inputTokens: 3168, outputTokens: 252 }, fallbackUsed: true, fallbackReason: "invalid_schema", decision: { action: "fallback" } }));
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist.mock.calls[0]![0]).toMatchObject({ failed: false, inputTokens: 3168, outputTokens: 252, fallbackUsed: true });
  });

  it("§24 Caso D: nessun usage + timeout → persistito failed=true, 0 token", () => {
    logMarioLlmRoute(base({ usage: null, fallbackUsed: true, fallbackReason: "timeout" }));
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist.mock.calls[0]![0]).toMatchObject({ failed: true, inputTokens: 0, outputTokens: 0 });
  });

  it("no_api_key (nessuna chiamata al provider) → NON persistito", () => {
    logMarioLlmRoute(base({ usage: null, fallbackUsed: true, fallbackReason: "no_api_key" }));
    expect(persist).not.toHaveBeenCalled();
  });

  it("shadow mode → NON persistito (diagnostico, non è una chiamata AI dell'utente)", () => {
    logMarioLlmRoute(base({ usage: { inputTokens: 100, outputTokens: 10 }, shadow: true }));
    expect(persist).not.toHaveBeenCalled();
  });

  it("decisione valida con usage → persistito con l'action corretta", () => {
    logMarioLlmRoute(base({ decision: { action: "tool_call", tool_name: "its.preview_create_booking_group", arguments: {} }, usage: { inputTokens: 900, outputTokens: 40 } }));
    expect(persist.mock.calls[0]![0]).toMatchObject({ action: "tool_call", failed: false, inputTokens: 900 });
  });
});
