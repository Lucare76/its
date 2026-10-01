import { describe, it, expect } from "vitest";
import { applyAlesteFerryTitleTimes, type ClaudeFormState } from "@/lib/server/pdf-extract-haiku";

function form(overrides: Partial<ClaudeFormState> = {}): ClaudeFormState {
  return {
    cliente_nome: "", cliente_cellulare: "", n_pax: "2", hotel: "", data_arrivo: "2026-04-04",
    orario_arrivo: "", data_partenza: "2026-04-07", orario_partenza: "", tipo_servizio: "transfer_port_hotel",
    treno_andata: "MEDMAR", treno_ritorno: "MEDMAR", citta_partenza: "PORTO DI POZZUOLI", totale_pratica: "",
    note: "", numero_pratica: "", agenzia: "Aleste Viaggi", tipo_barca_ritorno: "traghetto", porto_ritorno: "pozzuoli",
    ...overrides,
  };
}

// Testo reale estratto dal PDF Aleste 001233 (blocco operativo).
const ALESTE_001233 = [
  "04-apr 09:40 TRAGHETTO POZZUOLI + TRS H. ISCHIA 09:4012,502(1)25,00",
  "07-apr 11:10 TRS H. ISCHIA + TRAGHETTO POZZUOLI 11:1012,502(1)25,00",
  "50,00 Il04-apr-26 1 TRAGHETTO POZZUOLI + TRS H. ISCHIA 09:40",
  "Dalle 09:40 M.p.: PORTO DI POZZUOLI da: POZZUOLI CON MEDMAR a: CELL. 3515859941",
  "dest: LA VILLA Il07-apr-26 1 TRS H. ISCHIA + TRAGHETTO POZZUOLI 11:10",
  "Dalle 11:10 M.p.: HOTEL ISCHIA da: HOTEL a: PORTO PER POZZUOLI CON MEDMAR dest:",
].join("\n");

describe("applyAlesteFerryTitleTimes — Aleste PORTO/HOTEL senza 'Alle'", () => {
  it("001233: Haiku senza orari (nessun 'Alle') -> andata 09:40 e ritorno 11:10 dal titolo", () => {
    const result = applyAlesteFerryTitleTimes(form(), "aleste", ALESTE_001233);
    expect(result.orario_arrivo).toBe("09:40");
    expect(result.orario_partenza).toBe("11:10");
  });

  it("valore Haiku sbagliato (es. pickup) -> sostituito dall'orario nave del titolo", () => {
    const result = applyAlesteFerryTitleTimes(form({ orario_arrivo: "10:40", orario_partenza: "09:30" }), "aleste", ALESTE_001233);
    expect(result.orario_arrivo).toBe("09:40");
    expect(result.orario_partenza).toBe("11:10");
  });

  it("formato Napoli: TRAGHETTO NAPOLI 08:40 / ritorno 10:35", () => {
    const text = "Il08-ott-26 1 TRAGHETTO NAPOLI + TRS H. ISCHIA 08:40\nIl11-ott-26 1 TRS H. ISCHIA + TRAGHETTO NAPOLI 10:35";
    const result = applyAlesteFerryTitleTimes(form(), "aleste", text);
    expect(result.orario_arrivo).toBe("08:40");
    expect(result.orario_partenza).toBe("10:35");
  });

  it("titoli con orari diversi tra loro -> nessuna sostituzione, resta il valore Haiku", () => {
    const text = "TRAGHETTO POZZUOLI + TRS H. ISCHIA 09:40\nTRAGHETTO POZZUOLI + TRS H. ISCHIA 13:30";
    expect(applyAlesteFerryTitleTimes(form({ orario_arrivo: "09:40" }), "aleste", text).orario_arrivo).toBe("09:40");
    expect(applyAlesteFerryTitleTimes(form(), "aleste", text).orario_arrivo).toBe("");
  });

  it("solo andata nel documento: il ritorno non viene inventato", () => {
    const result = applyAlesteFerryTitleTimes(form(), "aleste", "TRAGHETTO POZZUOLI + TRS H. ISCHIA 09:40");
    expect(result.orario_arrivo).toBe("09:40");
    expect(result.orario_partenza).toBe("");
  });

  it("treni / voli / bus e aliscafo SNAV invariati", () => {
    const train = form({ tipo_servizio: "transfer_station_hotel", orario_arrivo: "13:43", orario_partenza: "13:20" });
    expect(applyAlesteFerryTitleTimes(train, "aleste", ALESTE_001233)).toEqual(train);
    const snav = form({ orario_arrivo: "08:30", orario_partenza: "14:00" });
    const snavText = "Il04-apr-26 1 AL ISCAFO DA NAPOLI + TRS H. ISCHIA 08:30\nIl07-apr-26 1 TRS H.ISCHIA + AL ISCAFO PER NAPOLI 14:00";
    expect(applyAlesteFerryTitleTimes(snav, "aleste", snavText)).toEqual(snav);
  });

  it("altre agenzie invariate anche con lo stesso testo", () => {
    const other = form({ orario_arrivo: "10:00" });
    expect(applyAlesteFerryTitleTimes(other, "sosandra", ALESTE_001233)).toEqual(other);
  });
});
