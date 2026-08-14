import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.MEDMAR_API_BASE_URL = "https://medmar.example.test";
process.env.MEDMAR_SESSION_TOKEN = "test-token";

const { fetchBigliettiVendibiliReadOnly, MedmarBadResponseError } = await import("@/lib/server/medmar-booking/client");

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Riga reale osservata via smoke test Fase 2A.1. */
const AR_ROW = {
  id_corsa: 131943, id_biglietto: 370, id_tipologia_passeggero: 1, id_tariffa: 6,
  id_iva: 22, id_log: 5001,
  nome: "ADULTO - TARIFFA SPECIALE AR",
  descrizione: "PASSAGGIO PONTE ADULTO - TARIFFA SPECIALE AR",
  prezzo: 10.25, prezzo_ar: 0, prezzo_prevendita: 10.25,
  flag_ar_obbligatorio: true, flag_targa: 0,
  quantita_min_per_esclusivo: null, quantita_max_per_esclusivo: null,
  collegati: null,
};

/** Envelope reale osservato via smoke test Fase 2A.1: { return: true, output: [...] }. */
function realEnvelope(rows: unknown[]) {
  return { return: true, output: rows };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("fetchBigliettiVendibiliReadOnly — schema reale (Fase 2A.2)", () => {
  it("envelope reale { return: true, output: [...] } -> righe parsate correttamente", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse(realEnvelope([AR_ROW])));
    const rows = await fetchBigliettiVendibiliReadOnly(131943);
    expect(rows).toEqual([AR_ROW]);
  });

  it("REGRESSIONE: il vecchio envelope Fase 1.6 (array grezzo alla radice) non è mai stato reale e ora fallisce", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse([AR_ROW]));
    await expect(fetchBigliettiVendibiliReadOnly(131943)).rejects.toThrow(MedmarBadResponseError);
  });

  it("REGRESSIONE: il vecchio envelope Fase 1.6 ({ data: [...] } alla radice) non è mai stato reale e ora fallisce", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse({ data: [AR_ROW] }));
    await expect(fetchBigliettiVendibiliReadOnly(131943)).rejects.toThrow(MedmarBadResponseError);
  });

  it("return: false -> fail closed anche con output array valido", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse({ return: false, output: [AR_ROW] }));
    await expect(fetchBigliettiVendibiliReadOnly(131943)).rejects.toThrow(MedmarBadResponseError);
  });

  it("response malformed (envelope non riconoscibile) -> fail closed, MedmarBadResponseError", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse({ unexpected: "shape" }));
    await expect(fetchBigliettiVendibiliReadOnly(131943)).rejects.toThrow(MedmarBadResponseError);
  });

  it("response malformed (stringa invece di JSON strutturato) -> fail closed", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse("not an object"));
    await expect(fetchBigliettiVendibiliReadOnly(131943)).rejects.toThrow(MedmarBadResponseError);
  });

  it("chiama il path READ-ONLY corretto con id_tariffa/id_biglietto vuoti", async () => {
    const spy = vi.spyOn(global, "fetch").mockResolvedValueOnce(jsonResponse(realEnvelope([AR_ROW])));
    await fetchBigliettiVendibiliReadOnly(131943);
    const calledUrl = String(spy.mock.calls[0]?.[0]);
    expect(calledUrl).toBe("https://medmar.example.test/production/biglietteria_api/public/index.php/api/biglietti/vendibili/131943?id_tariffa=&id_biglietto=");
  });
});
