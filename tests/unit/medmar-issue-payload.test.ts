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

describe("issue-payload — buildLockTickets (percorso solo-adulti)", () => {
  it("Fase 2D: una riga quantita=1 per singolo passeggero (mai più una riga aggregata quantita=pax), stesso per la tassa collegata", () => {
    const vendibili = new Map([[String(ID_CORSA), [adultRow(), taxRow()]]]);
    const lines = buildLockTickets(preflightResult({ pax: 2 }), vendibili);
    expect(lines).toEqual([
      { id_corsa: ID_CORSA, quantita: 1, id_log: 58820, descrizione: "PASSAGGIO PONTE ADULTO - TARIFFA SPECIALE AR" },
      { id_corsa: ID_CORSA, quantita: 1, id_log: 58820, descrizione: "PASSAGGIO PONTE ADULTO - TARIFFA SPECIALE AR" },
      { id_corsa: ID_CORSA, quantita: 1, id_log: 55880, descrizione: "TASSA DI SBARCO" },
      { id_corsa: ID_CORSA, quantita: 1, id_log: 55880, descrizione: "TASSA DI SBARCO" },
    ]);
  });

  it("pax=1: una sola riga adulto + una sola riga tassa (nessuna duplicazione spuria)", () => {
    const vendibili = new Map([[String(ID_CORSA), [adultRow(), taxRow()]]]);
    const lines = buildLockTickets(preflightResult({ pax: 1 }), vendibili);
    expect(lines).toEqual([
      { id_corsa: ID_CORSA, quantita: 1, id_log: 58820, descrizione: "PASSAGGIO PONTE ADULTO - TARIFFA SPECIALE AR" },
      { id_corsa: ID_CORSA, quantita: 1, id_log: 55880, descrizione: "TASSA DI SBARCO" },
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

describe("issue-payload — tassa di sbarco derivata da collegati[] (Fase 2C, root cause GERARDO D'ADDIO)", () => {
  const config: MedmarIssueConfig = { enabled: true, causaleId: 1, modalitaId: 5, vettoreAndataId: 1, vettoreRitornoId: 1 };
  const sessionContext: MedmarIssueSessionContext = { bearerToken: "t", userId: 1, clienteId: "c1", postazioneId: "p1", turnoId: 91001 };
  const OUTWARD_CORSA = 132178;
  const RETURN_CORSA = 131721;

  /** Riga adulto AR con tassa di sbarco SOLO annidata in collegati[] — struttura live reale osservata (nessuna riga sorella top-level). */
  function adultRowWithNestedTax(idCorsa: number, overrides: Partial<BigliettoVendibileRaw> = {}): BigliettoVendibileRaw {
    return adultRow({
      id_corsa: idCorsa,
      collegati: [
        {
          id_master: 370,
          id_corsa: idCorsa,
          id_biglietto: 413,
          id_tipologia_passeggero: 32,
          nome: "TASSA SBARCO",
          descrizione: "TASSA DI SBARCO",
          id_log: 55851,
          id_tariffa: 6,
          id_iva: 8,
          prezzo: 0,
          prezzo_ar: 0,
          prezzo_prevendita: 0,
          unita_allocata: 0,
          flag_targa: 0,
          quantita: 1,
          cumulativo: 0,
          orePrevendita: 24,
        },
      ],
      ...overrides,
    });
  }

  it("buildLockTickets: tassa SOLO in collegati[] (nessuna riga top-level) -> riga tassa per-passeggero comunque inclusa, id_log derivato live", () => {
    const vendibili = new Map([[String(OUTWARD_CORSA), [adultRowWithNestedTax(OUTWARD_CORSA)]]]);
    const lines = buildLockTickets(preflightResult({ pax: 2, outward: leg({ id_corsa: OUTWARD_CORSA }) }), vendibili);
    expect(lines).toEqual([
      { id_corsa: OUTWARD_CORSA, quantita: 1, id_log: 58820, descrizione: "PASSAGGIO PONTE ADULTO - TARIFFA SPECIALE AR" },
      { id_corsa: OUTWARD_CORSA, quantita: 1, id_log: 58820, descrizione: "PASSAGGIO PONTE ADULTO - TARIFFA SPECIALE AR" },
      { id_corsa: OUTWARD_CORSA, quantita: 1, id_log: 55851, descrizione: "TASSA DI SBARCO" },
      { id_corsa: OUTWARD_CORSA, quantita: 1, id_log: 55851, descrizione: "TASSA DI SBARCO" },
    ]);
  });

  it("buildLockTickets: taxIssue ambiguous (collegati[] e riga top-level discordanti) -> throw, ZERO riga costruita", () => {
    const vendibili = new Map([
      [String(OUTWARD_CORSA), [adultRowWithNestedTax(OUTWARD_CORSA), taxRow({ id_corsa: OUTWARD_CORSA, id_biglietto: 999 })]],
    ]);
    expect(() =>
      buildLockTickets(preflightResult({ pax: 2, outward: leg({ id_corsa: OUTWARD_CORSA }) }), vendibili)
    ).toThrow(MedmarIssuePayloadError);
  });

  it("buildBookingPayload: REGRESSIONE PISCITELLI/D'ADDIO — 2 adulti A/R -> dettaglio[] con 8 righe (1 adulto+1 tassa PER passeggero PER gamba, mai aggregato), id_biglietto_congelato individuale", () => {
    // Fase 2D — confronto esplicito coi due PDF Medmar reali: D'Addio (One
    // Click, aggregato: 2 numeri biglietto totali) vs Piscitelli (manuale,
    // struttura nativa Medmar: 4 numeri biglietto distinti, 8 righe
    // dettaglio[] — 1 adulto quantita=1 + 1 tassa quantita=1 PER passeggero
    // PER gamba). Questo test verifica che buildBookingPayload produca ora
    // la struttura Piscitelli anche a partire dai dati live D'Addio
    // (tassa solo in collegati[], vedi Fase 2C sopra).
    const vendibili = new Map([
      [String(OUTWARD_CORSA), [adultRowWithNestedTax(OUTWARD_CORSA)]],
      [String(RETURN_CORSA), [adultRowWithNestedTax(RETURN_CORSA)]],
    ]);
    const preflight = preflightResult({
      pax: 2,
      outward: leg({ id_corsa: OUTWARD_CORSA, direction: "outward" }),
      return: leg({ id_corsa: RETURN_CORSA, direction: "return" }),
    });
    // 2 frozen DISTINTI per gamba (id_biglietto_congelato diverso per ciascun
    // passeggero individuale — mai lo stesso frozen condiviso tra 2 persone).
    const frozenAdults = [
      frozen({ id_corsa: OUTWARD_CORSA, id_biglietto_congelato: 900001 }),
      frozen({ id_corsa: OUTWARD_CORSA, id_biglietto_congelato: 900002 }),
      frozen({ id_corsa: RETURN_CORSA, id_biglietto_congelato: 900003 }),
      frozen({ id_corsa: RETURN_CORSA, id_biglietto_congelato: 900004 }),
    ];

    const payload = buildBookingPayload({
      preflight,
      services: [{ id: "svc-1", tenant_id: "t1", customer_name: "Gerardo D'Addio", customer_email: "g@example.test", customer_phone: "123", pax: 2 }],
      vendibiliByCorsa: vendibili,
      frozenAdults,
      config,
      sessionContext,
      technicalEmail: "info@ischiatransferservice.it",
    });

    expect(payload.dettaglio).toHaveLength(8);

    const adultRows = payload.dettaglio.filter((r) => r.biglietto === "PASSAGGIO PONTE ADULTO - TARIFFA SPECIALE AR");
    const taxRows = payload.dettaglio.filter((r) => r.biglietto === "TASSA DI SBARCO");
    expect(adultRows).toHaveLength(4);
    expect(taxRows).toHaveLength(4);

    // Ogni riga adulto: quantita=1, MAI aggregata.
    for (const row of adultRows) expect(row.quantita).toBe(1);
    for (const row of taxRows) expect(row.quantita).toBe(1);

    // Ogni riga adulto ha un id_biglietto_congelato DIVERSO dagli altri (mai condiviso).
    const congelatiUsati = adultRows.map((r) => r.id_biglietto_congelato);
    expect(new Set(congelatiUsati).size).toBe(4);

    // Ogni riga tassa è collegata a UNA specifica riga adulto via id_child_riga (mai la stessa per due tasse diverse).
    const idChildRigaUsati = taxRows.map((r) => r.id_child_riga);
    expect(new Set(idChildRigaUsati).size).toBe(4);
    for (const taxRowLine of taxRows) {
      const parentRow = adultRows.find((r) => r.id_riga === taxRowLine.id_child_riga);
      expect(parentRow).toBeDefined();
      expect(parentRow!.id_corsa).toBe(taxRowLine.id_corsa);
      expect(parentRow!.flag_ar).toBe(taxRowLine.flag_ar);
    }

    // 2 righe adulto + 2 righe tassa per l'andata, idem per il ritorno (come nel PDF Piscitelli).
    expect(payload.dettaglio.filter((r) => r.flag_ar === "A")).toHaveLength(4);
    expect(payload.dettaglio.filter((r) => r.flag_ar === "R")).toHaveLength(4);

    // Fase 2F — id_gruppo nativo Medmar: passeggero 1 -> gruppo 1 su A e R (adulto+tassa), passeggero 2 -> gruppo 2 su A e R.
    // Medmar ricostruisce il pairing A/R cercando lo stesso id_gruppo sulla gamba opposta: mai gruppo diverso tra andata/ritorno dello stesso passeggero, mai gruppo diverso tra adulto e tassa collegata.
    const outwardRows = payload.dettaglio.filter((r) => r.flag_ar === "A");
    const returnRows = payload.dettaglio.filter((r) => r.flag_ar === "R");
    expect(outwardRows.map((r) => r.id_gruppo)).toEqual([1, 1, 2, 2]);
    expect(returnRows.map((r) => r.id_gruppo)).toEqual([1, 1, 2, 2]);
    // Stesso passeggero (stesso indice di consumo frozen) -> stesso id_gruppo su A e R.
    expect(outwardRows[0]!.id_gruppo).toBe(returnRows[0]!.id_gruppo);
    expect(outwardRows[2]!.id_gruppo).toBe(returnRows[2]!.id_gruppo);
  });

  it("Fase 2F — 1 adulto A/R -> gruppi [1,1,1,1] (A adulto, A tassa, R adulto, R tassa tutti gruppo 1)", () => {
    const vendibili = new Map([
      [String(OUTWARD_CORSA), [adultRowWithNestedTax(OUTWARD_CORSA)]],
      [String(RETURN_CORSA), [adultRowWithNestedTax(RETURN_CORSA)]],
    ]);
    const preflight = preflightResult({
      pax: 1,
      outward: leg({ id_corsa: OUTWARD_CORSA, direction: "outward" }),
      return: leg({ id_corsa: RETURN_CORSA, direction: "return" }),
    });
    const frozenAdults = [
      frozen({ id_corsa: OUTWARD_CORSA, id_biglietto_congelato: 910001 }),
      frozen({ id_corsa: RETURN_CORSA, id_biglietto_congelato: 910002 }),
    ];

    const payload = buildBookingPayload({
      preflight,
      services: [{ id: "svc-1", tenant_id: "t1", customer_name: "Mario Rossi", customer_email: "m@example.test", customer_phone: "123", pax: 1 }],
      vendibiliByCorsa: vendibili,
      frozenAdults,
      config,
      sessionContext,
      technicalEmail: "info@ischiatransferservice.it",
    });

    expect(payload.dettaglio).toHaveLength(4);
    expect(payload.dettaglio.map((r) => r.id_gruppo)).toEqual([1, 1, 1, 1]);
    const adultRows = payload.dettaglio.filter((r) => r.biglietto === "PASSAGGIO PONTE ADULTO - TARIFFA SPECIALE AR");
    const taxRows = payload.dettaglio.filter((r) => r.biglietto === "TASSA DI SBARCO");
    expect(adultRows).toHaveLength(2);
    expect(taxRows).toHaveLength(2);
    expect(new Set(adultRows.map((r) => r.id_biglietto_congelato)).size).toBe(2);
    const totale = payload.dettaglio.reduce((sum, r) => sum + r.prezzo, 0);
    expect(totale).toBe(20.5); // 2 x 10.25 (andata + ritorno)
  });

  it("Fase 2F — 6 adulti A/R -> gruppi 1..6 riusati identici su andata e ritorno, 24 righe totali", () => {
    const vendibili = new Map([
      [String(OUTWARD_CORSA), [adultRowWithNestedTax(OUTWARD_CORSA)]],
      [String(RETURN_CORSA), [adultRowWithNestedTax(RETURN_CORSA)]],
    ]);
    const preflight = preflightResult({
      pax: 6,
      outward: leg({ id_corsa: OUTWARD_CORSA, direction: "outward" }),
      return: leg({ id_corsa: RETURN_CORSA, direction: "return" }),
    });
    const frozenAdults = [
      ...Array.from({ length: 6 }, (_, i) => frozen({ id_corsa: OUTWARD_CORSA, id_biglietto_congelato: 920000 + i })),
      ...Array.from({ length: 6 }, (_, i) => frozen({ id_corsa: RETURN_CORSA, id_biglietto_congelato: 930000 + i })),
    ];

    const payload = buildBookingPayload({
      preflight,
      services: [{ id: "svc-1", tenant_id: "t1", customer_name: "Beatrice Papa", customer_email: "b@example.test", customer_phone: "123", pax: 6 }],
      vendibiliByCorsa: vendibili,
      frozenAdults,
      config,
      sessionContext,
      technicalEmail: "info@ischiatransferservice.it",
    });

    expect(payload.dettaglio).toHaveLength(24);
    const outwardRows = payload.dettaglio.filter((r) => r.flag_ar === "A");
    const returnRows = payload.dettaglio.filter((r) => r.flag_ar === "R");
    expect(outwardRows).toHaveLength(12);
    expect(returnRows).toHaveLength(12);

    // gruppi 1..6 sull'andata: [1,1,2,2,3,3,4,4,5,5,6,6] (adulto+tassa per ciascuno dei 6 passeggeri).
    expect(outwardRows.map((r) => r.id_gruppo)).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6]);
    // Stessi 6 gruppi riusati identici sul ritorno.
    expect(returnRows.map((r) => r.id_gruppo)).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6]);

    // Frozen distinti: 12 id_biglietto_congelato tutti diversi (mai condivisi tra passeggeri).
    const adultRows = payload.dettaglio.filter((r) => r.biglietto === "PASSAGGIO PONTE ADULTO - TARIFFA SPECIALE AR");
    expect(adultRows).toHaveLength(12);
    expect(new Set(adultRows.map((r) => r.id_biglietto_congelato)).size).toBe(12);

    // quantita sempre 1, prezzo sempre unitario, mai aggregato.
    for (const row of payload.dettaglio) expect(row.quantita).toBe(1);
    for (const row of adultRows) expect(row.prezzo).toBe(10.25);

    // Totale invariato: 12 righe adulto x 10.25 (tassa prezzo=0 nella fixture).
    const totale = payload.dettaglio.reduce((sum, r) => sum + r.prezzo, 0);
    expect(totale).toBe(123); // 12 x 10.25
  });

  it("buildBookingPayload: taxIssue ambiguous -> throw PRIMA di costruire qualunque riga dettaglio mutativa", () => {
    const vendibili = new Map([
      [String(OUTWARD_CORSA), [adultRowWithNestedTax(OUTWARD_CORSA), taxRow({ id_corsa: OUTWARD_CORSA, id_biglietto: 999 })]],
    ]);
    const preflight = preflightResult({ pax: 2, outward: leg({ id_corsa: OUTWARD_CORSA }) });
    expect(() =>
      buildBookingPayload({
        preflight,
        services: [{ id: "svc-1", tenant_id: "t1", customer_name: "Gerardo D'Addio", customer_email: "g@example.test", customer_phone: "123", pax: 2 }],
        vendibiliByCorsa: vendibili,
        frozenAdults: [frozen({ id_corsa: OUTWARD_CORSA })],
        config,
        sessionContext,
        technicalEmail: "info@ischiatransferservice.it",
      })
    ).toThrow(MedmarIssuePayloadError);
  });

  it("Fase 2F — id_gruppo nativo Medmar: 2 adulti, solo andata -> id_gruppo [1,1,2,2], id_child_riga corretto, frozen distinti, totale invariato", () => {
    const vendibili = new Map([[String(ID_CORSA), [adultRow(), taxRow()]]]);
    const preflight = preflightResult({ pax: 2, outward: leg({ id_corsa: ID_CORSA }), return: null });
    const frozenAdults = [
      frozen({ id_biglietto_congelato: 900101 }),
      frozen({ id_biglietto_congelato: 900102 }),
    ];

    const payload = buildBookingPayload({
      preflight,
      services: [{ id: "svc-1", tenant_id: "t1", customer_name: "Test Controllato", customer_email: "t@example.test", customer_phone: "123", pax: 2 }],
      vendibiliByCorsa: vendibili,
      frozenAdults,
      config,
      sessionContext,
      technicalEmail: "info@ischiatransferservice.it",
    });

    const adultRows = payload.dettaglio.filter((r) => r.biglietto === "PASSAGGIO PONTE ADULTO - TARIFFA SPECIALE AR");
    const taxRows = payload.dettaglio.filter((r) => r.biglietto === "TASSA DI SBARCO");

    expect(adultRows).toHaveLength(2);
    expect(taxRows).toHaveLength(2);
    for (const row of payload.dettaglio) expect(row.quantita).toBe(1);

    // id_gruppo: passeggero 1 -> 1 (adulto+tassa), passeggero 2 -> 2 (adulto+tassa). Ordine [adulto,tassa,adulto,tassa].
    expect(payload.dettaglio.map((r) => r.id_gruppo)).toEqual([1, 1, 2, 2]);

    // id_child_riga collega ogni tassa alla PROPRIA riga adulto (mai incrociata).
    expect(taxRows[0]!.id_child_riga).toBe(adultRows[0]!.id_riga);
    expect(taxRows[1]!.id_child_riga).toBe(adultRows[1]!.id_riga);

    // Frozen distinti: 2 id_biglietto_congelato diversi, mai condivisi.
    expect(adultRows.map((r) => r.id_biglietto_congelato)).toEqual([900101, 900102]);

    // Totale invariato: prezzo per riga resta il prezzo UNITARIO (10.25), mai sommato/aggregato.
    for (const row of adultRows) expect(row.prezzo).toBe(10.25);
    const totale = payload.dettaglio.reduce((sum, r) => sum + r.prezzo, 0);
    expect(totale).toBe(20.5); // 2 x 10.25 (tassa prezzo=0 nella fixture)
  });

  it("regressione: fixture precedente corsa 133760 (tassa top-level, adulto senza collegati) -> stessa granularità per-passeggero", () => {
    const vendibili = new Map([[String(ID_CORSA), [adultRow(), taxRow()]]]);
    const lines = buildLockTickets(preflightResult({ pax: 2 }), vendibili);
    expect(lines).toEqual([
      { id_corsa: ID_CORSA, quantita: 1, id_log: 58820, descrizione: "PASSAGGIO PONTE ADULTO - TARIFFA SPECIALE AR" },
      { id_corsa: ID_CORSA, quantita: 1, id_log: 58820, descrizione: "PASSAGGIO PONTE ADULTO - TARIFFA SPECIALE AR" },
      { id_corsa: ID_CORSA, quantita: 1, id_log: 55880, descrizione: "TASSA DI SBARCO" },
      { id_corsa: ID_CORSA, quantita: 1, id_log: 55880, descrizione: "TASSA DI SBARCO" },
    ]);
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
    // 21. tax: Fase 2D, una riga quantita=1 PER passeggero collegato (mai una riga aggregata quantita=taxQuantity)
    // -> SOLO adulto+bambino sono collegati (fallback euristico, nessun collegati[] nella fixture) -> 2 righe tax da 1, non 1 riga da 2.
    const taxLines = lines.filter((l) => l.descrizione === "TASSA DI SBARCO");
    expect(taxLines).toHaveLength(2);
    for (const t of taxLines) expect(t).toEqual({ id_corsa: ID_CORSA, quantita: 1, id_log: 55880, descrizione: "TASSA DI SBARCO" });
    expect(lines).toHaveLength(5);
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
