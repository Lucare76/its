import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import {
  SNAV_DEPARTURE_KINDS,
  isSnavDepartureKind,
  buildGeneratedSnavConvocationRows,
  type ServiceForSnavConvocation,
} from "@/lib/snav-generate-from-services";

// minimal E.164 normalizer for the pure-logic tests
function fakeNormalize(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, "");
  if (!/^\+?\d{8,15}$/.test(digits)) throw new Error("Numero non valido");
  return digits.startsWith("+") ? digits : `+39${digits}`;
}

function svc(p: Partial<ServiceForSnavConvocation> & { service_id: string }): ServiceForSnavConvocation {
  return {
    customer_name: "Mario Rossi",
    phone: "3334372831",
    hotel_name: "Hotel La Villa",
    pax: 2,
    pickup_time: "06:30",
    vessel_time: "07:10",
    booking_service_kind: "formula_snav",
    ...p,
  };
}

const DATE = "2026-09-07"; // Monday

describe("1/6. SNAV departure kind classifier — excludes everything but formula_snav", () => {
  it("recognises only formula_snav", () => {
    expect([...SNAV_DEPARTURE_KINDS]).toEqual(["formula_snav"]);
    expect(isSnavDepartureKind("formula_snav")).toBe(true);
  });
  it("excludes MEDMAR and everything else", () => {
    expect(isSnavDepartureKind("formula_medmar_napoli")).toBe(false);
    expect(isSnavDepartureKind("formula_medmar_pozzuoli")).toBe(false);
    expect(isSnavDepartureKind("transfer_train_hotel")).toBe(false);
    expect(isSnavDepartureKind(null)).toBe(false);
  });
});

describe("buildGeneratedSnavConvocationRows — service -> SNAV convocation row", () => {
  it("10. formats the departure date label from the requested day, no GMT/1899/timestamp", () => {
    const { rows } = buildGeneratedSnavConvocationRows([svc({ service_id: "s1" })], DATE, fakeNormalize);
    expect(rows[0].departure_date_label).toBe("LUNEDÌ 07 SETTEMBRE");
    expect(rows[0].departure_date_label).not.toMatch(/GMT/i);
    expect(rows[0].departure_date_label).not.toContain("1899");
    expect(rows[0].vessel_time).toBe("07:10");
  });

  it("5. maps customer / phone / hotel / pax / pickup / ora nave from the service", () => {
    const { rows } = buildGeneratedSnavConvocationRows(
      [svc({ service_id: "s1", customer_name: "Ada Lovelace", phone: "3331112222", hotel_name: "Hotel Miramare", pax: 3, pickup_time: "06:15", vessel_time: "07:10" })],
      DATE,
      fakeNormalize,
    );
    const r = rows[0];
    expect(r.customer_name).toBe("Ada Lovelace");
    expect(r.phone_raw).toBe("3331112222");
    expect(r.phone_e164).toBe("+393331112222");
    expect(r.hotel).toBe("Hotel Miramare");
    expect(r.passengers).toBe("3");
    expect(r.pickup_time).toBe("06:15");
    expect(r.vessel_time).toBe("07:10");
    expect(r.status).toBe("pronto");
  });

  it("5/6. phone_e164 comes exclusively from normalizing services.phone — no services.phone_e164 dependency", () => {
    const { rows } = buildGeneratedSnavConvocationRows([svc({ service_id: "s1", phone: "3334372831" })], DATE, fakeNormalize);
    expect(rows[0].phone_raw).toBe("3334372831");
    expect(rows[0].phone_e164).toBe("+393334372831");
    expect(Object.prototype.hasOwnProperty.call(svc({ service_id: "s1" }), "phone_e164")).toBe(false);
  });

  it("a service without a phone -> numero_non_valido, readable reason (never dropped)", () => {
    const { rows, summary } = buildGeneratedSnavConvocationRows([svc({ service_id: "s1", phone: "" })], DATE, fakeNormalize);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("numero_non_valido");
    expect(rows[0].error_message).toBe("Numero cliente mancante");
    expect(summary.toVerify).toBe(1);
  });

  it("missing hotel / pax / ora nave / pickup / nome each produce their own readable error", () => {
    const cases: Array<[Partial<ServiceForSnavConvocation>, string]> = [
      [{ hotel_name: null }, "Hotel mancante"],
      [{ pax: null }, "Pax mancante"],
      [{ pickup_time: null }, "Ora prelevamento mancante"],
      [{ vessel_time: null }, "Ora nave mancante"],
      [{ customer_name: "  " }, "Nome cliente mancante"],
    ];
    for (const [patch, reason] of cases) {
      const { rows } = buildGeneratedSnavConvocationRows([svc({ service_id: "s1", ...patch })], DATE, fakeNormalize);
      expect(rows[0].status).toBe("errore");
      expect(rows[0].error_message).toBe(reason);
    }
  });

  it("22. summary counts found / ready / toVerify", () => {
    const { summary } = buildGeneratedSnavConvocationRows(
      [svc({ service_id: "a" }), svc({ service_id: "b" }), svc({ service_id: "c", phone: "" })],
      DATE,
      fakeNormalize,
    );
    expect(summary).toMatchObject({ found: 3, ready: 2, toVerify: 1 });
  });

  it("every row carries service_id and is shape-compatible with the SNAV preview", () => {
    const { rows } = buildGeneratedSnavConvocationRows([svc({ service_id: "svc-123" })], DATE, fakeNormalize);
    const r = rows[0];
    for (const key of [
      "id", "row_index", "inviare", "phone_raw", "phone_e164", "customer_name",
      "departure_date_label", "hotel", "passengers", "pickup_time", "vessel_time",
      "generated_message", "status", "error_message", "provider_message_id", "sent_at",
    ]) {
      expect(r, `missing ${key}`).toHaveProperty(key);
    }
    expect(r.id).toBe("svc-123");
    expect(r.service_id).toBe("svc-123");
    expect(r.generated_message).toContain("Gentile Mario Rossi");
    expect(r.generated_message).toContain("LUNEDÌ 07 SETTEMBRE");
  });
});

// ── route-level: auth, SNAV-only query, MEDMAR exclusion, tenant isolation, no writes, A/R duplicate fix, pickup fallback ──
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

import { GET } from "@/app/api/ops/snav-convocations/generate-from-services/route";

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
  return new NextRequest(`http://localhost:3010/api/ops/snav-convocations/generate-from-services${qs}`, { method: "GET" });
}

const svcRow = (over: Record<string, unknown>) => ({
  id: "s1", tenant_id: TENANT_A, customer_name: "Mario", phone: "3334372831", pax: 2, hotel_id: "h1",
  booking_service_kind: "formula_snav", direction: "departure", date: "2026-09-07", departure_date: "2026-09-07",
  departure_time: "07:10", time: "07:10", pickup_hotel: "06:30", pickup_time: null, orario_barca: "07:10",
  vessel: "SNAV", barca_compagnia: "Napoli", porto_bruno: null, meeting_point: null, status: "confirmed",
  billing_party_name: "ALESTE VIAGGI",
  is_draft: false,
  ...over,
});

describe("GET /api/ops/snav-convocations/generate-from-services", () => {
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

  it("1. a valid date returns rows + summary (new coverage) for the SNAV departures of that day", async () => {
    const calls: Call[] = [];
    const admin = makeAdmin({ hotels: [{ id: "h1", name: "Hotel La Villa" }], services: [svcRow({})] }, calls);
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(TENANT_A, admin, "supervisor"));

    const res = await GET(req("?date=2026-09-07"));
    const json = (await res.json()) as {
      ok: boolean; date: string;
      summary: { found: number; new: number; sent: number; changed: number; invalid: number };
      rows: Array<{ service_id: string; hotel: string; vessel_time: string; pickup_time: string; status: string; coverage_status: string }>;
    };

    expect(res.status).toBe(200);
    expect(json.summary).toMatchObject({ found: 1, new: 1, sent: 0, changed: 0, invalid: 0 });
    expect(json.rows[0]).toMatchObject({ service_id: "s1", hotel: "Hotel La Villa", vessel_time: "07:10", pickup_time: "06:30", status: "pronto", coverage_status: "new" });
  });

  it("2/6. queries services filtered to formula_snav only — MEDMAR never requested", async () => {
    const calls: Call[] = [];
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(TENANT_A, makeAdmin({ hotels: [], services: [] }, calls)));

    await GET(req("?date=2026-09-07"));

    const inCalls = calls.filter((c) => c.table === "services" && c.method === "in" && c.args[0] === "booking_service_kind");
    expect(inCalls.length).toBeGreaterThan(0);
    for (const c of inCalls) {
      expect(c.args[1]).toEqual(["formula_snav"]);
      expect(c.args[1]).not.toContain("formula_medmar_napoli");
    }
  });

  it("every services/hotels query is scoped to the caller's tenant_id", async () => {
    const calls: Call[] = [];
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(TENANT_B, makeAdmin({ hotels: [], services: [] }, calls)));

    await GET(req("?date=2026-09-07"));

    const tenantCalls = calls.filter((c) => c.method === "eq" && c.args[0] === "tenant_id");
    expect(tenantCalls.length).toBeGreaterThan(0);
    expect(tenantCalls.every((c) => c.args[1] === TENANT_B)).toBe(true);
  });

  it("never mutates: no insert/update/delete/upsert (coverage adds a read-only snav_convocation_rows lookup)", async () => {
    const calls: Call[] = [];
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(TENANT_A, makeAdmin({ hotels: [{ id: "h1", name: "H" }], services: [svcRow({})] }, calls)));

    await GET(req("?date=2026-09-07"));

    expect(calls.some((c) => ["insert", "update", "delete", "upsert"].includes(c.method))).toBe(false);
    expect([...new Set(calls.map((c) => c.table))].sort()).toEqual(["hotels", "services", "snav_convocation_rows"]);
  });
});

// ── fix: round-trip bookings must not produce a duplicate convocation (same fix as MEDMAR §2) ──
type Predicate = { method: "eq" | "neq" | "is" | "in"; column: string; value: unknown };

function makeFilteringAdmin(servicesRows: Record<string, unknown>[], hotelsRows: Record<string, unknown>[]) {
  return {
    from(table: string) {
      const predicates: Predicate[] = [];
      const builder: Record<string, unknown> = {};
      const chain = (method: Predicate["method"]) => (column: string, value: unknown) => {
        predicates.push({ method, column, value });
        return builder;
      };
      builder.select = () => builder;
      builder.eq = chain("eq");
      builder.neq = chain("neq");
      builder.is = chain("is");
      builder.in = chain("in");
      builder.order = () => builder;
      builder.limit = () => builder;
      builder.maybeSingle = () => Promise.resolve({ data: null, error: null });
      (builder as { then: unknown }).then = (ok: (v: unknown) => unknown) => {
        let rows: Record<string, unknown>[] = table === "services" ? servicesRows : table === "hotels" ? hotelsRows : [];
        for (const p of predicates) {
          rows = rows.filter((r) => {
            const actual = r[p.column];
            if (p.method === "eq") return actual === p.value;
            if (p.method === "neq") return actual !== p.value;
            if (p.method === "is") return actual === p.value;
            if (p.method === "in") return Array.isArray(p.value) && (p.value as unknown[]).includes(actual);
            return true;
          });
        }
        return Promise.resolve({ data: rows, error: null }).then(ok);
      };
      return builder;
    },
  } as never;
}

describe("fix: SNAV generation excludes the arrival leg of round-trip bookings", () => {
  const DATE2 = "2026-08-30";
  const HOTELS = [{ id: "h1", tenant_id: TENANT_A, name: "Hotel Aurora", zone: "Ischia" }];

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveOperationalTiming.mockImplementation((s: { pickup_hotel?: string | null; orario_barca?: string | null }) => ({
      pickupTime: s.pickup_hotel ?? null,
      ferryTime: s.orario_barca ?? null,
      ferryCompany: null, ferryPort: null, pickupSource: "pickup_hotel",
      connectionTime: null, connectionType: "ferry", ruleSource: null, status: "ok", warnings: [],
    }));
  });

  it("2. arrival leg (also carrying departure_date) + departure leg -> exactly 1 convocation, the departure one", async () => {
    const admin = makeFilteringAdmin(
      [
        svcRow({ id: "arr-1", direction: "arrival", departure_date: DATE2, date: DATE2 }),
        svcRow({ id: "dep-1", direction: "departure", departure_date: DATE2, date: DATE2 }),
      ],
      HOTELS,
    );
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(TENANT_A, admin));

    const res = await GET(req(`?date=${DATE2}`));
    const json = (await res.json()) as { rows: Array<{ service_id: string }> };

    expect(json.rows).toHaveLength(1);
    expect(json.rows[0].service_id).toBe("dep-1");
  });

  it("4. two real distinct departure services for the same customer -> 2 convocations, never merged", async () => {
    const admin = makeFilteringAdmin(
      [
        svcRow({ id: "dep-a", direction: "departure", departure_date: DATE2, date: DATE2, customer_name: "Anna Bianchi", pax: 2 }),
        svcRow({ id: "dep-b", direction: "departure", departure_date: DATE2, date: DATE2, customer_name: "Anna Bianchi", pax: 1 }),
      ],
      HOTELS,
    );
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(TENANT_A, admin));

    const res = await GET(req(`?date=${DATE2}`));
    const json = (await res.json()) as { rows: Array<{ service_id: string }> };

    expect(json.rows).toHaveLength(2);
    expect(json.rows.map((r) => r.service_id).sort()).toEqual(["dep-a", "dep-b"]);
  });

  it("3. fallback query still includes departure_date=null / date=selected / direction=departure rows", async () => {
    const admin = makeFilteringAdmin(
      [svcRow({ id: "dep-fallback", direction: "departure", departure_date: null, date: DATE2 })],
      HOTELS,
    );
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(TENANT_A, admin));

    const res = await GET(req(`?date=${DATE2}`));
    const json = (await res.json()) as { rows: Array<{ service_id: string }> };

    expect(json.rows).toHaveLength(1);
    expect(json.rows[0].service_id).toBe("dep-fallback");
  });

  it("an arrival-only row that carries departure_date is excluded entirely", async () => {
    const admin = makeFilteringAdmin(
      [svcRow({ id: "arr-only", direction: "arrival", departure_date: DATE2, date: DATE2 })],
      HOTELS,
    );
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(TENANT_A, admin));

    const res = await GET(req(`?date=${DATE2}`));
    const json = (await res.json()) as { rows: Array<{ service_id: string }> };

    expect(json.rows).toHaveLength(0);
  });
});

// ── SNAV pickup falls back to the canonical Domain-B rule (applyPickupCalc) ──
describe("7/8/9/10. SNAV pickup uses the canonical Domain-B rule as a read-only fallback when nothing is persisted", () => {
  const DATE3 = "2026-08-30";
  // Real canonical row (lib/departure-pickup-rules.ts): snav, t_from 07:10,
  // zona forio -> pickup 06:20.
  const HOTELS = [{ id: "h1", tenant_id: TENANT_A, name: "Hotel Forio", zone: "Forio" }];

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveOperationalTiming.mockImplementation((s: { pickup_hotel?: string | null; orario_barca?: string | null }) => ({
      pickupTime: s.pickup_hotel ?? null,
      ferryTime: s.orario_barca ?? null,
      ferryCompany: null, ferryPort: null, pickupSource: "pickup_hotel",
      connectionTime: null, connectionType: "ferry", ruleSource: null, status: "ok", warnings: [],
    }));
  });

  it("7. a persisted pickup_hotel is used as-is — the canonical fallback is never consulted", async () => {
    const admin = makeFilteringAdmin(
      [svcRow({ id: "s-persisted", pickup_hotel: "05:00", orario_barca: "07:10", hotel_id: "h1", departure_date: DATE3, date: DATE3 })],
      HOTELS,
    );
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(TENANT_A, admin));

    const res = await GET(req(`?date=${DATE3}`));
    const json = (await res.json()) as { rows: Array<{ pickup_time: string; vessel_time: string }> };

    expect(json.rows[0].pickup_time).toBe("05:00");
    expect(json.rows[0].vessel_time).toBe("07:10");
  });

  it("8. no persisted pickup, but the canonical Domain-B SNAV rule matches -> pickup is read from it", async () => {
    const admin = makeFilteringAdmin(
      [svcRow({ id: "s-canonical", pickup_hotel: null, pickup_time: null, orario_barca: "07:10", hotel_id: "h1", departure_date: DATE3, date: DATE3 })],
      HOTELS,
    );
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(TENANT_A, admin));

    const res = await GET(req(`?date=${DATE3}`));
    const json = (await res.json()) as { rows: Array<{ pickup_time: string; status: string }> };

    expect(json.rows[0].pickup_time).toBe("06:20");
    expect(json.rows[0].status).toBe("pronto");
  });

  it("9. no persisted pickup and no matching canonical rule (hotel has no zone) -> stays invalid, no time invented", async () => {
    const admin = makeFilteringAdmin(
      [svcRow({ id: "s-no-source", pickup_hotel: null, pickup_time: null, orario_barca: "07:10", hotel_id: "h2", departure_date: DATE3, date: DATE3 })],
      [...HOTELS, { id: "h2", tenant_id: TENANT_A, name: "Hotel Senza Zona", zone: null }],
    );
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(TENANT_A, admin));

    const res = await GET(req(`?date=${DATE3}`));
    const json = (await res.json()) as { rows: Array<{ pickup_time: string; status: string; error_message: string | null; coverage_status: string }> };

    expect(json.rows[0].pickup_time).toBe("");
    expect(json.rows[0].status).toBe("errore");
    expect(json.rows[0].error_message).toBe("Ora prelevamento mancante");
    expect(json.rows[0].coverage_status).toBe("invalid");
  });

  it("10. the vessel/ora nave time is unaffected by the pickup fallback", async () => {
    const admin = makeFilteringAdmin(
      [svcRow({ id: "s-canonical-2", pickup_hotel: null, pickup_time: null, orario_barca: "07:10", hotel_id: "h1", departure_date: DATE3, date: DATE3 })],
      HOTELS,
    );
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(TENANT_A, admin));

    const res = await GET(req(`?date=${DATE3}`));
    const json = (await res.json()) as { rows: Array<{ vessel_time: string }> };

    expect(json.rows[0].vessel_time).toBe("07:10");
  });
});
