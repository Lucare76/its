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
    agency_bookings: [],
    booking_groups: [],
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

function agencyBooking(id: string, tenantId: string, sourceBookingKey: string, overrides: Row = {}): Row {
  return {
    id,
    tenant_id: tenantId,
    source: "mts_globe",
    source_booking_key: sourceBookingKey,
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

  // Hardening Sprint 2B: services.phone_e164 is confirmed absent on the real
  // DB (information_schema.columns audit) — a search filter can never
  // legitimately rely on that column, and a fixture that puts the matchable
  // value only in phone_e164 (absent from phone) tests a scenario that can
  // never occur in production. The real, achievable requirement is that the
  // *query* can be typed in any common phone format and still match
  // whatever format `phone` (the only real column) actually holds, via the
  // existing phoneNeedles() digit normalization — see route.ts's
  // phoneFilters comment for the reasoning.
  it("cerca per telefono in formato E.164 (+39...), phone memorizzato senza prefisso", async () => {
    const fake = createFakeAdmin({ services: [service("s1", TENANT_A, { phone: "3331112222" })] });
    authorizeAs(fake.admin);
    const body = await (await callGet("?q=%2B393331112222")).json();
    expect(body.results.map((r: Row) => r.id)).toEqual(["s1"]);
  });

  it("cerca per telefono con spazi/formattazione, phone memorizzato come cifre pure", async () => {
    const fake = createFakeAdmin({ services: [service("s1", TENANT_A, { phone: "3331112222" })] });
    authorizeAs(fake.admin);
    const body = await (await callGet("?q=333%20111%202222")).json();
    expect(body.results.map((r: Row) => r.id)).toEqual(["s1"]);
  });

  it("cerca per telefono con prefisso 39 senza +, phone memorizzato senza prefisso", async () => {
    const fake = createFakeAdmin({ services: [service("s1", TENANT_A, { phone: "3331112222" })] });
    authorizeAs(fake.admin);
    const body = await (await callGet("?q=393331112222")).json();
    expect(body.results.map((r: Row) => r.id)).toEqual(["s1"]);
  });

  it("numero non presente in phone: nessun risultato, nessun errore", async () => {
    const fake = createFakeAdmin({ services: [service("s1", TENANT_A, { phone: "3331112222" })] });
    authorizeAs(fake.admin);
    const body = await (await callGet("?q=%2B393339998888")).json();
    expect(body.ok).toBe(true);
    expect(body.results).toEqual([]);
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

describe("GET /api/ops/search — tratta nave (fix: card mostra compagnia/orari nave, non solo 'Arrivo indicativo')", () => {
  it("Mattioli combinato: direction='arrival' con partenza reale -> outbound_ferry_company/arrival_port da ferry_pickup_rules (to_ischia), return_ferry_company/departure_port dalla gamba stessa (barca_compagnia/porto_bruno)", async () => {
    const fake = createFakeAdmin({
      services: [
        service("mattioli-1", TENANT_A, {
          customer_name: "MATTIOLI ALESSANDRA",
          booking_service_kind: "transfer_train_hotel",
          direction: "arrival",
          billing_party_name: "Aleste Viaggi",
          arrival_date: "2026-09-01",
          arrival_time: "12:48",
          train_arrival_time: "12:48",
          departure_date: "2026-09-07",
          departure_time: "13:25",
          train_departure_time: "13:25",
          train_departure_number: "ITA 8918",
          // Già calcolati e salvati da applyPickupCalc (fix pickup hotel del
          // turno precedente) — la card di partenza deve leggerli da qui, non
          // da un match ferry_schedules indipendente.
          barca_compagnia: "Medmar",
          porto_bruno: "casamicciola",
          orario_barca: "10:10",
          pickup_hotel: "08:30",
        }),
      ],
      ferry_pickup_rules: [
        {
          id: "rule-to-ischia",
          agency_logic: "aleste",
          transport_type: "train",
          direction: "to_ischia",
          boat_type: "traghetto",
          hotel_id: null,
          zone: null,
          transport_from: "12:30",
          transport_to: "13:00",
          company: "Medmar",
          departure_time: "14:20:00",
          embark_port: null,
          arrival_port: "ischia_porto",
          arrival_time: "15:40:00",
          pickup_time: null,
          valid_from: null,
          valid_to: null,
          days_of_week: null,
          season_notes: null,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
      ],
    });
    authorizeAs(fake.admin);
    const body = await (await callGet("?q=MATTIOLI")).json();
    const row = body.results.find((r: Row) => r.id === "mattioli-1");

    // Arrivo: fonte canonica ferry_pickup_rules (mai il match ferry_schedules
    // legacy, che qui non ha nessuna riga seedata).
    expect(row.outbound_ferry_departure_time).toBe("14:20");
    expect(row.outbound_ferry_arrival_time).toBe("15:40");
    expect(row.outbound_ferry_company).toBe("MEDMAR");
    expect(row.outbound_ferry_arrival_port).toBe("Ischia Porto");

    // Partenza: valori già persistiti sulla riga stessa (record combinato).
    expect(row.return_ferry_company).toBe("MEDMAR");
    expect(row.return_ferry_departure_port).toBe("Casamicciola");
    expect(row.return_ferry_departure_time).toBe("10:10");
  });

  it("BIRAGO arrival-only: nessun train_departure_number/time -> nessun return_ferry_* mostrato (nessuna regressione)", async () => {
    const fake = createFakeAdmin({
      services: [
        service("birago-1", TENANT_A, {
          customer_name: "BIRAGO ANNAMARIA",
          booking_service_kind: "transfer_train_hotel",
          direction: "arrival",
          arrival_date: "2026-08-27",
          arrival_time: "10:00",
          // Residuo BIRAGO: departure_date/departure_time generici, MAI un
          // dato treno strutturato.
          departure_date: "2026-08-26",
          departure_time: "18:00",
        }),
      ],
    });
    authorizeAs(fake.admin);
    const body = await (await callGet("?q=BIRAGO")).json();
    const row = body.results.find((r: Row) => r.id === "birago-1");
    // return_ferry_company/departure_port restano comunque assenti a monte
    // (nessun barca_compagnia/porto_bruno seedato): qui il punto è che
    // hasRealDepartureLeg non deve far crashare o inventare nulla.
    expect(row.return_ferry_company).toBeFalsy();
  });

  it("nessuna regola nave applicabile: outbound_ferry_company/arrival_port restano null, nessuna compagnia inventata", async () => {
    const fake = createFakeAdmin({
      services: [
        service("no-rule-1", TENANT_A, {
          customer_name: "SENZA REGOLA",
          booking_service_kind: "transfer_train_hotel",
          direction: "arrival",
          billing_party_name: "Aleste Viaggi",
          arrival_date: "2026-09-01",
          arrival_time: "03:00", // fuori da qualunque fascia oraria nota
          train_arrival_time: "03:00",
        }),
      ],
      ferry_pickup_rules: [],
    });
    authorizeAs(fake.admin);
    const body = await (await callGet("?q=SENZA REGOLA")).json();
    const row = body.results.find((r: Row) => r.id === "no-rule-1");
    expect(row.outbound_ferry_company).toBeNull();
    expect(row.outbound_ferry_arrival_port).toBeNull();
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

describe("GET /api/ops/search — Obiettivo B: ricerca per practice_number", () => {
  it("trova la pratica cercando il numero pratica completo", async () => {
    const fake = createFakeAdmin({
      services: [service("s1", TENANT_A, { customer_name: "Cliente Pratica", practice_number: "ITS-2026-42" })],
    });
    authorizeAs(fake.admin);
    const body = await (await callGet("?q=ITS-2026-42")).json();
    expect(body.results.map((r: Row) => r.id)).toEqual(["s1"]);
    expect(body.results[0].practice_number).toBe("ITS-2026-42");
  });

  it("trova la pratica cercando una parte del numero pratica (ILIKE parziale)", async () => {
    const fake = createFakeAdmin({
      services: [service("s1", TENANT_A, { practice_number: "ITS-2026-42" })],
    });
    authorizeAs(fake.admin);
    const body = await (await callGet("?q=2026-42")).json();
    expect(body.results.map((r: Row) => r.id)).toEqual(["s1"]);
  });

  it("non rompe la ricerca normale per nome quando practice_number è assente", async () => {
    const fake = createFakeAdmin({
      services: [service("s1", TENANT_A, { customer_name: "Mario Rossi", practice_number: null })],
    });
    authorizeAs(fake.admin);
    const body = await (await callGet("?q=Mario")).json();
    expect(body.results.map((r: Row) => r.id)).toEqual(["s1"]);
  });
});

describe("GET /api/ops/search — Obiettivo C: ricerca per Voucher No MTS Globe", () => {
  it("trova il service collegato al voucher tramite agency_bookings.source_booking_key (nessun campo services contiene il voucher)", async () => {
    const fake = createFakeAdmin({
      agency_bookings: [agencyBooking("ab-1", TENANT_A, "mts_globe:1548652")],
      services: [
        service("s1", TENANT_A, {
          agency_booking_id: "ab-1",
          customer_name: "Cliente MTS Globe",
          practice_number: null,
        }),
      ],
    });
    authorizeAs(fake.admin);
    const body = await (await callGet("?q=1548652")).json();
    expect(body.results.map((r: Row) => r.id)).toEqual(["s1"]);
    expect(body.results[0].agency_booking_id).toBe("ab-1");
  });

  it("voucher inesistente: nessun risultato, nessun errore", async () => {
    const fake = createFakeAdmin({
      agency_bookings: [agencyBooking("ab-1", TENANT_A, "mts_globe:1548652")],
      services: [service("s1", TENANT_A, { agency_booking_id: "ab-1" })],
    });
    authorizeAs(fake.admin);
    const body = await (await callGet("?q=9999999")).json();
    expect(body.ok).toBe(true);
    expect(body.results).toEqual([]);
  });

  it("stesso q che matcha sia practice_number sia voucher: risultato deduplicato per service id, nessun doppione", async () => {
    const fake = createFakeAdmin({
      agency_bookings: [agencyBooking("ab-1", TENANT_A, "mts_globe:555555")],
      services: [
        service("s1", TENANT_A, {
          agency_booking_id: "ab-1",
          practice_number: "555555",
        }),
      ],
    });
    authorizeAs(fake.admin);
    const body = await (await callGet("?q=555555")).json();
    expect(body.results.map((r: Row) => r.id)).toEqual(["s1"]);
    expect(body.results).toHaveLength(1);
  });

  it("isolamento tenant: un voucher del tenant B non compare cercando come tenant A, anche con lo stesso source_booking_key", async () => {
    const fake = createFakeAdmin({
      agency_bookings: [
        agencyBooking("ab-a", TENANT_A, "mts_globe:7000001"),
        agencyBooking("ab-b", TENANT_B, "mts_globe:7000001"),
      ],
      services: [
        service("s-a", TENANT_A, { agency_booking_id: "ab-a" }),
        service("s-b", TENANT_B, { agency_booking_id: "ab-b" }),
      ],
    });
    authorizeAs(fake.admin, TENANT_A);
    const body = await (await callGet("?q=7000001")).json();
    const ids = body.results.map((r: Row) => r.id);
    expect(ids).toContain("s-a");
    expect(ids).not.toContain("s-b");
  });

  it("ricerca normale per nome/telefono/hotel resta invariata dopo l'aggiunta della ricerca voucher", async () => {
    const fake = createFakeAdmin({
      agency_bookings: [agencyBooking("ab-1", TENANT_A, "mts_globe:1234567")],
      services: [
        service("s-name", TENANT_A, { customer_name: "Mario Rossi" }),
        service("s-phone", TENANT_A, { phone: "3331234567" }),
        service("s-hotel", TENANT_A, { hotel_id: "hotel-1" }),
        service("s-voucher", TENANT_A, { agency_booking_id: "ab-1" }),
      ],
      hotels: [{ id: "hotel-1", name: "Hotel Ischia Palace", zone: "porto", tenant_id: TENANT_A }],
    });
    authorizeAs(fake.admin);
    const byName = await (await callGet("?q=Mario")).json();
    expect(byName.results.map((r: Row) => r.id)).toEqual(["s-name"]);
    const byPhone = await (await callGet("?q=3331234567")).json();
    expect(byPhone.results.map((r: Row) => r.id)).toEqual(["s-phone"]);
    const byHotel = await (await callGet("?q=Ischia Palace")).json();
    expect(byHotel.results.map((r: Row) => r.id)).toEqual(["s-hotel"]);
  });
});

describe("GET /api/ops/search — Fix B: visibilità services di Booking Groups", () => {
  it("service draft di un booking group (is_draft=true, needs_review) compare nei risultati con badge gruppo", async () => {
    const fake = createFakeAdmin({
      booking_groups: [{ id: "bg-1", tenant_id: TENANT_A, name: "Gruppo GIACOMONI" }],
      services: [
        service("s1", TENANT_A, { customer_name: "Bernardi Luisa", is_draft: true, status: "needs_review", booking_group_id: "bg-1" }),
      ],
    });
    authorizeAs(fake.admin);
    const body = await (await callGet("?q=Bernardi")).json();
    expect(body.results.map((r: Row) => r.id)).toEqual(["s1"]);
    expect(body.results[0].booking_group_id).toBe("bg-1");
    expect(body.results[0].booking_group_name).toBe("Gruppo GIACOMONI");
  });

  it("un draft SENZA booking_group_id resta escluso (nessuna regressione sul filtro is_draft originale)", async () => {
    const fake = createFakeAdmin({
      services: [
        service("s1", TENANT_A, { customer_name: "Bozza Inbound", is_draft: true, status: "needs_review", booking_group_id: null }),
      ],
    });
    authorizeAs(fake.admin);
    const body = await (await callGet("?q=Bozza")).json();
    expect(body.results).toEqual([]);
  });

  it("isolamento tenant: un service di gruppo di un altro tenant non compare", async () => {
    const fake = createFakeAdmin({
      booking_groups: [{ id: "bg-a", tenant_id: TENANT_A, name: "Gruppo A" }, { id: "bg-b", tenant_id: TENANT_B, name: "Gruppo B" }],
      services: [
        service("s-a", TENANT_A, { customer_name: "Stesso Nome", is_draft: true, status: "needs_review", booking_group_id: "bg-a" }),
        service("s-b", TENANT_B, { customer_name: "Stesso Nome", is_draft: true, status: "needs_review", booking_group_id: "bg-b" }),
      ],
    });
    authorizeAs(fake.admin, TENANT_A);
    const body = await (await callGet("?q=Stesso Nome")).json();
    const ids = body.results.map((r: Row) => r.id);
    expect(ids).toContain("s-a");
    expect(ids).not.toContain("s-b");
  });
});

describe("GET /api/ops/search — Obiettivo I: ricerca per nome del booking group", () => {
  it("cerca 'GIACOMONI' -> trova i services collegati anche se customer_name non contiene 'GIACOMONI'", async () => {
    const fake = createFakeAdmin({
      booking_groups: [{ id: "bg-giacomoni", tenant_id: TENANT_A, name: "GIACOMONI" }],
      services: [
        service("s1", TENANT_A, { customer_name: "MURATORI SANDRA", booking_group_id: "bg-giacomoni", is_draft: true, status: "needs_review" }),
        service("s2", TENANT_A, { customer_name: "ONOFRI VALDES", booking_group_id: "bg-giacomoni", is_draft: true, status: "needs_review" }),
        service("s3", TENANT_A, { customer_name: "Cliente Non Collegato" }),
      ],
    });
    authorizeAs(fake.admin);
    const body = await (await callGet("?q=GIACOMONI")).json();
    const ids = body.results.map((r: Row) => r.id);
    expect(ids).toContain("s1");
    expect(ids).toContain("s2");
    expect(ids).not.toContain("s3");
    expect(body.results.every((r: Row) => r.booking_group_name === "GIACOMONI")).toBe(true);
  });

  it("cerca 'MURATORI' (nome passeggero) -> il risultato espone booking_group_name = GIACOMONI", async () => {
    const fake = createFakeAdmin({
      booking_groups: [{ id: "bg-giacomoni", tenant_id: TENANT_A, name: "GIACOMONI" }],
      services: [
        service("s1", TENANT_A, { customer_name: "MURATORI SANDRA", booking_group_id: "bg-giacomoni", is_draft: true, status: "needs_review" }),
      ],
    });
    authorizeAs(fake.admin);
    const body = await (await callGet("?q=MURATORI")).json();
    expect(body.results.map((r: Row) => r.id)).toEqual(["s1"]);
    expect(body.results[0].booking_group_name).toBe("GIACOMONI");
  });

  it("un service SENZA booking_group_id con customer_name non collegato non compare cercando il nome di un gruppo altrui", async () => {
    const fake = createFakeAdmin({
      booking_groups: [{ id: "bg-giacomoni", tenant_id: TENANT_A, name: "GIACOMONI" }],
      services: [
        service("s1", TENANT_A, { customer_name: "Cliente Privato Qualsiasi", booking_group_id: null }),
      ],
    });
    authorizeAs(fake.admin);
    const body = await (await callGet("?q=GIACOMONI")).json();
    expect(body.results).toEqual([]);
  });

  it("due gruppi diversi: cercare il nome di uno non restituisce i services dell'altro", async () => {
    const fake = createFakeAdmin({
      booking_groups: [
        { id: "bg-giacomoni", tenant_id: TENANT_A, name: "GIACOMONI" },
        { id: "bg-parrocchia", tenant_id: TENANT_A, name: "PARROCCHIA SANTA BEATA" },
      ],
      services: [
        service("s1", TENANT_A, { customer_name: "MURATORI SANDRA", booking_group_id: "bg-giacomoni" }),
        service("s2", TENANT_A, { customer_name: "ROSSI MARIO", booking_group_id: "bg-parrocchia" }),
      ],
    });
    authorizeAs(fake.admin);
    const body = await (await callGet("?q=GIACOMONI")).json();
    const ids = body.results.map((r: Row) => r.id);
    expect(ids).toEqual(["s1"]);
    expect(ids).not.toContain("s2");
  });

  it("isolamento tenant: un gruppo con lo stesso nome in un altro tenant non fa comparire i suoi services", async () => {
    const fake = createFakeAdmin({
      booking_groups: [
        { id: "bg-a", tenant_id: TENANT_A, name: "GIACOMONI" },
        { id: "bg-b", tenant_id: TENANT_B, name: "GIACOMONI" },
      ],
      services: [
        service("s-a", TENANT_A, { customer_name: "Passeggero A", booking_group_id: "bg-a" }),
        service("s-b", TENANT_B, { customer_name: "Passeggero B", booking_group_id: "bg-b" }),
      ],
    });
    authorizeAs(fake.admin, TENANT_A);
    const body = await (await callGet("?q=GIACOMONI")).json();
    const ids = body.results.map((r: Row) => r.id);
    expect(ids).toContain("s-a");
    expect(ids).not.toContain("s-b");
  });

  it("nessun gruppo con quel nome: comportamento invariato, nessun errore", async () => {
    const fake = createFakeAdmin({
      services: [service("s1", TENANT_A, { customer_name: "Cliente Normale" })],
    });
    authorizeAs(fake.admin);
    const body = await (await callGet("?q=Normale")).json();
    expect(body.results.map((r: Row) => r.id)).toEqual(["s1"]);
    expect(body.results[0].booking_group_name).toBeNull();
  });
});

describe("GET /api/ops/search — Obiettivo A/E (card gruppo unica): espansione fratelli + metadata gruppo", () => {
  it("cerca una fermata (PESARO) -> tornano TUTTI i services del gruppo, non solo quello di Pesaro", async () => {
    const fake = createFakeAdmin({
      booking_groups: [{ id: "bg-giacomoni", tenant_id: TENANT_A, name: "GIACOMONI", kind: "bus_exclusive", service_date: "2026-09-06", return_date: "2026-09-13", hotel_id: null, notes: null }],
      services: [
        service("s-cattolica", TENANT_A, { customer_name: "GIACOMONI", pax: 4, bus_city_origin: "CATTOLICA", booking_group_id: "bg-giacomoni", direction: "arrival" }),
        service("s-pesaro", TENANT_A, { customer_name: "GIACOMONI", pax: 6, bus_city_origin: "PESARO", booking_group_id: "bg-giacomoni", direction: "arrival" }),
        service("s-fano", TENANT_A, { customer_name: "GIACOMONI", pax: 10, bus_city_origin: "FANO", booking_group_id: "bg-giacomoni", direction: "arrival" }),
        service("s-marotta", TENANT_A, { customer_name: "GIACOMONI", pax: 18, bus_city_origin: "MAROTTA", booking_group_id: "bg-giacomoni", direction: "arrival" }),
        service("s-altro", TENANT_A, { customer_name: "Cliente Non Collegato", bus_city_origin: "PESARO" }),
      ],
    });
    authorizeAs(fake.admin);
    const body = await (await callGet("?q=PESARO")).json();
    const ids = body.results.map((r: Row) => r.id);
    expect(ids).toEqual(expect.arrayContaining(["s-cattolica", "s-pesaro", "s-fano", "s-marotta"]));
    // Il cliente non collegato al gruppo (match diretto su PESARO ma senza
    // booking_group_id) resta comunque tra i risultati, non va confuso con
    // l'espansione fratelli.
    expect(ids).toContain("s-altro");

    const pesaroRow = body.results.find((r: Row) => r.id === "s-pesaro");
    const cattolicaRow = body.results.find((r: Row) => r.id === "s-cattolica");
    expect(pesaroRow.matched_query).toBe(true);
    // Cattolica non contiene "PESARO": è stato incluso solo come fratello di
    // gruppo, mai come match testuale diretto.
    expect(cattolicaRow.matched_query).toBe(false);
  });

  it("risposta include booking_groups con service_date/return_date/hotel_name/notes", async () => {
    const fake = createFakeAdmin({
      booking_groups: [{ id: "bg-giacomoni", tenant_id: TENANT_A, name: "GIACOMONI", kind: "bus_exclusive", service_date: "2026-09-06", return_date: "2026-09-13", hotel_id: "hotel-1", notes: "CI SAREBBERO 2 PAX CHE VORREBBERO SALIRE A CESENA" }],
      hotels: [{ id: "hotel-1", tenant_id: TENANT_A, name: "GRAND HOTEL DELLE TERME RE FERDINANDO", zone: null }],
      services: [
        service("s1", TENANT_A, { customer_name: "GIACOMONI", pax: 4, booking_group_id: "bg-giacomoni" }),
      ],
    });
    authorizeAs(fake.admin);
    const body = await (await callGet("?q=GIACOMONI")).json();
    expect(body.booking_groups).toEqual([{
      id: "bg-giacomoni",
      name: "GIACOMONI",
      kind: "bus_exclusive",
      service_date: "2026-09-06",
      return_date: "2026-09-13",
      hotel_id: "hotel-1",
      hotel_name: "GRAND HOTEL DELLE TERME RE FERDINANDO",
      notes: "CI SAREBBERO 2 PAX CHE VORREBBERO SALIRE A CESENA",
    }]);
  });

  it("gruppo senza hotel/notes: booking_groups espone comunque la riga con campi null (nessun dato inventato)", async () => {
    const fake = createFakeAdmin({
      booking_groups: [{ id: "bg-giacomoni", tenant_id: TENANT_A, name: "GIACOMONI", kind: "bus_exclusive", service_date: "2026-09-06", return_date: "2026-09-13", hotel_id: null, notes: null }],
      services: [service("s1", TENANT_A, { customer_name: "GIACOMONI", booking_group_id: "bg-giacomoni" })],
    });
    authorizeAs(fake.admin);
    const body = await (await callGet("?q=GIACOMONI")).json();
    expect(body.booking_groups[0].hotel_name).toBeNull();
    expect(body.booking_groups[0].notes).toBeNull();
  });

  it("servizio individuale (booking_group_id null): nessuna espansione fratelli, comportamento invariato", async () => {
    const fake = createFakeAdmin({
      services: [service("s1", TENANT_A, { customer_name: "Rossi Mario" })],
    });
    authorizeAs(fake.admin);
    const body = await (await callGet("?q=Rossi")).json();
    expect(body.results.map((r: Row) => r.id)).toEqual(["s1"]);
    expect(body.results[0].matched_query).toBe(true);
    expect(body.booking_groups).toEqual([]);
  });

  it("isolamento tenant: l'espansione fratelli non pesca services di un altro tenant anche con lo stesso booking_group_id letterale", async () => {
    const fake = createFakeAdmin({
      booking_groups: [
        { id: "bg-shared-id", tenant_id: TENANT_A, name: "GIACOMONI", kind: "bus_exclusive", service_date: null, return_date: null, hotel_id: null, notes: null },
      ],
      services: [
        service("s-a1", TENANT_A, { customer_name: "GIACOMONI", bus_city_origin: "PESARO", booking_group_id: "bg-shared-id" }),
        service("s-a2", TENANT_A, { customer_name: "MURATORI SANDRA", booking_group_id: "bg-shared-id" }),
        service("s-b1", TENANT_B, { customer_name: "Altro Passeggero", booking_group_id: "bg-shared-id" }),
      ],
    });
    authorizeAs(fake.admin, TENANT_A);
    const body = await (await callGet("?q=PESARO")).json();
    const ids = body.results.map((r: Row) => r.id);
    expect(ids).toContain("s-a1");
    expect(ids).toContain("s-a2");
    expect(ids).not.toContain("s-b1");
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
