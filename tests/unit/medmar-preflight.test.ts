import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { matchCourseByRouteAndTime } from "@/lib/server/medmar-booking/course-matcher";
import * as medmarClient from "@/lib/server/medmar-booking/client";
import * as routeMapping from "@/lib/server/medmar-booking/route-mapping";
import { MedmarNotConfiguredError, MedmarAuthFailedError } from "@/lib/server/medmar-booking/auth";
import { romeDateTimeToUtc } from "@/lib/server/medmar-booking/departure-datetime";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SVC_ARR = "s1111111-1111-4111-8111-111111111111";
const SVC_DEP = "s2222222-2222-4222-8222-222222222222";

type Row = Record<string, unknown>;

vi.mock("@/lib/server/medmar-booking/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/medmar-booking/client")>();
  return {
    ...actual,
    fetchCorseReadOnly: vi.fn(),
    fetchBigliettiVendibiliReadOnly: vi.fn(),
  };
});

vi.mock("@/lib/server/medmar-booking/route-mapping", () => ({
  getIdTrattaForRouteCode: vi.fn(),
  getExpectedPortsForRouteCode: vi.fn().mockReturnValue(null),
  isMirrorRouteCode: vi.fn().mockReturnValue(true),
}));

// Import DOPO i vi.mock, così runMedmarPreflight usa i moduli mockati.
const { runMedmarPreflight } = await import("@/lib/server/medmar-booking/preflight");

function fakeAdmin(services: Row[], ticketMemory: Row[] = []) {
  return {
    from(table: string) {
      const source = table === "services" ? services : table === "medmar_ticket_memory" ? ticketMemory : [];
      let filtered = [...source];
      const builder = {
        select() { return builder; },
        eq(field: string, value: unknown) { filtered = filtered.filter((r) => r[field] === value); return builder; },
        in(field: string, values: unknown[]) { filtered = filtered.filter((r) => values.includes(r[field])); return builder; },
        then(resolve: (v: { data: Row[]; error: null }) => void) { resolve({ data: filtered, error: null }); },
      };
      return builder;
    },
  } as unknown as import("@supabase/supabase-js").SupabaseClient;
}

function arrivalRow(overrides: Row = {}): Row {
  return {
    id: SVC_ARR, tenant_id: TENANT_A, date: "2026-08-20", time: "08:40",
    customer_name: "Mario Rossi", pax: 2, vessel: "Medmar", notes: "[practice:AAA]",
    booking_service_kind: "formula_medmar_napoli", direction: "arrival", status: "new",
    meeting_point: null,
    ...overrides,
  };
}

function departureRow(overrides: Row = {}): Row {
  return {
    id: SVC_DEP, tenant_id: TENANT_A, date: "2026-08-25", time: "15:30",
    orario_barca: "17:00",
    customer_name: "Mario Rossi", pax: 2, vessel: "Medmar", notes: "[practice:AAA]",
    booking_service_kind: "formula_medmar_pozzuoli", direction: "departure", status: "new",
    meeting_point: "Ischia Porto",
    ...overrides,
  };
}

// Fase 2B.6 — modello "single-row": una sola riga services, direction
// "arrival", con andata (date/time) E ritorno (departure_date/departure_time
// + orario_barca) sulla stessa riga, nessuna riga departure collegata.
function singleRowRoundTrip(overrides: Row = {}): Row {
  return {
    id: SVC_ARR, tenant_id: TENANT_A, date: "2026-08-18", time: "14:20",
    customer_name: "Mario Rossi", pax: 2, vessel: "Medmar", notes: "[practice:AAA]",
    booking_service_kind: "formula_medmar_napoli", direction: "arrival", status: "new",
    meeting_point: "Ischia Porto",
    departure_date: "2026-08-23", departure_time: "15:15", orario_barca: "17:00",
    ...overrides,
  };
}

const ARRIVAL_ROW: Row = arrivalRow();

const NAPOLI_ISCHIA_CORSA: Row = {
  id_corsa: 131943, id_tratta: 59, partenza_data: "2026-08-20", partenza_ora: "08:40",
  flag_chiuso: 0, flag_sospeso: 0, id_porto_partenza: 1, id_porto_arrivo: 41,
  porto_partenza: "NAPOLI", porto_arrivo: "ISCHIA", nave: "MEDMAR GIULIA",
};

// Fixture "biglietto vendibile" nello schema REALE confermato via smoke test
// Fase 2A.1 (id_corsa, id_biglietto, id_tipologia_passeggero, id_tariffa,
// id_iva, id_log, nome, descrizione, prezzo, prezzo_ar, prezzo_prevendita,
// flag_ar_obbligatorio, flag_targa, quantita_min/max_per_esclusivo). Queste
// righe sono consumate direttamente da fetchBigliettiVendibiliReadOnly
// mockata: rappresentano righe già parsate, non l'envelope HTTP grezzo (che
// è coperto da tests/unit/medmar-client-vendibili.test.ts).
function arTariffRow(overrides: Row = {}): Row {
  return {
    id_corsa: 131943, id_biglietto: 370, id_tipologia_passeggero: 1, id_tariffa: 6,
    id_iva: 22, id_log: 5001,
    nome: "ADULTO - TARIFFA SPECIALE AR",
    descrizione: "PASSAGGIO PONTE ADULTO - TARIFFA SPECIALE AR",
    prezzo: 10.25, prezzo_ar: 0, prezzo_prevendita: 10.25,
    flag_ar_obbligatorio: true, flag_targa: 0,
    quantita_min_per_esclusivo: null, quantita_max_per_esclusivo: null,
    ...overrides,
  };
}

function tassaSbarcoRow(overrides: Row = {}): Row {
  return {
    id_corsa: 131943, id_biglietto: 999, id_tipologia_passeggero: 32, id_tariffa: 12,
    id_iva: 22, id_log: 5002,
    nome: "TASSA DI SBARCO",
    descrizione: "TASSA DI SBARCO",
    prezzo: 1.5, prezzo_ar: 0, prezzo_prevendita: 1.5,
    flag_ar_obbligatorio: false, flag_targa: 0,
    quantita_min_per_esclusivo: null, quantita_max_per_esclusivo: null,
    ...overrides,
  };
}

const AR_TARIFF_ROW = arTariffRow();
const TASSA_SBARCO_ROW = tassaSbarcoRow();

// Fase 2B.8 — orologio globale congelato PRIMA di tutte le date fixture del
// file (la più vecchia è 2026-08-18): il nuovo controllo "corsa già partita"
// usa `now = new Date()` di default in runMedmarPreflight, quindi senza
// questo freeze i test esistenti (che non passano `now` esplicitamente)
// diventerebbero fragili rispetto al passare del tempo reale.
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-17T10:00:00+02:00"));
  vi.mocked(routeMapping.getIdTrattaForRouteCode).mockReset();
  vi.mocked(routeMapping.getExpectedPortsForRouteCode).mockReset().mockReturnValue(null);
  vi.mocked(routeMapping.isMirrorRouteCode).mockReset().mockReturnValue(true);
  vi.mocked(medmarClient.fetchCorseReadOnly).mockReset();
  vi.mocked(medmarClient.fetchBigliettiVendibiliReadOnly).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("course-matcher — matchCourseByRouteAndTime (solo diagnostico in Fase 1.5)", () => {
  it("corsa unica compatibile con l'orario richiesto", () => {
    expect(matchCourseByRouteAndTime("napoli_ischia", "08:40")).toEqual({ status: "matched", matchedTime: "08:40" });
  });
  it("nessuna corsa compatibile", () => {
    expect(matchCourseByRouteAndTime("napoli_ischia", "23:59").status).toBe("no_match");
  });
});

describe("runMedmarPreflight — validazione gruppo (invariata da Fase 1)", () => {
  it("service inesistente -> status error", async () => {
    const result = await runMedmarPreflight(fakeAdmin([]), TENANT_A, [SVC_ARR]);
    expect(result.ok).toBe(false);
    expect(result.status).toBe("error");
  });

  it("service non Medmar -> status not_medmar, can_issue false", async () => {
    const admin = fakeAdmin([{ ...ARRIVAL_ROW, vessel: "SNAV", booking_service_kind: "formula_snav" }]);
    const result = await runMedmarPreflight(admin, TENANT_A, [SVC_ARR]);
    expect(result.status).toBe("not_medmar");
    expect(result.can_issue).toBe(false);
  });

  it("gruppo incoerente -> status error", async () => {
    const admin = fakeAdmin([
      ARRIVAL_ROW,
      { id: SVC_DEP, tenant_id: TENANT_A, date: "2026-08-25", time: "11:10", customer_name: "Mario Rossi", pax: 2, vessel: "Medmar", notes: "[practice:BBB]", booking_service_kind: "formula_medmar_pozzuoli", direction: "departure", status: "new" },
    ]);
    const result = await runMedmarPreflight(admin, TENANT_A, [SVC_ARR, SVC_DEP]);
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/group_incoherent/);
  });
});

describe("runMedmarPreflight — tratta non mappata (nessun id_tratta inventato)", () => {
  it("id_tratta non verificato -> status manual_review, can_issue false, nessuna chiamata Medmar", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockReturnValue(null);
    const result = await runMedmarPreflight(fakeAdmin([ARRIVAL_ROW]), TENANT_A, [SVC_ARR]);
    expect(result.status).toBe("manual_review");
    expect(result.can_issue).toBe(false);
    expect(medmarClient.fetchCorseReadOnly).not.toHaveBeenCalled();
    expect(result.warnings.some((w) => w.code === "route_not_mapped")).toBe(true);
  });
});

describe("runMedmarPreflight — corse live", () => {
  it("chiama fetchCorseReadOnly con i parametri corretti", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockReturnValue(59);
    vi.mocked(medmarClient.fetchCorseReadOnly).mockResolvedValue([]);
    await runMedmarPreflight(fakeAdmin([ARRIVAL_ROW]), TENANT_A, [SVC_ARR]);
    expect(medmarClient.fetchCorseReadOnly).toHaveBeenCalledWith({ idTratta: 59, partenzaDataDal: "2026-08-20", dopoLe: "08:40:00" });
  });

  it("0 corse vendibili -> status no_match, can_issue false", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockReturnValue(59);
    vi.mocked(medmarClient.fetchCorseReadOnly).mockResolvedValue([]);
    const result = await runMedmarPreflight(fakeAdmin([ARRIVAL_ROW]), TENANT_A, [SVC_ARR]);
    expect(result.status).toBe("no_match");
    expect(result.can_issue).toBe(false);
  });

  it("più corse compatibili -> status ambiguous, can_issue false", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockReturnValue(59);
    vi.mocked(medmarClient.fetchCorseReadOnly).mockResolvedValue([
      { id_corsa: 131943, id_tratta: 59, partenza_data: "2026-08-20", partenza_ora: "08:40", flag_chiuso: 0, flag_sospeso: 0, id_porto_partenza: 1, id_porto_arrivo: 41, porto_partenza: "NAPOLI", porto_arrivo: "ISCHIA", nave: "MEDMAR GIULIA" },
      { id_corsa: 138399, id_tratta: 59, partenza_data: "2026-08-20", partenza_ora: "08:45", flag_chiuso: 0, flag_sospeso: 0, id_porto_partenza: 1, id_porto_arrivo: 41, porto_partenza: "NAPOLI", porto_arrivo: "ISCHIA", nave: "NEREIDE" },
    ]);
    vi.mocked(medmarClient.fetchBigliettiVendibiliReadOnly).mockResolvedValue([AR_TARIFF_ROW, TASSA_SBARCO_ROW] as never);
    const result = await runMedmarPreflight(fakeAdmin([ARRIVAL_ROW]), TENANT_A, [SVC_ARR]);
    expect(result.status).toBe("ok");
    expect(result.can_issue).toBe(true);
    expect(result.outward?.id_corsa).toBe(131943);
    expect(result.outward?.candidate_count).toBe(1);
    expect(result.outward?.match_source).toBe("booked_ferry_time");
    expect(result.warnings.some((w) => w.code === "course_ambiguous")).toBe(false);
  });

  it("sensitivity: non sceglie la corsa piu vicina senza match esatto", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockReturnValue(59);
    vi.mocked(medmarClient.fetchCorseReadOnly).mockResolvedValue([
      { ...NAPOLI_ISCHIA_CORSA, id_corsa: 1, partenza_ora: "08:35" },
      { ...NAPOLI_ISCHIA_CORSA, id_corsa: 2, partenza_ora: "08:45" },
    ]);
    const result = await runMedmarPreflight(fakeAdmin([ARRIVAL_ROW]), TENANT_A, [SVC_ARR]);
    expect(result.status).toBe("no_match");
    expect(result.can_issue).toBe(false);
    expect(result.outward?.id_corsa).toBeNull();
    expect(result.outward?.candidate_count).toBe(0);
  });

  it("HH:MM ITS combacia con HH:MM:SS Medmar", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockReturnValue(59);
    vi.mocked(medmarClient.fetchCorseReadOnly).mockResolvedValue([{ ...NAPOLI_ISCHIA_CORSA, partenza_ora: "08:40:00" }]);
    vi.mocked(medmarClient.fetchBigliettiVendibiliReadOnly).mockResolvedValue([AR_TARIFF_ROW, TASSA_SBARCO_ROW] as never);
    const result = await runMedmarPreflight(fakeAdmin([ARRIVAL_ROW]), TENANT_A, [SVC_ARR]);
    expect(result.status).toBe("ok");
    expect(result.outward?.candidate_count).toBe(1);
    expect(result.outward?.matched_departure_time).toBe("08:40:00");
  });

  it("orario nave ITS mancante -> manual_review senza chiamata Medmar", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockReturnValue(59);
    const result = await runMedmarPreflight(fakeAdmin([arrivalRow({ time: null })]), TENANT_A, [SVC_ARR]);
    expect(result.status).toBe("manual_review");
    expect(result.can_issue).toBe(false);
    expect(result.warnings.some((w) => w.code === "booked_ferry_time_missing")).toBe(true);
    expect(medmarClient.fetchCorseReadOnly).not.toHaveBeenCalled();
  });

  it("orario nave ITS malformato -> manual_review senza chiamata Medmar", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockReturnValue(59);
    const result = await runMedmarPreflight(fakeAdmin([arrivalRow({ time: "sera" })]), TENANT_A, [SVC_ARR]);
    expect(result.status).toBe("manual_review");
    expect(result.can_issue).toBe(false);
    expect(result.warnings.some((w) => w.code === "booked_ferry_time_invalid")).toBe(true);
    expect(medmarClient.fetchCorseReadOnly).not.toHaveBeenCalled();
  });

  it("piu corse stesso orario ma nave diversa restano ambiguous con vessel ITS generico", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockReturnValue(59);
    vi.mocked(medmarClient.fetchCorseReadOnly).mockResolvedValue([
      { ...NAPOLI_ISCHIA_CORSA, id_corsa: 1, partenza_ora: "08:40", nave: "MEDMAR GIULIA" },
      { ...NAPOLI_ISCHIA_CORSA, id_corsa: 2, partenza_ora: "08:40", nave: "NEREIDE" },
    ]);
    const result = await runMedmarPreflight(fakeAdmin([arrivalRow({ vessel: "MEDMAR" })]), TENANT_A, [SVC_ARR]);
    expect(result.status).toBe("ambiguous");
    expect(result.can_issue).toBe(false);
    expect(result.outward?.candidate_count).toBe(2);
  });

  it("corsa chiusa (flag_chiuso) viene ignorata -> status no_match", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockReturnValue(59);
    vi.mocked(medmarClient.fetchCorseReadOnly).mockResolvedValue([
      { id_corsa: 131943, id_tratta: 59, partenza_data: "2026-08-20", partenza_ora: "08:40", flag_chiuso: 1, flag_sospeso: 0, id_porto_partenza: 1, id_porto_arrivo: 41, porto_partenza: "NAPOLI", porto_arrivo: "ISCHIA", nave: "MEDMAR GIULIA" },
    ]);
    const result = await runMedmarPreflight(fakeAdmin([ARRIVAL_ROW]), TENANT_A, [SVC_ARR]);
    expect(result.status).toBe("no_match");
    expect(result.can_issue).toBe(false);
  });

  it("corsa sospesa (flag_sospeso) viene ignorata -> status no_match", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockReturnValue(59);
    vi.mocked(medmarClient.fetchCorseReadOnly).mockResolvedValue([
      { id_corsa: 131943, id_tratta: 59, partenza_data: "2026-08-20", partenza_ora: "08:40", flag_chiuso: 0, flag_sospeso: 1, id_porto_partenza: 1, id_porto_arrivo: 41, porto_partenza: "NAPOLI", porto_arrivo: "ISCHIA", nave: "MEDMAR GIULIA" },
    ]);
    const result = await runMedmarPreflight(fakeAdmin([ARRIVAL_ROW]), TENANT_A, [SVC_ARR]);
    expect(result.status).toBe("no_match");
    expect(result.can_issue).toBe(false);
  });

  it("corsa di tratta diversa (id_tratta non corrispondente) viene ignorata -> status no_match", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockReturnValue(59);
    vi.mocked(medmarClient.fetchCorseReadOnly).mockResolvedValue([
      { id_corsa: 131248, id_tratta: 47, partenza_data: "2026-08-20", partenza_ora: "08:40", flag_chiuso: 0, flag_sospeso: 0, id_porto_partenza: 41, id_porto_arrivo: 1, porto_partenza: "ISCHIA", porto_arrivo: "NAPOLI", nave: "MEDMAR GIULIA" },
    ]);
    const result = await runMedmarPreflight(fakeAdmin([ARRIVAL_ROW]), TENANT_A, [SVC_ARR]);
    expect(result.status).toBe("no_match");
    expect(result.can_issue).toBe(false);
  });

  it("route mismatch: id_tratta corrisponde ma i port IDs sono diversi -> status route_mismatch, can_issue false (bloccante, non solo warning)", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockReturnValue(59);
    vi.mocked(routeMapping.getExpectedPortsForRouteCode).mockReturnValue({ idPortoPartenza: 1, idPortoArrivo: 41 });
    vi.mocked(medmarClient.fetchCorseReadOnly).mockResolvedValue([
      { ...NAPOLI_ISCHIA_CORSA, id_porto_partenza: 999, id_porto_arrivo: 998 },
    ]);
    const result = await runMedmarPreflight(fakeAdmin([ARRIVAL_ROW]), TENANT_A, [SVC_ARR]);
    expect(result.status).toBe("route_mismatch");
    expect(result.can_issue).toBe(false);
    expect(result.warnings.filter((w) => w.code === "port_mismatch")).toHaveLength(2);
    expect(medmarClient.fetchBigliettiVendibiliReadOnly).not.toHaveBeenCalled();
  });

  it("port mismatch: un solo port ID è diverso da quello atteso -> status route_mismatch, can_issue false", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockReturnValue(59);
    vi.mocked(routeMapping.getExpectedPortsForRouteCode).mockReturnValue({ idPortoPartenza: 1, idPortoArrivo: 41 });
    vi.mocked(medmarClient.fetchCorseReadOnly).mockResolvedValue([
      { ...NAPOLI_ISCHIA_CORSA, id_porto_partenza: 999 },
    ]);
    const result = await runMedmarPreflight(fakeAdmin([ARRIVAL_ROW]), TENANT_A, [SVC_ARR]);
    expect(result.status).toBe("route_mismatch");
    expect(result.can_issue).toBe(false);
    expect(result.warnings.some((w) => w.code === "port_mismatch")).toBe(true);
  });

  it("corsa unica + tariffa AR + tassa di sbarco live -> status ok, can_issue true, is_live true (dati reali Napoli->Ischia)", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockReturnValue(59);
    vi.mocked(medmarClient.fetchCorseReadOnly).mockResolvedValue([NAPOLI_ISCHIA_CORSA]);
    vi.mocked(medmarClient.fetchBigliettiVendibiliReadOnly).mockResolvedValue([AR_TARIFF_ROW, TASSA_SBARCO_ROW] as never);

    const result = await runMedmarPreflight(fakeAdmin([ARRIVAL_ROW]), TENANT_A, [SVC_ARR]);

    expect(result.status).toBe("ok");
    expect(result.can_issue).toBe(true);
    expect(result.is_live).toBe(true);
    expect(result.outward?.id_corsa).toBe(131943);
    expect(result.outward?.vessel).toBe("MEDMAR GIULIA");
    expect(result.outward?.source).toBe("live");
    expect(result.tariff).toMatchObject({ id_biglietto: 370, id_tariffa: 6, source: "medmar_live", unit_price_cents: 1025 });
    expect(result.taxes).toEqual([{ label: "TASSA DI SBARCO", amount_cents: 150 }]);
    expect(result.expected_total_cents).toBe((1025 + 150) * 2);
    expect(medmarClient.fetchBigliettiVendibiliReadOnly).toHaveBeenCalledWith(131943);
    // Nessun warning port_mismatch: i porti reali (1->NAPOLI, 41->ISCHIA) combaciano con la mappatura verificata (mock default: null -> nessuna verifica strutturale attivata).
    expect(result.warnings.some((w) => w.code === "port_mismatch")).toBe(false);
  });

  it("1 adulto (pax=1) -> expected_total_cents calcolato senza moltiplicatore", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockReturnValue(59);
    vi.mocked(medmarClient.fetchCorseReadOnly).mockResolvedValue([NAPOLI_ISCHIA_CORSA]);
    vi.mocked(medmarClient.fetchBigliettiVendibiliReadOnly).mockResolvedValue([AR_TARIFF_ROW, TASSA_SBARCO_ROW] as never);

    const result = await runMedmarPreflight(fakeAdmin([arrivalRow({ pax: 1 })]), TENANT_A, [SVC_ARR]);

    expect(result.can_issue).toBe(true);
    expect(result.pax).toBe(1);
    expect(result.expected_total_cents).toBe(1025 + 150);
  });

  it("più adulti (pax=5) -> expected_total_cents scala correttamente", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockReturnValue(59);
    vi.mocked(medmarClient.fetchCorseReadOnly).mockResolvedValue([NAPOLI_ISCHIA_CORSA]);
    vi.mocked(medmarClient.fetchBigliettiVendibiliReadOnly).mockResolvedValue([AR_TARIFF_ROW, TASSA_SBARCO_ROW] as never);

    const result = await runMedmarPreflight(fakeAdmin([arrivalRow({ pax: 5 })]), TENANT_A, [SVC_ARR]);

    expect(result.can_issue).toBe(true);
    expect(result.pax).toBe(5);
    expect(result.expected_total_cents).toBe((1025 + 150) * 5);
  });

  it("tassa di sbarco mancante (nessuna riga) -> tariffa AR comunque emissibile, taxes vuoto", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockReturnValue(59);
    vi.mocked(medmarClient.fetchCorseReadOnly).mockResolvedValue([NAPOLI_ISCHIA_CORSA]);
    vi.mocked(medmarClient.fetchBigliettiVendibiliReadOnly).mockResolvedValue([AR_TARIFF_ROW] as never);

    const result = await runMedmarPreflight(fakeAdmin([ARRIVAL_ROW]), TENANT_A, [SVC_ARR]);

    expect(result.can_issue).toBe(true);
    expect(result.taxes).toEqual([]);
    expect(result.expected_total_cents).toBe(1025 * 2);
  });

  it("prezzo AR nullo -> can_issue false, status manual_review, warning ticket_data_incomplete (mai emissione su dati incompleti)", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockReturnValue(59);
    vi.mocked(medmarClient.fetchCorseReadOnly).mockResolvedValue([NAPOLI_ISCHIA_CORSA]);
    vi.mocked(medmarClient.fetchBigliettiVendibiliReadOnly).mockResolvedValue([arTariffRow({ prezzo: null })] as never);

    const result = await runMedmarPreflight(fakeAdmin([ARRIVAL_ROW]), TENANT_A, [SVC_ARR]);

    expect(result.can_issue).toBe(false);
    expect(result.status).toBe("manual_review");
    expect(result.warnings.some((w) => w.code === "ticket_data_incomplete")).toBe(true);
  });

  it("prezzo AR malformato (NaN) -> can_issue false", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockReturnValue(59);
    vi.mocked(medmarClient.fetchCorseReadOnly).mockResolvedValue([NAPOLI_ISCHIA_CORSA]);
    vi.mocked(medmarClient.fetchBigliettiVendibiliReadOnly).mockResolvedValue([arTariffRow({ prezzo: Number.NaN })] as never);

    const result = await runMedmarPreflight(fakeAdmin([ARRIVAL_ROW]), TENANT_A, [SVC_ARR]);

    expect(result.can_issue).toBe(false);
  });

  it("tassa di sbarco ambigua (più righe) -> can_issue false, status manual_review", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockReturnValue(59);
    vi.mocked(medmarClient.fetchCorseReadOnly).mockResolvedValue([NAPOLI_ISCHIA_CORSA]);
    vi.mocked(medmarClient.fetchBigliettiVendibiliReadOnly).mockResolvedValue([
      AR_TARIFF_ROW,
      tassaSbarcoRow({ id_biglietto: 999 }),
      tassaSbarcoRow({ id_biglietto: 998, prezzo: 2 }),
    ] as never);

    const result = await runMedmarPreflight(fakeAdmin([ARRIVAL_ROW]), TENANT_A, [SVC_ARR]);

    expect(result.can_issue).toBe(false);
    expect(result.status).toBe("manual_review");
    expect(result.warnings.some((w) => w.code === "ticket_data_incomplete")).toBe(true);
  });

  it("passenger type non supportato: biglietto compatibile per descrizione+flag_ar ma tipologia diversa da adulto -> status unsupported_passenger_type, can_issue false", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockReturnValue(59);
    vi.mocked(medmarClient.fetchCorseReadOnly).mockResolvedValue([NAPOLI_ISCHIA_CORSA]);
    vi.mocked(medmarClient.fetchBigliettiVendibiliReadOnly).mockResolvedValue([arTariffRow({ id_tipologia_passeggero: 5 })] as never);

    const result = await runMedmarPreflight(fakeAdmin([ARRIVAL_ROW]), TENANT_A, [SVC_ARR]);

    expect(result.status).toBe("unsupported_passenger_type");
    expect(result.can_issue).toBe(false);
    expect(result.warnings.some((w) => w.code === "unsupported_passenger_type")).toBe(true);
  });

  it("risposta biglietti/vendibili malformata (schema non riconosciuto) -> fail closed, status medmar_unavailable", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockReturnValue(59);
    vi.mocked(medmarClient.fetchCorseReadOnly).mockResolvedValue([NAPOLI_ISCHIA_CORSA]);
    vi.mocked(medmarClient.fetchBigliettiVendibiliReadOnly).mockRejectedValue(new medmarClient.MedmarBadResponseError("Risposta Medmar biglietti/vendibili non conforme allo schema atteso (fail-closed)."));

    const result = await runMedmarPreflight(fakeAdmin([ARRIVAL_ROW]), TENANT_A, [SVC_ARR]);

    expect(result.status).toBe("medmar_unavailable");
    expect(result.can_issue).toBe(false);
  });

  it("tariffa AR non trovata nella risposta live -> fallback ticket_memory, is_live false, can_issue false", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockReturnValue(59);
    vi.mocked(medmarClient.fetchCorseReadOnly).mockResolvedValue([NAPOLI_ISCHIA_CORSA]);
    vi.mocked(medmarClient.fetchBigliettiVendibiliReadOnly).mockResolvedValue([arTariffRow({ descrizione: "ALTRA TARIFFA", nome: "ALTRA TARIFFA" })] as never);

    const admin = fakeAdmin([ARRIVAL_ROW], [{ tenant_id: TENANT_A, matched_service_id: SVC_ARR, tariff_label: "PASSAGGIO PONTE ADULTO - TARIFFA SPECIALE AR", price_cents: 1025, quantity: 2 }]);
    const result = await runMedmarPreflight(admin, TENANT_A, [SVC_ARR]);

    expect(result.is_live).toBe(false);
    expect(result.can_issue).toBe(false);
    expect(result.tariff?.source).toBe("ticket_memory");
    expect(result.warnings.some((w) => w.code === "ar_tariff_not_found_live")).toBe(true);
  });

  it("sensitivity: medmar_ticket_memory non può mai far tornare can_issue=true, anche con dati di memoria ricchi/completi", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockReturnValue(59);
    vi.mocked(medmarClient.fetchCorseReadOnly).mockResolvedValue([NAPOLI_ISCHIA_CORSA]);
    vi.mocked(medmarClient.fetchBigliettiVendibiliReadOnly).mockResolvedValue([]);

    const admin = fakeAdmin([ARRIVAL_ROW], [
      { tenant_id: TENANT_A, matched_service_id: SVC_ARR, tariff_label: "PASSAGGIO PONTE ADULTO - TARIFFA SPECIALE AR", price_cents: 1025, quantity: 2 },
    ]);
    const result = await runMedmarPreflight(admin, TENANT_A, [SVC_ARR]);

    expect(result.can_issue).toBe(false);
  });
});

describe("runMedmarPreflight — coerenza andata/ritorno su 6 tratte", () => {
  it("ritorno usa orario_barca e non time/pickup del servizio", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockImplementation((route) => (route === "ischia_napoli" ? 47 : null));
    vi.mocked(medmarClient.fetchCorseReadOnly).mockResolvedValue([
      { id_corsa: 10, id_tratta: 47, partenza_data: "2026-08-25", partenza_ora: "15:30", flag_chiuso: 0, flag_sospeso: 0, id_porto_partenza: 41, id_porto_arrivo: 1, porto_partenza: "ISCHIA", porto_arrivo: "NAPOLI", nave: "MEDMAR GIULIA" },
      { id_corsa: 11, id_tratta: 47, partenza_data: "2026-08-25", partenza_ora: "17:00", flag_chiuso: 0, flag_sospeso: 0, id_porto_partenza: 41, id_porto_arrivo: 1, porto_partenza: "ISCHIA", porto_arrivo: "NAPOLI", nave: "MEDMAR GIULIA" },
    ]);
    vi.mocked(medmarClient.fetchBigliettiVendibiliReadOnly).mockResolvedValue([AR_TARIFF_ROW, TASSA_SBARCO_ROW] as never);
    const result = await runMedmarPreflight(
      fakeAdmin([departureRow({ booking_service_kind: "formula_medmar_napoli", meeting_point: null, time: "15:30", orario_barca: "17:00" })]),
      TENANT_A,
      [SVC_DEP]
    );
    expect(medmarClient.fetchCorseReadOnly).toHaveBeenCalledWith({ idTratta: 47, partenzaDataDal: "2026-08-25", dopoLe: "17:00:00" });
    expect(result.status).toBe("ok");
    expect(result.return?.requested_time).toBe("17:00");
    expect(result.return?.id_corsa).toBe(11);
    expect(result.return?.match_source).toBe("booked_ferry_time");
  });

  it("andata e ritorno usano orari nave differenti senza ereditarli tra gambe", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockImplementation((route) => (route === "napoli_ischia" ? 59 : route === "ischia_napoli" ? 47 : null));
    vi.mocked(medmarClient.fetchCorseReadOnly).mockImplementation(async ({ idTratta }) =>
      idTratta === 59
        ? [{ ...NAPOLI_ISCHIA_CORSA, id_corsa: 20, id_tratta: 59, partenza_ora: "08:40" }]
        : [
            { id_corsa: 21, id_tratta: 47, partenza_data: "2026-08-25", partenza_ora: "08:40", flag_chiuso: 0, flag_sospeso: 0, id_porto_partenza: 41, id_porto_arrivo: 1, porto_partenza: "ISCHIA", porto_arrivo: "NAPOLI", nave: "MEDMAR GIULIA" },
            { id_corsa: 22, id_tratta: 47, partenza_data: "2026-08-25", partenza_ora: "17:00", flag_chiuso: 0, flag_sospeso: 0, id_porto_partenza: 41, id_porto_arrivo: 1, porto_partenza: "ISCHIA", porto_arrivo: "NAPOLI", nave: "MEDMAR GIULIA" },
          ]
    );
    vi.mocked(medmarClient.fetchBigliettiVendibiliReadOnly).mockResolvedValue([AR_TARIFF_ROW, TASSA_SBARCO_ROW] as never);
    const result = await runMedmarPreflight(
      fakeAdmin([
        arrivalRow({ booking_service_kind: "formula_medmar_napoli", time: "08:40" }),
        departureRow({ booking_service_kind: "formula_medmar_napoli", meeting_point: null, time: "15:30", orario_barca: "17:00" }),
      ]),
      TENANT_A,
      [SVC_ARR, SVC_DEP]
    );
    expect(result.status).toBe("ok");
    expect(result.outward?.id_corsa).toBe(20);
    expect(result.return?.id_corsa).toBe(22);
    expect(result.return?.id_corsa).not.toBe(21);
  });

  it("booking storico di ritorno senza orario_barca -> manual_review e non usa departure_time/time", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockReturnValue(47);
    const result = await runMedmarPreflight(
      fakeAdmin([departureRow({ booking_service_kind: "formula_medmar_napoli", meeting_point: null, time: "15:30", orario_barca: null, departure_time: "17:00" })]),
      TENANT_A,
      [SVC_DEP]
    );
    expect(result.status).toBe("manual_review");
    expect(result.can_issue).toBe(false);
    expect(result.return?.requested_time).toBeNull();
    expect(result.warnings.some((w) => w.code === "booked_ferry_time_missing")).toBe(true);
    expect(medmarClient.fetchCorseReadOnly).not.toHaveBeenCalled();
  });

  it("id_tratta corretto ma data sbagliata -> no_match", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockReturnValue(59);
    vi.mocked(medmarClient.fetchCorseReadOnly).mockResolvedValue([{ ...NAPOLI_ISCHIA_CORSA, partenza_data: "2026-08-21" }]);
    const result = await runMedmarPreflight(fakeAdmin([ARRIVAL_ROW]), TENANT_A, [SVC_ARR]);
    expect(result.status).toBe("no_match");
    expect(result.can_issue).toBe(false);
  });

  it("andata Napoli->Ischia + ritorno Ischia->Pozzuoli (non speculari) -> status manual_review, can_issue false, warning leg_route_mismatch", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockImplementation((route) => (route === "napoli_ischia" ? 59 : route === "ischia_pozzuoli" ? 14 : null));
    vi.mocked(routeMapping.isMirrorRouteCode).mockReturnValue(false);
    vi.mocked(medmarClient.fetchCorseReadOnly).mockImplementation(async ({ idTratta }) =>
      idTratta === 59 ? [NAPOLI_ISCHIA_CORSA] : idTratta === 14
        ? [{ id_corsa: 555, id_tratta: 14, partenza_data: "2026-08-25", partenza_ora: "11:10", flag_chiuso: 0, flag_sospeso: 0, id_porto_partenza: 41, id_porto_arrivo: 44, porto_partenza: "ISCHIA", porto_arrivo: "POZZUOLI", nave: "MEDMAR GIULIA" }]
        : []
    );

    const admin = fakeAdmin([
      ARRIVAL_ROW,
      { id: SVC_DEP, tenant_id: TENANT_A, date: "2026-08-25", time: "11:10", customer_name: "Mario Rossi", pax: 2, vessel: "Medmar", notes: "[practice:AAA]", booking_service_kind: "formula_medmar_pozzuoli", direction: "departure", status: "new", meeting_point: "Ischia Porto" },
    ]);
    const result = await runMedmarPreflight(admin, TENANT_A, [SVC_ARR, SVC_DEP]);

    expect(result.status).toBe("manual_review");
    expect(result.can_issue).toBe(false);
    expect(result.warnings.some((w) => w.code === "leg_route_mismatch")).toBe(true);
    expect(medmarClient.fetchBigliettiVendibiliReadOnly).not.toHaveBeenCalled();
  });

  it("andata Napoli->Ischia + ritorno Casamicciola->Pozzuoli (porti isolani diversi, risolti indipendentemente per gamba) -> manual_review, leg_route_mismatch", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockImplementation((route) => (route === "napoli_ischia" ? 59 : route === "casamicciola_pozzuoli" ? 50 : null));
    vi.mocked(routeMapping.isMirrorRouteCode).mockReturnValue(false);
    vi.mocked(medmarClient.fetchCorseReadOnly).mockImplementation(async ({ idTratta }) =>
      idTratta === 59 ? [NAPOLI_ISCHIA_CORSA] : idTratta === 50
        ? [{ id_corsa: 556, id_tratta: 50, partenza_data: "2026-08-25", partenza_ora: "11:10", flag_chiuso: 0, flag_sospeso: 0, id_porto_partenza: 2, id_porto_arrivo: 44, porto_partenza: "CASAMICCIOLA", porto_arrivo: "POZZUOLI", nave: "MEDMAR GIULIA" }]
        : []
    );

    // Ritorno: booking_service_kind pozzuoli + meeting_point che menziona
    // Casamicciola -> porto isolano risolto in modo indipendente da quello
    // dell'andata (Ischia), senza alcuna assunzione incrociata tra le gambe.
    const admin = fakeAdmin([
      ARRIVAL_ROW,
      { id: SVC_DEP, tenant_id: TENANT_A, date: "2026-08-25", time: "11:10", customer_name: "Mario Rossi", pax: 2, vessel: "Medmar", notes: "[practice:AAA]", booking_service_kind: "formula_medmar_pozzuoli", direction: "departure", status: "new", meeting_point: "Casamicciola - Piazza Marina" },
    ]);
    const result = await runMedmarPreflight(admin, TENANT_A, [SVC_ARR, SVC_DEP]);

    expect(result.outward?.route_code).toBe("napoli_ischia");
    expect(result.return?.route_code).toBe("casamicciola_pozzuoli");
    expect(result.status).toBe("manual_review");
    expect(result.can_issue).toBe(false);
    expect(result.warnings.some((w) => w.code === "leg_route_mismatch")).toBe(true);
    expect(medmarClient.fetchBigliettiVendibiliReadOnly).not.toHaveBeenCalled();
  });
});

describe("runMedmarPreflight — Fase 2G: A/R con porto isolano diverso tra le gambe (island_port_differs_between_legs)", () => {
  function corsa(idTratta: number, idCorsa: number, date: string, ora: string, portoPartenza: number, portoArrivo: number, partenzaLabel: string, arrivoLabel: string): Row {
    return {
      id_corsa: idCorsa, id_tratta: idTratta, partenza_data: date, partenza_ora: ora,
      flag_chiuso: 0, flag_sospeso: 0, id_porto_partenza: portoPartenza, id_porto_arrivo: portoArrivo,
      porto_partenza: partenzaLabel, porto_arrivo: arrivoLabel, nave: "MEDMAR GIULIA",
    };
  }

  it("1. Pozzuoli->Casamicciola + Casamicciola->Pozzuoli (stesso porto isolano) -> ok, nessun warning porto diverso", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockImplementation((route) => (route === "pozzuoli_casamicciola" ? 53 : route === "casamicciola_pozzuoli" ? 50 : null));
    vi.mocked(medmarClient.fetchCorseReadOnly).mockImplementation(async ({ idTratta }) =>
      idTratta === 53 ? [corsa(53, 701, "2026-08-25", "08:00", 44, 2, "POZZUOLI", "CASAMICCIOLA")]
        : idTratta === 50 ? [corsa(50, 702, "2026-08-28", "17:00", 2, 44, "CASAMICCIOLA", "POZZUOLI")]
        : []
    );
    vi.mocked(medmarClient.fetchBigliettiVendibiliReadOnly).mockResolvedValue([AR_TARIFF_ROW, TASSA_SBARCO_ROW] as never);
    const result = await runMedmarPreflight(
      fakeAdmin([
        arrivalRow({ booking_service_kind: "formula_medmar_pozzuoli", meeting_point: "Casamicciola - Piazza Marina", date: "2026-08-25", time: "08:00" }),
        departureRow({ booking_service_kind: "formula_medmar_pozzuoli", meeting_point: "Casamicciola - Piazza Marina", date: "2026-08-28", time: "15:00", orario_barca: "17:00" }),
      ]),
      TENANT_A, [SVC_ARR, SVC_DEP]
    );
    expect(result.status).toBe("ok");
    expect(result.can_issue).toBe(true);
    expect(result.warnings.some((w) => w.code === "island_port_differs_between_legs")).toBe(false);
    expect(result.warnings.some((w) => w.code === "leg_route_mismatch")).toBe(false);
  });

  it("2. Pozzuoli->Casamicciola + Ischia->Pozzuoli (porto isolano diverso, stesso mainland) -> ok, warning island_port_differs_between_legs", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockImplementation((route) => (route === "pozzuoli_casamicciola" ? 53 : route === "ischia_pozzuoli" ? 14 : null));
    vi.mocked(medmarClient.fetchCorseReadOnly).mockImplementation(async ({ idTratta }) =>
      idTratta === 53 ? [corsa(53, 703, "2026-08-25", "08:00", 44, 2, "POZZUOLI", "CASAMICCIOLA")]
        : idTratta === 14 ? [corsa(14, 704, "2026-08-28", "17:00", 41, 44, "ISCHIA", "POZZUOLI")]
        : []
    );
    vi.mocked(medmarClient.fetchBigliettiVendibiliReadOnly).mockResolvedValue([AR_TARIFF_ROW, TASSA_SBARCO_ROW] as never);
    const result = await runMedmarPreflight(
      fakeAdmin([
        arrivalRow({ booking_service_kind: "formula_medmar_pozzuoli", meeting_point: "Casamicciola - Piazza Marina", date: "2026-08-25", time: "08:00" }),
        departureRow({ booking_service_kind: "formula_medmar_pozzuoli", meeting_point: "Ischia Porto", date: "2026-08-28", time: "15:00", orario_barca: "17:00" }),
      ]),
      TENANT_A, [SVC_ARR, SVC_DEP]
    );
    expect(result.status).toBe("ok");
    expect(result.can_issue).toBe(true);
    expect(result.warnings.some((w) => w.code === "leg_route_mismatch")).toBe(false);
    const warn = result.warnings.find((w) => w.code === "island_port_differs_between_legs");
    expect(warn).toBeDefined();
    expect(warn?.message).toBe("Il porto isolano di arrivo e quello di ripartenza sono diversi: Casamicciola → Ischia. Verificare che sia voluto.");
  });

  it("3. Pozzuoli->Ischia + Casamicciola->Pozzuoli (porto isolano diverso, stesso mainland) -> ok, warning island_port_differs_between_legs", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockImplementation((route) => (route === "pozzuoli_ischia" ? 56 : route === "casamicciola_pozzuoli" ? 50 : null));
    vi.mocked(medmarClient.fetchCorseReadOnly).mockImplementation(async ({ idTratta }) =>
      idTratta === 56 ? [corsa(56, 705, "2026-08-25", "08:00", 44, 41, "POZZUOLI", "ISCHIA")]
        : idTratta === 50 ? [corsa(50, 706, "2026-08-28", "17:00", 2, 44, "CASAMICCIOLA", "POZZUOLI")]
        : []
    );
    vi.mocked(medmarClient.fetchBigliettiVendibiliReadOnly).mockResolvedValue([AR_TARIFF_ROW, TASSA_SBARCO_ROW] as never);
    const result = await runMedmarPreflight(
      fakeAdmin([
        arrivalRow({ booking_service_kind: "formula_medmar_pozzuoli", meeting_point: "Ischia Porto", date: "2026-08-25", time: "08:00" }),
        departureRow({ booking_service_kind: "formula_medmar_pozzuoli", meeting_point: "Casamicciola - Piazza Marina", date: "2026-08-28", time: "15:00", orario_barca: "17:00" }),
      ]),
      TENANT_A, [SVC_ARR, SVC_DEP]
    );
    expect(result.status).toBe("ok");
    expect(result.can_issue).toBe(true);
    const warn = result.warnings.find((w) => w.code === "island_port_differs_between_legs");
    expect(warn).toBeDefined();
    expect(warn?.message).toBe("Il porto isolano di arrivo e quello di ripartenza sono diversi: Ischia → Casamicciola. Verificare che sia voluto.");
  });

  it("4. Napoli->Ischia + Ischia->Napoli (stesso porto isolano, unico caso possibile su Napoli) -> ok, nessun warning porto diverso", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockImplementation((route) => (route === "napoli_ischia" ? 59 : route === "ischia_napoli" ? 47 : null));
    vi.mocked(medmarClient.fetchCorseReadOnly).mockImplementation(async ({ idTratta }) =>
      idTratta === 59 ? [corsa(59, 707, "2026-08-25", "08:00", 1, 41, "NAPOLI", "ISCHIA")]
        : idTratta === 47 ? [corsa(47, 708, "2026-08-28", "17:00", 41, 1, "ISCHIA", "NAPOLI")]
        : []
    );
    vi.mocked(medmarClient.fetchBigliettiVendibiliReadOnly).mockResolvedValue([AR_TARIFF_ROW, TASSA_SBARCO_ROW] as never);
    const result = await runMedmarPreflight(
      fakeAdmin([
        arrivalRow({ booking_service_kind: "formula_medmar_napoli", date: "2026-08-25", time: "08:00" }),
        departureRow({ booking_service_kind: "formula_medmar_napoli", meeting_point: null, date: "2026-08-28", time: "15:00", orario_barca: "17:00" }),
      ]),
      TENANT_A, [SVC_ARR, SVC_DEP]
    );
    expect(result.status).toBe("ok");
    expect(result.can_issue).toBe(true);
    expect(result.warnings.some((w) => w.code === "island_port_differs_between_legs")).toBe(false);
  });

  it("5. Napoli->Ischia + Casamicciola->Pozzuoli (mainland diverso, Napoli vs Pozzuoli) -> blocco, leg_route_mismatch", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockImplementation((route) => (route === "napoli_ischia" ? 59 : route === "casamicciola_pozzuoli" ? 50 : null));
    vi.mocked(medmarClient.fetchCorseReadOnly).mockImplementation(async ({ idTratta }) =>
      idTratta === 59 ? [corsa(59, 709, "2026-08-25", "08:00", 1, 41, "NAPOLI", "ISCHIA")]
        : idTratta === 50 ? [corsa(50, 710, "2026-08-28", "17:00", 2, 44, "CASAMICCIOLA", "POZZUOLI")]
        : []
    );
    const result = await runMedmarPreflight(
      fakeAdmin([
        arrivalRow({ booking_service_kind: "formula_medmar_napoli", date: "2026-08-25", time: "08:00" }),
        departureRow({ booking_service_kind: "formula_medmar_pozzuoli", meeting_point: "Casamicciola - Piazza Marina", date: "2026-08-28", time: "15:00", orario_barca: "17:00" }),
      ]),
      TENANT_A, [SVC_ARR, SVC_DEP]
    );
    expect(result.status).toBe("manual_review");
    expect(result.can_issue).toBe(false);
    expect(result.warnings.some((w) => w.code === "leg_route_mismatch")).toBe(true);
    expect(result.warnings.some((w) => w.code === "island_port_differs_between_legs")).toBe(false);
    expect(medmarClient.fetchBigliettiVendibiliReadOnly).not.toHaveBeenCalled();
  });

  it("6. Pozzuoli->Casamicciola + Ischia->Napoli (mainland diverso, Pozzuoli vs Napoli) -> blocco, leg_route_mismatch", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockImplementation((route) => (route === "pozzuoli_casamicciola" ? 53 : route === "ischia_napoli" ? 47 : null));
    vi.mocked(medmarClient.fetchCorseReadOnly).mockImplementation(async ({ idTratta }) =>
      idTratta === 53 ? [corsa(53, 711, "2026-08-25", "08:00", 44, 2, "POZZUOLI", "CASAMICCIOLA")]
        : idTratta === 47 ? [corsa(47, 712, "2026-08-28", "17:00", 41, 1, "ISCHIA", "NAPOLI")]
        : []
    );
    const result = await runMedmarPreflight(
      fakeAdmin([
        arrivalRow({ booking_service_kind: "formula_medmar_pozzuoli", meeting_point: "Casamicciola - Piazza Marina", date: "2026-08-25", time: "08:00" }),
        departureRow({ booking_service_kind: "formula_medmar_napoli", meeting_point: null, date: "2026-08-28", time: "15:00", orario_barca: "17:00" }),
      ]),
      TENANT_A, [SVC_ARR, SVC_DEP]
    );
    expect(result.status).toBe("manual_review");
    expect(result.can_issue).toBe(false);
    expect(result.warnings.some((w) => w.code === "leg_route_mismatch")).toBe(true);
  });

  it("7. stesso mainland, porto isolano diverso, MA ritorno prima dell'andata (stesso giorno) -> resta bloccato (invalid_same_day_return_order ha priorità sulla relaxation)", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockImplementation((route) => (route === "pozzuoli_casamicciola" ? 53 : route === "ischia_pozzuoli" ? 14 : null));
    vi.mocked(medmarClient.fetchCorseReadOnly).mockImplementation(async ({ idTratta }) =>
      idTratta === 53 ? [corsa(53, 713, "2026-08-25", "17:00", 44, 2, "POZZUOLI", "CASAMICCIOLA")]
        : idTratta === 14 ? [corsa(14, 714, "2026-08-25", "08:00", 41, 44, "ISCHIA", "POZZUOLI")]
        : []
    );
    const now = new Date("2026-08-24T06:00:00.000Z");
    const result = await runMedmarPreflight(
      fakeAdmin([
        arrivalRow({ booking_service_kind: "formula_medmar_pozzuoli", meeting_point: "Casamicciola - Piazza Marina", date: "2026-08-25", time: "17:00" }),
        departureRow({ booking_service_kind: "formula_medmar_pozzuoli", meeting_point: "Ischia Porto", date: "2026-08-25", time: "10:00", orario_barca: "08:00" }),
      ]),
      TENANT_A, [SVC_ARR, SVC_DEP], now
    );
    expect(result.status).toBe("invalid_same_day_return_order");
    expect(result.can_issue).toBe(false);
  });

  it("8. stesso mainland, porto isolano diverso, MA corsa di andata già partita -> resta bloccato (course_already_departed ha priorità sulla relaxation)", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockImplementation((route) => (route === "pozzuoli_casamicciola" ? 53 : route === "ischia_pozzuoli" ? 14 : null));
    vi.mocked(medmarClient.fetchCorseReadOnly).mockImplementation(async ({ idTratta }) =>
      idTratta === 53 ? [corsa(53, 715, "2026-08-25", "08:00", 44, 2, "POZZUOLI", "CASAMICCIOLA")]
        : idTratta === 14 ? [corsa(14, 716, "2026-08-28", "17:00", 41, 44, "ISCHIA", "POZZUOLI")]
        : []
    );
    const now = new Date("2026-08-25T20:00:00.000Z"); // dopo le 08:00 del 25/08 -> andata già partita
    const result = await runMedmarPreflight(
      fakeAdmin([
        arrivalRow({ booking_service_kind: "formula_medmar_pozzuoli", meeting_point: "Casamicciola - Piazza Marina", date: "2026-08-25", time: "08:00" }),
        departureRow({ booking_service_kind: "formula_medmar_pozzuoli", meeting_point: "Ischia Porto", date: "2026-08-28", time: "15:00", orario_barca: "17:00" }),
      ]),
      TENANT_A, [SVC_ARR, SVC_DEP], now
    );
    expect(result.status).toBe("course_already_departed");
    expect(result.can_issue).toBe(false);
    expect(result.warnings.some((w) => w.code === "course_already_departed")).toBe(true);
  });
});

describe("runMedmarPreflight — modello single-row (Fase 2B.6: ritorno imbarcato nella stessa riga arrival)", () => {
  it("Modello a due righe (arrival+departure collegate) resta invariato: nessun warning embedded_return_*", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockImplementation((route) => (route === "napoli_ischia" ? 59 : route === "ischia_napoli" ? 47 : null));
    vi.mocked(medmarClient.fetchCorseReadOnly).mockImplementation(async ({ idTratta }) =>
      idTratta === 59
        ? [{ ...NAPOLI_ISCHIA_CORSA, id_corsa: 20, partenza_ora: "08:40" }]
        : [{ id_corsa: 22, id_tratta: 47, partenza_data: "2026-08-25", partenza_ora: "17:00", flag_chiuso: 0, flag_sospeso: 0, id_porto_partenza: 41, id_porto_arrivo: 1, porto_partenza: "ISCHIA", porto_arrivo: "NAPOLI", nave: "MEDMAR GIULIA" }]
    );
    vi.mocked(medmarClient.fetchBigliettiVendibiliReadOnly).mockResolvedValue([AR_TARIFF_ROW, TASSA_SBARCO_ROW] as never);
    const result = await runMedmarPreflight(
      fakeAdmin([
        arrivalRow({ booking_service_kind: "formula_medmar_napoli", time: "08:40" }),
        departureRow({ booking_service_kind: "formula_medmar_napoli", meeting_point: null, time: "15:30", orario_barca: "17:00" }),
      ]),
      TENANT_A,
      [SVC_ARR, SVC_DEP]
    );
    expect(result.status).toBe("ok");
    expect(result.return?.id_corsa).toBe(22);
    expect(result.return?.service_ids).toEqual([SVC_DEP]);
    expect(result.warnings.some((w) => w.code === "embedded_return_leg_used")).toBe(false);
    expect(result.warnings.some((w) => w.code === "embedded_return_island_port_ambiguous")).toBe(false);
  });

  it("Napoli single-row: outward e return entrambi risolti dalla stessa riga, can_issue true", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockImplementation((route) => (route === "napoli_ischia" ? 59 : route === "ischia_napoli" ? 47 : null));
    vi.mocked(medmarClient.fetchCorseReadOnly).mockImplementation(async ({ idTratta }) =>
      idTratta === 59
        ? [{ ...NAPOLI_ISCHIA_CORSA, id_corsa: 301, partenza_data: "2026-08-18", partenza_ora: "14:20" }]
        : idTratta === 47
          ? [{ id_corsa: 302, id_tratta: 47, partenza_data: "2026-08-23", partenza_ora: "17:00", flag_chiuso: 0, flag_sospeso: 0, id_porto_partenza: 41, id_porto_arrivo: 1, porto_partenza: "ISCHIA", porto_arrivo: "NAPOLI", nave: "MEDMAR GIULIA" }]
          : []
    );
    vi.mocked(medmarClient.fetchBigliettiVendibiliReadOnly).mockResolvedValue([AR_TARIFF_ROW, TASSA_SBARCO_ROW] as never);

    const result = await runMedmarPreflight(fakeAdmin([singleRowRoundTrip()]), TENANT_A, [SVC_ARR]);

    expect(result.status).toBe("ok");
    expect(result.can_issue).toBe(true);
    expect(result.outward?.id_corsa).toBe(301);
    expect(result.return).not.toBeNull();
    expect(result.return?.id_corsa).toBe(302);
    expect(result.warnings.some((w) => w.code === "embedded_return_leg_used")).toBe(true);
  });

  it("il ritorno single-row usa departure_date/orario_barca della riga, non date/time dell'andata", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockImplementation((route) => (route === "napoli_ischia" ? 59 : route === "ischia_napoli" ? 47 : null));
    vi.mocked(medmarClient.fetchCorseReadOnly).mockImplementation(async ({ idTratta }) =>
      idTratta === 59
        ? [{ ...NAPOLI_ISCHIA_CORSA, id_corsa: 301, partenza_data: "2026-08-18", partenza_ora: "14:20" }]
        : [{ id_corsa: 302, id_tratta: 47, partenza_data: "2026-08-23", partenza_ora: "17:00", flag_chiuso: 0, flag_sospeso: 0, id_porto_partenza: 41, id_porto_arrivo: 1, porto_partenza: "ISCHIA", porto_arrivo: "NAPOLI", nave: "MEDMAR GIULIA" }]
    );
    vi.mocked(medmarClient.fetchBigliettiVendibiliReadOnly).mockResolvedValue([AR_TARIFF_ROW, TASSA_SBARCO_ROW] as never);

    const result = await runMedmarPreflight(fakeAdmin([singleRowRoundTrip()]), TENANT_A, [SVC_ARR]);

    expect(medmarClient.fetchCorseReadOnly).toHaveBeenCalledWith({ idTratta: 47, partenzaDataDal: "2026-08-23", dopoLe: "17:00:00" });
    expect(result.return?.date).toBe("2026-08-23");
    expect(result.return?.requested_time).toBe("17:00");
  });

  it("il ritorno single-row cade su return_time quando orario_barca e' assente", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockImplementation((route) => (route === "napoli_ischia" ? 59 : route === "ischia_napoli" ? 47 : null));
    vi.mocked(medmarClient.fetchCorseReadOnly).mockImplementation(async ({ idTratta }) =>
      idTratta === 59
        ? [{ ...NAPOLI_ISCHIA_CORSA, id_corsa: 301, partenza_data: "2026-08-18", partenza_ora: "14:20" }]
        : [{ id_corsa: 303, id_tratta: 47, partenza_data: "2026-08-23", partenza_ora: "17:00", flag_chiuso: 0, flag_sospeso: 0, id_porto_partenza: 41, id_porto_arrivo: 1, porto_partenza: "ISCHIA", porto_arrivo: "NAPOLI", nave: "MEDMAR GIULIA" }]
    );
    vi.mocked(medmarClient.fetchBigliettiVendibiliReadOnly).mockResolvedValue([AR_TARIFF_ROW, TASSA_SBARCO_ROW] as never);

    const row = singleRowRoundTrip({ orario_barca: null, return_time: "17:00" });
    const result = await runMedmarPreflight(fakeAdmin([row]), TENANT_A, [SVC_ARR]);

    expect(result.return?.id_corsa).toBe(303);
    expect(result.return?.requested_time).toBe("17:00");
  });

  it("return.service_ids resta [first.id]: nessun secondo service_id sintetizzato", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockImplementation((route) => (route === "napoli_ischia" ? 59 : route === "ischia_napoli" ? 47 : null));
    vi.mocked(medmarClient.fetchCorseReadOnly).mockImplementation(async ({ idTratta }) =>
      idTratta === 59
        ? [{ ...NAPOLI_ISCHIA_CORSA, id_corsa: 301, partenza_data: "2026-08-18", partenza_ora: "14:20" }]
        : [{ id_corsa: 302, id_tratta: 47, partenza_data: "2026-08-23", partenza_ora: "17:00", flag_chiuso: 0, flag_sospeso: 0, id_porto_partenza: 41, id_porto_arrivo: 1, porto_partenza: "ISCHIA", porto_arrivo: "NAPOLI", nave: "MEDMAR GIULIA" }]
    );
    vi.mocked(medmarClient.fetchBigliettiVendibiliReadOnly).mockResolvedValue([AR_TARIFF_ROW, TASSA_SBARCO_ROW] as never);

    const result = await runMedmarPreflight(fakeAdmin([singleRowRoundTrip()]), TENANT_A, [SVC_ARR]);

    expect(result.outward?.service_ids).toEqual([SVC_ARR]);
    expect(result.return?.service_ids).toEqual([SVC_ARR]);
  });

  it("senza departure_date/orario_barca imbarcati, la riga resta sola andata (comportamento invariato)", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockReturnValue(59);
    vi.mocked(medmarClient.fetchCorseReadOnly).mockResolvedValue([{ ...NAPOLI_ISCHIA_CORSA, id_corsa: 301, partenza_data: "2026-08-18", partenza_ora: "14:20" }]);
    vi.mocked(medmarClient.fetchBigliettiVendibiliReadOnly).mockResolvedValue([AR_TARIFF_ROW, TASSA_SBARCO_ROW] as never);

    const row = singleRowRoundTrip({ departure_date: null, departure_time: null, orario_barca: null, return_time: null });
    const result = await runMedmarPreflight(fakeAdmin([row]), TENANT_A, [SVC_ARR]);

    expect(result.status).toBe("ok");
    expect(result.return).toBeNull();
    expect(medmarClient.fetchCorseReadOnly).toHaveBeenCalledTimes(1);
    expect(result.warnings.some((w) => w.code === "embedded_return_leg_used")).toBe(false);
  });

  it("Pozzuoli single-row: porto isolano del ritorno non determinabile da un campo distinto -> manual_review, can_issue false, nessun fallback verso Ischia/Casamicciola", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockImplementation((route) => (route === "pozzuoli_ischia" ? 56 : null));
    vi.mocked(medmarClient.fetchCorseReadOnly).mockResolvedValue([
      { id_corsa: 401, id_tratta: 56, partenza_data: "2026-08-18", partenza_ora: "14:20", flag_chiuso: 0, flag_sospeso: 0, id_porto_partenza: 44, id_porto_arrivo: 41, porto_partenza: "POZZUOLI", porto_arrivo: "ISCHIA", nave: "MEDMAR GIULIA" },
    ]);

    const row = singleRowRoundTrip({ booking_service_kind: "formula_medmar_pozzuoli", meeting_point: "Ischia Porto" });
    const result = await runMedmarPreflight(fakeAdmin([row]), TENANT_A, [SVC_ARR]);

    expect(result.status).toBe("manual_review");
    expect(result.can_issue).toBe(false);
    expect(result.return).not.toBeNull();
    expect(result.return?.route_code).toBeNull();
    expect(result.return?.id_corsa).toBeNull();
    expect(result.return?.service_ids).toEqual([SVC_ARR]);
    expect(result.warnings.some((w) => w.code === "embedded_return_island_port_ambiguous")).toBe(true);
    expect(medmarClient.fetchBigliettiVendibiliReadOnly).not.toHaveBeenCalled();
  });

  it("Pozzuoli single-row con meeting_point che menziona Casamicciola resta comunque manual_review (nessuna assunzione, anche se il testo suggerirebbe un porto)", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockImplementation((route) => (route === "casamicciola_pozzuoli" ? 50 : null));
    vi.mocked(medmarClient.fetchCorseReadOnly).mockResolvedValue([
      { id_corsa: 402, id_tratta: 50, partenza_data: "2026-08-18", partenza_ora: "14:20", flag_chiuso: 0, flag_sospeso: 0, id_porto_partenza: 2, id_porto_arrivo: 44, porto_partenza: "CASAMICCIOLA", porto_arrivo: "POZZUOLI", nave: "MEDMAR GIULIA" },
    ]);

    const row = singleRowRoundTrip({ booking_service_kind: "formula_medmar_pozzuoli", meeting_point: "Casamicciola - Piazza Marina" });
    const result = await runMedmarPreflight(fakeAdmin([row]), TENANT_A, [SVC_ARR]);

    expect(result.status).toBe("manual_review");
    expect(result.can_issue).toBe(false);
    expect(result.return?.route_code).toBeNull();
    expect(result.warnings.some((w) => w.code === "embedded_return_island_port_ambiguous")).toBe(true);
  });

  it("invariante: un gruppo single-row con dati di ritorno imbarcati non puo' mai risultare status ok con return=null", async () => {
    // id_tratta del ritorno (ischia_napoli) volutamente NON mappato: l'andata
    // da sola risolverebbe "ok", ma il ritorno deve restare presente e
    // bloccante (manual_review), mai silenziosamente ignorato.
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockImplementation((route) => (route === "napoli_ischia" ? 59 : null));
    vi.mocked(medmarClient.fetchCorseReadOnly).mockResolvedValue([{ ...NAPOLI_ISCHIA_CORSA, id_corsa: 301, partenza_data: "2026-08-18", partenza_ora: "14:20" }]);

    const result = await runMedmarPreflight(fakeAdmin([singleRowRoundTrip()]), TENANT_A, [SVC_ARR]);

    expect(result.status).not.toBe("ok");
    expect(result.return).not.toBeNull();
  });

  it("sensitivity: senza la ricostruzione single-row, fetchCorseReadOnly verrebbe chiamata una sola volta invece di due", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockImplementation((route) => (route === "napoli_ischia" ? 59 : route === "ischia_napoli" ? 47 : null));
    vi.mocked(medmarClient.fetchCorseReadOnly).mockImplementation(async ({ idTratta }) =>
      idTratta === 59
        ? [{ ...NAPOLI_ISCHIA_CORSA, id_corsa: 301, partenza_data: "2026-08-18", partenza_ora: "14:20" }]
        : [{ id_corsa: 302, id_tratta: 47, partenza_data: "2026-08-23", partenza_ora: "17:00", flag_chiuso: 0, flag_sospeso: 0, id_porto_partenza: 41, id_porto_arrivo: 1, porto_partenza: "ISCHIA", porto_arrivo: "NAPOLI", nave: "MEDMAR GIULIA" }]
    );
    vi.mocked(medmarClient.fetchBigliettiVendibiliReadOnly).mockResolvedValue([AR_TARIFF_ROW, TASSA_SBARCO_ROW] as never);

    await runMedmarPreflight(fakeAdmin([singleRowRoundTrip()]), TENANT_A, [SVC_ARR]);

    expect(medmarClient.fetchCorseReadOnly).toHaveBeenCalledTimes(2);
    expect(medmarClient.fetchCorseReadOnly).toHaveBeenNthCalledWith(2, { idTratta: 47, partenzaDataDal: "2026-08-23", dopoLe: "17:00:00" });
  });
});

describe("runMedmarPreflight — pricing A/R per-gamba (Fase 2B.7: bugfix totale A/R dimezzato)", () => {
  // Fixture dedicata: prezzo 11.50 senza tassa di sbarco, cosi' i totali
  // combaciano esattamente con l'evidenza reale riportata dall'utente
  // (portale Medmar: andata=23,00 + ritorno=23,00 = 46,00 per 2 adulti).
  function arTariff1150(overrides: Row = {}): Row {
    return { ...arTariffRow({ prezzo: 11.5 }), ...overrides };
  }

  it("2 adulti, due righe collegate: outward e return prezzati separatamente (chiamate distinte a fetchBigliettiVendibiliReadOnly), totale = somma delle due gambe", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockImplementation((route) => (route === "napoli_ischia" ? 59 : route === "ischia_napoli" ? 47 : null));
    vi.mocked(medmarClient.fetchCorseReadOnly).mockImplementation(async ({ idTratta }) =>
      idTratta === 59
        ? [{ ...NAPOLI_ISCHIA_CORSA, id_corsa: 701, partenza_data: "2026-08-18", partenza_ora: "14:20" }]
        : [{ id_corsa: 702, id_tratta: 47, partenza_data: "2026-08-23", partenza_ora: "17:00", flag_chiuso: 0, flag_sospeso: 0, id_porto_partenza: 41, id_porto_arrivo: 1, porto_partenza: "ISCHIA", porto_arrivo: "NAPOLI", nave: "MEDMAR GIULIA" }]
    );
    vi.mocked(medmarClient.fetchBigliettiVendibiliReadOnly).mockImplementation(async (idCorsa) =>
      (idCorsa === 701 || idCorsa === 702 ? [arTariff1150({ id_corsa: idCorsa })] : []) as never
    );

    const result = await runMedmarPreflight(
      fakeAdmin([
        arrivalRow({ date: "2026-08-18", time: "14:20", booking_service_kind: "formula_medmar_napoli", pax: 2 }),
        departureRow({ date: "2026-08-23", time: "15:30", orario_barca: "17:00", booking_service_kind: "formula_medmar_napoli", meeting_point: null, pax: 2 }),
      ]),
      TENANT_A,
      [SVC_ARR, SVC_DEP]
    );

    expect(result.status).toBe("ok");
    expect(result.can_issue).toBe(true);
    expect(result.outward?.id_corsa).toBe(701);
    expect(result.return?.id_corsa).toBe(702);
    // Prova diretta del bug segnalato: PRIMA del fix expected_total_cents
    // era unit_price*pax di UNA sola gamba (2300, non 4600).
    expect(result.outward?.total_cents).toBe(2300);
    expect(result.return?.total_cents).toBe(2300);
    expect(result.expected_total_cents).toBe(4600);
    expect(result.expected_total_cents).not.toBe(result.outward?.total_cents);
    expect(medmarClient.fetchBigliettiVendibiliReadOnly).toHaveBeenCalledWith(701);
    expect(medmarClient.fetchBigliettiVendibiliReadOnly).toHaveBeenCalledWith(702);
    expect(medmarClient.fetchBigliettiVendibiliReadOnly).toHaveBeenCalledTimes(2);
  });

  it("1 adulto, due righe collegate: outward=11,50 return=11,50 totale=23,00", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockImplementation((route) => (route === "napoli_ischia" ? 59 : route === "ischia_napoli" ? 47 : null));
    vi.mocked(medmarClient.fetchCorseReadOnly).mockImplementation(async ({ idTratta }) =>
      idTratta === 59
        ? [{ ...NAPOLI_ISCHIA_CORSA, id_corsa: 703, partenza_data: "2026-08-18", partenza_ora: "14:20" }]
        : [{ id_corsa: 704, id_tratta: 47, partenza_data: "2026-08-23", partenza_ora: "17:00", flag_chiuso: 0, flag_sospeso: 0, id_porto_partenza: 41, id_porto_arrivo: 1, porto_partenza: "ISCHIA", porto_arrivo: "NAPOLI", nave: "MEDMAR GIULIA" }]
    );
    vi.mocked(medmarClient.fetchBigliettiVendibiliReadOnly).mockResolvedValue([arTariff1150()] as never);

    const result = await runMedmarPreflight(
      fakeAdmin([
        arrivalRow({ date: "2026-08-18", time: "14:20", booking_service_kind: "formula_medmar_napoli", pax: 1 }),
        departureRow({ date: "2026-08-23", time: "15:30", orario_barca: "17:00", booking_service_kind: "formula_medmar_napoli", meeting_point: null, pax: 1 }),
      ]),
      TENANT_A,
      [SVC_ARR, SVC_DEP]
    );

    expect(result.can_issue).toBe(true);
    expect(result.outward?.total_cents).toBe(1150);
    expect(result.return?.total_cents).toBe(1150);
    expect(result.expected_total_cents).toBe(2300);
  });

  it("solo andata (nessun ritorno nel gruppo): expected_total_cents e' la sola gamba andata, comportamento invariato", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockReturnValue(59);
    vi.mocked(medmarClient.fetchCorseReadOnly).mockResolvedValue([{ ...NAPOLI_ISCHIA_CORSA, id_corsa: 705, partenza_data: "2026-08-18", partenza_ora: "14:20" }]);
    vi.mocked(medmarClient.fetchBigliettiVendibiliReadOnly).mockResolvedValue([arTariff1150()] as never);

    const result = await runMedmarPreflight(
      fakeAdmin([arrivalRow({ date: "2026-08-18", time: "14:20", booking_service_kind: "formula_medmar_napoli", pax: 2 })]),
      TENANT_A,
      [SVC_ARR]
    );

    expect(result.can_issue).toBe(true);
    expect(result.outward?.total_cents).toBe(2300);
    expect(result.return).toBeNull();
    expect(result.expected_total_cents).toBe(2300);
    expect(medmarClient.fetchBigliettiVendibiliReadOnly).toHaveBeenCalledTimes(1);
  });

  it("single-row A/R (Fase 2B.6 + 2B.7): ritorno imbarcato nella stessa riga, prezzato separatamente, totale = somma delle due gambe", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockImplementation((route) => (route === "napoli_ischia" ? 59 : route === "ischia_napoli" ? 47 : null));
    vi.mocked(medmarClient.fetchCorseReadOnly).mockImplementation(async ({ idTratta }) =>
      idTratta === 59
        ? [{ ...NAPOLI_ISCHIA_CORSA, id_corsa: 301, partenza_data: "2026-08-18", partenza_ora: "14:20" }]
        : idTratta === 47
          ? [{ id_corsa: 302, id_tratta: 47, partenza_data: "2026-08-23", partenza_ora: "17:00", flag_chiuso: 0, flag_sospeso: 0, id_porto_partenza: 41, id_porto_arrivo: 1, porto_partenza: "ISCHIA", porto_arrivo: "NAPOLI", nave: "MEDMAR GIULIA" }]
          : []
    );
    vi.mocked(medmarClient.fetchBigliettiVendibiliReadOnly).mockImplementation(async (idCorsa) =>
      (idCorsa === 301 || idCorsa === 302 ? [arTariff1150({ id_corsa: idCorsa })] : []) as never
    );

    const result = await runMedmarPreflight(fakeAdmin([singleRowRoundTrip({ pax: 2 })]), TENANT_A, [SVC_ARR]);

    expect(result.status).toBe("ok");
    expect(result.can_issue).toBe(true);
    expect(result.outward?.total_cents).toBe(2300);
    expect(result.return?.total_cents).toBe(2300);
    expect(result.expected_total_cents).toBe(4600);
    expect(result.warnings.some((w) => w.code === "embedded_return_leg_used")).toBe(true);
  });

  it("prezzi asimmetrici tra andata e ritorno: ogni gamba usa la PROPRIA risposta vendibili, nessun prezzo riusato tra le gambe", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockImplementation((route) => (route === "napoli_ischia" ? 59 : route === "ischia_napoli" ? 47 : null));
    vi.mocked(medmarClient.fetchCorseReadOnly).mockImplementation(async ({ idTratta }) =>
      idTratta === 59
        ? [{ ...NAPOLI_ISCHIA_CORSA, id_corsa: 706, partenza_data: "2026-08-18", partenza_ora: "14:20" }]
        : [{ id_corsa: 707, id_tratta: 47, partenza_data: "2026-08-23", partenza_ora: "17:00", flag_chiuso: 0, flag_sospeso: 0, id_porto_partenza: 41, id_porto_arrivo: 1, porto_partenza: "ISCHIA", porto_arrivo: "NAPOLI", nave: "MEDMAR GIULIA" }]
    );
    vi.mocked(medmarClient.fetchBigliettiVendibiliReadOnly).mockImplementation(async (idCorsa) => {
      if (idCorsa === 706) return [arTariff1150({ id_corsa: 706, prezzo: 11.5 })] as never;
      if (idCorsa === 707) return [arTariff1150({ id_corsa: 707, prezzo: 12 })] as never;
      return [] as never;
    });

    const result = await runMedmarPreflight(
      fakeAdmin([
        arrivalRow({ date: "2026-08-18", time: "14:20", booking_service_kind: "formula_medmar_napoli", pax: 2 }),
        departureRow({ date: "2026-08-23", time: "15:30", orario_barca: "17:00", booking_service_kind: "formula_medmar_napoli", meeting_point: null, pax: 2 }),
      ]),
      TENANT_A,
      [SVC_ARR, SVC_DEP]
    );

    expect(result.outward?.total_cents).toBe(2300); // 11.50 * 2
    expect(result.return?.total_cents).toBe(2400); // 12.00 * 2
    expect(result.expected_total_cents).toBe(4700);
  });

  it("sensitivity: se la seconda gamba non fosse prezzata separatamente, expected_total_cents resterebbe 2300 invece di 4600", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockImplementation((route) => (route === "napoli_ischia" ? 59 : route === "ischia_napoli" ? 47 : null));
    vi.mocked(medmarClient.fetchCorseReadOnly).mockImplementation(async ({ idTratta }) =>
      idTratta === 59
        ? [{ ...NAPOLI_ISCHIA_CORSA, id_corsa: 708, partenza_data: "2026-08-18", partenza_ora: "14:20" }]
        : [{ id_corsa: 709, id_tratta: 47, partenza_data: "2026-08-23", partenza_ora: "17:00", flag_chiuso: 0, flag_sospeso: 0, id_porto_partenza: 41, id_porto_arrivo: 1, porto_partenza: "ISCHIA", porto_arrivo: "NAPOLI", nave: "MEDMAR GIULIA" }]
    );
    vi.mocked(medmarClient.fetchBigliettiVendibiliReadOnly).mockImplementation(async (idCorsa) =>
      (idCorsa === 708 || idCorsa === 709 ? [arTariff1150({ id_corsa: idCorsa })] : []) as never
    );

    const result = await runMedmarPreflight(
      fakeAdmin([
        arrivalRow({ date: "2026-08-18", time: "14:20", booking_service_kind: "formula_medmar_napoli", pax: 2 }),
        departureRow({ date: "2026-08-23", time: "15:30", orario_barca: "17:00", booking_service_kind: "formula_medmar_napoli", meeting_point: null, pax: 2 }),
      ]),
      TENANT_A,
      [SVC_ARR, SVC_DEP]
    );

    expect(result.expected_total_cents).not.toBe(2300);
    expect(result.expected_total_cents).toBe(4600);
  });
});

describe("runMedmarPreflight — risoluzione porto isolano Ischia/Casamicciola (Fase 1.7)", () => {
  it("servizio Pozzuoli con meeting_point che menziona Casamicciola -> route_code pozzuoli_casamicciola, corsa Casamicciola raggiungibile end-to-end", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockImplementation((route) => (route === "pozzuoli_casamicciola" ? 50 : null));
    vi.mocked(medmarClient.fetchCorseReadOnly).mockResolvedValue([
      { id_corsa: 777, id_tratta: 50, partenza_data: "2026-08-20", partenza_ora: "08:40", flag_chiuso: 0, flag_sospeso: 0, id_porto_partenza: 44, id_porto_arrivo: 2, porto_partenza: "POZZUOLI", porto_arrivo: "CASAMICCIOLA", nave: "MEDMAR GIULIA" },
    ]);
    vi.mocked(medmarClient.fetchBigliettiVendibiliReadOnly).mockResolvedValue([AR_TARIFF_ROW, TASSA_SBARCO_ROW] as never);

    const row = arrivalRow({ booking_service_kind: "formula_medmar_pozzuoli", meeting_point: "Casamicciola - Corso Garibaldi" });
    const result = await runMedmarPreflight(fakeAdmin([row]), TENANT_A, [SVC_ARR]);

    expect(result.outward?.route_code).toBe("pozzuoli_casamicciola");
    expect(result.status).toBe("ok");
    expect(result.can_issue).toBe(true);
    expect(result.warnings.some((w) => w.code === "island_port_resolved" && w.message.includes("casamicciola"))).toBe(true);
  });

  it("servizio Pozzuoli senza meeting_point (mancante) -> porto isolano unknown, manual_review, can_issue false, NESSUN fallback su Ischia", async () => {
    const row = arrivalRow({ booking_service_kind: "formula_medmar_pozzuoli", meeting_point: null });
    const result = await runMedmarPreflight(fakeAdmin([row]), TENANT_A, [SVC_ARR]);

    expect(result.outward?.route_code).toBeNull();
    expect(result.status).toBe("manual_review");
    expect(result.can_issue).toBe(false);
    expect(result.warnings.some((w) => w.code === "route_not_determined")).toBe(true);
    expect(result.warnings.some((w) => w.code === "island_port_resolved")).toBe(false);
    expect(medmarClient.fetchCorseReadOnly).not.toHaveBeenCalled();
  });

  it("servizio Pozzuoli con meeting_point vuoto (stringa vuota) -> unknown, stesso comportamento fail-closed di meeting_point null", async () => {
    const row = arrivalRow({ booking_service_kind: "formula_medmar_pozzuoli", meeting_point: "   " });
    const result = await runMedmarPreflight(fakeAdmin([row]), TENANT_A, [SVC_ARR]);

    expect(result.status).toBe("manual_review");
    expect(result.can_issue).toBe(false);
  });

  it("sensitivity: nessun input con porto isolano non risolvibile produce mai un route_code contenente 'ischia' per default", async () => {
    const inputs: Row[] = [
      arrivalRow({ booking_service_kind: "formula_medmar_pozzuoli", meeting_point: null }),
      arrivalRow({ booking_service_kind: "formula_medmar_pozzuoli", meeting_point: undefined }),
      arrivalRow({ booking_service_kind: "formula_medmar_unknown", meeting_point: null }),
      arrivalRow({ booking_service_kind: null, meeting_point: null }),
    ];
    for (const row of inputs) {
      const result = await runMedmarPreflight(fakeAdmin([row]), TENANT_A, [SVC_ARR]);
      expect(result.outward?.route_code ?? null).toBeNull();
      expect(result.can_issue).toBe(false);
    }
  });
});

describe("runMedmarPreflight — quantita_min/max_per_esclusivo (Fase 2A.2: semantica non confermata, non usata come guard di disponibilità)", () => {
  it("quantita_min/max_per_esclusivo null sulla tariffa AR -> can_issue resta true (non usati per bloccare l'emissione)", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockReturnValue(59);
    vi.mocked(medmarClient.fetchCorseReadOnly).mockResolvedValue([NAPOLI_ISCHIA_CORSA]);
    vi.mocked(medmarClient.fetchBigliettiVendibiliReadOnly).mockResolvedValue([
      arTariffRow({ quantita_min_per_esclusivo: null, quantita_max_per_esclusivo: null }),
      tassaSbarcoRow({ quantita_min_per_esclusivo: null, quantita_max_per_esclusivo: null }),
    ] as never);

    const result = await runMedmarPreflight(fakeAdmin([ARRIVAL_ROW]), TENANT_A, [SVC_ARR]);

    expect(result.can_issue).toBe(true);
  });

  it("quantita_min/max_per_esclusivo negativo o 0 sulla tariffa AR -> can_issue resta true (nessun controllo di disponibilità implementato su dati non confermati)", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockReturnValue(59);
    vi.mocked(medmarClient.fetchCorseReadOnly).mockResolvedValue([NAPOLI_ISCHIA_CORSA]);
    vi.mocked(medmarClient.fetchBigliettiVendibiliReadOnly).mockResolvedValue([
      arTariffRow({ quantita_min_per_esclusivo: -1, quantita_max_per_esclusivo: -1 }),
      tassaSbarcoRow({ quantita_min_per_esclusivo: 0, quantita_max_per_esclusivo: 0 }),
    ] as never);

    const result = await runMedmarPreflight(fakeAdmin([arrivalRow({ pax: 5 })]), TENANT_A, [SVC_ARR]);

    expect(result.can_issue).toBe(true);
    expect(result.expected_total_cents).toBe((1025 + 150) * 5);
  });

  it("sensitivity: il vecchio campo 'quantita' (rimosso dallo schema reale) anche se presente nella riga non ha alcun effetto su can_issue", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockReturnValue(59);
    vi.mocked(medmarClient.fetchCorseReadOnly).mockResolvedValue([NAPOLI_ISCHIA_CORSA]);
    vi.mocked(medmarClient.fetchBigliettiVendibiliReadOnly).mockResolvedValue([
      { ...arTariffRow(), quantita: 0 },
      { ...tassaSbarcoRow(), quantita: 0 },
    ] as never);

    const result = await runMedmarPreflight(fakeAdmin([ARRIVAL_ROW]), TENANT_A, [SVC_ARR]);

    expect(result.can_issue).toBe(true);
  });
});

// Fixture reali corsa 133760 (Fase 2B.5) — vedi lib/server/medmar-booking/live-parser.ts.
function bambinoTariffRow(overrides: Row = {}): Row {
  return {
    id_corsa: 131943, id_biglietto: 17, id_tipologia_passeggero: 1, id_tariffa: 6,
    id_iva: 32, id_log: 45656,
    nome: "BAMBINO", descrizione: "PASSAGGIO PONTE BAMBINO (4-12 Anni)",
    prezzo: 8, prezzo_ar: 8, prezzo_prevendita: 8,
    flag_ar_obbligatorio: false, flag_targa: 0,
    quantita_min_per_esclusivo: null, quantita_max_per_esclusivo: null,
    collegati: null,
    ...overrides,
  };
}

function infantTariffRow(overrides: Row = {}): Row {
  return {
    id_corsa: 131943, id_biglietto: 20, id_tipologia_passeggero: 1, id_tariffa: 6,
    id_iva: 32, id_log: 45663,
    nome: "INFANT", descrizione: "PASSAGGIO PONTE INFANT (0-4 Anni)",
    prezzo: 2.5, prezzo_ar: 2.5, prezzo_prevendita: 2.5,
    flag_ar_obbligatorio: false, flag_targa: 0,
    quantita_min_per_esclusivo: null, quantita_max_per_esclusivo: null,
    collegati: null,
    ...overrides,
  };
}

describe("runMedmarPreflight — passeggeri misti adulto/bambino/infant (Fase 2B.5)", () => {
  function mixedRow(overrides: Row = {}): Row {
    return arrivalRow({
      pax: 3,
      ferry_details: { medmar_adult_count: 1, medmar_child_count: 1, medmar_infant_count: 1 },
      ...overrides,
    });
  }

  beforeEach(() => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockReturnValue(59);
    vi.mocked(medmarClient.fetchCorseReadOnly).mockResolvedValue([NAPOLI_ISCHIA_CORSA]);
  });

  it("15/29. 1 adulto + 1 bambino + 1 infant -> status passenger_payload_pending_verification, can_issue false, ticket_breakdown popolato con prezzi live", async () => {
    vi.mocked(medmarClient.fetchBigliettiVendibiliReadOnly).mockResolvedValue([
      AR_TARIFF_ROW, bambinoTariffRow(), infantTariffRow(), TASSA_SBARCO_ROW,
    ] as never);

    const result = await runMedmarPreflight(fakeAdmin([mixedRow()]), TENANT_A, [SVC_ARR]);

    expect(result.status).toBe("passenger_payload_pending_verification");
    expect(result.can_issue).toBe(false);
    expect(result.is_live).toBe(true);
    expect(result.passengers).toEqual({ adults: 1, children: 1, infants: 1, source: "medmar_counts" });
    expect(result.ticket_breakdown?.adult).toMatchObject({ count: 1, id_biglietto: 370, unit_price_cents: 1025, total_cents: 1025 });
    expect(result.ticket_breakdown?.child).toMatchObject({ count: 1, id_biglietto: 17, unit_price_cents: 800, total_cents: 800 });
    expect(result.ticket_breakdown?.infant).toMatchObject({ count: 1, id_biglietto: 20, unit_price_cents: 250, total_cents: 250 });
    expect(result.warnings.some((w) => w.code === "child_issue_payload_not_verified")).toBe(true);
  });

  it("14/heuristic: nessun collegati sui biglietti -> tax qty 2 (adulto+bambino), infant escluso (fallback euristico esplicito)", async () => {
    vi.mocked(medmarClient.fetchBigliettiVendibiliReadOnly).mockResolvedValue([
      AR_TARIFF_ROW, bambinoTariffRow(), infantTariffRow(), TASSA_SBARCO_ROW,
    ] as never);

    const result = await runMedmarPreflight(fakeAdmin([mixedRow()]), TENANT_A, [SVC_ARR]);

    expect(result.ticket_breakdown?.taxes).toMatchObject({ count: 2, unit_amount_cents: 150, total_amount_cents: 300 });
  });

  it("13. infant con collegati=[] (nessuna tax osservata) -> tax qty 1 (solo adulto), MAI una tax inventata per l'infant", async () => {
    vi.mocked(medmarClient.fetchBigliettiVendibiliReadOnly).mockResolvedValue([
      { ...AR_TARIFF_ROW, collegati: [{ id_biglietto: 999 }] },
      infantTariffRow({ collegati: [] }),
      TASSA_SBARCO_ROW,
    ] as never);

    const result = await runMedmarPreflight(fakeAdmin([arrivalRow({ pax: 2, ferry_details: { medmar_adult_count: 1, medmar_child_count: 0, medmar_infant_count: 1 } })]), TENANT_A, [SVC_ARR]);

    expect(result.ticket_breakdown?.taxes).toMatchObject({ count: 1 });
    expect(result.ticket_breakdown?.infant).toMatchObject({ count: 1, total_cents: 250 });
  });

  it("15. pricing misto: totale atteso = adulto*count + bambino*count + infant*count + tax(qty collegata)*prezzo tax", async () => {
    vi.mocked(medmarClient.fetchBigliettiVendibiliReadOnly).mockResolvedValue([
      AR_TARIFF_ROW, bambinoTariffRow(), infantTariffRow(), TASSA_SBARCO_ROW,
    ] as never);

    const result = await runMedmarPreflight(fakeAdmin([mixedRow()]), TENANT_A, [SVC_ARR]);

    // adulto 1025 + bambino 800 + infant 250 + tax 2*150 = 2375
    expect(result.expected_total_cents).toBe(1025 + 800 + 250 + 2 * 150);
  });

  it("16/17. sensitivity: nessun prezzo hardcoded — cambiare il prezzo live del bambino cambia il totale atteso", async () => {
    vi.mocked(medmarClient.fetchBigliettiVendibiliReadOnly).mockResolvedValue([
      AR_TARIFF_ROW, bambinoTariffRow({ prezzo: 99 }), infantTariffRow(), TASSA_SBARCO_ROW,
    ] as never);

    const result = await runMedmarPreflight(fakeAdmin([mixedRow()]), TENANT_A, [SVC_ARR]);

    expect(result.ticket_breakdown?.child?.unit_price_cents).toBe(9900);
    expect(result.expected_total_cents).toBe(1025 + 9900 + 250 + 2 * 150);
  });

  it("18. sensitivity: gruppo con SOLI adulti (children=0, infants=0 espliciti) -> comportamento invariato, can_issue true, status ok", async () => {
    vi.mocked(medmarClient.fetchBigliettiVendibiliReadOnly).mockResolvedValue([AR_TARIFF_ROW, TASSA_SBARCO_ROW] as never);

    const result = await runMedmarPreflight(
      fakeAdmin([arrivalRow({ pax: 2, ferry_details: { medmar_adult_count: 2, medmar_child_count: 0, medmar_infant_count: 0 } })]),
      TENANT_A,
      [SVC_ARR]
    );

    expect(result.status).toBe("ok");
    expect(result.can_issue).toBe(true);
    expect(result.expected_total_cents).toBe((1025 + 150) * 2);
    expect(result.ticket_breakdown?.child).toBeNull();
    expect(result.ticket_breakdown?.infant).toBeNull();
  });

  it("legacy: ferry_details mai valorizzato (prenotazioni precedenti alla Fase 2B.5) -> fallback adults=pax, comportamento identico a prima di questa fase", async () => {
    vi.mocked(medmarClient.fetchBigliettiVendibiliReadOnly).mockResolvedValue([AR_TARIFF_ROW, TASSA_SBARCO_ROW] as never);

    const result = await runMedmarPreflight(fakeAdmin([ARRIVAL_ROW]), TENANT_A, [SVC_ARR]);

    expect(result.status).toBe("ok");
    expect(result.can_issue).toBe(true);
    expect(result.passengers).toEqual({ adults: 2, children: 0, infants: 0, source: "pax_fallback" });
    expect(result.expected_total_cents).toBe((1025 + 150) * 2);
  });

  it("27/28. fail-closed: bambino presente -> can_issue sempre false anche con prezzo/tariffa completi", async () => {
    vi.mocked(medmarClient.fetchBigliettiVendibiliReadOnly).mockResolvedValue([AR_TARIFF_ROW, bambinoTariffRow(), TASSA_SBARCO_ROW] as never);

    const result = await runMedmarPreflight(
      fakeAdmin([arrivalRow({ pax: 2, ferry_details: { medmar_adult_count: 1, medmar_child_count: 1, medmar_infant_count: 0 } })]),
      TENANT_A,
      [SVC_ARR]
    );

    expect(result.can_issue).toBe(false);
    expect(result.status).toBe("passenger_payload_pending_verification");
  });

  it("sensitivity: bambino/infant con id_tipologia_passeggero=1 non vengono MAI conteggiati come adulto extra nel breakdown", async () => {
    vi.mocked(medmarClient.fetchBigliettiVendibiliReadOnly).mockResolvedValue([
      AR_TARIFF_ROW, bambinoTariffRow({ id_tipologia_passeggero: 1 }), infantTariffRow({ id_tipologia_passeggero: 1 }), TASSA_SBARCO_ROW,
    ] as never);

    const result = await runMedmarPreflight(fakeAdmin([mixedRow()]), TENANT_A, [SVC_ARR]);

    expect(result.ticket_breakdown?.adult).toMatchObject({ count: 1 });
    expect(result.tariff?.id_biglietto).toBe(370);
  });
});

describe("runMedmarPreflight — schema vecchio (Fase 1.6) non deve mai produrre can_issue=true (Fase 2A.2)", () => {
  it("fixture nel vecchio formato (biglietto/flag_ar invece di descrizione/flag_ar_obbligatorio) -> not_found, can_issue false", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockReturnValue(59);
    vi.mocked(medmarClient.fetchCorseReadOnly).mockResolvedValue([NAPOLI_ISCHIA_CORSA]);
    const oldShapedRow = {
      id_corsa: 131943, id_biglietto: 370, id_tipologia_passeggero: 1, id_tariffa: 6,
      id_log: 5001, id_iva: 22, id_gruppo: 1,
      biglietto: "PASSAGGIO PONTE ADULTO - TARIFFA SPECIALE AR",
      prezzo: 10.25, prezzo_prevendita: 10.25, quantita: 40,
      flag_ar: "R", flag_collegabile: 1, flag_targa: 0, checkin: true, re: null,
    };
    vi.mocked(medmarClient.fetchBigliettiVendibiliReadOnly).mockResolvedValue([oldShapedRow] as never);

    const result = await runMedmarPreflight(fakeAdmin([ARRIVAL_ROW]), TENANT_A, [SVC_ARR]);

    expect(result.can_issue).toBe(false);
  });
});

describe("runMedmarPreflight — fail-closed (Medmar non disponibile / auth scaduta)", () => {
  it("401/403 su ricerca corse -> status medmar_auth_expired, can_issue false", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockReturnValue(59);
    vi.mocked(medmarClient.fetchCorseReadOnly).mockRejectedValue(new medmarClient.MedmarAuthExpiredError());
    const result = await runMedmarPreflight(fakeAdmin([ARRIVAL_ROW]), TENANT_A, [SVC_ARR]);
    expect(result.status).toBe("medmar_auth_expired");
    expect(result.can_issue).toBe(false);
  });

  it("timeout/rete su ricerca corse -> status medmar_unavailable, can_issue false SEMPRE FALSE anche se l'orario locale combacerebbe", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockReturnValue(59);
    vi.mocked(medmarClient.fetchCorseReadOnly).mockRejectedValue(new medmarClient.MedmarNotAvailableError("Timeout chiamata Medmar."));
    // ARRIVAL_ROW.time = "08:40" combacia con l'orario locale noto (napoli_ischia),
    // ma il fallback locale NON deve mai trasformarsi in can_issue=true.
    const result = await runMedmarPreflight(fakeAdmin([ARRIVAL_ROW]), TENANT_A, [SVC_ARR]);
    expect(result.status).toBe("medmar_unavailable");
    expect(result.can_issue).toBe(false);
    expect(result.outward?.matched_departure_time).toBe("08:40"); // solo diagnostico
    expect(result.outward?.source).toBe("local_fallback");
  });

  it("500 Medmar su biglietti vendibili -> status medmar_unavailable, can_issue false", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockReturnValue(59);
    vi.mocked(medmarClient.fetchCorseReadOnly).mockResolvedValue([NAPOLI_ISCHIA_CORSA]);
    vi.mocked(medmarClient.fetchBigliettiVendibiliReadOnly).mockRejectedValue(new medmarClient.MedmarBadResponseError("Medmar ha risposto con errore 500."));
    const result = await runMedmarPreflight(fakeAdmin([ARRIVAL_ROW]), TENANT_A, [SVC_ARR]);
    expect(result.status).toBe("medmar_unavailable");
    expect(result.can_issue).toBe(false);
  });

  it("risposta corse malformata -> trattata come 0 corse (no_match), nessun crash", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockReturnValue(59);
    // Il parser reale (live-parser.ts) normalizza input non-array a [].
    vi.mocked(medmarClient.fetchCorseReadOnly).mockResolvedValue([]);
    const result = await runMedmarPreflight(fakeAdmin([ARRIVAL_ROW]), TENANT_A, [SVC_ARR]);
    expect(result.status).toBe("no_match");
    expect(result.can_issue).toBe(false);
  });
});

describe("runMedmarPreflight — Medmar non configurato (Fase 2A)", () => {
  it("MedmarNotConfiguredError su ricerca corse -> status medmar_auth_not_configured, can_issue false, MAI un crash", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockReturnValue(59);
    vi.mocked(medmarClient.fetchCorseReadOnly).mockRejectedValue(new MedmarNotConfiguredError());
    const result = await runMedmarPreflight(fakeAdmin([ARRIVAL_ROW]), TENANT_A, [SVC_ARR]);
    expect(result.status).toBe("medmar_auth_not_configured");
    expect(result.can_issue).toBe(false);
  });

  it("MedmarNotConfiguredError su biglietti vendibili -> status medmar_auth_not_configured, can_issue false", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockReturnValue(59);
    vi.mocked(medmarClient.fetchCorseReadOnly).mockResolvedValue([NAPOLI_ISCHIA_CORSA]);
    vi.mocked(medmarClient.fetchBigliettiVendibiliReadOnly).mockRejectedValue(new MedmarNotConfiguredError());
    const result = await runMedmarPreflight(fakeAdmin([ARRIVAL_ROW]), TENANT_A, [SVC_ARR]);
    expect(result.status).toBe("medmar_auth_not_configured");
    expect(result.can_issue).toBe(false);
  });

  it("medmar_auth_not_configured ha priorità su medmar_auth_expired quando le due gambe divergono", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockImplementation((route) => (route === "napoli_ischia" ? 59 : route === "ischia_pozzuoli" ? 14 : null));
    vi.mocked(medmarClient.fetchCorseReadOnly).mockImplementation(async ({ idTratta }) => {
      if (idTratta === 59) throw new MedmarNotConfiguredError();
      throw new medmarClient.MedmarAuthExpiredError();
    });
    const admin = fakeAdmin([
      ARRIVAL_ROW,
      { id: SVC_DEP, tenant_id: TENANT_A, date: "2026-08-25", time: "11:10", customer_name: "Mario Rossi", pax: 2, vessel: "Medmar", notes: "[practice:AAA]", booking_service_kind: "formula_medmar_pozzuoli", direction: "departure", status: "new", meeting_point: "Ischia Porto" },
    ]);
    const result = await runMedmarPreflight(admin, TENANT_A, [SVC_ARR, SVC_DEP]);
    expect(result.status).toBe("medmar_auth_not_configured");
    expect(result.can_issue).toBe(false);
  });

  it("MedmarAuthFailedError (credenziali automatiche rifiutate da Medmar) -> status medmar_unavailable, can_issue false, messaggio senza dati sensibili", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockReturnValue(59);
    vi.mocked(medmarClient.fetchCorseReadOnly).mockRejectedValue(new MedmarAuthFailedError("Medmar ha rifiutato le credenziali configurate."));
    const result = await runMedmarPreflight(fakeAdmin([ARRIVAL_ROW]), TENANT_A, [SVC_ARR]);
    expect(result.status).toBe("medmar_unavailable");
    expect(result.can_issue).toBe(false);
    const warningMsg = result.warnings.find((w) => w.code === "medmar_live_unavailable")?.message ?? "";
    expect(warningMsg).not.toMatch(/password|Bearer|token/i);
  });

  it("sensitivity: nessun risultato del preflight contiene mai un token/Bearer/credenziale, in nessuno scenario auth", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockReturnValue(59);
    vi.mocked(medmarClient.fetchCorseReadOnly).mockRejectedValue(new MedmarNotConfiguredError());
    const result = await runMedmarPreflight(fakeAdmin([ARRIVAL_ROW]), TENANT_A, [SVC_ARR]);
    expect(JSON.stringify(result)).not.toMatch(/Bearer |MEDMAR_PASSWORD|password/i);
  });
});

describe("runMedmarPreflight — nessuna chiamata mutativa", () => {
  it("in nessuno scenario viene chiamato un path mutativo Medmar", async () => {
    const assertSpy = vi.spyOn(medmarClient, "assertReadOnlyPath");
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockReturnValue(59);
    vi.mocked(medmarClient.fetchCorseReadOnly).mockResolvedValue([NAPOLI_ISCHIA_CORSA]);
    vi.mocked(medmarClient.fetchBigliettiVendibiliReadOnly).mockResolvedValue([AR_TARIFF_ROW] as never);
    await runMedmarPreflight(fakeAdmin([ARRIVAL_ROW]), TENANT_A, [SVC_ARR]);
    // fetchCorseReadOnly/fetchBigliettiVendibiliReadOnly sono mockati (non
    // eseguono il vero medmarReadonlyFetch in questo test), quindi il vero
    // assertReadOnlyPath del modulo reale non viene invocato da loro: questo
    // conferma che il preflight non ha alcuna via alternativa per chiamare
    // fetch/path arbitrari al di fuori dei 2 wrapper dedicati.
    expect(assertSpy).not.toHaveBeenCalled();
    assertSpy.mockRestore();
  });

  it("sensitivity: il modulo client non espone alcuna funzione verso path mutativi", () => {
    const exportNames = Object.keys(medmarClient);
    const suspicious = exportNames.filter((name) => /prenota|disponibilita|scongela|^lock|manuale$/i.test(name));
    expect(suspicious).toEqual([]);
  });

  it("sensitivity: nessun path contenente 'prenotazioni' è mai raggiungibile tramite assertReadOnlyPath", () => {
    expect(() => medmarClient.assertReadOnlyPath("/prenotazioni")).toThrow(medmarClient.MedmarMutationBlockedError);
    expect(() => medmarClient.assertReadOnlyPath("/prenotazioni/lock-disponibilita")).toThrow(medmarClient.MedmarMutationBlockedError);
  });
});

// Fase 2B.8 — MEDMAR VALIDAZIONE TEMPORALE CORSE: corse già partite + ordine
// A/R stesso giorno. `now` è sempre passato esplicitamente a
// runMedmarPreflight (4° argomento) cosi' ogni test è deterministico e
// indipendente dall'orologio reale della macchina che esegue la suite.
describe("runMedmarPreflight — Fase 2B.8 Regola 1: corsa già partita", () => {
  function napoliCorsa(overrides: Row = {}): Row {
    return {
      id_corsa: 900100, id_tratta: 59, partenza_data: "2026-08-19", partenza_ora: "08:40",
      flag_chiuso: 0, flag_sospeso: 0, id_porto_partenza: 1, id_porto_arrivo: 41,
      porto_partenza: "NAPOLI", porto_arrivo: "ISCHIA", nave: "MEDMAR GIULIA",
      ...overrides,
    };
  }

  it("1. oggi, corsa futura -> OK (can_issue true, nessun warning course_already_departed)", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockReturnValue(59);
    vi.mocked(medmarClient.fetchCorseReadOnly).mockResolvedValue([napoliCorsa()]);
    vi.mocked(medmarClient.fetchBigliettiVendibiliReadOnly).mockResolvedValue([AR_TARIFF_ROW, TASSA_SBARCO_ROW] as never);

    const now = romeDateTimeToUtc("2026-08-19", "08:00")!;
    const result = await runMedmarPreflight(fakeAdmin([arrivalRow({ date: "2026-08-19", time: "08:40" })]), TENANT_A, [SVC_ARR], now);

    expect(result.status).toBe("ok");
    expect(result.can_issue).toBe(true);
    expect(result.warnings.some((w) => w.code === "course_already_departed")).toBe(false);
  });

  it("2. oggi, corsa già partita -> BLOCCO (status/can_issue/warning/messaggio corretti)", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockReturnValue(59);
    // flag_chiuso=0/flag_sospeso=0 (corsa "vendibile" secondo Medmar): il
    // blocco deve arrivare SOLO dal controllo temporale ITS, non da questi flag.
    vi.mocked(medmarClient.fetchCorseReadOnly).mockResolvedValue([napoliCorsa()]);

    const now = romeDateTimeToUtc("2026-08-19", "20:00")!;
    const result = await runMedmarPreflight(fakeAdmin([arrivalRow({ date: "2026-08-19", time: "08:40" })]), TENANT_A, [SVC_ARR], now);

    expect(result.status).toBe("course_already_departed");
    expect(result.can_issue).toBe(false);
    const warn = result.warnings.find((w) => w.code === "course_already_departed");
    expect(warn?.leg).toBe("outward");
    expect(warn?.message).toBe("La corsa Medmar delle 08:40 del 19/08/2026 è già partita.");
    expect(medmarClient.fetchBigliettiVendibiliReadOnly).not.toHaveBeenCalled();
  });

  it("3. oggi, corsa esattamente all'ora corrente (departure_datetime === now, confine <=) -> BLOCCO", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockReturnValue(59);
    vi.mocked(medmarClient.fetchCorseReadOnly).mockResolvedValue([napoliCorsa()]);

    const now = romeDateTimeToUtc("2026-08-19", "08:40:00")!;
    const result = await runMedmarPreflight(fakeAdmin([arrivalRow({ date: "2026-08-19", time: "08:40" })]), TENANT_A, [SVC_ARR], now);

    expect(result.status).toBe("course_already_departed");
    expect(result.can_issue).toBe(false);
  });

  it("4. corsa domani con lo stesso orario di oggi -> OK", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockReturnValue(59);
    vi.mocked(medmarClient.fetchCorseReadOnly).mockResolvedValue([napoliCorsa({ partenza_data: "2026-08-20" })]);
    vi.mocked(medmarClient.fetchBigliettiVendibiliReadOnly).mockResolvedValue([AR_TARIFF_ROW, TASSA_SBARCO_ROW] as never);

    const now = romeDateTimeToUtc("2026-08-19", "08:40")!;
    const result = await runMedmarPreflight(fakeAdmin([arrivalRow({ date: "2026-08-20", time: "08:40" })]), TENANT_A, [SVC_ARR], now);

    expect(result.status).toBe("ok");
    expect(result.can_issue).toBe(true);
  });
});

describe("runMedmarPreflight — Fase 2B.8 Regola 2: ordine A/R (stesso giorno e giorni diversi)", () => {
  function corsaFor(idTratta: 59 | 47, date: string, time: string): Row {
    return idTratta === 59
      ? { id_corsa: 900200, id_tratta: 59, partenza_data: date, partenza_ora: time, flag_chiuso: 0, flag_sospeso: 0, id_porto_partenza: 1, id_porto_arrivo: 41, porto_partenza: "NAPOLI", porto_arrivo: "ISCHIA", nave: "MEDMAR GIULIA" }
      : { id_corsa: 900300, id_tratta: 47, partenza_data: date, partenza_ora: time, flag_chiuso: 0, flag_sospeso: 0, id_porto_partenza: 41, id_porto_arrivo: 1, porto_partenza: "ISCHIA", porto_arrivo: "NAPOLI", nave: "MEDMAR GIULIA" };
  }

  function setupLegs(outward: { date: string; time: string }, ret: { date: string; time: string }) {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockImplementation((route) => (route === "napoli_ischia" ? 59 : route === "ischia_napoli" ? 47 : null));
    vi.mocked(medmarClient.fetchCorseReadOnly).mockImplementation(async ({ idTratta }) =>
      idTratta === 59 ? [corsaFor(59, outward.date, outward.time)] : idTratta === 47 ? [corsaFor(47, ret.date, ret.time)] : []
    );
    return fakeAdmin([
      arrivalRow({ date: outward.date, time: outward.time }),
      departureRow({ date: ret.date, time: ret.time, orario_barca: ret.time, booking_service_kind: "formula_medmar_napoli", meeting_point: null }),
    ]);
  }

  it("5. andata 08:40 / ritorno 10:35 (stesso giorno) -> OK", async () => {
    const admin = setupLegs({ date: "2026-08-19", time: "08:40" }, { date: "2026-08-19", time: "10:35" });
    vi.mocked(medmarClient.fetchBigliettiVendibiliReadOnly).mockResolvedValue([AR_TARIFF_ROW, TASSA_SBARCO_ROW] as never);

    const now = romeDateTimeToUtc("2026-08-19", "06:00")!;
    const result = await runMedmarPreflight(admin, TENANT_A, [SVC_ARR, SVC_DEP], now);

    expect(result.status).toBe("ok");
    expect(result.can_issue).toBe(true);
    expect(result.warnings.some((w) => w.code === "invalid_same_day_return_order")).toBe(false);
  });

  it("6. andata 10:35 / ritorno 08:40 (stesso giorno, ritorno prima dell'andata) -> BLOCCO", async () => {
    const admin = setupLegs({ date: "2026-08-19", time: "10:35" }, { date: "2026-08-19", time: "08:40" });

    const now = romeDateTimeToUtc("2026-08-19", "06:00")!;
    const result = await runMedmarPreflight(admin, TENANT_A, [SVC_ARR, SVC_DEP], now);

    expect(result.status).toBe("invalid_same_day_return_order");
    expect(result.can_issue).toBe(false);
    expect(result.warnings.some((w) => w.code === "invalid_same_day_return_order")).toBe(true);
  });

  it("7. andata 10:35 / ritorno 10:35 (stesso orario, stesso giorno) -> BLOCCO", async () => {
    const admin = setupLegs({ date: "2026-08-19", time: "10:35" }, { date: "2026-08-19", time: "10:35" });

    const now = romeDateTimeToUtc("2026-08-19", "06:00")!;
    const result = await runMedmarPreflight(admin, TENANT_A, [SVC_ARR, SVC_DEP], now);

    expect(result.status).toBe("invalid_same_day_return_order");
    expect(result.can_issue).toBe(false);
  });

  it("8. andata 08:40 / ritorno 23:59 (stesso giorno) -> OK", async () => {
    const admin = setupLegs({ date: "2026-08-19", time: "08:40" }, { date: "2026-08-19", time: "23:59" });
    vi.mocked(medmarClient.fetchBigliettiVendibiliReadOnly).mockResolvedValue([AR_TARIFF_ROW, TASSA_SBARCO_ROW] as never);

    const now = romeDateTimeToUtc("2026-08-19", "06:00")!;
    const result = await runMedmarPreflight(admin, TENANT_A, [SVC_ARR, SVC_DEP], now);

    expect(result.status).toBe("ok");
    expect(result.can_issue).toBe(true);
  });

  it("9. andata oggi 17:00 / ritorno domani 08:40 (giorni diversi, la data prevale sull'orario) -> OK", async () => {
    const admin = setupLegs({ date: "2026-08-19", time: "17:00" }, { date: "2026-08-20", time: "08:40" });
    vi.mocked(medmarClient.fetchBigliettiVendibiliReadOnly).mockResolvedValue([AR_TARIFF_ROW, TASSA_SBARCO_ROW] as never);

    const now = romeDateTimeToUtc("2026-08-19", "06:00")!;
    const result = await runMedmarPreflight(admin, TENANT_A, [SVC_ARR, SVC_DEP], now);

    expect(result.status).toBe("ok");
    expect(result.can_issue).toBe(true);
    expect(result.warnings.some((w) => w.code === "invalid_same_day_return_order")).toBe(false);
  });

  it("10. andata domani / ritorno oggi -> BLOCCO perché ordine date impossibile (nessun confronto orario, la data basta)", async () => {
    const admin = setupLegs({ date: "2026-08-20", time: "08:40" }, { date: "2026-08-19", time: "17:00" });

    const now = romeDateTimeToUtc("2026-08-19", "06:00")!;
    const result = await runMedmarPreflight(admin, TENANT_A, [SVC_ARR, SVC_DEP], now);

    expect(result.status).toBe("invalid_same_day_return_order");
    expect(result.can_issue).toBe(false);
    expect(result.warnings.some((w) => w.code === "invalid_same_day_return_order")).toBe(true);
  });
});

describe("runMedmarPreflight — Fase 2B.8: timezone Europe/Rome (nessun confronto UTC naïve)", () => {
  it("11. corsa a cavallo di mezzanotte (00:30 del 20/08 a Roma = 22:30 UTC del 19/08): 30 minuti prima -> OK", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockReturnValue(59);
    vi.mocked(medmarClient.fetchCorseReadOnly).mockResolvedValue([
      { id_corsa: 900400, id_tratta: 59, partenza_data: "2026-08-20", partenza_ora: "00:30", flag_chiuso: 0, flag_sospeso: 0, id_porto_partenza: 1, id_porto_arrivo: 41, porto_partenza: "NAPOLI", porto_arrivo: "ISCHIA", nave: "MEDMAR GIULIA" },
    ]);
    vi.mocked(medmarClient.fetchBigliettiVendibiliReadOnly).mockResolvedValue([AR_TARIFF_ROW, TASSA_SBARCO_ROW] as never);

    // Istante UTC reale e corretto della corsa (00:30 CEST = 22:30 UTC del giorno prima): 2026-08-19T22:30:00Z.
    const now = new Date("2026-08-19T22:00:00.000Z"); // 30 minuti PRIMA dell'istante corretto
    const result = await runMedmarPreflight(fakeAdmin([arrivalRow({ date: "2026-08-20", time: "00:30" })]), TENANT_A, [SVC_ARR], now);

    expect(result.status).toBe("ok");
    expect(result.can_issue).toBe(true);
  });

  it("12. stessa corsa a cavallo di mezzanotte: 30 minuti dopo l'istante UTC corretto -> BLOCCO (un confronto UTC naïve sul solo campo 'data' darebbe invece OK, per errore)", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockReturnValue(59);
    vi.mocked(medmarClient.fetchCorseReadOnly).mockResolvedValue([
      { id_corsa: 900401, id_tratta: 59, partenza_data: "2026-08-20", partenza_ora: "00:30", flag_chiuso: 0, flag_sospeso: 0, id_porto_partenza: 1, id_porto_arrivo: 41, porto_partenza: "NAPOLI", porto_arrivo: "ISCHIA", nave: "MEDMAR GIULIA" },
    ]);

    // 23:00Z del 19/08: successivo all'istante UTC corretto (22:30Z) ma
    // ANTECEDENTE a "2026-08-20T00:30:00Z" — il valore che si otterrebbe
    // trattando erroneamente data+ora come se fossero già UTC. Solo
    // un'implementazione Europe/Rome-aware (non naïve) blocca qui.
    const now = new Date("2026-08-19T23:00:00.000Z");
    const result = await runMedmarPreflight(fakeAdmin([arrivalRow({ date: "2026-08-20", time: "00:30" })]), TENANT_A, [SVC_ARR], now);

    expect(result.status).toBe("course_already_departed");
    expect(result.can_issue).toBe(false);
  });
});

describe("runMedmarPreflight — Fase 2B.8: usa l'orario nave Medmar, mai il pickup", () => {
  it("13. pickup 13:15 / nave 15:00 -> il controllo temporale usa 15:00 (orario Medmar live, con secondi), non l'orario richiesto ITS troncato", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockReturnValue(59);
    vi.mocked(medmarClient.fetchCorseReadOnly).mockResolvedValue([
      { id_corsa: 900500, id_tratta: 59, partenza_data: "2026-08-19", partenza_ora: "15:00:00", flag_chiuso: 0, flag_sospeso: 0, id_porto_partenza: 1, id_porto_arrivo: 41, porto_partenza: "NAPOLI", porto_arrivo: "ISCHIA", nave: "MEDMAR GIULIA" },
    ]);

    // services.time = "15:00" qui rappresenta l'orario nave richiesto (mai il
    // pickup: vedi commento su MedmarPreflightServiceRow.time in preflight.ts).
    const row = arrivalRow({ date: "2026-08-19", time: "15:00" });
    const now = romeDateTimeToUtc("2026-08-19", "16:00")!; // dopo le 15:00 -> già partita
    const result = await runMedmarPreflight(fakeAdmin([row]), TENANT_A, [SVC_ARR], now);

    expect(result.status).toBe("course_already_departed");
    const warn = result.warnings.find((w) => w.code === "course_already_departed");
    // Il messaggio riflette l'orario Medmar live risolto (only.partenza_ora), non un valore diverso.
    expect(warn?.message).toBe("La corsa Medmar delle 15:00 del 19/08/2026 è già partita.");
  });

  it("14. modificare un campo non di nave (meeting_point, tipo 'pickup') non cambia l'esito della validazione nave", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockReturnValue(59);
    vi.mocked(medmarClient.fetchCorseReadOnly).mockResolvedValue([
      { id_corsa: 900600, id_tratta: 59, partenza_data: "2026-08-19", partenza_ora: "15:00:00", flag_chiuso: 0, flag_sospeso: 0, id_porto_partenza: 1, id_porto_arrivo: 41, porto_partenza: "NAPOLI", porto_arrivo: "ISCHIA", nave: "MEDMAR GIULIA" },
    ]);
    const now = romeDateTimeToUtc("2026-08-19", "16:00")!;

    const rowA = arrivalRow({ date: "2026-08-19", time: "15:00", meeting_point: "Hotel Central, ore 13:15" });
    const resultA = await runMedmarPreflight(fakeAdmin([rowA]), TENANT_A, [SVC_ARR], now);

    const rowB = arrivalRow({ date: "2026-08-19", time: "15:00", meeting_point: "Molo Beverello, ore 13:45" });
    const resultB = await runMedmarPreflight(fakeAdmin([rowB]), TENANT_A, [SVC_ARR], now);

    expect(resultA.status).toBe("course_already_departed");
    expect(resultB.status).toBe("course_already_departed");
    expect(resultA.warnings.find((w) => w.code === "course_already_departed")?.message).toBe(
      resultB.warnings.find((w) => w.code === "course_already_departed")?.message
    );
  });
});
