import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Test dell'helper condiviso lib/server/api-error.ts (sanitizedErrorResponse).
 *
 * Questo helper NON è ancora usato da alcuna route (rollout futuro, fuori
 * scope di questo task): i test esercitano solo l'helper in isolamento,
 * verificando che replichi esattamente il pattern già validato nelle route
 * SEC-06 (catch → auditLog(details.message) → NextResponse.json(fallback)).
 */

const mocks = vi.hoisted(() => ({
  auditLog: vi.fn(),
}));

vi.mock("@/lib/server/ops-audit", () => ({
  auditLog: mocks.auditLog,
}));

import { sanitizedErrorResponse } from "@/lib/server/api-error";

const RICH_RAW_ERROR =
  'duplicate key value violates unique constraint "services_pkey" on relation "services", column "id" SQLSTATE=23505';

describe("sanitizedErrorResponse", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("1. Error('duplicate key...') -> body contiene solo il fallback", async () => {
    const res = sanitizedErrorResponse(new Error(RICH_RAW_ERROR), { status: 500, fallback: "Errore interno." });
    const body = await res.json();

    expect(body).toEqual({ error: "Errore interno." });
  });

  it("2. raw message assente dal body", async () => {
    const res = sanitizedErrorResponse(new Error(RICH_RAW_ERROR), { status: 500, fallback: "Errore interno." });
    const rawText = await res.clone().text();

    expect(rawText).not.toContain("duplicate key");
  });

  it("3. constraint name assente dal body", async () => {
    const res = sanitizedErrorResponse(new Error(RICH_RAW_ERROR), { status: 500, fallback: "Errore interno." });
    const rawText = await res.clone().text();

    expect(rawText).not.toContain("services_pkey");
  });

  it("4. table name assente dal body", async () => {
    const res = sanitizedErrorResponse(new Error(RICH_RAW_ERROR), { status: 500, fallback: "Errore interno." });
    const rawText = await res.clone().text();

    expect(rawText).not.toContain("relation");
  });

  it("5. column name assente dal body", async () => {
    const res = sanitizedErrorResponse(new Error(RICH_RAW_ERROR), { status: 500, fallback: "Errore interno." });
    const rawText = await res.clone().text();

    expect(rawText).not.toContain('column "id"');
  });

  it("6. details/hint/code assenti dal body", async () => {
    const res = sanitizedErrorResponse(
      { message: RICH_RAW_ERROR, details: "internal detail", hint: "internal hint", code: "23505" },
      { status: 500, fallback: "Errore interno." }
    );
    const body = await res.json();

    expect(body).not.toHaveProperty("details");
    expect(body).not.toHaveProperty("hint");
    expect(body).not.toHaveProperty("code");
    expect(body).not.toHaveProperty("stack");
  });

  it("7. status HTTP preservato", async () => {
    expect(sanitizedErrorResponse(new Error("x"), { status: 404, fallback: "Non trovato." }).status).toBe(404);
    expect(sanitizedErrorResponse(new Error("x"), { status: 409, fallback: "Conflitto." }).status).toBe(409);
    expect(sanitizedErrorResponse(new Error("x"), { status: 500, fallback: "Errore." }).status).toBe(500);
  });

  it("8. default field 'error'", async () => {
    const res = sanitizedErrorResponse(new Error("x"), { status: 500, fallback: "Errore interno." });
    const body = await res.json();

    expect(body).toEqual({ error: "Errore interno." });
    expect(Object.keys(body)).toEqual(["error"]);
  });

  it("9. override field 'message'", async () => {
    const res = sanitizedErrorResponse(new Error("x"), { status: 500, fallback: "Errore interno.", field: "message" });
    const body = await res.json();

    expect(body).toEqual({ message: "Errore interno." });
    expect(Object.keys(body)).toEqual(["message"]);
  });

  it("10. fallback unicode/italiano preservato esattamente", async () => {
    const res = sanitizedErrorResponse(new Error("x"), { status: 500, fallback: "Impossibile completare l'operazione più tardi." });
    const body = await res.json();

    expect(body.error).toBe("Impossibile completare l'operazione più tardi.");
  });

  it("11. Error standard loggato server-side con message estratto", async () => {
    sanitizedErrorResponse(new Error(RICH_RAW_ERROR), { status: 500, fallback: "x", event: "test_event" });

    expect(mocks.auditLog).toHaveBeenCalledTimes(1);
    expect(mocks.auditLog.mock.calls[0][0].details.message).toBe(RICH_RAW_ERROR);
  });

  it("12. errore Supabase-like { message, ... } loggato con message estratto", async () => {
    sanitizedErrorResponse(
      { message: RICH_RAW_ERROR, code: "23505", details: "d", hint: "h" },
      { status: 500, fallback: "x", event: "test_event" }
    );

    expect(mocks.auditLog).toHaveBeenCalledTimes(1);
    expect(mocks.auditLog.mock.calls[0][0].details.message).toBe(RICH_RAW_ERROR);
  });

  it("13. string error gestita", async () => {
    sanitizedErrorResponse("plain string error", { status: 500, fallback: "x", event: "test_event" });

    expect(mocks.auditLog.mock.calls[0][0].details.message).toBe("plain string error");
  });

  it("14. null gestito senza throw", async () => {
    expect(() => sanitizedErrorResponse(null, { status: 500, fallback: "x", event: "test_event" })).not.toThrow();
    expect(mocks.auditLog.mock.calls[0][0].details.message).toBe("null");
  });

  it("15. undefined gestito senza throw", async () => {
    expect(() => sanitizedErrorResponse(undefined, { status: 500, fallback: "x", event: "test_event" })).not.toThrow();
    expect(mocks.auditLog.mock.calls[0][0].details.message).toBe("undefined");
  });

  it("16. unknown object gestito senza throw e senza serializzazione raw nel body", async () => {
    const weird = { foo: "bar", nested: { a: 1 } };
    const res = sanitizedErrorResponse(weird, { status: 500, fallback: "Errore interno.", event: "test_event" });
    const body = await res.json();

    expect(body).toEqual({ error: "Errore interno." });
    expect(mocks.auditLog.mock.calls[0][0].details.message).toContain("[object Object]");
  });

  it("17. event presente -> auditLog invocato esattamente una volta", () => {
    sanitizedErrorResponse(new Error("x"), { status: 500, fallback: "x", event: "some_event" });

    expect(mocks.auditLog).toHaveBeenCalledTimes(1);
  });

  it("18. event assente -> auditLog non invocato", () => {
    sanitizedErrorResponse(new Error("x"), { status: 500, fallback: "x" });

    expect(mocks.auditLog).not.toHaveBeenCalled();
  });

  it("19. tenantId inoltrato ad auditLog", () => {
    sanitizedErrorResponse(new Error("x"), { status: 500, fallback: "x", event: "e", tenantId: "tenant-123" });

    expect(mocks.auditLog.mock.calls[0][0].tenantId).toBe("tenant-123");
  });

  it("20. serviceId inoltrato ad auditLog", () => {
    sanitizedErrorResponse(new Error("x"), { status: 500, fallback: "x", event: "e", serviceId: "service-456" });

    expect(mocks.auditLog.mock.calls[0][0].serviceId).toBe("service-456");
  });

  it("21. custom details inoltrati ad auditLog insieme al message", () => {
    sanitizedErrorResponse(new Error("x"), {
      status: 500,
      fallback: "x",
      event: "e",
      details: { stage: "insert", attempt: 2 },
    });

    const logged = mocks.auditLog.mock.calls[0][0];
    expect(logged.details.stage).toBe("insert");
    expect(logged.details.attempt).toBe(2);
    expect(logged.details.message).toBe("x");
  });

  it("22. custom details NON finiscono nel body della risposta", async () => {
    const res = sanitizedErrorResponse(new Error("x"), {
      status: 500,
      fallback: "Errore interno.",
      event: "e",
      details: { stage: "insert", secretInternalId: "abc-123" },
    });
    const body = await res.json();

    expect(body).toEqual({ error: "Errore interno." });
    expect(JSON.stringify(body)).not.toContain("secretInternalId");
  });

  it("23. auditLog che rifiuta una promise -> response comunque restituita, nessun throw", async () => {
    mocks.auditLog.mockReturnValue(Promise.reject(new Error("audit backend down")));

    let res: ReturnType<typeof sanitizedErrorResponse> | undefined;
    expect(() => {
      res = sanitizedErrorResponse(new Error("x"), { status: 500, fallback: "Errore interno.", event: "e" });
    }).not.toThrow();

    const body = await res!.json();
    expect(body).toEqual({ error: "Errore interno." });

    // drain microtask queue so the rejection handler attaches before the test ends
    await new Promise((r) => setTimeout(r, 0));
  });

  it("24. auditLog che lancia sincrono -> response comunque restituita, nessun throw", async () => {
    mocks.auditLog.mockImplementation(() => {
      throw new Error("audit sync failure");
    });

    let res: ReturnType<typeof sanitizedErrorResponse> | undefined;
    expect(() => {
      res = sanitizedErrorResponse(new Error("x"), { status: 500, fallback: "Errore interno.", event: "e" });
    }).not.toThrow();

    const body = await res!.json();
    expect(body).toEqual({ error: "Errore interno." });
  });

  it("25. nessun unhandled rejection generato dal caso 23", async () => {
    const unhandled: unknown[] = [];
    const handler = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", handler);

    mocks.auditLog.mockReturnValue(Promise.reject(new Error("audit backend down")));
    sanitizedErrorResponse(new Error("x"), { status: 500, fallback: "x", event: "e" });

    await new Promise((r) => setTimeout(r, 10));
    process.off("unhandledRejection", handler);

    expect(unhandled).toEqual([]);
  });

  it("26. nessun raw object serializzato nel body per errori oggetto complessi", async () => {
    const res = sanitizedErrorResponse(
      { message: RICH_RAW_ERROR, code: "23505", details: "detail-x", hint: "hint-y", stack: "at foo()" },
      { status: 500, fallback: "Errore interno." }
    );
    const rawText = await res.clone().text();

    expect(rawText).toBe(JSON.stringify({ error: "Errore interno." }));
  });

  it("27. response JSON shape esatta (solo il field richiesto, nessuna chiave extra)", async () => {
    const res = sanitizedErrorResponse(new Error("x"), { status: 500, fallback: "Errore interno.", field: "message", event: "e", details: { a: 1 } });
    const body = await res.json();

    expect(body).toEqual({ message: "Errore interno." });
  });

  it("28. helper importabile ed eseguibile in isolamento (server-only, nessuna dipendenza client)", () => {
    expect(typeof sanitizedErrorResponse).toBe("function");
    const res = sanitizedErrorResponse(new Error("x"), { status: 418, fallback: "teapot" });
    expect(res.status).toBe(418);
  });

  it("29. nessuna mutazione globale: options passate non vengono modificate", () => {
    const details = { stage: "insert" };
    const options = { status: 500, fallback: "x", event: "e", details };
    sanitizedErrorResponse(new Error("x"), options);

    expect(options.details).toBe(details);
    expect(details).toEqual({ stage: "insert" });
  });

  it("30. chiamate multiple indipendenti non si influenzano a vicenda", async () => {
    const res1 = sanitizedErrorResponse(new Error("first"), { status: 400, fallback: "Primo errore.", event: "evt_1" });
    const res2 = sanitizedErrorResponse(new Error("second"), { status: 500, fallback: "Secondo errore.", field: "message", event: "evt_2" });

    expect(res1.status).toBe(400);
    expect(res2.status).toBe(500);
    expect(await res1.json()).toEqual({ error: "Primo errore." });
    expect(await res2.json()).toEqual({ message: "Secondo errore." });
    expect(mocks.auditLog).toHaveBeenCalledTimes(2);
    expect(mocks.auditLog.mock.calls[0][0].event).toBe("evt_1");
    expect(mocks.auditLog.mock.calls[0][0].details.message).toBe("first");
    expect(mocks.auditLog.mock.calls[1][0].event).toBe("evt_2");
    expect(mocks.auditLog.mock.calls[1][0].details.message).toBe("second");
  });
});
