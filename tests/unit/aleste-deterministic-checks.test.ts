import { describe, expect, it } from "vitest";
import {
  applyAlesteDeterministicChecks,
  extractAlesteHeaderPax,
  extractAlesteTariffRows,
  resolveAlestePax,
  resolveAlesteReturnTrain,
  type AlesteCheckableForm,
} from "@/lib/server/aleste-deterministic-checks";
import { BELOTTI_AMBIGUOUS, BELOTTI_LIKE, REAL_001182, SAMORI_LIKE } from "./fixtures/aleste-pdf-texts";

function form(overrides: Partial<AlesteCheckableForm> = {}): AlesteCheckableForm {
  return {
    n_pax: "2",
    orario_partenza: "13:20",
    treno_ritorno: "ITA 9940",
    totale_pratica: "104",
    tipo_servizio: "transfer_station_hotel",
    data_partenza: "2026-04-26",
    ...overrides,
  };
}

function belottiForm(overrides: Partial<AlesteCheckableForm> = {}): AlesteCheckableForm {
  return form({ n_pax: "3", orario_partenza: "17:45", treno_ritorno: "ITA 8524", totale_pratica: "168", data_partenza: "2026-10-11", ...overrides });
}

describe("Aleste pax deterministico — audit SAMORI 26/015867", () => {
  it("documento equivalente SAMORI: PAX intestazione 6, righe tariffa coerenti 6 pax, totale 336 €", () => {
    expect(extractAlesteHeaderPax(SAMORI_LIKE)).toBe(6);
    expect(extractAlesteTariffRows(SAMORI_LIKE)).toEqual([
      { unitPrice: 28, pax: 6, num: 1, total: 168 },
      { unitPrice: 28, pax: 6, num: 1, total: 168 },
    ]);
    expect(resolveAlestePax(SAMORI_LIKE)).toMatchObject({ pax: 6, headerPax: 6, conflict: false });
  });

  it("documento coerente e AI già corretta (6) -> n_pax 6, nessun warning", () => {
    const result = applyAlesteDeterministicChecks(form({ n_pax: "6", totale_pratica: "336" }), SAMORI_LIKE);
    expect(result.form.n_pax).toBe("6");
    expect(result.warnings).toEqual([]);
  });

  it("caso opposto: AI = 1, parser deterministico = 6 -> corretto a 6 + warning (mai il '(1)' moltiplicatore)", () => {
    const result = applyAlesteDeterministicChecks(form({ n_pax: "1", totale_pratica: "336" }), SAMORI_LIKE);
    expect(result.form.n_pax).toBe("6");
    expect(result.warnings).toEqual([expect.stringMatching(/n_pax corretto da 1 a 6 \(letto da colonna PAX intestazione del PDF\)/)]);
  });

  it("il totale 336 € da solo NON inventa 6 pax: senza PAX leggibile n_pax resta 1, solo warning", () => {
    const noPaxText = "Il08-nov-26 1 TRANSFER HOTEL/STAZIONE\nDalle 13:20 M.p.: LA VILLA da: ITALO 9940 a: NAPOLI STAZIONE";
    const result = applyAlesteDeterministicChecks(form({ n_pax: "1", totale_pratica: "336" }), noPaxText);
    expect(result.form.n_pax).toBe("1");
    expect(result.warnings).toEqual([
      expect.stringMatching(/n_pax 1 non coerente col totale pratica 336\.00 € \(atteso 56\.00 € = 1 pax × 2 tratte × 28 €\)/),
    ]);
  });

  it("intestazione e righe tariffa in conflitto -> nessuna correzione, warning esplicito", () => {
    const conflicting = SAMORI_LIKE.replace("Staff Aleste6", "Staff Aleste5");
    const result = applyAlesteDeterministicChecks(form({ n_pax: "1", totale_pratica: "336" }), conflicting);
    expect(result.form.n_pax).toBe("1");
    expect(result.warnings.some((w) => /PAX non univoco nel PDF \(intestazione: 5, righe tariffa: 6\)/.test(w))).toBe(true);
  });

  it("split corretto anche con orario incollato davanti all'importo ('09:4012,502(1)25,00')", () => {
    expect(extractAlesteTariffRows("04-apr 09:40 TRAGHETTO POZZUOLI + TRS H. ISCHIA 09:4012,502(1)25,00")).toEqual([
      { unitPrice: 12.5, pax: 2, num: 1, total: 25 },
    ]);
  });

  it("riga con NUM diverso da 1 ('120,003(3)360,00'): il totale riga è importo × pax", () => {
    expect(extractAlesteTariffRows("BUS DA BOLOGNA PARTENZA ORE 09:15120,003(3)360,00")).toEqual([
      { unitPrice: 120, pax: 3, num: 3, total: 360 },
    ]);
  });
});

describe("Aleste treno di ritorno per blocco/orario — audit BELOTTI 26/015929", () => {
  it("documento con 3 numeri treno, partenza 17:45: vince il numero dello stesso blocco delle 17:45, mai la 'riga 2'", () => {
    const ret = resolveAlesteReturnTrain(BELOTTI_LIKE, "17:45");
    expect(ret.departureTime).toBe("17:45");
    expect(ret.candidates).toEqual(["ITA 8524"]);
    expect(ret.code).toBe("ITA 8524");
    // La riga 2 della tabella (ITA 9911) è un treno dell'andata.
    expect(ret.candidates).not.toContain("ITA 9911");
  });

  it("numero presente SOLO nel blocco delle 17:45 (riga tabella senza codice leggibile) -> preso dal blocco", () => {
    const blockOnly = BELOTTI_LIKE.replace("3 NAPOLI CENTRALE 17:4511-ott ITALOITA 8524", "3 NAPOLI CENTRALE 17:4511-ott ITALO");
    const ret = resolveAlesteReturnTrain(blockOnly, "17:45");
    expect(ret.code).toBe("ITALO 8524");
  });

  it("Haiku restituisce il treno del primo riquadro (FR 9604) -> corretto in ITA 8524 + warning", () => {
    const result = applyAlesteDeterministicChecks(belottiForm({ treno_ritorno: "FR 9604" }), BELOTTI_LIKE);
    expect(result.form.treno_ritorno).toBe("ITA 8524");
    expect(result.warnings).toEqual([expect.stringMatching(/Treno ritorno corretto da FR 9604 a ITA 8524 \(associato alla partenza delle 17:45/)]);
  });

  it("treno già corretto (stesso numero, formato diverso) -> nessuna modifica, nessun warning", () => {
    const result = applyAlesteDeterministicChecks(belottiForm({ treno_ritorno: "ITALO 8524" }), BELOTTI_LIKE);
    expect(result.form.treno_ritorno).toBe("ITALO 8524");
    expect(result.warnings).toEqual([]);
  });

  it("due candidati compatibili per le 17:45 (tabella ≠ blocco) -> campo non determinato + revisione manuale", () => {
    const result = applyAlesteDeterministicChecks(belottiForm(), BELOTTI_AMBIGUOUS);
    expect(result.form.treno_ritorno).toBe("");
    expect(result.warnings).toEqual([expect.stringMatching(/Più treni candidati per la partenza delle 17:45 \(FR 9547, ITALO 8524\)/)]);
  });

  it("due codici 'da:' nello stesso blocco delle 17:45 -> campo non determinato + revisione manuale", () => {
    const twoInBlock = BELOTTI_LIKE
      .replace("3 NAPOLI CENTRALE 17:4511-ott ITALOITA 8524", "3 NAPOLI CENTRALE 17:4511-ott ITALO")
      .replace("da: ITALO 8524 a: NAPOLI STAZIONE", "da: ITALO 8524 da: TRENITALIA 9547 a: NAPOLI STAZIONE");
    const result = applyAlesteDeterministicChecks(belottiForm(), twoInBlock);
    expect(result.form.treno_ritorno).toBe("");
    expect(result.warnings.some((w) => /Più treni candidati per la partenza delle 17:45/.test(w))).toBe(true);
  });

  it("orario partenza estratto diverso dal blocco di ritorno -> warning, nessuna modifica dell'orario", () => {
    const result = applyAlesteDeterministicChecks(belottiForm({ orario_partenza: "12:03" }), BELOTTI_LIKE);
    expect(result.form.orario_partenza).toBe("12:03");
    expect(result.warnings).toEqual([expect.stringMatching(/Orario partenza estratto 12:03 diverso .*Dalle 17:45/)]);
  });
});

describe("Aleste controlli deterministici — nessuna regressione su PDF reale corretto", () => {
  it("001182 (2 pax, ITALO 9940, totale 104): form invariato e nessun warning", () => {
    const input = form();
    const result = applyAlesteDeterministicChecks(input, REAL_001182);
    expect(result.form).toEqual(input);
    expect(result.warnings).toEqual([]);
  });

  it("testo vuoto (PDF scansionato senza testo usabile): nessun controllo", () => {
    const input = form({ n_pax: "1" });
    expect(applyAlesteDeterministicChecks(input, "")).toEqual({ form: input, warnings: [] });
  });
});
