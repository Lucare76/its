import { describe, it, expect } from "vitest";
import {
  parseBigliettiVendibiliResponse,
  findArTariffAndTax,
  ADULT_TIPOLOGIA_PASSEGGERO,
  TASSA_SBARCO_TIPOLOGIA_PASSEGGERO,
} from "@/lib/server/medmar-booking/live-parser";
import type { BigliettoVendibileRaw } from "@/lib/server/medmar-booking/types";

function bigliettoRow(overrides: Partial<BigliettoVendibileRaw> = {}): Record<string, unknown> {
  return {
    id_corsa: 131943,
    id_biglietto: 370,
    id_tipologia_passeggero: ADULT_TIPOLOGIA_PASSEGGERO,
    id_tariffa: 6,
    id_log: 5001,
    id_iva: 22,
    id_gruppo: 1,
    biglietto: "PASSAGGIO PONTE ADULTO - TARIFFA SPECIALE AR",
    prezzo: 10.25,
    prezzo_prevendita: 10.25,
    quantita: 40,
    flag_ar: "R",
    flag_collegabile: 1,
    flag_targa: 0,
    checkin: true,
    re: null,
    ...overrides,
  };
}

function tassaRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id_corsa: 131943,
    id_biglietto: 999,
    id_tipologia_passeggero: TASSA_SBARCO_TIPOLOGIA_PASSEGGERO,
    id_tariffa: 12,
    id_log: 5002,
    id_iva: 22,
    id_gruppo: 1,
    biglietto: "TASSA DI SBARCO",
    prezzo: 1.5,
    prezzo_prevendita: 1.5,
    quantita: 40,
    flag_ar: null,
    flag_collegabile: 0,
    flag_targa: 0,
    checkin: false,
    re: null,
    ...overrides,
  };
}

describe("live-parser — parseBigliettiVendibiliResponse (schema reale)", () => {
  it("array grezzo -> schemaValid true, tutti i campi reali letti dalla chiave esatta", () => {
    const { rows, schemaValid } = parseBigliettiVendibiliResponse([bigliettoRow()]);
    expect(schemaValid).toBe(true);
    expect(rows).toEqual([
      {
        id_corsa: 131943,
        id_biglietto: 370,
        id_tipologia_passeggero: 1,
        id_tariffa: 6,
        id_log: 5001,
        id_iva: 22,
        id_gruppo: 1,
        biglietto: "PASSAGGIO PONTE ADULTO - TARIFFA SPECIALE AR",
        prezzo: 10.25,
        prezzo_prevendita: 10.25,
        quantita: 40,
        flag_ar: "R",
        flag_collegabile: 1,
        flag_targa: 0,
        checkin: true,
        re: null,
      },
    ]);
  });

  it("envelope { data: [...] } -> schemaValid true", () => {
    const { rows, schemaValid } = parseBigliettiVendibiliResponse({ data: [bigliettoRow()] });
    expect(schemaValid).toBe(true);
    expect(rows).toHaveLength(1);
  });

  it("fail closed: envelope non riconoscibile (né array né { data }) -> schemaValid false, righe vuote", () => {
    expect(parseBigliettiVendibiliResponse({ foo: "bar" })).toEqual({ rows: [], schemaValid: false });
    expect(parseBigliettiVendibiliResponse(null)).toEqual({ rows: [], schemaValid: false });
    expect(parseBigliettiVendibiliResponse("not json")).toEqual({ rows: [], schemaValid: false });
  });

  it("sensitivity: il parser permissivo multi-chiave NON deve essere reintrodotto — chiavi alternative/legacy vengono ignorate, non lette come fallback", () => {
    // Forma "vecchio stile Fase 1.5" (permissiva): label/descrizione/prezzo_cents/idBiglietto
    // al posto dei campi reali confermati. Se qualcuno reintroduce pick(...)
    // multi-chiave, questi valori finirebbero per popolare i campi — qui
    // devono restare null.
    const legacyShapedRow = {
      idBiglietto: 370,
      idTariffa: 6,
      label: "PASSAGGIO PONTE ADULTO - TARIFFA SPECIALE AR",
      descrizione: "PASSAGGIO PONTE ADULTO - TARIFFA SPECIALE AR",
      tariffa_label: "PASSAGGIO PONTE ADULTO - TARIFFA SPECIALE AR",
      nome: "PASSAGGIO PONTE ADULTO - TARIFFA SPECIALE AR",
      prezzo_cents: 1025,
      price: 10.25,
      importo: 10.25,
    };
    const { rows, schemaValid } = parseBigliettiVendibiliResponse([legacyShapedRow]);
    expect(schemaValid).toBe(true);
    expect(rows[0]).toMatchObject({
      id_biglietto: null,
      id_tariffa: null,
      biglietto: null,
      prezzo: null,
    });
  });

  it("un envelope avvolto sotto chiavi alternative (biglietti/results/items) NON viene più riconosciuto (solo array o { data })", () => {
    expect(parseBigliettiVendibiliResponse({ biglietti: [bigliettoRow()] })).toEqual({ rows: [], schemaValid: false });
    expect(parseBigliettiVendibiliResponse({ results: [bigliettoRow()] })).toEqual({ rows: [], schemaValid: false });
    expect(parseBigliettiVendibiliResponse({ items: [bigliettoRow()] })).toEqual({ rows: [], schemaValid: false });
  });
});

describe("live-parser — findArTariffAndTax (selezione da dati live)", () => {
  it("adulto AR trovato + tassa di sbarco presente -> kind found, entrambi riportati", () => {
    const { rows } = parseBigliettiVendibiliResponse([bigliettoRow(), tassaRow()]);
    const result = findArTariffAndTax(rows);
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.tariff.id_biglietto).toBe(370);
      expect(result.tariff.id_tariffa).toBe(6);
      expect(result.tassaSbarco?.id_biglietto).toBe(999);
      expect(result.taxIssue).toBeNull();
    }
  });

  it("adulto AR trovato, tassa di sbarco mancante (nessuna riga) -> kind found, tassaSbarco null, nessun errore", () => {
    const { rows } = parseBigliettiVendibiliResponse([bigliettoRow()]);
    const result = findArTariffAndTax(rows);
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.tassaSbarco).toBeNull();
      expect(result.taxIssue).toBeNull();
    }
  });

  it("adulto AR mancante (nessuna riga con descrizione+flag_ar compatibili) -> kind not_found", () => {
    const { rows } = parseBigliettiVendibiliResponse([bigliettoRow({ biglietto: "ALTRA TARIFFA", flag_ar: null })]);
    expect(findArTariffAndTax(rows)).toEqual({ kind: "not_found" });
  });

  it("flag_ar diverso da 'R' (sola andata) -> non trattato come AR, kind not_found", () => {
    const { rows } = parseBigliettiVendibiliResponse([bigliettoRow({ flag_ar: "A" })]);
    expect(findArTariffAndTax(rows)).toEqual({ kind: "not_found" });
  });

  it("descrizione compatibile + flag_ar='R' ma id_tipologia_passeggero non adulto -> kind unsupported_passenger_type", () => {
    const { rows } = parseBigliettiVendibiliResponse([bigliettoRow({ id_tipologia_passeggero: 5 })]);
    const result = findArTariffAndTax(rows);
    expect(result.kind).toBe("unsupported_passenger_type");
    if (result.kind === "unsupported_passenger_type") {
      expect(result.row.id_tipologia_passeggero).toBe(5);
    }
  });

  it("tassa di sbarco ambigua (più righe) -> kind found ma taxIssue 'ambiguous'", () => {
    const { rows } = parseBigliettiVendibiliResponse([bigliettoRow(), tassaRow({ id_biglietto: 999 }), tassaRow({ id_biglietto: 998, prezzo: 2 })]);
    const result = findArTariffAndTax(rows);
    expect(result.kind).toBe("found");
    if (result.kind === "found") expect(result.taxIssue).toBe("ambiguous");
  });

  it("tassa di sbarco senza prezzo -> kind found ma taxIssue 'price_missing'", () => {
    const { rows } = parseBigliettiVendibiliResponse([bigliettoRow(), tassaRow({ prezzo: null })]);
    const result = findArTariffAndTax(rows);
    expect(result.kind).toBe("found");
    if (result.kind === "found") expect(result.taxIssue).toBe("price_missing");
  });

  it("id_biglietto/id_tariffa hardcoded 370/6 NON è più l'unico criterio: un id diverso con descrizione+flag_ar+tipologia corretti viene comunque selezionato", () => {
    const { rows } = parseBigliettiVendibiliResponse([bigliettoRow({ id_biglietto: 4321, id_tariffa: 99 })]);
    const result = findArTariffAndTax(rows);
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.tariff.id_biglietto).toBe(4321);
      expect(result.tariff.id_tariffa).toBe(99);
    }
  });
});
