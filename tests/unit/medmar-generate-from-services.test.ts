import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import {
  MEDMAR_DEPARTURE_KINDS,
  isMedmarDepartureKind,
  buildGeneratedConvocationRows,
  type ServiceForConvocation,
} from "@/lib/medmar-generate-from-services";

// minimal E.164 normalizer for the pure-logic tests
function fakeNormalize(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, "");
  if (!/^\+?\d{8,15}$/.test(digits)) throw new Error("Numero non valido");
  return digits.startsWith("+") ? digits : `+39${digits}`;
}

function svc(p: Partial<ServiceForConvocation> & { service_id: string }): ServiceForConvocation {
  return {
    customer_name: "Mario Rossi",
    phone: "3334372831",
    phone_e164: null,
    hotel_name: "Hotel La Villa",
    pax: 2,
    pickup_time: "09:00",
    vessel_time: "11:10",
    booking_service_kind: "formula_medmar_napoli",
    ...p,
  };
}

const DATE = "2026-09-07"; // Monday

describe("MEDMAR departure kind classifier", () => {
  it("recognises only the two Formula MEDMAR kinds", () => {
    expect([...MEDMAR_DEPARTURE_KINDS]).toEqual(["formula_medmar_napoli", "formula_medmar_pozzuoli"]);
    expect(isMedmarDepartureKind("formula_medmar_napoli")).toBe(true);
    expect(isMedmarDepartureKind("formula_medmar_pozzuoli")).toBe(true);
  });
  it("3. excludes SNAV and everything else", () => {
    expect(isMedmarDepartureKind("formula_snav")).toBe(false);
    expect(isMedmarDepartureKind("transfer_train_hotel")).toBe(false);
    expect(isMedmarDepartureKind(null)).toBe(false);
  });
});

describe("buildGeneratedConvocationRows — service -> MEDMAR convocation row", () => {
  it("1/11. formats the departure date label from the requested day, keeps the canonical ISO", () => {
    const { rows } = buildGeneratedConvocationRows([svc({ service_id: "s1" })], DATE, fakeNormalize);
    expect(rows[0].travel_date).toBe("LUNEDÌ 07 SETTEMBRE");
    expect(rows[0].travel_date_iso).toBe("2026-09-07");
  });

  it("12/13. the date label never contains GMT / 1899 / a time", () => {
    const { rows } = buildGeneratedConvocationRows([svc({ service_id: "s1" })], DATE, fakeNormalize);
    expect(rows[0].travel_date).not.toMatch(/GMT/i);
    expect(rows[0].travel_date).not.toContain("1899");
    expect(rows[0].travel_date).not.toMatch(/\d{2}:\d{2}/);
    expect(rows[0].pickup_time).toBe("09:00");
    expect(rows[0].departure_time).toBe("11:10");
  });

  it("5/6/7/8/9/10. maps customer / phone / hotel / pax / pickup / ora nave", () => {
    const { rows } = buildGeneratedConvocationRows(
      [svc({ service_id: "s1", customer_name: "Ada Lovelace", phone: "3331112222", hotel_name: "Hotel Miramare", pax: 3, pickup_time: "07:20", vessel_time: "09:40" })],
      DATE,
      fakeNormalize,
    );
    const r = rows[0];
    expect(r.customer_name).toBe("Ada Lovelace");
    expect(r.phone_raw).toBe("3331112222");
    expect(r.phone_e164).toBe("+393331112222");
    expect(r.hotel).toBe("Hotel Miramare");
    expect(r.passengers).toBe("3");
    expect(r.pickup_time).toBe("07:20");
    expect(r.departure_time).toBe("09:40");
    expect(r.status).toBe("pronto");
  });

  it("14. a service without a phone -> numero_non_valido, readable reason (never dropped)", () => {
    const { rows, summary } = buildGeneratedConvocationRows([svc({ service_id: "s1", phone: "" })], DATE, fakeNormalize);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("numero_non_valido");
    expect(rows[0].error_message).toBe("Numero cliente mancante");
    expect(summary.toVerify).toBe(1);
    expect(summary.byReason["Numero cliente mancante"]).toBe(1);
  });

  it("an invalid phone -> numero_non_valido with the normalizer message", () => {
    const { rows } = buildGeneratedConvocationRows([svc({ service_id: "s1", phone: "12" })], DATE, fakeNormalize);
    expect(rows[0].status).toBe("numero_non_valido");
    expect(rows[0].error_message).toBe("Numero non valido");
  });

  it("15. a service without a pickup -> errore 'Ora prelevamento mancante'", () => {
    const { rows } = buildGeneratedConvocationRows([svc({ service_id: "s1", pickup_time: null })], DATE, fakeNormalize);
    expect(rows[0].status).toBe("errore");
    expect(rows[0].error_message).toBe("Ora prelevamento mancante");
  });

  it("missing hotel / pax / ora nave / nome each produce their own readable error", () => {
    const cases: Array<[Partial<ServiceForConvocation>, string]> = [
      [{ hotel_name: null }, "Hotel mancante"],
      [{ pax: null }, "Pax mancante"],
      [{ vessel_time: null }, "Ora nave mancante"],
      [{ customer_name: "  " }, "Nome cliente mancante"],
    ];
    for (const [patch, reason] of cases) {
      const { rows } = buildGeneratedConvocationRows([svc({ service_id: "s1", ...patch })], DATE, fakeNormalize);
      expect(rows[0].status).toBe("errore");
      expect(rows[0].error_message).toBe(reason);
    }
  });

  it("summary counts found / ready / toVerify", () => {
    const { summary } = buildGeneratedConvocationRows(
      [svc({ service_id: "a" }), svc({ service_id: "b" }), svc({ service_id: "c", phone: "" })],
      DATE,
      fakeNormalize,
    );
    expect(summary).toMatchObject({ found: 3, ready: 2, toVerify: 1 });
  });

  it("16. every row is shape-compatible with the MEDMAR preview + carries service_id", () => {
    const { rows } = buildGeneratedConvocationRows([svc({ service_id: "svc-123" })], DATE, fakeNormalize);
    const r = rows[0];
    for (const key of [
      "id", "row_index", "inviare", "phone_raw", "phone_e164", "customer_name",
      "travel_date", "hotel", "passengers", "pickup_time", "departure_time",
      "generated_message", "status", "error_message", "provider_message_id", "sent_at",
    ]) {
      expect(r, `missing ${key}`).toHaveProperty(key);
    }
    expect(r.id).toBe("svc-123");
    expect(r.service_id).toBe("svc-123");
    expect(r.inviare).toBe(true);
    expect(r.provider_message_id).toBeNull();
    expect(r.sent_at).toBeNull();
    expect(r.generated_message).toContain("Ciao Mario Rossi");
    expect(r.generated_message).toContain("LUNEDÌ 07 SETTEMBRE");
  });
});

// ── route-level: auth, MEDMAR-only query, SNAV exclusion, tenant isolation, no writes ──
const mocks = vi.hoisted(() => ({
  authorizePricingRequest: vi.fn(),
  normalizeE164: vi.fn((s: string) => {
    const d = s.replace(/\D/g, "");
    if (!/^\d{8,15}$/.test(d)) throw new Error("Numero non valido");
    return `+39${d}`;
  }),
  resolveOperationalTiming: vi.fn(),
}));

vi.mock("@/lib/server/pricing-auth", () => ({ authorizePricingRequest: mocks.authorizePricingRequest }));
vi.mock("@/lib/server/whatsapp", () => ({ normalizeE164: mocks.normalizeE164 }));
vi.mock("@/lib/operational-timing-resolver", () => ({ resolveOperationalTiming: mocks.resolveOperationalTiming }));

import { GET } from "@/app/api/ops/medmar-convocations/generate-from-services/route";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

type Call = { table: string; method: string; args: unknown[] };

function makeAdmin(tables: Record<string, unknown[]>, calls: Call[]) {
  const methods = ["select", "eq", "neq", "is", "in", "order", "limit", "maybeSingle", "insert", "update", "delete", "upsert"] as const;
  return {
    from(table: string) {
      const builder: Record<string, unknown> = {};
      for (const m of methods) builder[m] = (...a: unknown[]) => { calls.push({ table, method: m, args: a }); return builder; };
      (builder as { then: unknown }).then = (ok: (v: unknown) => unknown) =>
        Promise.resolve({ data: tables[table] ?? [], error: null }).then(ok);
      return builder;
    },
  } as never;
}

function authCtx(tenantId: string, admin: unknown, role = "operator") {
  return { admin, user: { id: "u1", email: "a@b.test" }, membership: { tenant_id: tenantId, role, suspended: false } };
}

function req(qs: string) {
  return new NextRequest(`http://localhost:3010/api/ops/medmar-convocations/generate-from-services${qs}`, { method: "GET" });
}

const svcRow = (over: Record<string, unknown>) => ({
  id: "s1", customer_name: "Mario", phone: "3334372831", phone_e164: null, pax: 2, hotel_id: "h1",
  booking_service_kind: "formula_medmar_napoli", direction: "departure", date: "2026-09-07", departure_date: "2026-09-07",
  departure_time: "11:10", time: "11:10", pickup_hotel: "09:00", pickup_time: null, orario_barca: "11:10",
  vessel: "MEDMAR Napoli", barca_compagnia: "Napoli Beverello", porto_bruno: null, meeting_point: null, status: "confirmed",
  ...over,
});

describe("GET /api/ops/medmar-convocations/generate-from-services", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveOperationalTiming.mockImplementation((s: { pickup_hotel?: string | null; orario_barca?: string | null }) => ({
      pickupTime: s.pickup_hotel ?? null,
      ferryTime: s.orario_barca ?? null,
      ferryCompany: null, ferryPort: null, pickupSource: "pickup_hotel",
      connectionTime: null, connectionType: "ferry", ruleSource: null, status: "ok", warnings: [],
    }));
  });

  it("401 from authorizePricingRequest is propagated", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "no" }, { status: 401 }));
    const res = await GET(req("?date=2026-09-07"));
    expect(res.status).toBe(401);
    expect(mocks.authorizePricingRequest).toHaveBeenCalledWith(expect.anything(), ["admin", "operator", "supervisor"]);
  });

  it("rejects a non-ISO date with 400", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(TENANT_A, makeAdmin({}, [])));
    const res = await GET(req("?date=07-09-2026"));
    expect(res.status).toBe(400);
  });

  it("1. a valid date returns rows + summary for the MEDMAR departures of that day", async () => {
    const calls: Call[] = [];
    const admin = makeAdmin({ hotels: [{ id: "h1", name: "Hotel La Villa" }], services: [svcRow({})] }, calls);
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(TENANT_A, admin, "supervisor"));

    const res = await GET(req("?date=2026-09-07"));
    const json = (await res.json()) as {
      ok: boolean; date: string;
      summary: { found: number; new: number; sent: number; changed: number; invalid: number };
      rows: Array<{ service_id: string; hotel: string; departure_time: string; pickup_time: string; status: string; coverage_status: string }>;
    };

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.date).toBe("2026-09-07");
    // SPRINT MEDMAR STEP 2: no prior successful send for this service_id -> coverage_status "new".
    expect(json.summary).toMatchObject({ found: 1, new: 1, sent: 0, changed: 0, invalid: 0 });
    expect(json.rows[0]).toMatchObject({ service_id: "s1", hotel: "Hotel La Villa", departure_time: "11:10", pickup_time: "09:00", status: "pronto", coverage_status: "new" });
  });

  it("2/3. queries services filtered to the two MEDMAR kinds only — SNAV never requested", async () => {
    const calls: Call[] = [];
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(TENANT_A, makeAdmin({ hotels: [], services: [] }, calls)));

    await GET(req("?date=2026-09-07"));

    const inCalls = calls.filter((c) => c.table === "services" && c.method === "in" && c.args[0] === "booking_service_kind");
    expect(inCalls.length).toBeGreaterThan(0);
    for (const c of inCalls) {
      expect(c.args[1]).toEqual(["formula_medmar_napoli", "formula_medmar_pozzuoli"]);
      expect(c.args[1]).not.toContain("formula_snav");
    }
  });

  it("4. every services/hotels query is scoped to the caller's tenant_id", async () => {
    const calls: Call[] = [];
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(TENANT_B, makeAdmin({ hotels: [], services: [] }, calls)));

    await GET(req("?date=2026-09-07"));

    const tenantCalls = calls.filter((c) => c.method === "eq" && c.args[0] === "tenant_id");
    expect(tenantCalls.length).toBeGreaterThan(0);
    expect(tenantCalls.every((c) => c.args[1] === TENANT_B)).toBe(true);
    for (const table of ["hotels", "services"]) {
      expect(calls.some((c) => c.table === table && c.method === "eq" && c.args[0] === "tenant_id")).toBe(true);
    }
  });

  it("9. never mutates: no insert/update/delete/upsert (SPRINT MEDMAR STEP 2 adds a read-only medmar_convocation_rows lookup for coverage)", async () => {
    const calls: Call[] = [];
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(TENANT_A, makeAdmin({ hotels: [{ id: "h1", name: "H" }], services: [svcRow({})] }, calls)));

    await GET(req("?date=2026-09-07"));

    expect(calls.some((c) => ["insert", "update", "delete", "upsert"].includes(c.method))).toBe(false);
    expect([...new Set(calls.map((c) => c.table))].sort()).toEqual(["hotels", "medmar_convocation_rows", "services"]);
  });
});
