import { describe, it, expect } from "vitest";
import {
  parseBigliettiVendibiliResponse,
  findArTariffAndTax,
  resolveBigliettoLabel,
  ADULT_TIPOLOGIA_PASSEGGERO,
  TASSA_SBARCO_TIPOLOGIA_PASSEGGERO,
  classifyPassengerTicket,
  selectPassengerTariffs,
  deriveTaxLinkage,
} from "@/lib/server/medmar-booking/live-parser";
import type { BigliettoVendibileRaw } from "@/lib/server/medmar-booking/types";

/** Riga reale osservata via smoke test Fase 2A.1 (tariffa AR adulto). */
function bigliettoRow(overrides: Partial<BigliettoVendibileRaw> = {}): Record<string, unknown> {
  return {
    id_corsa: 131943,
    id_biglietto: 370,
    id_tipologia_passeggero: ADULT_TIPOLOGIA_PASSEGGERO,
    id_tariffa: 6,
    id_iva: 22,
    id_log: 5001,
    nome: "ADULTO - TARIFFA SPECIALE AR",
    descrizione: "PASSAGGIO PONTE ADULTO - TARIFFA SPECIALE AR",
    prezzo: 10.25,
    prezzo_ar: 0,
    prezzo_prevendita: 10.25,
    flag_ar_obbligatorio: true,
    flag_targa: 0,
    quantita_min_per_esclusivo: null,
    quantita_max_per_esclusivo: null,
    ...overrides,
  };
}

/** Riga reale osservata via smoke test Fase 2A.1 (tassa di sbarco). */
function tassaRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id_corsa: 131943,
    id_biglietto: 999,
    id_tipologia_passeggero: TASSA_SBARCO_TIPOLOGIA_PASSEGGERO,
    id_tariffa: 12,
    id_iva: 22,
    id_log: 5002,
    nome: "TASSA DI SBARCO",
    descrizione: "TASSA DI SBARCO",
    prezzo: 1.5,
    prezzo_ar: 0,
    prezzo_prevendita: 1.5,
    flag_ar_obbligatorio: false,
    flag_targa: 0,
    quantita_min_per_esclusivo: null,
    quantita_max_per_esclusivo: null,
    ...overrides,
  };
}

/** Envelope reale osservato: { return: true, output: [...] } — array DIRETTO sotto output. */
function realEnvelope(rows: unknown[]): unknown {
  return { return: true, output: rows };
}

describe("live-parser — parseBigliettiVendibiliResponse (schema reale, Fase 2A.2)", () => {
  it("envelope reale { return: true, output: [...] } -> schemaValid true, tutti i campi reali letti dalla chiave esatta", () => {
    const { rows, schemaValid, schemaError } = parseBigliettiVendibiliResponse(realEnvelope([bigliettoRow()]));
    expect(schemaValid).toBe(true);
    expect(schemaError).toBeNull();
    expect(rows).toEqual([
      {
        id_corsa: 131943,
        id_biglietto: 370,
        id_tipologia_passeggero: 1,
        id_tariffa: 6,
        id_iva: 22,
        id_log: 5001,
        nome: "ADULTO - TARIFFA SPECIALE AR",
        descrizione: "PASSAGGIO PONTE ADULTO - TARIFFA SPECIALE AR",
        prezzo: 10.25,
        prezzo_ar: 0,
        prezzo_prevendita: 10.25,
        flag_ar_obbligatorio: true,
        flag_targa: 0,
        quantita_min_per_esclusivo: null,
        quantita_max_per_esclusivo: null,
        collegati: null,
      },
    ]);
  });

  it("output vuoto ma envelope valido -> schemaValid true, rows vuoto (distinto da envelope malformato)", () => {
    const { rows, schemaValid } = parseBigliettiVendibiliResponse(realEnvelope([]));
    expect(schemaValid).toBe(true);
    expect(rows).toEqual([]);
  });

  it("return: false -> fail closed anche se output è un array valido", () => {
    const { rows, schemaValid, schemaError } = parseBigliettiVendibiliResponse({ return: false, output: [bigliettoRow()] });
    expect(schemaValid).toBe(false);
    expect(schemaError).toBe("return_not_true");
    expect(rows).toEqual([]);
  });

  it("output non è un array -> fail closed", () => {
    const { schemaValid, schemaError } = parseBigliettiVendibiliResponse({ return: true, output: { data: [bigliettoRow()] } });
    expect(schemaValid).toBe(false);
    expect(schemaError).toBe("output_not_array");
  });

  it("output mancante -> fail closed", () => {
    const { schemaValid, schemaError } = parseBigliettiVendibiliResponse({ return: true });
    expect(schemaValid).toBe(false);
    expect(schemaError).toBe("output_missing");
  });

  it("fail closed: envelope non riconoscibile (oggetto qualunque, null, stringa) -> schemaValid false, righe vuote", () => {
    expect(parseBigliettiVendibiliResponse({ foo: "bar" })).toEqual({ rows: [], schemaValid: false, schemaError: "return_not_true" });
    expect(parseBigliettiVendibiliResponse(null)).toEqual({ rows: [], schemaValid: false, schemaError: "envelope_not_object" });
    expect(parseBigliettiVendibiliResponse("not json")).toEqual({ rows: [], schemaValid: false, schemaError: "envelope_not_object" });
  });

  it("REGRESSIONE: il vecchio envelope Fase 1.6 (array alla radice) non è mai stato reale e ora deve fallire, non essere accettato", () => {
    const { schemaValid, rows } = parseBigliettiVendibiliResponse([bigliettoRow()]);
    expect(schemaValid).toBe(false);
    expect(rows).toEqual([]);
  });

  it("REGRESSIONE: il vecchio envelope Fase 1.6 ({ data: [...] } alla radice) non è mai stato reale e ora deve fallire", () => {
    const { schemaValid, rows } = parseBigliettiVendibiliResponse({ data: [bigliettoRow()] });
    expect(schemaValid).toBe(false);
    expect(rows).toEqual([]);
  });

  it("sensitivity: campi non reali (vecchio schema o inventati) non devono mai popolare i campi reali", () => {
    // Riga con SOLO chiavi non reali (né le vecchie Fase 1.6 "biglietto"/
    // "flag_ar"/"quantita"/"checkin", né alias inventati): tutti i campi
    // reali del parser devono restare null, mai un fallback permissivo.
    const noiseRow = {
      idBiglietto: 370,
      idTariffa: 6,
      label: "PASSAGGIO PONTE ADULTO - TARIFFA SPECIALE AR",
      tariffa_label: "PASSAGGIO PONTE ADULTO - TARIFFA SPECIALE AR",
      prezzo_cents: 1025,
      price: 10.25,
      importo: 10.25,
      biglietto: "PASSAGGIO PONTE ADULTO - TARIFFA SPECIALE AR",
      flag_ar: "R",
      quantita: 40,
      checkin: true,
    };
    const { rows, schemaValid } = parseBigliettiVendibiliResponse(realEnvelope([noiseRow]));
    expect(schemaValid).toBe(true);
    expect(rows[0]).toEqual({
      id_corsa: null,
      id_biglietto: null,
      id_tipologia_passeggero: null,
      id_tariffa: null,
      id_iva: null,
      id_log: null,
      nome: null,
      descrizione: null,
      prezzo: null,
      prezzo_ar: null,
      prezzo_prevendita: null,
      flag_ar_obbligatorio: null,
      flag_targa: null,
      quantita_min_per_esclusivo: null,
      quantita_max_per_esclusivo: null,
      collegati: null,
    });
  });

  it("un envelope avvolto sotto chiavi alternative (biglietti/results/items) NON viene riconosciuto (manca return/output)", () => {
    expect(parseBigliettiVendibiliResponse({ biglietti: [bigliettoRow()] }).schemaValid).toBe(false);
    expect(parseBigliettiVendibiliResponse({ results: [bigliettoRow()] }).schemaValid).toBe(false);
    expect(parseBigliettiVendibiliResponse({ items: [bigliettoRow()] }).schemaValid).toBe(false);
  });
});

describe("live-parser — resolveBigliettoLabel (precedenza descrizione/nome)", () => {
  it("descrizione presente -> fonte primaria", () => {
    const { rows } = parseBigliettiVendibiliResponse(realEnvelope([bigliettoRow()]));
    expect(resolveBigliettoLabel(rows[0]!)).toEqual({ label: "PASSAGGIO PONTE ADULTO - TARIFFA SPECIALE AR", source: "descrizione" });
  });

  it("descrizione assente/vuota, nome presente -> fonte secondaria", () => {
    const { rows } = parseBigliettiVendibiliResponse(realEnvelope([bigliettoRow({ descrizione: null })]));
    expect(resolveBigliettoLabel(rows[0]!)).toEqual({ label: "ADULTO - TARIFFA SPECIALE AR", source: "nome" });
  });

  it("entrambi assenti -> null", () => {
    const { rows } = parseBigliettiVendibiliResponse(realEnvelope([bigliettoRow({ descrizione: null, nome: null })]));
    expect(resolveBigliettoLabel(rows[0]!)).toEqual({ label: null, source: null });
  });
});

describe("live-parser — findArTariffAndTax (selezione da dati live, schema reale)", () => {
  it("adulto AR trovato + tassa di sbarco presente -> kind found, entrambi riportati, labelSource descrizione", () => {
    const { rows } = parseBigliettiVendibiliResponse(realEnvelope([bigliettoRow(), tassaRow()]));
    const result = findArTariffAndTax(rows);
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.tariff.id_biglietto).toBe(370);
      expect(result.tariff.id_tariffa).toBe(6);
      expect(result.labelSource).toBe("descrizione");
      expect(result.tassaSbarco?.id_biglietto).toBe(999);
      expect(result.taxIssue).toBeNull();
    }
  });

  it("adulto AR trovato, tassa di sbarco mancante (nessuna riga) -> kind found, tassaSbarco null, nessun errore", () => {
    const { rows } = parseBigliettiVendibiliResponse(realEnvelope([bigliettoRow()]));
    const result = findArTariffAndTax(rows);
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.tassaSbarco).toBeNull();
      expect(result.taxIssue).toBeNull();
    }
  });

  it("adulto AR trovato con descrizione assente ma nome compatibile -> kind found, labelSource nome (edge case esplicito)", () => {
    const { rows } = parseBigliettiVendibiliResponse(realEnvelope([bigliettoRow({ descrizione: null, nome: "PASSAGGIO PONTE ADULTO - TARIFFA SPECIALE AR" })]));
    const result = findArTariffAndTax(rows);
    expect(result.kind).toBe("found");
    if (result.kind === "found") expect(result.labelSource).toBe("nome");
  });

  it("adulto AR mancante (nessuna riga con descrizione/nome compatibili) -> kind not_found", () => {
    const { rows } = parseBigliettiVendibiliResponse(realEnvelope([bigliettoRow({ descrizione: "ALTRA TARIFFA", nome: "ALTRA TARIFFA" })]));
    expect(findArTariffAndTax(rows)).toEqual({ kind: "not_found" });
  });

  it("flag_ar_obbligatorio non è più usato come discriminante bloccante: descrizione compatibile con flag false viene comunque selezionata", () => {
    const { rows } = parseBigliettiVendibiliResponse(realEnvelope([bigliettoRow({ flag_ar_obbligatorio: false })]));
    const result = findArTariffAndTax(rows);
    expect(result.kind).toBe("found");
    if (result.kind === "found") expect(result.tariff.flag_ar_obbligatorio).toBe(false);
  });

  it("descrizione compatibile ma id_tipologia_passeggero non adulto -> kind unsupported_passenger_type", () => {
    const { rows } = parseBigliettiVendibiliResponse(realEnvelope([bigliettoRow({ id_tipologia_passeggero: 5 })]));
    const result = findArTariffAndTax(rows);
    expect(result.kind).toBe("unsupported_passenger_type");
    if (result.kind === "unsupported_passenger_type") {
      expect(result.row.id_tipologia_passeggero).toBe(5);
    }
  });

  it("più righe adulto AR candidate -> kind ambiguous_tariff, nessuna scelta arbitraria", () => {
    const { rows } = parseBigliettiVendibiliResponse(realEnvelope([
      bigliettoRow({ id_biglietto: 370 }),
      bigliettoRow({ id_biglietto: 999, id_tariffa: 77 }),
    ]));
    expect(findArTariffAndTax(rows)).toEqual({ kind: "ambiguous_tariff" });
  });

  it("tassa di sbarco ambigua (più righe) -> kind found ma taxIssue 'ambiguous'", () => {
    const { rows } = parseBigliettiVendibiliResponse(realEnvelope([bigliettoRow(), tassaRow({ id_biglietto: 999 }), tassaRow({ id_biglietto: 998, prezzo: 2 })]));
    const result = findArTariffAndTax(rows);
    expect(result.kind).toBe("found");
    if (result.kind === "found") expect(result.taxIssue).toBe("ambiguous");
  });

  it("tassa di sbarco senza prezzo -> kind found ma taxIssue 'price_missing'", () => {
    const { rows } = parseBigliettiVendibiliResponse(realEnvelope([bigliettoRow(), tassaRow({ prezzo: null })]));
    const result = findArTariffAndTax(rows);
    expect(result.kind).toBe("found");
    if (result.kind === "found") expect(result.taxIssue).toBe("price_missing");
  });

  it("id_biglietto/id_tariffa NON sono l'unico criterio: un id diverso con descrizione+tipologia corretti viene comunque selezionato", () => {
    const { rows } = parseBigliettiVendibiliResponse(realEnvelope([bigliettoRow({ id_biglietto: 4321, id_tariffa: 99 })]));
    const result = findArTariffAndTax(rows);
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.tariff.id_biglietto).toBe(4321);
      expect(result.tariff.id_tariffa).toBe(99);
    }
  });

  it("sensitivity: quantita_min/max_per_esclusivo sono catturati ma MAI usati per selezionare/escludere una tariffa", () => {
    const { rows } = parseBigliettiVendibiliResponse(realEnvelope([bigliettoRow({ quantita_min_per_esclusivo: 0, quantita_max_per_esclusivo: 0 })]));
    const result = findArTariffAndTax(rows);
    expect(result.kind).toBe("found");
  });
});

describe("live-parser — findArTariffAndTax: tassa di sbarco via collegati[] (Fase 2C, root cause GERARDO D'ADDIO)", () => {
  /** Entry collegati[] reale osservata live (corsa 132178/131721): tassa SOLO annidata, mai riga sorella top-level. */
  function collegatoTassa(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id_master: 370,
      id_corsa: 132178,
      id_biglietto: 413,
      id_tipologia_passeggero: TASSA_SBARCO_TIPOLOGIA_PASSEGGERO,
      unita_allocata: 0,
      nome: "TASSA SBARCO",
      descrizione: "TASSA DI SBARCO",
      flag_prevendita_obbligatorio: 0,
      flag_targa: 0,
      id_log: 55851,
      id_tariffa: 6,
      id_iva: 8,
      prezzo: 0,
      prezzo_ar: 0,
      prezzo_prevendita: 0,
      quantita: 1,
      cumulativo: 0,
      orePrevendita: 24,
      ...overrides,
    };
  }

  it("tassa SOLO in collegati[] (nessuna riga top-level, caso reale D'ADDIO) -> kind found, tassaSbarco derivata da collegati, taxIssue null", () => {
    const { rows } = parseBigliettiVendibiliResponse(realEnvelope([bigliettoRow({ collegati: [collegatoTassa()] })]));
    const result = findArTariffAndTax(rows);
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.tassaSbarco?.id_biglietto).toBe(413);
      expect(result.tassaSbarco?.id_log).toBe(55851);
      expect(result.tassaSbarco?.id_tipologia_passeggero).toBe(TASSA_SBARCO_TIPOLOGIA_PASSEGGERO);
      expect(result.taxIssue).toBeNull();
    }
  });

  it("tassa presente sia in collegati[] SIA come riga top-level, COERENTI (stesso id_biglietto) -> un'unica tassa logica, taxIssue null", () => {
    const { rows } = parseBigliettiVendibiliResponse(
      realEnvelope([bigliettoRow({ collegati: [collegatoTassa({ id_biglietto: 413 })] }), tassaRow({ id_biglietto: 413 })])
    );
    const result = findArTariffAndTax(rows);
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.tassaSbarco?.id_biglietto).toBe(413);
      expect(result.taxIssue).toBeNull();
    }
  });

  it("tassa presente sia in collegati[] SIA come riga top-level, DISCORDANTI (id_biglietto diverso) -> taxIssue ambiguous, fail-closed", () => {
    const { rows } = parseBigliettiVendibiliResponse(
      realEnvelope([bigliettoRow({ collegati: [collegatoTassa({ id_biglietto: 413 })] }), tassaRow({ id_biglietto: 999 })])
    );
    const result = findArTariffAndTax(rows);
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.taxIssue).toBe("ambiguous");
      expect(result.tassaSbarco).toBeNull();
    }
  });

  it("più di una tassa candidata SOLO dentro collegati[] -> taxIssue ambiguous, nessuna scelta arbitraria", () => {
    const { rows } = parseBigliettiVendibiliResponse(
      realEnvelope([bigliettoRow({ collegati: [collegatoTassa({ id_biglietto: 413 }), collegatoTassa({ id_biglietto: 414 })] })])
    );
    const result = findArTariffAndTax(rows);
    expect(result.kind).toBe("found");
    if (result.kind === "found") expect(result.taxIssue).toBe("ambiguous");
  });

  it("tassa in collegati[] senza prezzo valido -> taxIssue price_missing, fail-closed", () => {
    const { rows } = parseBigliettiVendibiliResponse(realEnvelope([bigliettoRow({ collegati: [collegatoTassa({ prezzo: null })] })]));
    const result = findArTariffAndTax(rows);
    expect(result.kind).toBe("found");
    if (result.kind === "found") expect(result.taxIssue).toBe("price_missing");
  });

  it("regressione: tassa SOLO top-level (nessun collegati) continua a funzionare come prima (fallback legacy invariato)", () => {
    const { rows } = parseBigliettiVendibiliResponse(realEnvelope([bigliettoRow(), tassaRow()]));
    const result = findArTariffAndTax(rows);
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.tassaSbarco?.id_biglietto).toBe(999);
      expect(result.taxIssue).toBeNull();
    }
  });

  it("collegati[] con entry non-tassa (es. CONDUCENTE VEICOLO) -> ignorata, non confusa con la tassa", () => {
    const { rows } = parseBigliettiVendibiliResponse(
      realEnvelope([bigliettoRow({ collegati: [{ id_biglietto: 23, id_tipologia_passeggero: 1, descrizione: "CONDUCENTE VEICOLO", nome: null, prezzo: 0 }] })])
    );
    const result = findArTariffAndTax(rows);
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.tassaSbarco).toBeNull();
      expect(result.taxIssue).toBeNull();
    }
  });
});

describe("live-parser — classifyPassengerTicket / selectPassengerTariffs / deriveTaxLinkage (Fase 2B.5)", () => {
  /** Riga reale osservata corsa 133760 — BAMBINO (4-12 anni), id_tipologia_passeggero=1 come l'adulto. */
  function bambinoRow(overrides: Partial<BigliettoVendibileRaw> = {}): Record<string, unknown> {
    return {
      id_corsa: 133760,
      id_biglietto: 17,
      id_tipologia_passeggero: ADULT_TIPOLOGIA_PASSEGGERO,
      id_tariffa: 6,
      id_iva: 32,
      id_log: 45656,
      nome: "BAMBINO",
      descrizione: "PASSAGGIO PONTE BAMBINO (4-12 Anni)",
      prezzo: 8,
      prezzo_ar: 8,
      prezzo_prevendita: 8,
      flag_ar_obbligatorio: false,
      flag_targa: 0,
      quantita_min_per_esclusivo: null,
      quantita_max_per_esclusivo: null,
      collegati: null,
      ...overrides,
    };
  }

  /** Riga reale osservata corsa 133760 — INFANT (0-4 anni), id_tipologia_passeggero=1 come l'adulto. */
  function infantRow(overrides: Partial<BigliettoVendibileRaw> = {}): Record<string, unknown> {
    return {
      id_corsa: 133760,
      id_biglietto: 20,
      id_tipologia_passeggero: ADULT_TIPOLOGIA_PASSEGGERO,
      id_tariffa: 6,
      id_iva: 32,
      id_log: 45663,
      nome: "INFANT",
      descrizione: "PASSAGGIO PONTE INFANT (0-4 Anni)",
      prezzo: 2.5,
      prezzo_ar: 2.5,
      prezzo_prevendita: 2.5,
      flag_ar_obbligatorio: false,
      flag_targa: 0,
      quantita_min_per_esclusivo: null,
      quantita_max_per_esclusivo: null,
      collegati: null,
      ...overrides,
    };
  }

  it("1. adulto AR speciale riconosciuto -> kind adult", () => {
    const { rows } = parseBigliettiVendibiliResponse(realEnvelope([bigliettoRow()]));
    expect(classifyPassengerTicket(rows[0]!).kind).toBe("adult");
  });

  it("2. bambino riconosciuto -> kind child", () => {
    const { rows } = parseBigliettiVendibiliResponse(realEnvelope([bambinoRow()]));
    expect(classifyPassengerTicket(rows[0]!).kind).toBe("child");
  });

  it("3. infant riconosciuto -> kind infant", () => {
    const { rows } = parseBigliettiVendibiliResponse(realEnvelope([infantRow()]));
    expect(classifyPassengerTicket(rows[0]!).kind).toBe("infant");
  });

  it("4. tax riconosciuta -> kind tax", () => {
    const { rows } = parseBigliettiVendibiliResponse(realEnvelope([tassaRow()]));
    expect(classifyPassengerTicket(rows[0]!).kind).toBe("tax");
  });

  it("5. auto NON classificata come pax -> kind unsupported", () => {
    const { rows } = parseBigliettiVendibiliResponse(realEnvelope([bigliettoRow({ descrizione: "PASSAGGIO AUTO FINO A 4 METRI", nome: "AUTO" })]));
    expect(classifyPassengerTicket(rows[0]!).kind).toBe("unsupported");
  });

  it("6. moto NON classificata come pax -> kind unsupported", () => {
    const { rows } = parseBigliettiVendibiliResponse(realEnvelope([bigliettoRow({ descrizione: "TRASPORTO MOTO", nome: "MOTO" })]));
    expect(classifyPassengerTicket(rows[0]!).kind).toBe("unsupported");
  });

  it("7. animale NON classificato come pax -> kind unsupported", () => {
    const { rows } = parseBigliettiVendibiliResponse(realEnvelope([bigliettoRow({ descrizione: "TRASPORTO ANIMALE DOMESTICO", nome: "ANIMALE" })]));
    expect(classifyPassengerTicket(rows[0]!).kind).toBe("unsupported");
  });

  it('8. "INT PASSEGGERO" (etichetta non riconosciuta) NON classificato come bambino -> kind unsupported', () => {
    const { rows } = parseBigliettiVendibiliResponse(realEnvelope([bigliettoRow({ descrizione: "INT PASSEGGERO", nome: "INT PASSEGGERO" })]));
    expect(classifyPassengerTicket(rows[0]!).kind).toBe("unsupported");
  });

  it("9. sensitivity: bambino con id_tipologia_passeggero=1 (come l'adulto) NON diventa adult", () => {
    const { rows } = parseBigliettiVendibiliResponse(realEnvelope([bambinoRow({ id_tipologia_passeggero: 1 })]));
    const result = classifyPassengerTicket(rows[0]!);
    expect(result.kind).toBe("child");
    expect(result.kind).not.toBe("adult");
  });

  it("10. sensitivity: infant con id_tipologia_passeggero=1 (come l'adulto) NON diventa adult", () => {
    const { rows } = parseBigliettiVendibiliResponse(realEnvelope([infantRow({ id_tipologia_passeggero: 1 })]));
    const result = classifyPassengerTicket(rows[0]!);
    expect(result.kind).toBe("infant");
    expect(result.kind).not.toBe("adult");
  });

  it("sensitivity: descrizione compatibile bambino ma id_tipologia_passeggero diverso da 1 -> unsupported (tipologia_mismatch), MAI child", () => {
    const { rows } = parseBigliettiVendibiliResponse(realEnvelope([bambinoRow({ id_tipologia_passeggero: 7 })]));
    const result = classifyPassengerTicket(rows[0]!);
    expect(result.kind).toBe("unsupported");
    if (result.kind === "unsupported") expect(result.reason).toBe("tipologia_mismatch");
  });

  it("sensitivity: id_biglietto 17 da solo (descrizione incompatibile) NON diventa la regola -> non classificato come child", () => {
    const { rows } = parseBigliettiVendibiliResponse(realEnvelope([bambinoRow({ id_biglietto: 17, descrizione: "ALTRA TARIFFA", nome: "ALTRA TARIFFA" })]));
    expect(classifyPassengerTicket(rows[0]!).kind).toBe("unsupported");
  });

  it("sensitivity: id_biglietto 20 da solo (descrizione incompatibile) NON diventa la regola -> non classificato come infant", () => {
    const { rows } = parseBigliettiVendibiliResponse(realEnvelope([infantRow({ id_biglietto: 20, descrizione: "ALTRA TARIFFA", nome: "ALTRA TARIFFA" })]));
    expect(classifyPassengerTicket(rows[0]!).kind).toBe("unsupported");
  });

  it("selectPassengerTariffs: 1 adulto + 1 bambino + 1 infant + 1 tax -> tutte e 4 le categorie 'found'", () => {
    const { rows } = parseBigliettiVendibiliResponse(realEnvelope([bigliettoRow(), bambinoRow(), infantRow(), tassaRow()]));
    const selection = selectPassengerTariffs(rows);
    expect(selection.adult.kind).toBe("found");
    expect(selection.child.kind).toBe("found");
    expect(selection.infant.kind).toBe("found");
    expect(selection.taxRows).toHaveLength(1);
  });

  it("selectPassengerTariffs: nessun bambino nella risposta -> child not_found (non un errore)", () => {
    const { rows } = parseBigliettiVendibiliResponse(realEnvelope([bigliettoRow()]));
    expect(selectPassengerTariffs(rows).child.kind).toBe("not_found");
  });

  it("selectPassengerTariffs: due righe bambino candidate -> ambiguous, nessuna scelta arbitraria", () => {
    const { rows } = parseBigliettiVendibiliResponse(realEnvelope([bambinoRow({ id_biglietto: 17 }), bambinoRow({ id_biglietto: 18 })]));
    expect(selectPassengerTariffs(rows).child.kind).toBe("ambiguous");
  });

  it("11. tax: adulto con collegati che referenzia l'id_biglietto della tassa -> linked true, source collegati", () => {
    const { rows } = parseBigliettiVendibiliResponse(
      realEnvelope([bigliettoRow({ collegati: [{ id_biglietto: 413 }] }), tassaRow({ id_biglietto: 413 })])
    );
    const selection = selectPassengerTariffs(rows);
    const adultRow = selection.adult.kind === "found" ? selection.adult.ticket : null;
    expect(adultRow).not.toBeNull();
    const linkage = deriveTaxLinkage("adult", adultRow!, selection.taxRows);
    expect(linkage).toEqual({ linked: true, tax: expect.objectContaining({ id_biglietto: 413 }), source: "collegati" });
  });

  it("12. tax: bambino con collegati che referenzia l'id_biglietto della tassa -> linked true, source collegati", () => {
    const { rows } = parseBigliettiVendibiliResponse(
      realEnvelope([bambinoRow({ collegati: [{ id_biglietto: 413 }] }), tassaRow({ id_biglietto: 413 })])
    );
    const selection = selectPassengerTariffs(rows);
    const childRow = selection.child.kind === "found" ? selection.child.ticket : null;
    const linkage = deriveTaxLinkage("child", childRow!, selection.taxRows);
    expect(linkage.linked).toBe(true);
    if (linkage.linked) expect(linkage.source).toBe("collegati");
  });

  it("13. tax: infant con collegati=[] (nessun link osservato) -> linked false, MAI una tax inventata", () => {
    const { rows } = parseBigliettiVendibiliResponse(realEnvelope([infantRow({ collegati: [] }), tassaRow({ id_biglietto: 413 })]));
    const selection = selectPassengerTariffs(rows);
    const infantTicket = selection.infant.kind === "found" ? selection.infant.ticket : null;
    const linkage = deriveTaxLinkage("infant", infantTicket!, selection.taxRows);
    expect(linkage).toEqual({ linked: false, source: "none" });
  });

  it("13b. tax: infant con collegati assente (fallback euristico) resta comunque senza tax -> linked false", () => {
    const { rows } = parseBigliettiVendibiliResponse(realEnvelope([infantRow(), tassaRow({ id_biglietto: 413 })]));
    const selection = selectPassengerTariffs(rows);
    const infantTicket = selection.infant.kind === "found" ? selection.infant.ticket : null;
    const linkage = deriveTaxLinkage("infant", infantTicket!, selection.taxRows);
    expect(linkage).toEqual({ linked: false, source: "none" });
  });

  it("adulto/bambino senza collegati (dato non disponibile) -> fallback euristico ESPLICITAMENTE etichettato, mai silenzioso", () => {
    const { rows } = parseBigliettiVendibiliResponse(realEnvelope([bigliettoRow(), tassaRow({ id_biglietto: 413 })]));
    const selection = selectPassengerTariffs(rows);
    const adultTicket = selection.adult.kind === "found" ? selection.adult.ticket : null;
    const linkage = deriveTaxLinkage("adult", adultTicket!, selection.taxRows);
    expect(linkage.linked).toBe(true);
    if (linkage.linked) expect(linkage.source).toBe("heuristic_unverified");
  });

  it("sensitivity: due righe tax nella risposta -> linkage ambiguo, nessuna tax collegata scelta arbitrariamente", () => {
    const { rows } = parseBigliettiVendibiliResponse(realEnvelope([bigliettoRow(), tassaRow({ id_biglietto: 413 }), tassaRow({ id_biglietto: 414 })]));
    const selection = selectPassengerTariffs(rows);
    const adultTicket = selection.adult.kind === "found" ? selection.adult.ticket : null;
    expect(deriveTaxLinkage("adult", adultTicket!, selection.taxRows)).toEqual({ linked: false, source: "ambiguous" });
  });

  it("sensitivity: nessuna riga tax nella risposta -> linked false, source none per qualunque categoria", () => {
    const { rows } = parseBigliettiVendibiliResponse(realEnvelope([bigliettoRow()]));
    const selection = selectPassengerTariffs(rows);
    const adultTicket = selection.adult.kind === "found" ? selection.adult.ticket : null;
    expect(deriveTaxLinkage("adult", adultTicket!, selection.taxRows)).toEqual({ linked: false, source: "none" });
  });
});
