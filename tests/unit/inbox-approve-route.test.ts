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
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "order", "limit"]) b[m] = () => b;
    b.maybeSingle = async () => ({ data: null, error: null }); // nessuna bozza pre-esistente: sempre insert
    b.insert = (payload: Record<string, unknown>) => {
      opts.serviceInserts.push(payload);
      const id = `svc-${opts.serviceInserts.length}`;
      const result = { data: { id }, error: null };
      return { select: () => ({ single: async () => result }) };
    };
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
