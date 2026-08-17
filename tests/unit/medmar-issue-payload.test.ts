import { describe, it, expect } from "vitest";
import {
  buildLockTickets,
  buildBookingPayload,
  buildMixedPassengerLockTickets,
  validateAdultFrozenTickets,
  validatePassengerFrozenTickets,
  MedmarIssuePayloadError,
} from "@/lib/server/medmar-booking/issue-payload";
import type { BigliettoVendibileRaw, MedmarPreflightResult, MedmarPreflightLeg } from "@/lib/server/medmar-booking/types";
import type { MedmarIssueConfig, MedmarIssueSessionContext, MedmarLockedTicket } from "@/lib/server/medmar-booking/issue-types";

const ID_CORSA = 133760;

function leg(overrides: Partial<MedmarPreflightLeg> = {}): MedmarPreflightLeg {
  return {
    direction: "outward",
    route_code: "napoli_ischia",
    route: { from: "NAPOLI", to: "ISCHIA" },
    date: "2026-08-20",
    requested_time: "08:40",
    matched_departure_time: "08:40:00",
    candidate_count: 1,
    match_source: "booked_ferry_time",
    vessel: "MEDMAR GIULIA",
    service_ids: ["svc-1"],
    id_corsa: ID_CORSA,
    source: "live",
    ...overrides,
  };
}

function preflightResult(overrides: Partial<MedmarPreflightResult> = {}): MedmarPreflightResult {
  return {
    ok: true,
    can_issue: true,
    status: "ok",
    group_key: "AAA",
    customer_name: "Mario Rossi",
    pratica: "AAA",
    pax: 1,
    outward: leg(),
    return: null,
    tariff: { id_biglietto: 370, id_tariffa: 6, label: "PASSAGGIO PONTE ADULTO - TARIFFA SPECIALE AR", unit_price_cents: 1025, source: "medmar_live" },
    taxes: [{ label: "TASSA DI SBARCO", amount_cents: 150 }],
    expected_total_cents: 1175,
    is_live: true,
    warnings: [],
    error: null,
    passengers: { adults: 1, children: 0, infants: 0, source: "pax_fallback" },
    ticket_breakdown: null,
    ...overrides,
  };
}

function adultRow(overrides: Partial<BigliettoVendibileRaw> = {}): BigliettoVendibileRaw {
  return {
    id_corsa: ID_CORSA, id_biglietto: 370, id_tipologia_passeggero: 1, id_tariffa: 6,
    id_iva: 78, id_log: 58820, nome: "ADULTO - TARIFFA SPECIALE AR",
    descrizione: "PASSAGGIO PONTE ADULTO - TARIFFA SPECIALE AR",
    prezzo: 10.25, prezzo_ar: 10.25, prezzo_prevendita: 10.25,
    flag_ar_obbligatorio: true, flag_targa: 0,
    quantita_min_per_esclusivo: null, quantita_max_per_esclusivo: null,
    collegati: null,
    ...overrides,
  };
}

function childRow(overrides: Partial<BigliettoVendibileRaw> = {}): BigliettoVendibileRaw {
  return {
    id_corsa: ID_CORSA, id_biglietto: 17, id_tipologia_passeggero: 1, id_tariffa: 6,
    id_iva: 32, id_log: 45656, nome: "BAMBINO",
    descrizione: "PASSAGGIO PONTE BAMBINO (4-12 Anni)",
    prezzo: 8, prezzo_ar: 8, prezzo_prevendita: 8,
    flag_ar_obbligatorio: false, flag_targa: 0,
    quantita_min_per_esclusivo: null, quantita_max_per_esclusivo: null,
    collegati: null,
    ...overrides,
  };
}

function infantRow(overrides: Partial<BigliettoVendibileRaw> = {}): BigliettoVendibileRaw {
  return {
    id_corsa: ID_CORSA, id_biglietto: 20, id_tipologia_passeggero: 1, id_tariffa: 6,
    id_iva: 32, id_log: 45663, nome: "INFANT",
    descrizione: "PASSAGGIO PONTE INFANT (0-4 Anni)",
    prezzo: 2.5, prezzo_ar: 2.5, prezzo_prevendita: 2.5,
    flag_ar_obbligatorio: false, flag_targa: 0,
    quantita_min_per_esclusivo: null, quantita_max_per_esclusivo: null,
    collegati: null,
    ...overrides,
  };
}

function taxRow(overrides: Partial<BigliettoVendibileRaw> = {}): BigliettoVendibileRaw {
  return {
    id_corsa: ID_CORSA, id_biglietto: 413, id_tipologia_passeggero: 32, id_tariffa: 6,
    id_iva: 8, id_log: 55880, nome: "TASSA DI SBARCO", descrizione: "TASSA DI SBARCO",
    prezzo: 0, prezzo_ar: 0, prezzo_prevendita: 0,
    flag_ar_obbligatorio: false, flag_targa: 0,
    quantita_min_per_esclusivo: null, quantita_max_per_esclusivo: null,
    collegati: null,
    ...overrides,
  };
}

function frozen(overrides: Partial<MedmarLockedTicket> = {}): MedmarLockedTicket {
  return {
    id_corsa: ID_CORSA,
    quantita: 1,
    id_log: 58820,
    descrizione: "PASSAGGIO PONTE ADULTO - TARIFFA SPECIALE AR",
    id_biglietto: 370,
    id_biglietto_congelato: 900001,
    ...overrides,
  };
}

describe("issue-payload — buildLockTickets (percorso solo-adulti, invariato Fase 2B.5)", () => {
  it("adult-only: comportamento invariato, quantita = pax", () => {
    const vendibili = new Map([[String(ID_CORSA), [adultRow(), taxRow()]]]);
    const lines = buildLockTickets(preflightResult({ pax: 2 }), vendibili);
    expect(lines).toEqual([
      { id_corsa: ID_CORSA, quantita: 2, id_log: 58820, descrizione: "PASSAGGIO PONTE ADULTO - TARIFFA SPECIALE AR" },
      { id_corsa: ID_CORSA, quantita: 2, id_log: 55880, descrizione: "TASSA DI SBARCO" },
    ]);
  });

  it("difesa in profondità: bambino presente nel preflight -> throw, ZERO riga costruita (anche se il gate a monte fosse bypassato)", () => {
    const vendibili = new Map([[String(ID_CORSA), [adultRow(), taxRow()]]]);
    expect(() =>
      buildLockTickets(preflightResult({ passengers: { adults: 1, children: 1, infants: 0, source: "medmar_counts" } }), vendibili)
    ).toThrow(MedmarIssuePayloadError);
  });

  it("difesa in profondità: infant presente nel preflight -> throw", () => {
    const vendibili = new Map([[String(ID_CORSA), [adultRow(), taxRow()]]]);
    expect(() =>
      buildLockTickets(preflightResult({ passengers: { adults: 1, children: 0, infants: 1, source: "medmar_counts" } }), vendibili)
    ).toThrow(MedmarIssuePayloadError);
  });
});

describe("issue-payload — buildBookingPayload (difesa in profondità, Fase 2B.5)", () => {
  const config: MedmarIssueConfig = { enabled: true, causaleId: 1, modalitaId: 5, vettoreAndataId: 1, vettoreRitornoId: 1 };
  const sessionContext: MedmarIssueSessionContext = { bearerToken: "t", userId: 1, clienteId: "c1", postazioneId: "p1", turnoId: 91001 };

  it("bambino/infant presenti nel preflight -> throw PRIMA di costruire qualunque riga dettaglio mutativa, mai buildBookingPayload mutativo raggiunto", () => {
    const vendibili = new Map([[String(ID_CORSA), [adultRow(), taxRow()]]]);
    expect(() =>
      buildBookingPayload({
        preflight: preflightResult({ passengers: { adults: 1, children: 1, infants: 1, source: "medmar_counts" } }),
        services: [{ id: "svc-1", tenant_id: "t1", customer_name: "Mario Rossi", customer_email: "m@example.test", customer_phone: "123", pax: 3 }],
        vendibiliByCorsa: vendibili,
        frozenAdults: [frozen()],
        config,
        sessionContext,
        technicalEmail: "info@ischiatransferservice.it",
      })
    ).toThrow(MedmarIssuePayloadError);
  });
});

describe("issue-payload — buildMixedPassengerLockTickets (FIXTURE ONLY, nessun lock reale — Fase 2B.5)", () => {
  it("18/19/20/21. adult+child+infant+tax: una riga per categoria, tax qty = pax collegati (fallback euristico: adulto+bambino)", () => {
    const vendibili = new Map([[String(ID_CORSA), [adultRow(), childRow(), infantRow(), taxRow()]]]);
    const preflight = preflightResult({ passengers: { adults: 1, children: 1, infants: 1, source: "medmar_counts" } });
    const lines = buildMixedPassengerLockTickets(preflight, vendibili);

    expect(lines).toContainEqual({ id_corsa: ID_CORSA, quantita: 1, id_log: 58820, descrizione: "PASSAGGIO PONTE ADULTO - TARIFFA SPECIALE AR" });
    expect(lines).toContainEqual({ id_corsa: ID_CORSA, quantita: 1, id_log: 45656, descrizione: "PASSAGGIO PONTE BAMBINO (4-12 Anni)" });
    expect(lines).toContainEqual({ id_corsa: ID_CORSA, quantita: 1, id_log: 45663, descrizione: "PASSAGGIO PONTE INFANT (0-4 Anni)" });
    // 21. tax qty corretta: SOLO adulto+bambino sono collegati (fallback euristico, nessun collegati[] nella fixture) -> qty 2, non 3 (mai il totale pax).
    expect(lines).toContainEqual({ id_corsa: ID_CORSA, quantita: 2, id_log: 55880, descrizione: "TASSA DI SBARCO" });
    expect(lines).toHaveLength(4);
  });

  it("infant senza tax collegata (collegati=[] esplicito) -> tax qty riflette solo adulto", () => {
    const vendibili = new Map([[String(ID_CORSA), [adultRow(), infantRow({ collegati: [] }), taxRow()]]]);
    const preflight = preflightResult({ passengers: { adults: 1, children: 0, infants: 1, source: "medmar_counts" } });
    const lines = buildMixedPassengerLockTickets(preflight, vendibili);
    const taxLine = lines.find((l) => l.descrizione === "TASSA DI SBARCO");
    expect(taxLine?.quantita).toBe(1);
  });

  it("solo bambino (nessun adulto nel gruppo) -> riga bambino presente, nessuna riga adulto", () => {
    const vendibili = new Map([[String(ID_CORSA), [childRow(), taxRow()]]]);
    const preflight = preflightResult({ passengers: { adults: 0, children: 1, infants: 0, source: "medmar_counts" } });
    const lines = buildMixedPassengerLockTickets(preflight, vendibili);
    expect(lines.some((l) => l.descrizione.includes("ADULTO"))).toBe(false);
    expect(lines.some((l) => l.descrizione.includes("BAMBINO"))).toBe(true);
  });

  it("bambino presente nel gruppo ma nessuna riga BAMBINO nella risposta vendibili -> throw (mai un prezzo indovinato)", () => {
    const vendibili = new Map([[String(ID_CORSA), [adultRow(), taxRow()]]]);
    const preflight = preflightResult({ passengers: { adults: 1, children: 1, infants: 0, source: "medmar_counts" } });
    expect(() => buildMixedPassengerLockTickets(preflight, vendibili)).toThrow(MedmarIssuePayloadError);
  });
});

describe("issue-payload — validatePassengerFrozenTickets (generalizzazione di validateAdultFrozenTickets, Fase 2B.5)", () => {
  it("23. child frozen valid -> match trovato", () => {
    const requested = [{ id_corsa: ID_CORSA, quantita: 1, id_log: 45656, descrizione: "PASSAGGIO PONTE BAMBINO (4-12 Anni)" }];
    const frozenRows = [frozen({ id_log: 45656, descrizione: "PASSAGGIO PONTE BAMBINO (4-12 Anni)", id_biglietto: 17 })];
    expect(validatePassengerFrozenTickets(requested, frozenRows)).toHaveLength(1);
  });

  it("24. infant frozen valid -> match trovato", () => {
    const requested = [{ id_corsa: ID_CORSA, quantita: 1, id_log: 45663, descrizione: "PASSAGGIO PONTE INFANT (0-4 Anni)" }];
    const frozenRows = [frozen({ id_log: 45663, descrizione: "PASSAGGIO PONTE INFANT (0-4 Anni)", id_biglietto: 20 })];
    expect(validatePassengerFrozenTickets(requested, frozenRows)).toHaveLength(1);
  });

  it("25. child frozen missing -> throw", () => {
    const requested = [{ id_corsa: ID_CORSA, quantita: 1, id_log: 45656, descrizione: "PASSAGGIO PONTE BAMBINO (4-12 Anni)" }];
    expect(() => validatePassengerFrozenTickets(requested, [])).toThrow(MedmarIssuePayloadError);
  });

  it("26. duplicate child frozen (piu' righe candidate) -> ambiguo, throw", () => {
    const requested = [{ id_corsa: ID_CORSA, quantita: 1, id_log: 45656, descrizione: "PASSAGGIO PONTE BAMBINO (4-12 Anni)" }];
    const frozenRows = [
      frozen({ id_log: 45656, descrizione: "PASSAGGIO PONTE BAMBINO (4-12 Anni)", id_biglietto_congelato: 1 }),
      frozen({ id_log: 45656, descrizione: "PASSAGGIO PONTE BAMBINO (4-12 Anni)", id_biglietto_congelato: 2 }),
    ];
    expect(() => validatePassengerFrozenTickets(requested, frozenRows)).toThrow(MedmarIssuePayloadError);
  });

  it("22. tax NON richiede frozen: una riga tax nella richiesta viene ignorata dalla validazione (mai bloccante)", () => {
    const requested = [
      { id_corsa: ID_CORSA, quantita: 1, id_log: 45656, descrizione: "PASSAGGIO PONTE BAMBINO (4-12 Anni)" },
      { id_corsa: ID_CORSA, quantita: 2, id_log: 55880, descrizione: "TASSA DI SBARCO" },
    ];
    const frozenRows = [frozen({ id_log: 45656, descrizione: "PASSAGGIO PONTE BAMBINO (4-12 Anni)", id_biglietto: 17 })];
    // Nessuna riga frozen per la tax eppure la validazione non lancia: la tax è filtrata via PASSENGER_LINE_HINT, non richiesta.
    expect(validatePassengerFrozenTickets(requested, frozenRows)).toHaveLength(1);
  });

  it("adult validato da validatePassengerFrozenTickets esattamente come da validateAdultFrozenTickets (stesso risultato sul percorso adulto)", () => {
    const requested = [{ id_corsa: ID_CORSA, quantita: 1, id_log: 58820, descrizione: "PASSAGGIO PONTE ADULTO - TARIFFA SPECIALE AR" }];
    const frozenRows = [frozen()];
    expect(validatePassengerFrozenTickets(requested, frozenRows)).toEqual(validateAdultFrozenTickets(requested, frozenRows));
  });
});
