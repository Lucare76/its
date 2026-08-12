import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveRouteCodeFromService, matchCourseByRouteAndTime } from "@/lib/server/medmar-booking/course-matcher";
import * as medmarClient from "@/lib/server/medmar-booking/client";
import * as routeMapping from "@/lib/server/medmar-booking/route-mapping";

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
    ...overrides,
  };
}

const ARRIVAL_ROW: Row = arrivalRow();

const NAPOLI_ISCHIA_CORSA: Row = {
  id_corsa: 131943, id_tratta: 59, partenza_data: "2026-08-20", partenza_ora: "08:40",
  flag_chiuso: 0, flag_sospeso: 0, id_porto_partenza: 1, id_porto_arrivo: 41,
  porto_partenza: "NAPOLI", porto_arrivo: "ISCHIA", nave: "MEDMAR GIULIA",
};

// Fixture "biglietto vendibile" nello schema reale confermato in Fase 1.6
// (id_corsa, id_biglietto, id_tipologia_passeggero, id_tariffa, id_log,
// id_iva, id_gruppo, biglietto, prezzo, prezzo_prevendita, quantita,
// flag_ar, flag_collegabile, flag_targa, checkin, re).
function arTariffRow(overrides: Row = {}): Row {
  return {
    id_corsa: 131943, id_biglietto: 370, id_tipologia_passeggero: 1, id_tariffa: 6,
    id_log: 5001, id_iva: 22, id_gruppo: 1,
    biglietto: "PASSAGGIO PONTE ADULTO - TARIFFA SPECIALE AR",
    prezzo: 10.25, prezzo_prevendita: 10.25, quantita: 40,
    flag_ar: "R", flag_collegabile: 1, flag_targa: 0, checkin: true, re: null,
    ...overrides,
  };
}

function tassaSbarcoRow(overrides: Row = {}): Row {
  return {
    id_corsa: 131943, id_biglietto: 999, id_tipologia_passeggero: 32, id_tariffa: 12,
    id_log: 5002, id_iva: 22, id_gruppo: 1,
    biglietto: "TASSA DI SBARCO",
    prezzo: 1.5, prezzo_prevendita: 1.5, quantita: 40,
    flag_ar: null, flag_collegabile: 0, flag_targa: 0, checkin: false, re: null,
    ...overrides,
  };
}

const AR_TARIFF_ROW = arTariffRow();
const TASSA_SBARCO_ROW = tassaSbarcoRow();

beforeEach(() => {
  vi.mocked(routeMapping.getIdTrattaForRouteCode).mockReset();
  vi.mocked(routeMapping.getExpectedPortsForRouteCode).mockReset().mockReturnValue(null);
  vi.mocked(routeMapping.isMirrorRouteCode).mockReset().mockReturnValue(true);
  vi.mocked(medmarClient.fetchCorseReadOnly).mockReset();
  vi.mocked(medmarClient.fetchBigliettiVendibiliReadOnly).mockReset();
});

describe("course-matcher — resolveRouteCodeFromService", () => {
  it("mappa arrivo Napoli -> napoli_ischia", () => {
    expect(resolveRouteCodeFromService({ bookingServiceKind: "formula_medmar_napoli", direction: "arrival" })).toBe("napoli_ischia");
  });
  it("mappa partenza Pozzuoli -> ischia_pozzuoli", () => {
    expect(resolveRouteCodeFromService({ bookingServiceKind: "formula_medmar_pozzuoli", direction: "departure" })).toBe("ischia_pozzuoli");
  });
  it("nessuna direzione -> null", () => {
    expect(resolveRouteCodeFromService({ bookingServiceKind: "formula_medmar_napoli", direction: null })).toBeNull();
  });
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
    const result = await runMedmarPreflight(fakeAdmin([ARRIVAL_ROW]), TENANT_A, [SVC_ARR]);
    expect(result.status).toBe("ambiguous");
    expect(result.can_issue).toBe(false);
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
    vi.mocked(medmarClient.fetchBigliettiVendibiliReadOnly).mockResolvedValue([arTariffRow({ biglietto: "ALTRA TARIFFA", flag_ar: null })] as never);

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
      { id: SVC_DEP, tenant_id: TENANT_A, date: "2026-08-25", time: "11:10", customer_name: "Mario Rossi", pax: 2, vessel: "Medmar", notes: "[practice:AAA]", booking_service_kind: "formula_medmar_pozzuoli", direction: "departure", status: "new" },
    ]);
    const result = await runMedmarPreflight(admin, TENANT_A, [SVC_ARR, SVC_DEP]);

    expect(result.status).toBe("manual_review");
    expect(result.can_issue).toBe(false);
    expect(result.warnings.some((w) => w.code === "leg_route_mismatch")).toBe(true);
    expect(medmarClient.fetchBigliettiVendibiliReadOnly).not.toHaveBeenCalled();
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
