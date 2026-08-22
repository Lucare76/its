import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  authorizePricingRequest: vi.fn(),
}));

vi.mock("@/lib/server/pricing-auth", () => ({
  authorizePricingRequest: mocks.authorizePricingRequest,
}));

import { GET } from "@/app/api/services/medmar-delivery-summary/route";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function makeRequest() {
  return new NextRequest("http://localhost:3010/api/services/medmar-delivery-summary", { method: "GET" });
}

type QueryResult = { data: unknown[] | null; error: unknown };
type CallSpy = (table: string, method: string, args: unknown[]) => void;

/**
 * Query builder "thenable" minimale: ogni metodo restituisce lo stesso
 * oggetto (chainable) e l'oggetto stesso e' awaitable via .then() —
 * la route reale termina la catena in punti diversi per tabella
 * (.eq per medmar_delivery_attempts, .limit per medmar_issuing_attempts,
 * .ilike per services), quindi il mock deve restare risolvibile a
 * qualunque punto della catena, non solo all'ultimo metodo chiamato.
 */
function makeQueryBuilder(result: QueryResult, onCall: (method: string, args: unknown[]) => void) {
  const methods = ["select", "eq", "neq", "gte", "lte", "ilike", "order", "limit"] as const;
  const builder: Record<string, unknown> = {};
  for (const method of methods) {
    builder[method] = (...args: unknown[]) => {
      onCall(method, args);
      return builder;
    };
  }
  builder.then = (onFulfilled: (v: QueryResult) => unknown, onRejected?: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(onFulfilled, onRejected);
  return builder;
}

function makeAuthContext(
  tenantId: string,
  tables: { delivery?: unknown[]; issuing?: unknown[]; services?: unknown[] },
  errors: { delivery?: unknown; issuing?: unknown; services?: unknown } = {},
  callSpy?: CallSpy
) {
  return {
    admin: {
      from(table: string) {
        if (table === "medmar_delivery_attempts") {
          return makeQueryBuilder({ data: tables.delivery ?? [], error: errors.delivery ?? null }, (m, a) => callSpy?.(table, m, a));
        }
        if (table === "medmar_issuing_attempts") {
          return makeQueryBuilder({ data: tables.issuing ?? [], error: errors.issuing ?? null }, (m, a) => callSpy?.(table, m, a));
        }
        if (table === "services") {
          return makeQueryBuilder({ data: tables.services ?? [], error: errors.services ?? null }, (m, a) => callSpy?.(table, m, a));
        }
        throw new Error(`tabella inattesa: ${table}`);
      },
    } as never,
    user: { id: "user-1", email: "a@b.test" },
    membership: { tenant_id: tenantId, role: "operator", suspended: false },
  };
}

describe("GET /api/services/medmar-delivery-summary — coda + Credito e fabbisogno Medmar (sola lettura)", () => {
  const originalManualCredit = process.env.MEDMAR_MANUAL_CREDIT_CENTS;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalManualCredit === undefined) delete process.env.MEDMAR_MANUAL_CREDIT_CENTS;
    else process.env.MEDMAR_MANUAL_CREDIT_CENTS = originalManualCredit;
  });

  it("1. sessione non autorizzata -> la route propaga la 401 di authorizePricingRequest, nessuna query eseguita", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Sessione non valida." }, { status: 401 }));

    const res = await GET(makeRequest());

    expect(res.status).toBe(401);
    expect(mocks.authorizePricingRequest).toHaveBeenCalledWith(expect.anything(), ["admin", "operator", "supervisor"]);
  });

  it("2. sessione autorizzata -> filtra sempre per tenant_id del membership su TUTTE e tre le tabelle (tenant isolation)", async () => {
    const calls: Array<{ table: string; method: string; args: unknown[] }> = [];
    mocks.authorizePricingRequest.mockResolvedValue(
      makeAuthContext(TENANT_A, {}, {}, (table, method, args) => calls.push({ table, method, args }))
    );

    const res = await GET(makeRequest());
    const json = (await res.json()) as { ok: boolean; tenant_id?: string };

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.tenant_id).toBe(TENANT_A);

    for (const table of ["medmar_delivery_attempts", "medmar_issuing_attempts", "services"]) {
      const tenantEqCall = calls.find((c) => c.table === table && c.method === "eq" && c.args[0] === "tenant_id");
      expect(tenantEqCall?.args[1]).toBe(TENANT_A);
    }
  });

  it("3. tenant diverso -> filtro applicato con l'altro tenant_id su tutte le tabelle, nessuna fuoriuscita cross-tenant", async () => {
    const calls: Array<{ table: string; method: string; args: unknown[] }> = [];
    mocks.authorizePricingRequest.mockResolvedValue(
      makeAuthContext(TENANT_B, {}, {}, (table, method, args) => calls.push({ table, method, args }))
    );

    await GET(makeRequest());

    const tenantCalls = calls.filter((c) => c.method === "eq" && c.args[0] === "tenant_id");
    expect(tenantCalls.every((c) => c.args[1] === TENANT_B)).toBe(true);
    expect(tenantCalls.some((c) => c.args[1] === TENANT_A)).toBe(false);
  });

  it("4. la risposta espone solo conteggi/importi/metadati minimi: nessun campo pdf/token/contenuto email/segreto", async () => {
    process.env.MEDMAR_MANUAL_CREDIT_CENTS = "100000";
    mocks.authorizePricingRequest.mockResolvedValue(
      makeAuthContext(TENANT_A, {
        delivery: [
          {
            id: "row-1",
            issuing_attempt_id: "issuing-1",
            status: "delivered",
            created_at: "2026-08-22T08:00:00.000Z",
            updated_at: "2026-08-22T08:05:00.000Z",
            delivered_at: "2026-08-22T08:05:00.000Z",
            medmar_numero: "MED-123",
            last_error_code: null,
          },
        ],
        issuing: [{ id: "issuing-1", status: "completed", completed_at: "2026-08-22T07:55:00.000Z", final_total_cents: 5000, service_ids: ["svc-1"] }],
      })
    );

    const res = await GET(makeRequest());
    const json = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    const serialized = JSON.stringify(json);
    expect(serialized).not.toContain("pdf_base64");
    expect(serialized).not.toContain("resend_message_id");
    expect(serialized).not.toContain("recipient_email");
    expect(serialized).not.toContain("MEDMAR_MANUAL_CREDIT_CENTS");
    expect(serialized).not.toMatch(/bearer|jwt|token/i);
    expect(json).toHaveProperty("today");
    expect(json).toHaveProperty("queue");
    expect(json).toHaveProperty("activity");
    expect(json).toHaveProperty("forecast");
    expect(json).toHaveProperty("credit");
    expect(json).toHaveProperty("credit_evaluation");
  });

  it("5. errore Supabase su una qualunque delle tre query -> 500 generico, nessun dettaglio interno esposto", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(TENANT_A, {}, { services: { message: "connection reset" } }));

    const res = await GET(makeRequest());
    const json = (await res.json()) as { ok: boolean; error?: string };

    expect(res.status).toBe(500);
    expect(json.ok).toBe(false);
    expect(json.error).not.toContain("connection reset");
  });

  it("6. importo emesso oggi: activity.issued_today_amount_cents somma i final_total_cents delle emissioni completate", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(
      makeAuthContext(TENANT_A, {
        issuing: [
          { id: "i1", status: "completed", completed_at: new Date().toISOString(), final_total_cents: 3000, service_ids: ["s1"] },
          { id: "i2", status: "completed", completed_at: new Date().toISOString(), final_total_cents: 4500, service_ids: ["s2"] },
        ],
      })
    );

    const res = await GET(makeRequest());
    const json = (await res.json()) as { activity: { issued_today_count: number; issued_today_amount_cents: number } };

    expect(json.activity.issued_today_count).toBe(2);
    expect(json.activity.issued_today_amount_cents).toBe(7500);
  });

  it("7. ultimo importo emesso: activity.last_issued_amount_cents riflette l'emissione completed_at piu' recente", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(
      makeAuthContext(TENANT_A, {
        issuing: [
          { id: "old", status: "completed", completed_at: "2026-08-01T07:00:00.000Z", final_total_cents: 1111, service_ids: [] },
          { id: "new", status: "completed", completed_at: "2026-08-22T09:00:00.000Z", final_total_cents: 8800, service_ids: [] },
        ],
      })
    );

    const res = await GET(makeRequest());
    const json = (await res.json()) as { activity: { last_issued_amount_cents: number | null } };

    expect(json.activity.last_issued_amount_cents).toBe(8800);
  });

  it("8. stima prossimi 3 giorni: forecast.upcoming_3d_estimated_tickets deduplica andata+ritorno per pratica", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(
      makeAuthContext(TENANT_A, {
        issuing: [{ id: "i1", status: "completed", completed_at: "2026-08-20T07:00:00.000Z", final_total_cents: 5000, service_ids: [] }],
        services: [
          { id: "svc-arrivo", customer_name: "Mario Rossi", notes: "[practice:PR-1]" },
          { id: "svc-partenza", customer_name: "Mario Rossi", notes: "[practice:PR-1]" },
        ],
      })
    );

    const res = await GET(makeRequest());
    const json = (await res.json()) as { forecast: { upcoming_3d_estimated_tickets: number; upcoming_3d_amount_source: string } };

    expect(json.forecast.upcoming_3d_estimated_tickets).toBe(1);
    expect(json.forecast.upcoming_3d_amount_source).toBe("historical_average");
  });

  it("9. importo prossimi 3 giorni non calcolabile se manca lo storico -> null, source 'unavailable'", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(
      makeAuthContext(TENANT_A, {
        issuing: [],
        services: [{ id: "svc-1", customer_name: "Mario Rossi", notes: null }],
      })
    );

    const res = await GET(makeRequest());
    const json = (await res.json()) as { forecast: { upcoming_3d_estimated_amount_cents: number | null; upcoming_3d_amount_source: string } };

    expect(json.forecast.upcoming_3d_estimated_amount_cents).toBeNull();
    expect(json.forecast.upcoming_3d_amount_source).toBe("unavailable");
  });

  it("10. credito NON inventato se MEDMAR_MANUAL_CREDIT_CENTS non e' configurata -> 'unavailable', credit_evaluation 'unknown'", async () => {
    delete process.env.MEDMAR_MANUAL_CREDIT_CENTS;
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(TENANT_A, {}));

    const res = await GET(makeRequest());
    const json = (await res.json()) as { credit: { type: string; available_cents: number | null }; credit_evaluation: { status: string } };

    expect(json.credit).toEqual({ type: "unavailable", available_cents: null, as_of: null });
    expect(json.credit_evaluation.status).toBe("unknown");
  });

  it("11. credito manuale/stimato se MEDMAR_MANUAL_CREDIT_CENTS e' configurata -> 'manual_estimated', mai 'real' (nessuna integrazione reale oggi)", async () => {
    process.env.MEDMAR_MANUAL_CREDIT_CENTS = "500000";
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(TENANT_A, {}));

    const res = await GET(makeRequest());
    const json = (await res.json()) as { credit: { type: string; available_cents: number | null } };

    expect(json.credit.type).toBe("manual_estimated");
    expect(json.credit.available_cents).toBe(500000);
  });

  it("12. credit_evaluation 'sufficient' quando il credito manuale copre ampiamente la stima", async () => {
    process.env.MEDMAR_MANUAL_CREDIT_CENTS = "1000000"; // 10.000 EUR
    mocks.authorizePricingRequest.mockResolvedValue(
      makeAuthContext(TENANT_A, {
        issuing: [{ id: "i1", status: "completed", completed_at: "2026-08-20T07:00:00.000Z", final_total_cents: 5000, service_ids: [] }],
        services: [{ id: "svc-1", customer_name: "Mario Rossi", notes: null }],
      })
    );

    const res = await GET(makeRequest());
    const json = (await res.json()) as { credit_evaluation: { status: string } };

    expect(json.credit_evaluation.status).toBe("sufficient");
  });

  it("13. credit_evaluation 'insufficient' quando il credito manuale e' sotto la stima", async () => {
    process.env.MEDMAR_MANUAL_CREDIT_CENTS = "1000"; // 10 EUR
    mocks.authorizePricingRequest.mockResolvedValue(
      makeAuthContext(TENANT_A, {
        issuing: [{ id: "i1", status: "completed", completed_at: "2026-08-20T07:00:00.000Z", final_total_cents: 50000, service_ids: [] }],
        services: [{ id: "svc-1", customer_name: "Mario Rossi", notes: null }],
      })
    );

    const res = await GET(makeRequest());
    const json = (await res.json()) as { credit_evaluation: { status: string; shortfall_cents: number | null } };

    expect(json.credit_evaluation.status).toBe("insufficient");
    expect(json.credit_evaluation.shortfall_cents).toBeGreaterThan(0);
  });

  it("14. nessuna chiamata a lock/booking/payment: il mock admin espone solo from() verso tabelle di sola lettura, nessun altro metodo e' invocato", async () => {
    const seenTables: string[] = [];
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(TENANT_A, {}, {}, (table) => seenTables.push(table)));

    await GET(makeRequest());

    const uniqueTables = [...new Set(seenTables)];
    expect(uniqueTables.sort()).toEqual(["medmar_delivery_attempts", "medmar_issuing_attempts", "services"]);
  });
});
