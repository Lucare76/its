import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  authorizePricingRequest: vi.fn(),
  resolveBookingPracticeNumber: vi.fn(),
}));

vi.mock("@/lib/server/pricing-auth", () => ({
  authorizePricingRequest: mocks.authorizePricingRequest,
}));

vi.mock("@/lib/server/booking-practice-number", () => ({
  resolveBookingPracticeNumber: mocks.resolveBookingPracticeNumber,
}));

import { POST } from "@/app/api/ops/new-booking/route";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HOTEL_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

type DirectRuleOverrides = Partial<{
  id: string;
  agency_logic: "aleste" | "sosandra";
  company: "snav" | "medmar";
  hotel_id: string | null;
  zone: string | null;
  departure_time: string;
  pickup_time: string | null;
  embark_port: string | null;
  arrival_port: string;
  valid_from: string | null;
  valid_to: string | null;
  days_of_week: number[] | null;
}>;

function directRule(overrides: DirectRuleOverrides = {}) {
  return {
    id: overrides.id ?? "rule-1",
    agency_logic: overrides.agency_logic ?? "aleste",
    transport_type: "direct",
    direction: "from_ischia",
    boat_type: "aliscafo",
    hotel_id: overrides.hotel_id ?? null,
    zone: overrides.zone ?? "ischia",
    transport_from: null,
    transport_to: null,
    company: overrides.company ?? "snav",
    departure_time: overrides.departure_time ?? "07:10",
    embark_port: overrides.embark_port ?? "casamicciola",
    arrival_port: overrides.arrival_port ?? "napoli_beverello",
    arrival_time: null,
    pickup_time: overrides.pickup_time === undefined ? "06:30" : overrides.pickup_time,
    valid_from: overrides.valid_from ?? null,
    valid_to: overrides.valid_to ?? null,
    days_of_week: overrides.days_of_week ?? null,
  };
}

function basePayload(overrides: Record<string, unknown> = {}) {
  return {
    customer_first_name: "Angela",
    customer_last_name: "Sinisi",
    customer_phone: "3331234567",
    customer_email: "",
    pax: 2,
    hotel_id: HOTEL_ID,
    booking_service_kind: "formula_snav",
    arrival_date: "2026-08-25",
    arrival_time: "10:00",
    departure_date: "2026-08-27",
    departure_time: "14:00",
    transport_code: "",
    transport_code_return: "",
    notes: "",
    trip_leg: "return_only",
    ...overrides,
  };
}

function makeRequest(body: unknown) {
  return new NextRequest("http://localhost:3010/api/ops/new-booking", { method: "POST", body: JSON.stringify(body) });
}

function makeFakeAdmin(opts: {
  serviceInserts: Array<Record<string, unknown>>;
  directRules?: Array<Record<string, unknown>>;
  hotelZoneById?: Record<string, string | null>;
  agencyNameById?: Record<string, string>;
}) {
  const directRules = opts.directRules ?? [];
  const hotelZoneById = opts.hotelZoneById ?? { [HOTEL_ID]: "ischia" };
  const agencyNameById = opts.agencyNameById ?? {};

  const genericBuilder = (): Record<string, unknown> => {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "neq", "gte", "lte", "in", "overlaps", "order", "limit", "ilike"]) b[m] = () => b;
    b.maybeSingle = async () => ({ data: null, error: null });
    b.single = async () => ({ data: null, error: null });
    b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve({ data: [], error: null, count: 0 }).then(resolve, reject);
    b.insert = () => {
      const result = { data: null, error: null };
      const chainable: Record<string, unknown> = { select: () => ({ single: async () => result }) };
      chainable.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(result).then(resolve, reject);
      return chainable;
    };
    b.update = () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) });
    return b;
  };

  const ferryPickupRulesBuilder = (): Record<string, unknown> => {
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve({ data: directRules, error: null }).then(resolve, reject);
    return b;
  };

  const servicesBuilder = (): Record<string, unknown> => {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "neq", "gte", "lte", "in", "overlaps", "order", "limit", "ilike"]) b[m] = () => b;
    b.maybeSingle = async () => ({ data: null, error: null });
    b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve({ data: [], error: null, count: 0 }).then(resolve, reject);
    b.insert = (payload: Record<string, unknown>) => {
      opts.serviceInserts.push(payload);
      const id = `svc-${opts.serviceInserts.length}`;
      const result = { data: { id, created_at: "2026-08-22T10:00:00.000Z" }, error: null };
      return { select: () => ({ single: async () => result }) };
    };
    b.update = () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) });
    return b;
  };

  const hotelsBuilder = (): Record<string, unknown> => {
    const b: Record<string, unknown> = {};
    let requestedId: string | undefined;
    b.select = () => b;
    b.eq = (col: string, value: string) => {
      if (col === "id") requestedId = value;
      return b;
    };
    b.maybeSingle = async () => ({
      data: requestedId
        ? { id: requestedId, name: "Hotel Test", zone: hotelZoneById[requestedId] ?? null }
        : null,
      error: null,
    });
    return b;
  };

  const membershipsBuilder = (): Record<string, unknown> => {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq"]) b[m] = () => b;
    b.maybeSingle = async () => ({ data: { full_name: "Mario Rossi" }, error: null });
    return b;
  };

  const agenciesBuilder = (): Record<string, unknown> => {
    const b: Record<string, unknown> = {};
    let requestedId: string | undefined;
    b.select = () => b;
    b.eq = (col: string, value: string) => {
      if (col === "id") requestedId = value;
      return b;
    };
    b.maybeSingle = async () => ({
      data: requestedId && agencyNameById[requestedId]
        ? { id: requestedId, name: agencyNameById[requestedId] }
        : null,
      error: null,
    });
    return b;
  };

  return {
    from(table: string) {
      if (table === "services") return servicesBuilder();
      if (table === "hotels") return hotelsBuilder();
      if (table === "memberships") return membershipsBuilder();
      if (table === "ferry_pickup_rules") return ferryPickupRulesBuilder();
      if (table === "agencies") return agenciesBuilder();
      return genericBuilder();
    },
  } as never;
}

function makeAuthContext(admin: unknown) {
  return {
    admin,
    user: { id: "user-1", email: "operatore@test.it" },
    membership: { tenant_id: TENANT, role: "operator", suspended: false },
  };
}

describe("POST /api/ops/new-booking — Formula SNAV/MEDMAR usa ferry_pickup_rules DB (Step A)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveBookingPracticeNumber.mockResolvedValue("ITS-2026-1");
  });

  // A. formula_snav con direct rule DB compatibile -> usa pickup DB
  it("A. formula_snav usa il pickup_time della direct rule DB quando c'e' match", async () => {
    const serviceInserts: Array<Record<string, unknown>> = [];
    const directRules = [directRule({ company: "snav", zone: "ischia", departure_time: "07:10", pickup_time: "06:30", agency_logic: "aleste" })];
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(makeFakeAdmin({ serviceInserts, directRules })));

    await POST(makeRequest(basePayload({
      booking_service_kind: "formula_snav",
      trip_leg: "return_only",
      arrival_date: "2026-08-25",
      arrival_time: "10:00",
      departure_date: "2026-08-25",
      ferry_dep_time: "07:10",
      porto_partenza: "Casamicciola",
    })));

    expect(serviceInserts.length).toBe(1);
    expect(serviceInserts[0]!.pickup_hotel).toBe("06:30");
  });

  // B. formula_medmar_napoli -> direct rule DB -> pickup corretto
  it("B. formula_medmar_napoli usa la direct rule DB (caso reale: zona forio, 17:00 -> pickup 15:15)", async () => {
    const serviceInserts: Array<Record<string, unknown>> = [];
    const directRules = [directRule({
      company: "medmar", zone: "forio", departure_time: "17:00", pickup_time: "15:15",
      embark_port: "ischia_porto", arrival_port: "napoli_beverello", agency_logic: "aleste",
    })];
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(makeFakeAdmin({
      serviceInserts, directRules, hotelZoneById: { [HOTEL_ID]: "forio" },
    })));

    await POST(makeRequest(basePayload({
      booking_service_kind: "formula_medmar_napoli",
      trip_leg: "return_only",
      arrival_date: "2026-08-25",
      arrival_time: "10:00",
      ferry_dep_time: "17:00",
      porto_partenza: "Ischia Porto",
    })));

    expect(serviceInserts[0]!.pickup_hotel).toBe("15:15");
  });

  // C. formula_medmar_pozzuoli -> direct rule DB -> pickup corretto
  it("C. formula_medmar_pozzuoli usa la direct rule DB", async () => {
    const serviceInserts: Array<Record<string, unknown>> = [];
    const directRules = [directRule({
      company: "medmar", zone: "casamicciola", departure_time: "10:10", pickup_time: "08:45",
      embark_port: "casamicciola", arrival_port: "pozzuoli", agency_logic: "aleste",
    })];
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(makeFakeAdmin({
      serviceInserts, directRules, hotelZoneById: { [HOTEL_ID]: "casamicciola" },
    })));

    await POST(makeRequest(basePayload({
      booking_service_kind: "formula_medmar_pozzuoli",
      trip_leg: "return_only",
      arrival_date: "2026-08-25",
      arrival_time: "10:00",
      ferry_dep_time: "10:10",
      porto_partenza: "Casamicciola",
    })));

    expect(serviceInserts[0]!.pickup_hotel).toBe("08:45");
  });

  // D. agency logic: aleste vs sosandra scelgono righe diverse
  it("D. agency_logic aleste vs sosandra selezionano direct rule diverse per lo stesso orario/zona", async () => {
    const directRules = [
      directRule({ id: "aleste-rule", company: "snav", zone: "ischia", departure_time: "07:10", pickup_time: "06:30", agency_logic: "aleste" }),
      directRule({ id: "sosandra-rule", company: "snav", zone: "ischia", departure_time: "07:10", pickup_time: "06:25", agency_logic: "sosandra" }),
    ];

    const aleste: Array<Record<string, unknown>> = [];
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(makeFakeAdmin({ serviceInserts: aleste, directRules })));
    await POST(makeRequest(basePayload({
      booking_service_kind: "formula_snav", trip_leg: "return_only",
      arrival_date: "2026-08-25", arrival_time: "10:00", ferry_dep_time: "07:10", porto_partenza: "Casamicciola",
    })));
    expect(aleste[0]!.pickup_hotel).toBe("06:30");

    vi.clearAllMocks();
    mocks.resolveBookingPracticeNumber.mockResolvedValue("ITS-2026-2");
    const sosandra: Array<Record<string, unknown>> = [];
    const AGENCY_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(makeFakeAdmin({
      serviceInserts: sosandra, directRules, agencyNameById: { [AGENCY_ID]: "Sosandra Viaggi" },
    })));
    await POST(makeRequest(basePayload({
      booking_service_kind: "formula_snav", trip_leg: "return_only", agency_id: AGENCY_ID,
      arrival_date: "2026-08-25", arrival_time: "10:00", ferry_dep_time: "07:10", porto_partenza: "Casamicciola",
    })));
    expect(sosandra[0]!.pickup_hotel).toBe("06:25");
  });

  // E. due zone con pickup differenti
  it("E. zone diverse (ischia vs forio) producono pickup diversi dalla stessa direct rule DB", async () => {
    const directRules = [
      directRule({ id: "r-ischia", company: "medmar", zone: "ischia", departure_time: "17:00", pickup_time: "15:30", embark_port: "ischia_porto", arrival_port: "napoli_beverello" }),
      directRule({ id: "r-forio", company: "medmar", zone: "forio", departure_time: "17:00", pickup_time: "15:15", embark_port: "ischia_porto", arrival_port: "napoli_beverello" }),
    ];

    const ischia: Array<Record<string, unknown>> = [];
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(makeFakeAdmin({ serviceInserts: ischia, directRules, hotelZoneById: { [HOTEL_ID]: "ischia" } })));
    await POST(makeRequest(basePayload({
      booking_service_kind: "formula_medmar_napoli", trip_leg: "return_only",
      arrival_date: "2026-08-25", arrival_time: "10:00", ferry_dep_time: "17:00", porto_partenza: "Ischia Porto",
    })));
    expect(ischia[0]!.pickup_hotel).toBe("15:30");

    vi.clearAllMocks();
    mocks.resolveBookingPracticeNumber.mockResolvedValue("ITS-2026-2");
    const forio: Array<Record<string, unknown>> = [];
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(makeFakeAdmin({ serviceInserts: forio, directRules, hotelZoneById: { [HOTEL_ID]: "forio" } })));
    await POST(makeRequest(basePayload({
      booking_service_kind: "formula_medmar_napoli", trip_leg: "return_only",
      arrival_date: "2026-08-25", arrival_time: "10:00", ferry_dep_time: "17:00", porto_partenza: "Ischia Porto",
    })));
    expect(forio[0]!.pickup_hotel).toBe("15:15");
  });

  // F. stagionalita'/weekday realmente rispettati dal DB resolver
  it("F. una direct rule fuori dalla finestra valid_from/valid_to non viene usata (fallback statico)", async () => {
    const serviceInserts: Array<Record<string, unknown>> = [];
    // Regola DB con pickup diverso dallo statico, ma valida solo dal 2027 in poi:
    // la data del servizio (2026-08-25) e' fuori finestra -> niente match DB ->
    // cade sul fallback statico reale (SNAV zona ischia 07:10 -> 06:30, valore
    // noto da lib/departure-pickup-rules.ts).
    const directRules = [directRule({
      company: "snav", zone: "ischia", departure_time: "07:10", pickup_time: "09:59",
      valid_from: "2027-01-01",
    })];
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(makeFakeAdmin({ serviceInserts, directRules })));

    await POST(makeRequest(basePayload({
      booking_service_kind: "formula_snav", trip_leg: "return_only",
      arrival_date: "2026-08-25", arrival_time: "10:00", ferry_dep_time: "07:10", porto_partenza: "Casamicciola",
    })));

    expect(serviceInserts[0]!.pickup_hotel).toBe("06:30");
  });

  // G. context presente, nessuna direct rule -> fallback statico attuale (regressione)
  it("G. nessuna direct rule DB per l'orario richiesto -> fallback statico invariato", async () => {
    const serviceInserts: Array<Record<string, unknown>> = [];
    // Nessuna regola DB per le 07:10: il resolver deve cadere sul fallback
    // statico storico (getPickupRule reale, non mockato) — stesso comportamento
    // di prima dello Step A.
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(makeFakeAdmin({ serviceInserts, directRules: [] })));

    await POST(makeRequest(basePayload({
      booking_service_kind: "formula_snav", trip_leg: "return_only",
      arrival_date: "2026-08-25", arrival_time: "10:00", ferry_dep_time: "07:10", porto_partenza: "Casamicciola",
    })));

    expect(serviceInserts[0]!.pickup_hotel).toBe("06:30");
  });

  // H. barca_compagnia contiene un porto: il match DB non deve dipendere da esso
  it("H. barca_compagnia = porto (bug noto, non corretto in questo step) non influenza il match della direct rule", async () => {
    const serviceInserts: Array<Record<string, unknown>> = [];
    const directRules = [directRule({ company: "medmar", zone: "ischia", departure_time: "17:00", pickup_time: "15:30", embark_port: "ischia_porto", arrival_port: "napoli_beverello" })];
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(makeFakeAdmin({ serviceInserts, directRules, hotelZoneById: { [HOTEL_ID]: "ischia" } })));

    await POST(makeRequest(basePayload({
      booking_service_kind: "formula_medmar_napoli", trip_leg: "return_only",
      arrival_date: "2026-08-25", arrival_time: "10:00", ferry_dep_time: "17:00",
      porto_partenza: "Ischia Porto", // valore di porto, non di compagnia
    })));

    // barca_compagnia resta il porto (comportamento noto, non toccato)...
    expect(serviceInserts[0]!.barca_compagnia).toBe("Ischia Porto");
    // ...ma il match della direct rule (derivato da booking_service_kind) ha comunque funzionato:
    expect(serviceInserts[0]!.pickup_hotel).toBe("15:30");
  });

  // I. regression train/flight: stesso risultato di prima (calcolo reale invariato)
  it("I. transfer_train_hotel continua a produrre lo stesso pickup di prima (fallback statico, nessuna direct rule per il dominio A qui)", async () => {
    const serviceInserts: Array<Record<string, unknown>> = [];
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(makeFakeAdmin({ serviceInserts, directRules: [] })));

    await POST(makeRequest(basePayload({
      booking_service_kind: "transfer_train_hotel",
      trip_leg: "return_only",
      departure_time: "14:00",
      transport_code: "TRENO",
      transport_code_return: "TRENO",
    })));

    expect(serviceInserts[0]!.pickup_hotel).toBe("11:00");
  });

  // J. transfer_port_hotel resta fuori scope (non riceve context in questo step)
  it("J. transfer_port_hotel NON usa il context DB (fuori scope Step A): compagnia non riconosciuta come prima dello Step A", async () => {
    const serviceInserts: Array<Record<string, unknown>> = [];
    // Una direct rule DB con lo stesso company/zona/orario ma pickup diverso:
    // se transfer_port_hotel finisse per usare il context, vedremmo 05:55 qui.
    const directRules = [directRule({ company: "snav", zone: "ischia", departure_time: "07:10", pickup_time: "05:55" })];
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(makeFakeAdmin({ serviceInserts, directRules })));

    await POST(makeRequest(basePayload({
      booking_service_kind: "transfer_port_hotel",
      trip_leg: "return_only",
      arrival_date: "2026-08-25",
      arrival_time: "10:00",
      departure_time: "07:10",
    })));

    // transfer_port_hotel: il vessel di default ("Transfer porto") non nomina
    // SNAV/MEDMAR, quindi directCarrierFromKind ritorna null e applyPickupCalc
    // segnala il carrier non riconosciuto — comportamento identico a prima
    // dello Step A, nessuna direct rule usata (nessun 05:55 nel risultato).
    expect(serviceInserts[0]!.pickup_hotel ?? null).toBeNull();
    expect(serviceInserts[0]!.pickup_alert).toContain("compagnia traghetto/aliscafo non riconosciuta");
  });

  // STEP 9 — PARITY TEST: la regola DB vince sempre sul fallback statico quando presente
  it("PARITY: con context presente, la direct rule DB ha precedenza sul valore statico anche se diverso", async () => {
    // Valore statico reale noto (lib/departure-pickup-rules.ts, SNAV zona ischia 07:10): 06:30.
    const staticExpected = "06:30";
    const dbPickup = "06:20"; // deliberatamente diverso dallo statico

    const staticRun: Array<Record<string, unknown>> = [];
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(makeFakeAdmin({ serviceInserts: staticRun, directRules: [] })));
    await POST(makeRequest(basePayload({
      booking_service_kind: "formula_snav", trip_leg: "return_only",
      arrival_date: "2026-08-25", arrival_time: "10:00", ferry_dep_time: "07:10", porto_partenza: "Casamicciola",
    })));
    expect(staticRun[0]!.pickup_hotel).toBe(staticExpected);

    vi.clearAllMocks();
    mocks.resolveBookingPracticeNumber.mockResolvedValue("ITS-2026-2");
    const dbRun: Array<Record<string, unknown>> = [];
    const directRules = [directRule({ company: "snav", zone: "ischia", departure_time: "07:10", pickup_time: dbPickup })];
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(makeFakeAdmin({ serviceInserts: dbRun, directRules })));
    await POST(makeRequest(basePayload({
      booking_service_kind: "formula_snav", trip_leg: "return_only",
      arrival_date: "2026-08-25", arrival_time: "10:00", ferry_dep_time: "07:10", porto_partenza: "Casamicciola",
    })));

    expect(dbRun[0]!.pickup_hotel).toBe(dbPickup);
    expect(dbRun[0]!.pickup_hotel).not.toBe(staticExpected);
  });

  // STEP 10 — caso reale verificato (audit live DB): MEDMAR Napoli zona Ischia 17:00 -> 15:30
  it("caso reale (audit live 2026-09-03): formula_medmar_napoli zona ischia 17:00 -> pickup 15:30", async () => {
    const serviceInserts: Array<Record<string, unknown>> = [];
    const directRules = [directRule({
      company: "medmar", zone: "ischia", departure_time: "17:00", pickup_time: "15:30",
      embark_port: "ischia_porto", arrival_port: "napoli_beverello", agency_logic: "aleste",
    })];
    mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(makeFakeAdmin({
      serviceInserts, directRules, hotelZoneById: { [HOTEL_ID]: "ischia" },
    })));

    await POST(makeRequest(basePayload({
      booking_service_kind: "formula_medmar_napoli", trip_leg: "return_only",
      arrival_date: "2026-08-25", arrival_time: "10:00", ferry_dep_time: "17:00", porto_partenza: "Ischia Porto",
    })));

    expect(serviceInserts[0]!.pickup_hotel).toBe("15:30");
  });
});
