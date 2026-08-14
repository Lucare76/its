import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Pre-push fix — test per GET /api/ops/search (ricerca ITS / dispatch).
 *
 * Il commit baee11a aveva sostituito la select esplicita con select("*"),
 * ridotto i campi di ricerca da ~20 a 5, degradato la ricerca a token a
 * customer_name soltanto, e azzerato phone_e164 in risposta. Questi test
 * coprono il ripristino: campi di ricerca completi, nessuna ILIKE su id
 * (uuid, cercato con .eq esatto), phone_e164 reale in risposta, nessun
 * select("*"), nessun fetch non paginato.
 */

type Row = Record<string, unknown>;

function splitTopLevelClauses(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of input) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  return parts;
}

function fieldMatches(row: Row, field: string, op: string, rawValue: string): boolean {
  if (op === "ilike") {
    const value = row[field];
    if (typeof value !== "string") return false;
    const needle = rawValue.replace(/^%/, "").replace(/%$/, "").toLowerCase();
    return value.toLowerCase().includes(needle);
  }
  if (op === "eq") return String(row[field] ?? "") === rawValue;
  if (op === "is") {
    const isNull = row[field] === null || row[field] === undefined;
    return rawValue === "null" ? isNull : String(row[field]) === rawValue;
  }
  return false;
}

function evalOrClause(row: Row, clause: string): boolean {
  const match = clause.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\.(eq|is|ilike)\.(.*)$/);
  if (!match) return false;
  const [, field, op, rawValue] = match;
  return fieldMatches(row, field, op, rawValue);
}

function selectBuilder(rows: Row[]) {
  let filtered = rows;
  const builder = {
    eq(field: string, value: unknown) {
      filtered = filtered.filter((r) => String(r[field] ?? "") === String(value));
      return builder;
    },
    ilike(field: string, pattern: string) {
      filtered = filtered.filter((r) => fieldMatches(r, field, "ilike", pattern));
      return builder;
    },
    is(field: string, value: null) {
      filtered = filtered.filter((r) => fieldMatches(r, field, "is", value === null ? "null" : String(value)));
      return builder;
    },
    in(field: string, values: unknown[]) {
      const set = new Set(values.map(String));
      filtered = filtered.filter((r) => set.has(String(r[field])));
      return builder;
    },
    or(filterStr: string) {
      const clauses = splitTopLevelClauses(filterStr);
      filtered = filtered.filter((r) => clauses.some((clause) => evalOrClause(r, clause)));
      return builder;
    },
    order() {
      return builder;
    },
    limit(n: number) {
      filtered = filtered.slice(0, n);
      return builder;
    },
    then(resolve: (v: { data: Row[]; error: null }) => unknown, reject?: (e: unknown) => unknown) {
      return Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
    },
  };
  return builder;
}

function createFakeAdmin(seed: Partial<Record<string, Row[]>> = {}) {
  const tables: Record<string, Row[]> = {
    services: [],
    hotels: [],
    agencies: [],
    ferry_schedules: [],
    ferry_pickup_rules: [],
    ...seed,
  };
  const admin = {
    from(table: string) {
      return { select: () => selectBuilder(tables[table] ?? []) };
    },
  };
  return { admin, tables };
}

const mocks = vi.hoisted(() => ({
  authorizePricingRequest: vi.fn(),
}));

vi.mock("@/lib/server/pricing-auth", () => ({
  authorizePricingRequest: mocks.authorizePricingRequest,
}));

import { GET } from "@/app/api/ops/search/route";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function authorizeAs(admin: ReturnType<typeof createFakeAdmin>["admin"], tenantId = TENANT_A) {
  mocks.authorizePricingRequest.mockResolvedValue({
    admin,
    user: { id: "user-1", email: "op@test.dev" },
    membership: { tenant_id: tenantId, role: "operator", suspended: false },
  });
}

function service(id: string, tenantId: string, overrides: Row = {}): Row {
  return {
    id,
    tenant_id: tenantId,
    inbound_email_id: null,
    is_draft: false,
    customer_name: "Cliente Test",
    customer_first_name: null,
    customer_last_name: null,
    customer_email: null,
    phone: null,
    phone_e164: null,
    date: "2026-08-20",
    time: "10:00",
    status: "new",
    direction: "arrival",
    pax: 2,
    vessel: null,
    booking_service_kind: null,
    service_type: null,
    service_type_code: null,
    arrival_date: null,
    arrival_time: null,
    train_arrival_time: null,
    departure_date: null,
    departure_time: null,
    train_departure_time: null,
    orario_barca: null,
    pickup_time: null,
    transport_code: null,
    transport_code_return: null,
    transport_reference_outward: null,
    transport_reference_return: null,
    train_arrival_number: null,
    train_departure_number: null,
    bus_city_origin: null,
    hotel_id: null,
    billing_party_name: null,
    agency_id: null,
    meeting_point: null,
    pickup_hotel: null,
    tour_name: null,
    excursion_title: null,
    notes: null,
    linked_service_id: null,
    created_at: "2026-08-01T09:00:00Z",
    ...overrides,
  };
}

function callGet(qs: string) {
  return GET(new NextRequest(`http://localhost:3010/api/ops/search${qs}`));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/ops/search — campi di ricerca ripristinati", () => {
  it("cerca per nome cliente (customer_name)", async () => {
    const fake = createFakeAdmin({ services: [service("s1", TENANT_A, { customer_name: "Mario Rossi" })] });
    authorizeAs(fake.admin);
    const body = await (await callGet("?q=Mario")).json();
    expect(body.ok).toBe(true);
    expect(body.results.map((r: Row) => r.id)).toEqual(["s1"]);
  });

  it("cerca 'Nome Cognome' via customer_first_name + customer_last_name (token search)", async () => {
    const fake = createFakeAdmin({
      services: [
        service("s1", TENANT_A, { customer_name: null, customer_first_name: "Luca", customer_last_name: "Renna" }),
        service("s2", TENANT_A, { customer_name: "Altro Cliente" }),
      ],
    });
    authorizeAs(fake.admin);
    const body = await (await callGet("?q=Luca Renna")).json();
    expect(body.results.map((r: Row) => r.id)).toContain("s1");
    expect(body.results.map((r: Row) => r.id)).not.toContain("s2");
  });

  it("cerca per telefono (phone)", async () => {
    const fake = createFakeAdmin({ services: [service("s1", TENANT_A, { phone: "3331234567" })] });
    authorizeAs(fake.admin);
    const body = await (await callGet("?q=3331234567")).json();
    expect(body.results.map((r: Row) => r.id)).toEqual(["s1"]);
  });

  it("cerca per telefono normalizzato (phone_e164), assente da phone", async () => {
    const fake = createFakeAdmin({
      services: [service("s1", TENANT_A, { phone: "0392 111222", phone_e164: "+393331112222" })],
    });
    authorizeAs(fake.admin);
    const body = await (await callGet("?q=3331112222")).json();
    expect(body.results.map((r: Row) => r.id)).toEqual(["s1"]);
  });

  it("cerca per email cliente", async () => {
    const fake = createFakeAdmin({ services: [service("s1", TENANT_A, { customer_email: "mario@example.com" })] });
    authorizeAs(fake.admin);
    const body = await (await callGet("?q=mario@example.com")).json();
    expect(body.results.map((r: Row) => r.id)).toEqual(["s1"]);
  });

  it("cerca per transport_code", async () => {
    const fake = createFakeAdmin({ services: [service("s1", TENANT_A, { transport_code: "AZ123" })] });
    authorizeAs(fake.admin);
    const body = await (await callGet("?q=AZ123")).json();
    expect(body.results.map((r: Row) => r.id)).toEqual(["s1"]);
  });

  it("cerca per service_type", async () => {
    const fake = createFakeAdmin({ services: [service("s1", TENANT_A, { service_type: "bus_tour" })] });
    authorizeAs(fake.admin);
    const body = await (await callGet("?q=bus_tour")).json();
    expect(body.results.map((r: Row) => r.id)).toEqual(["s1"]);
  });

  it("cerca nel campo notes", async () => {
    const fake = createFakeAdmin({ services: [service("s1", TENANT_A, { notes: "Cliente VIP, richiede seggiolino" })] });
    authorizeAs(fake.admin);
    const body = await (await callGet("?q=seggiolino")).json();
    expect(body.results.map((r: Row) => r.id)).toEqual(["s1"]);
  });

  it("cerca per hotel: risolve l'hotel per nome poi filtra i servizi per hotel_id", async () => {
    const fake = createFakeAdmin({
      services: [service("s1", TENANT_A, { hotel_id: "hotel-1" })],
      hotels: [{ id: "hotel-1", name: "Hotel Ischia Palace", zone: "porto", tenant_id: TENANT_A }],
    });
    authorizeAs(fake.admin);
    const body = await (await callGet("?q=Ischia Palace")).json();
    expect(body.results.map((r: Row) => r.id)).toEqual(["s1"]);
    expect(body.results[0].hotel_name).toBe("Hotel Ischia Palace");
  });
});

describe("GET /api/ops/search — UUID id", () => {
  const VALID_UUID = "11111111-2222-4333-8444-555555555555";

  it("UUID valido: trova il servizio con quell'id esatto", async () => {
    const fake = createFakeAdmin({ services: [service(VALID_UUID, TENANT_A)] });
    authorizeAs(fake.admin);
    const body = await (await callGet(`?q=${VALID_UUID}`)).json();
    expect(body.results.map((r: Row) => r.id)).toEqual([VALID_UUID]);
  });

  it("testo non-UUID non genera ILIKE su id: una sottostringa dell'id non basta a trovarlo", async () => {
    const fake = createFakeAdmin({
      services: [service(VALID_UUID, TENANT_A, { customer_name: "Nessuna corrispondenza testuale" })],
    });
    authorizeAs(fake.admin);
    // "2222" è una sottostringa dell'id ma il termine non è un UUID valido:
    // prima della regressione .id.ilike l'avrebbe trovato, ora non deve.
    const body = await (await callGet("?q=2222")).json();
    expect(body.results).toEqual([]);
  });
});

describe("GET /api/ops/search — nessun risultato e isolamento tenant", () => {
  it("nessuna corrispondenza: results vuoto, nessun errore", async () => {
    const fake = createFakeAdmin({ services: [service("s1", TENANT_A, { customer_name: "Mario Rossi" })] });
    authorizeAs(fake.admin);
    const body = await (await callGet("?q=zzznessunmatchzzz")).json();
    expect(body.ok).toBe(true);
    expect(body.results).toEqual([]);
  });

  it("isolamento tenant: un servizio del tenant B non compare per il tenant A", async () => {
    const fake = createFakeAdmin({
      services: [
        service("s-a", TENANT_A, { customer_name: "Stesso Nome" }),
        service("s-b", TENANT_B, { customer_name: "Stesso Nome" }),
      ],
    });
    authorizeAs(fake.admin, TENANT_A);
    const body = await (await callGet("?q=Stesso Nome")).json();
    const ids = body.results.map((r: Row) => r.id);
    expect(ids).toContain("s-a");
    expect(ids).not.toContain("s-b");
  });
});

describe("GET /api/ops/search — risposta conserva phone_e164", () => {
  it("restituisce il valore reale di phone_e164, non null", async () => {
    const fake = createFakeAdmin({
      services: [service("s1", TENANT_A, { customer_name: "Mario Rossi", phone_e164: "+393331112222" })],
    });
    authorizeAs(fake.admin);
    const body = await (await callGet("?q=Mario")).json();
    expect(body.results[0].phone_e164).toBe("+393331112222");
  });
});

describe("Sprint 3566212 — ranking booking search non regredito dal fix", () => {
  it("tests/unit/booking-search.test.ts copre già il ranking: qui verifichiamo solo che la route non lo aggiri", async () => {
    const fake = createFakeAdmin({
      services: [
        service("secondary", TENANT_A, { customer_name: "HONCHARENNKO IVANCEVYH", notes: "renn" }),
        service("name-match", TENANT_A, { customer_name: "LUCA RENNA" }),
      ],
    });
    authorizeAs(fake.admin);
    const body = await (await callGet("?q=renn")).json();
    const ids = body.results.map((r: Row) => r.id);
    expect(ids.indexOf("name-match")).toBeLessThan(ids.indexOf("secondary"));
  });
});

describe("Performance — nessun select('*'), nessun fetch non paginato", () => {
  const source = readFileSync(join(process.cwd(), "app/api/ops/search/route.ts"), "utf8");

  it("SERVICE_SEARCH_COLUMNS non è '*' (nessun select('*') sui services)", () => {
    expect(source).not.toMatch(/SERVICE_SEARCH_COLUMNS\s*=\s*"\*"/);
    expect(source).toMatch(/SERVICE_SEARCH_COLUMNS\s*=\s*\[/);
  });

  it("nessun fetchAllServices e query candidate limitate (non full-history)", () => {
    expect(source).not.toMatch(/fetchAllServices/);
    expect(source).toMatch(/perQueryLimit/);
    expect(source).toMatch(/\.limit\(perQueryLimit\)/);
  });

  it("id (uuid) non è mai in ILIKE, solo in .eq()", () => {
    expect(source).toMatch(/isUuid\(input\.q\)\).*\.eq\("id", input\.q\)/);
    expect(source).not.toMatch(/`id\.ilike/);
  });
});
