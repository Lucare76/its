import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Bug reale: prenotazioni importate via IMAP+Claude (Aleste Viaggi, hotel
 * ISOLA VERDE HOTEL & THERMAL SPA) venivano approvate con anagrafica
 * corretta ma con i box operativi ARRIVO/PARTENZA quasi vuoti nella card
 * (lib/booking-list-display.ts::bookingListTransportTimes) e nella pagina
 * di modifica servizio (app/(app)/services/[id]/edit), perché
 * /api/email/inbox-approve scriveva solo i campi legacy (date/time/
 * outbound_time/return_time/vessel) e MAI arrival_date/arrival_time/
 * departure_date/departure_time/meeting_point/transport_code — gli unici
 * campi letti da quei due punti di lettura (senza alcun fallback).
 * departureDate/orario_partenza venivano perfino parsati e poi scartati.
 */

const mocks = vi.hoisted(() => ({
  authorizePricingRequest: vi.fn(),
  autoLinkImportedServices: vi.fn(),
}));

vi.mock("@/lib/server/pricing-auth", () => ({
  authorizePricingRequest: mocks.authorizePricingRequest,
}));

vi.mock("@/lib/server/transfer-ischia-blocks", () => ({
  autoLinkImportedServices: mocks.autoLinkImportedServices,
}));

import { POST } from "@/app/api/email/inbox-approve/route";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HOTEL_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const INBOUND_EMAIL_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

type FormState = {
  cliente_nome: string;
  cliente_cellulare: string;
  n_pax: string;
  hotel: string;
  data_arrivo: string;
  orario_arrivo: string;
  data_partenza: string;
  orario_partenza: string;
  tipo_servizio: string;
  treno_andata: string;
  treno_ritorno: string;
  citta_partenza: string;
  totale_pratica: string;
  note: string;
  numero_pratica: string;
  agenzia: string;
  pickup_hotel?: string;
};

/** Dati reali del caso di bug: conferma Aleste Viaggi, treno A/R. */
function alesteForm(overrides: Partial<FormState> = {}): FormState {
  return {
    cliente_nome: "STROZZI GIANLUCA",
    cliente_cellulare: "3488803921",
    n_pax: "2",
    hotel: "ISOLA VERDE HOTEL & THERMAL SPA",
    data_arrivo: "2026-08-30",
    orario_arrivo: "13:43",
    data_partenza: "2026-09-06",
    orario_partenza: "13:20",
    tipo_servizio: "transfer_station_hotel",
    treno_andata: "ITA 9919",
    treno_ritorno: "ITA 9940",
    citta_partenza: "TORINO PORTA NUOVA",
    totale_pratica: "104.00",
    note: "",
    numero_pratica: "26/002739",
    agenzia: "Aleste Viaggi",
    ...overrides,
  };
}

/** Dati reali STROZZI GIANLUCA (transfer_port_hotel puro, SNAV A/R). */
function portForm(overrides: Partial<FormState> = {}): FormState {
  return {
    cliente_nome: "STROZZI GIANLUCA",
    cliente_cellulare: "3488803921",
    n_pax: "2",
    hotel: "ISOLA VERDE HOTEL & THERMAL SPA",
    data_arrivo: "2026-08-30",
    orario_arrivo: "16:20",
    data_partenza: "2026-09-05",
    orario_partenza: "14:00",
    tipo_servizio: "transfer_port_hotel",
    treno_andata: "SNAV",
    treno_ritorno: "SNAV",
    citta_partenza: "PORTO NAPOLI",
    totale_pratica: "14",
    note: "",
    numero_pratica: "26/013082",
    agenzia: "Aleste Viaggi",
    ...overrides,
  };
}

function makeRequest(body: unknown) {
  return new NextRequest("http://localhost:3010/api/email/inbox-approve", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Stesso stile "generico + builder dedicato" di tests/unit/new-booking-practice-number.test.ts. */
function makeFakeAdmin(opts: {
  serviceInserts: Array<Record<string, unknown>>;
  hotelsSeed?: Array<{ id: string; name: string; zone?: string | null }>;
  hotelsInserts?: Array<Record<string, unknown>>;
  /** Riga restituita da findServiceByPattern (match "certo" su [pdf_composite]/[practice]/...). */
  dupCertainRow?: Record<string, unknown> | null;
  /** Righe restituite dalle query di lista del deduplicatore
   *  (findPotentialExistingMatches + hydrateDuplicateMatches). */
  dupListRows?: Array<Record<string, unknown>>;
  /** Servizi indirizzabili via link_to_service_id (id → riga). */
  existingServicesById?: Record<string, Record<string, unknown>>;
  inboundEmailUpdates?: Array<Record<string, unknown>>;
}) {
  const genericBuilder = (): Record<string, unknown> => {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "order", "limit", "ilike"]) b[m] = () => b;
    b.maybeSingle = async () => ({ data: null, error: null });
    b.single = async () => ({ data: { parsed_json: {} }, error: null });
    b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(resolve, reject);
    b.update = () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) });
    return b;
  };

  const servicesBuilder = (): Record<string, unknown> => {
    const state = { usedIlike: false, usedIn: false, eqId: null as string | null };
    const b: Record<string, unknown> = {};
    for (const m of ["select", "order", "limit"]) b[m] = () => b;
    b.eq = (field: string, value: string) => { if (field === "id") state.eqId = value; return b; };
    b.ilike = () => { state.usedIlike = true; return b; };
    b.in = () => { state.usedIn = true; return b; };
    b.maybeSingle = async () => {
      // .ilike → findServiceByPattern (match "certo" del deduplicatore)
      if (state.usedIlike) return { data: opts.dupCertainRow ?? null, error: null };
      // .eq("id",...) → lookup service esistente per link_to_service_id
      if (state.eqId) return { data: opts.existingServicesById?.[state.eqId] ?? null, error: null };
      // altrimenti → existingService per inbound_email_id (nessuna bozza: insert)
      return { data: null, error: null };
    };
    b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      // .in(...) → hydrateDuplicateMatches ; .ilike/.eq(...).limit(5) → findPotentialExistingMatches
      const rows = state.usedIn || state.usedIlike ? (opts.dupListRows ?? []) : [];
      return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
    };
    b.update = () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) });
    b.insert = (payload: Record<string, unknown>) => {
      opts.serviceInserts.push(payload);
      const id = `svc-${opts.serviceInserts.length}`;
      const result = { data: { id }, error: null };
      return { select: () => ({ single: async () => result }) };
    };
    return b;
  };

  const inboundEmailsBuilder = (): Record<string, unknown> => {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq"]) b[m] = () => b;
    b.maybeSingle = async () => ({ data: { parsed_json: {} }, error: null });
    b.single = async () => ({ data: { id: "inbound-1", parsed_json: {} }, error: null });
    b.update = (payload: Record<string, unknown>) => {
      (opts.inboundEmailUpdates ?? []).push(payload);
      return { eq: () => ({ eq: () => Promise.resolve({ error: null }) }) };
    };
    b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(resolve, reject);
    return b;
  };

  const hotelsBuilder = (): Record<string, unknown> => {
    const seed = opts.hotelsSeed ?? [];
    let filterId: string | null = null;
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = (field: string, value: string) => {
      if (field === "id") filterId = value;
      return b;
    };
    b.limit = () => b;
    // resolveOrCreateHotel usa .select().eq("tenant_id",...).limit(500) (via .then,
    // nessun .eq("id",...)); il lookup zona pickup usa .select("zone").eq("id",hotelId)
    // .maybeSingle() — filtro su filterId per distinguere i due usi sullo stesso builder.
    b.maybeSingle = async () => {
      const match = filterId ? seed.find((h) => h.id === filterId) ?? null : null;
      return { data: match, error: null };
    };
    b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve({ data: seed, error: null }).then(resolve, reject);
    b.insert = (payload: Record<string, unknown>) => {
      (opts.hotelsInserts ?? []).push(payload);
      const id = `hotel-new-${(opts.hotelsInserts ?? []).length}`;
      const result = { data: { id }, error: null };
      return { select: () => ({ single: async () => result }) };
    };
    return b;
  };

  const hotelAliasesBuilder = (): Record<string, unknown> => {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "limit"]) b[m] = () => b;
    b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(resolve, reject);
    b.insert = () => Promise.resolve({ data: null, error: null });
    return b;
  };

  return {
    from(table: string) {
      if (table === "services") return servicesBuilder();
      if (table === "hotels") return hotelsBuilder();
      if (table === "hotel_aliases") return hotelAliasesBuilder();
      if (table === "inbound_emails") return inboundEmailsBuilder();
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.autoLinkImportedServices.mockResolvedValue(undefined);
});

describe("POST /api/email/inbox-approve — parità campi operativi con il flusso manuale", () => {
  it("import con arrivo + partenza: valorizza arrival_date/time, departure_date/time, meeting_point, transport_code", async () => {
    const serviceInserts: Array<Record<string, unknown>> = [];
    mocks.authorizePricingRequest.mockResolvedValue(
      makeAuthContext(makeFakeAdmin({ serviceInserts, hotelsSeed: [] }))
    );

    const res = await POST(makeRequest({ inbound_email_id: INBOUND_EMAIL_ID, form: alesteForm() }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(serviceInserts).toHaveLength(1);
    const row = serviceInserts[0]!;

    // Campi che la card (bookingListTransportTimes) e la pagina di modifica
    // leggono senza alcun fallback su date/time/outbound_time/return_time.
    expect(row.arrival_date).toBe("2026-08-30");
    expect(row.arrival_time).toBe("13:43");
    expect(row.departure_date).toBe("2026-09-06");
    expect(row.departure_time).toBe("13:20");
    expect(row.meeting_point).toBe("TORINO PORTA NUOVA");
    expect(row.transport_code).toBe("ITA 9919 / ITA 9940");

    // Campi legacy: restano popolati per non rompere altri lettori (es. buildOperationalInstances).
    expect(row.date).toBe("2026-08-30");
    expect(row.time).toBe("13:43");
    expect(row.outbound_time).toBe("13:43");
    expect(row.return_time).toBe("13:20");
  });

  it("import con solo arrivo (nessun ritorno confermato): departure_date/time restano null, nessun crash", async () => {
    const serviceInserts: Array<Record<string, unknown>> = [];
    mocks.authorizePricingRequest.mockResolvedValue(
      makeAuthContext(makeFakeAdmin({ serviceInserts, hotelsSeed: [] }))
    );

    const form = alesteForm({ data_partenza: "", orario_partenza: "", treno_ritorno: "" });
    const res = await POST(makeRequest({ inbound_email_id: INBOUND_EMAIL_ID, form }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    const row = serviceInserts[0]!;

    expect(row.arrival_date).toBe("2026-08-30");
    expect(row.arrival_time).toBe("13:43");
    expect(row.departure_date).toBeNull();
    expect(row.departure_time).toBeNull();
    // Un solo codice mezzo disponibile: nessuna " / " spuria.
    expect(row.transport_code).toBe("ITA 9919");
    expect(row.meeting_point).toBe("TORINO PORTA NUOVA");
  });

  it("hotel riconosciuto: riusa l'hotel esistente per nome invece di crearne uno nuovo", async () => {
    const serviceInserts: Array<Record<string, unknown>> = [];
    const hotelsInserts: Array<Record<string, unknown>> = [];
    mocks.authorizePricingRequest.mockResolvedValue(
      makeAuthContext(
        makeFakeAdmin({
          serviceInserts,
          hotelsInserts,
          hotelsSeed: [{ id: HOTEL_ID, name: "Isola Verde Hotel & Thermal Spa" }],
        })
      )
    );

    const res = await POST(makeRequest({ inbound_email_id: INBOUND_EMAIL_ID, form: alesteForm() }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(hotelsInserts).toHaveLength(0);
    expect(serviceInserts[0]!.hotel_id).toBe(HOTEL_ID);
  });
});

describe("POST /api/email/inbox-approve — pickup hotel calcolato per transfer_port_hotel puri (SNAV/MEDMAR diretti)", () => {
  it("transfer_port_hotel con hotel zona nota + orario SNAV standard: calcola pickup_hotel dalla regola esistente (dati reali STROZZI GIANLUCA)", async () => {
    const serviceInserts: Array<Record<string, unknown>> = [];
    mocks.authorizePricingRequest.mockResolvedValue(
      makeAuthContext(
        makeFakeAdmin({
          serviceInserts,
          hotelsSeed: [{ id: HOTEL_ID, name: "Isola Verde Hotel & Thermal Spa", zone: "Ischia Porto" }],
        })
      )
    );

    const res = await POST(makeRequest({ inbound_email_id: INBOUND_EMAIL_ID, form: portForm() }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    const row = serviceInserts[0]!;
    // Regola SNAV_DIRECT (lib/departure-pickup-rules.ts): partenza 14:00, zona
    // "ischia" (normalizzata da "Ischia Porto") -> pickup 12:30. Non inventato:
    // stessa tabella già usata da app/api/ops/search per le gambe collegate.
    expect(row.pickup_hotel).toBe("12:30");
    expect(row.pickup_alert).toBeNull();
    expect(row.departure_time).toBe("14:00"); // resta l'orario del traghetto, non sovrascritto dal pickup
  });

  it("treno/aereo (transfer_train_hotel): pickup_hotel resta null, nessuna regola SNAV/MEDMAR applicata (comportamento invariato)", async () => {
    const serviceInserts: Array<Record<string, unknown>> = [];
    mocks.authorizePricingRequest.mockResolvedValue(
      makeAuthContext(makeFakeAdmin({ serviceInserts, hotelsSeed: [] }))
    );

    const res = await POST(makeRequest({ inbound_email_id: INBOUND_EMAIL_ID, form: alesteForm() }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    const row = serviceInserts[0]!;
    expect(row.pickup_hotel).toBeNull();
    expect(row.pickup_alert).toBeNull();
    // Il calcolo per treno/aereo passa da un altro sistema (calc-pickup-time.ts,
    // collegato solo a app/api/inbound/email e app/api/excel/import), non toccato qui.
    expect(row.departure_time).toBe("13:20");
  });

  it("hotel senza zona impostata: pickup_hotel resta null, pickup_alert segnala il dato anagrafico mancante (nessun orario inventato)", async () => {
    const serviceInserts: Array<Record<string, unknown>> = [];
    mocks.authorizePricingRequest.mockResolvedValue(
      makeAuthContext(
        makeFakeAdmin({
          serviceInserts,
          hotelsSeed: [{ id: HOTEL_ID, name: "Isola Verde Hotel & Thermal Spa", zone: undefined }],
        })
      )
    );

    const res = await POST(makeRequest({ inbound_email_id: INBOUND_EMAIL_ID, form: portForm() }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    const row = serviceInserts[0]!;
    expect(row.pickup_hotel).toBeNull();
    expect(String(row.pickup_alert)).toMatch(/zona/i);
    expect(String(row.pickup_alert)).toMatch(/Isola Verde/i);
  });

  it("orario traghetto non standard (nessuna corsa nota in tabella): pickup_hotel resta null, pickup_alert lo segnala esplicitamente", async () => {
    const serviceInserts: Array<Record<string, unknown>> = [];
    mocks.authorizePricingRequest.mockResolvedValue(
      makeAuthContext(
        makeFakeAdmin({
          serviceInserts,
          hotelsSeed: [{ id: HOTEL_ID, name: "Isola Verde Hotel & Thermal Spa", zone: "Ischia Porto" }],
        })
      )
    );

    const res = await POST(makeRequest({ inbound_email_id: INBOUND_EMAIL_ID, form: portForm({ orario_partenza: "14:07" }) }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    const row = serviceInserts[0]!;
    expect(row.pickup_hotel).toBeNull();
    expect(String(row.pickup_alert)).toMatch(/nessuna regola/i);
    expect(row.departure_time).toBe("14:07");
  });

  it("form.pickup_hotel valorizzato dall'operatore in Inbox: ha priorità sul calcolo automatico, nessun pickup_alert (fix: campo prima invisibile in Inbox)", async () => {
    const serviceInserts: Array<Record<string, unknown>> = [];
    mocks.authorizePricingRequest.mockResolvedValue(
      makeAuthContext(
        makeFakeAdmin({
          serviceInserts,
          // Orario non standard: senza override, produrrebbe un pickup_alert
          // ("nessuna regola ... orario non standard") come nel test sopra.
          hotelsSeed: [{ id: HOTEL_ID, name: "Isola Verde Hotel & Thermal Spa", zone: "Ischia Porto" }],
        })
      )
    );

    const res = await POST(
      makeRequest({
        inbound_email_id: INBOUND_EMAIL_ID,
        form: portForm({ orario_partenza: "14:07", pickup_hotel: "12:45" }),
      })
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    const row = serviceInserts[0]!;
    expect(row.pickup_hotel).toBe("12:45");
    expect(row.pickup_alert).toBeNull();
  });

  it("compagnia non riconosciuta (né SNAV né MEDMAR nel form): pickup_hotel resta null, pickup_alert lo segnala", async () => {
    const serviceInserts: Array<Record<string, unknown>> = [];
    mocks.authorizePricingRequest.mockResolvedValue(
      makeAuthContext(
        makeFakeAdmin({
          serviceInserts,
          hotelsSeed: [{ id: HOTEL_ID, name: "Isola Verde Hotel & Thermal Spa", zone: "Ischia Porto" }],
        })
      )
    );

    const res = await POST(
      makeRequest({ inbound_email_id: INBOUND_EMAIL_ID, form: portForm({ treno_andata: "", treno_ritorno: "" }) })
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    const row = serviceInserts[0]!;
    expect(row.pickup_hotel).toBeNull();
    expect(String(row.pickup_alert)).toMatch(/compagnia/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Regressione MARIOTTI: controllo duplicati LIVE prima dell'INSERT.
// Dati reali dell'audit: MARIOTTI SERENA, 2 pax, arrivo 2026-09-06, ISOLA VERDE
// HOTEL & THERMAL SPA, tel 3289126048. Record A (pratica 26/140508, arrivo
// 12:28) già a sistema; la nuova comunicazione ("MODIFICA ORARI", pratica
// 26/011405, arrivo 12:38, ritorno 13:18) NON deve creare un secondo service.
// ─────────────────────────────────────────────────────────────────────────────
const MARIOTTI_EXISTING_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function mariottiForm(overrides: Partial<FormState> = {}): FormState {
  return {
    cliente_nome: "MARIOTTI SERENA",
    cliente_cellulare: "3289126048",
    n_pax: "2",
    hotel: "ISOLA VERDE HOTEL & THERMAL SPA",
    data_arrivo: "2026-09-06",
    orario_arrivo: "12:38",
    data_partenza: "2026-09-13",
    orario_partenza: "13:18",
    tipo_servizio: "transfer_station_hotel",
    treno_andata: "ITA 8903",
    treno_ritorno: "ITA 9940",
    citta_partenza: "FIRENZE",
    totale_pratica: "112.00",
    note: "",
    numero_pratica: "26/011405",
    agenzia: "Aleste Viaggi",
    ...overrides,
  };
}

/** Riga "Record A" restituita sia dal match certo sia dalle liste soft. */
function mariottiExistingRow() {
  return {
    id: MARIOTTI_EXISTING_ID,
    status: "new",
    is_draft: false,
    customer_name: "MARIOTTI SERENA",
    phone: "3289126048",
    date: "2026-09-06",
    pax: 2,
    hotel_id: HOTEL_ID,
    agency_id: null,
    billing_party_name: "Aleste Viaggi",
    transport_code: null,
    outbound_time: "12:28",
    return_time: "13:20",
    arrival_time: null,
    departure_time: null,
    notes:
      "[pdf_import] Booking finale creato da PDF | [practice:26/140508] | " +
      "[pdf_composite:mariotti-serena-2026-09-06-isola-verde-hotel-thermal-spa]",
    hotels: { name: "Isola Verde Hotel & Thermal Spa" },
    agencies: null,
  };
}

describe("POST /api/email/inbox-approve — controllo duplicati LIVE (regressione MARIOTTI)", () => {
  it("primo tentativo di approvazione: nessun INSERT, 409 duplicate con il record esistente nei matches", async () => {
    const serviceInserts: Array<Record<string, unknown>> = [];
    mocks.authorizePricingRequest.mockResolvedValue(
      makeAuthContext(
        makeFakeAdmin({
          serviceInserts,
          hotelsSeed: [{ id: HOTEL_ID, name: "Isola Verde Hotel & Thermal Spa" }],
          dupCertainRow: { id: MARIOTTI_EXISTING_ID, is_draft: false, status: "new", inbound_email_id: null, notes: mariottiExistingRow().notes },
          dupListRows: [mariottiExistingRow()],
        })
      )
    );

    const res = await POST(makeRequest({ inbound_email_id: INBOUND_EMAIL_ID, form: mariottiForm() }));
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.duplicate).toBe(true);
    expect(serviceInserts).toHaveLength(0);
    expect(json.certain_service_id).toBe(MARIOTTI_EXISTING_ID);
    expect(Array.isArray(json.matches)).toBe(true);
    expect(json.matches.map((m: { service_id: string }) => m.service_id)).toContain(MARIOTTI_EXISTING_ID);
    // Il match riporta i dati per il confronto MODIFICA/AGGIUNGI.
    const m = json.matches.find((x: { service_id: string }) => x.service_id === MARIOTTI_EXISTING_ID);
    expect(m.customer_name).toBe("MARIOTTI SERENA");
    expect(m.practice_number).toBe("26/140508");
  });

  it("AGGIUNGI COMUNQUE (confirm_duplicate:true): crea il secondo service solo con conferma esplicita", async () => {
    const serviceInserts: Array<Record<string, unknown>> = [];
    mocks.authorizePricingRequest.mockResolvedValue(
      makeAuthContext(
        makeFakeAdmin({
          serviceInserts,
          hotelsSeed: [{ id: HOTEL_ID, name: "Isola Verde Hotel & Thermal Spa" }],
          dupCertainRow: { id: MARIOTTI_EXISTING_ID, is_draft: false, status: "new", inbound_email_id: null, notes: mariottiExistingRow().notes },
          dupListRows: [mariottiExistingRow()],
        })
      )
    );

    const res = await POST(
      makeRequest({ inbound_email_id: INBOUND_EMAIL_ID, form: mariottiForm(), confirm_duplicate: true })
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(serviceInserts).toHaveLength(1);
  });

  it("MODIFICA (link_to_service_id): nessun INSERT, la email viene collegata al service esistente", async () => {
    const serviceInserts: Array<Record<string, unknown>> = [];
    const inboundEmailUpdates: Array<Record<string, unknown>> = [];
    mocks.authorizePricingRequest.mockResolvedValue(
      makeAuthContext(
        makeFakeAdmin({
          serviceInserts,
          inboundEmailUpdates,
          existingServicesById: { [MARIOTTI_EXISTING_ID]: { id: MARIOTTI_EXISTING_ID } },
        })
      )
    );

    const res = await POST(
      makeRequest({ inbound_email_id: INBOUND_EMAIL_ID, form: mariottiForm(), link_to_service_id: MARIOTTI_EXISTING_ID })
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.linked).toBe(true);
    expect(json.service_id).toBe(MARIOTTI_EXISTING_ID);
    expect(serviceInserts).toHaveLength(0);
    expect(inboundEmailUpdates).toHaveLength(1);
    const pj = inboundEmailUpdates[0]!.parsed_json as Record<string, unknown>;
    expect(pj.review_status).toBe("confirmed");
    expect(pj.linked_service_id).toBe(MARIOTTI_EXISTING_ID);
  });

  it("SCARTA DUPLICATO (action:discard_duplicate): nessun INSERT, nessun UPDATE, inbound_email marcata scartata", async () => {
    const serviceInserts: Array<Record<string, unknown>> = [];
    const inboundEmailUpdates: Array<Record<string, unknown>> = [];
    mocks.authorizePricingRequest.mockResolvedValue(
      makeAuthContext(makeFakeAdmin({ serviceInserts, inboundEmailUpdates }))
    );

    const res = await POST(
      makeRequest({
        inbound_email_id: INBOUND_EMAIL_ID,
        action: "discard_duplicate",
        existing_service_id: MARIOTTI_EXISTING_ID,
      })
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.discarded).toBe(true);
    expect(serviceInserts).toHaveLength(0);
    expect(inboundEmailUpdates).toHaveLength(1);
    const pj = inboundEmailUpdates[0]!.parsed_json as Record<string, unknown>;
    expect(pj.duplicate_resolution).toBe("discarded");
    expect(pj.review_status).toBe("confirmed");
  });

  it("AGGIORNA ESISTENTE (action:update_existing): update in-place dello stesso ID, nessun INSERT, changed_fields solo campi realmente cambiati e non distruttivi", async () => {
    const serviceInserts: Array<Record<string, unknown>> = [];
    const inboundEmailUpdates: Array<Record<string, unknown>> = [];
    const existingRow = {
      id: MARIOTTI_EXISTING_ID,
      direction: "arrival",
      status: "new",
      is_draft: false,
      hotel_id: HOTEL_ID,
      customer_name: "MARIOTTI SERENA",
      phone: "3289126048",
      pax: 2,
      time: "12:28",
      outbound_time: "12:28",
      arrival_time: "12:28",
      return_time: "13:20",
      departure_time: "13:20",
      arrival_date: "2026-09-06",
      date: "2026-09-06",
      departure_date: "2026-09-13",
      meeting_point: "FIRENZE",
      transport_code: null,
      notes:
        "[pdf_import] Booking finale creato da PDF | [practice:26/140508] | " +
        "[pdf_composite:mariotti-serena-2026-09-06-isola-verde-hotel-thermal-spa]",
    };
    mocks.authorizePricingRequest.mockResolvedValue(
      makeAuthContext(
        makeFakeAdmin({
          serviceInserts,
          inboundEmailUpdates,
          hotelsSeed: [{ id: HOTEL_ID, name: "Isola Verde Hotel & Thermal Spa" }],
          dupCertainRow: { id: MARIOTTI_EXISTING_ID, is_draft: false, status: "new", inbound_email_id: null, notes: existingRow.notes },
          dupListRows: [existingRow],
          existingServicesById: { [MARIOTTI_EXISTING_ID]: existingRow },
        })
      )
    );

    const res = await POST(
      makeRequest({
        inbound_email_id: INBOUND_EMAIL_ID,
        form: mariottiForm(),
        action: "update_existing",
        existing_service_id: MARIOTTI_EXISTING_ID,
      })
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.updated).toBe(true);
    expect(json.service_id).toBe(MARIOTTI_EXISTING_ID);
    expect(serviceInserts).toHaveLength(0);
    // orari cambiati + mezzo + swap marker pratica
    expect(json.changed_fields).toEqual(
      expect.arrayContaining(["time", "arrival_time", "return_time", "departure_time", "transport_code", "notes"])
    );
    // Mai campi distruttivi / non presenti nella nuova comunicazione
    expect(json.changed_fields).not.toContain("status");
    expect(json.changed_fields).not.toContain("is_draft");
    expect(json.changed_fields).not.toContain("customer_name");
    expect(json.changed_fields).not.toContain("pax");
    expect(json.changed_fields).not.toContain("hotel_id");
    // email collegata al service esistente
    const pj = inboundEmailUpdates.at(-1)!.parsed_json as Record<string, unknown>;
    expect(pj.linked_service_id).toBe(MARIOTTI_EXISTING_ID);
    expect(pj.linked_via).toBe("duplicate_update");
  });

  it("SICUREZZA (action:update_existing): existing_service_id NON fra i duplicati rilevati → 422, nessun INSERT", async () => {
    const serviceInserts: Array<Record<string, unknown>> = [];
    const OTHER_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    mocks.authorizePricingRequest.mockResolvedValue(
      makeAuthContext(
        makeFakeAdmin({
          serviceInserts,
          hotelsSeed: [{ id: HOTEL_ID, name: "Isola Verde Hotel & Thermal Spa" }],
          dupCertainRow: null,
          dupListRows: [],
          existingServicesById: { [OTHER_ID]: { id: OTHER_ID, direction: "arrival" } },
        })
      )
    );

    const res = await POST(
      makeRequest({
        inbound_email_id: INBOUND_EMAIL_ID,
        form: mariottiForm(),
        action: "update_existing",
        existing_service_id: OTHER_ID,
      })
    );
    const json = await res.json();

    expect(res.status).toBe(422);
    expect(json.ok).toBe(false);
    expect(String(json.error)).toMatch(/non corrisponde/i);
    expect(serviceInserts).toHaveLength(0);
  });

  it("AGGIUNGI COME NUOVA (action:create_new) su possibile duplicato: crea la nuova prenotazione", async () => {
    const serviceInserts: Array<Record<string, unknown>> = [];
    const comitivaRow = {
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      status: "new",
      is_draft: false,
      customer_name: "MARIOTTI SERENA",
      phone: "3289126048",
      date: "2026-09-06",
      pax: 2,
      hotel_id: HOTEL_ID,
      notes: "",
      hotels: { name: "Isola Verde Hotel & Thermal Spa" },
      agencies: null,
    };
    mocks.authorizePricingRequest.mockResolvedValue(
      makeAuthContext(
        makeFakeAdmin({
          serviceInserts,
          hotelsSeed: [{ id: HOTEL_ID, name: "Isola Verde Hotel & Thermal Spa" }],
          dupCertainRow: null,
          dupListRows: [comitivaRow],
        })
      )
    );

    const res = await POST(
      makeRequest({ inbound_email_id: INBOUND_EMAIL_ID, form: mariottiForm(), action: "create_new" })
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(serviceInserts).toHaveLength(1);
  });

  it("COMITIVE: stesso telefono + stessa data, persone diverse → 409 come possibile match (NON certo), operatore può aggiungere", async () => {
    const serviceInserts: Array<Record<string, unknown>> = [];
    // Membro comitiva già a sistema: stesso telefono, altra persona.
    const comitivaRow = {
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      status: "new",
      is_draft: false,
      customer_name: "LEVI STEFANIA",
      phone: "3382157166",
      date: "2026-07-12",
      pax: 3,
      hotel_id: HOTEL_ID,
      notes: "",
      hotels: { name: "Hotel X" },
      agencies: null,
    };
    mocks.authorizePricingRequest.mockResolvedValue(
      makeAuthContext(
        makeFakeAdmin({
          serviceInserts,
          hotelsSeed: [{ id: HOTEL_ID, name: "Hotel X" }],
          dupCertainRow: null, // nessun match certo (né composite né pratica né hash)
          dupListRows: [comitivaRow],
        })
      )
    );

    const form = alesteForm({
      cliente_nome: "LEVI ALLEGRA",
      cliente_cellulare: "3382157166",
      data_arrivo: "2026-07-12",
      n_pax: "2",
      numero_pratica: "", // nessuna pratica → nessun match "certo" possibile
    });
    const res = await POST(makeRequest({ inbound_email_id: INBOUND_EMAIL_ID, form }));
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.duplicate).toBe(true);
    expect(json.certain_service_id).toBeNull(); // NON trattato come duplicato certo
    expect(serviceInserts).toHaveLength(0); // l'operatore decide (Aggiungi comunque / Modifica)
    expect(json.matches.length).toBeGreaterThan(0);
  });
});
