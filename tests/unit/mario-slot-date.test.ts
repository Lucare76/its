import { describe, it, expect } from "vitest";
import { parseMarioSlotDate, formatMarioDateForUser, parseMarioDateRange, parseMarioDraftDateSlots } from "@/lib/server/mario-assistant/date-time";

// now fissato a martedì 1 settembre 2026 (Europe/Rome)
const NOW = new Date("2026-09-01T09:00:00Z");

describe("parseMarioSlotDate — FASE A.3 §5", () => {
  it("ISO / oggi / domani (delega a parseRelativeOrIsoDate)", () => {
    expect(parseMarioSlotDate("il 2026-09-13", NOW)).toBe("2026-09-13");
    expect(parseMarioSlotDate("oggi", NOW)).toBe("2026-09-01");
    expect(parseMarioSlotDate("domani", NOW)).toBe("2026-09-02");
  });

  it("dopodomani", () => {
    expect(parseMarioSlotDate("dopodomani", NOW)).toBe("2026-09-03");
  });

  it("'13 settembre' → 2026-09-13 (anno corrente, futuro vicino)", () => {
    expect(parseMarioSlotDate("13 settembre", NOW)).toBe("2026-09-13");
    expect(parseMarioSlotDate("il 13 settembre", NOW)).toBe("2026-09-13");
    expect(parseMarioSlotDate("13 di settembre grazie", NOW)).toBe("2026-09-13");
  });

  it("'13 sett' e '13/09' e '13-09'", () => {
    expect(parseMarioSlotDate("13 sett", NOW)).toBe("2026-09-13");
    expect(parseMarioSlotDate("13/09", NOW)).toBe("2026-09-13");
    expect(parseMarioSlotDate("13-09", NOW)).toBe("2026-09-13");
  });

  it("data già passata senza anno → anno successivo (prossima occorrenza)", () => {
    expect(parseMarioSlotDate("1 agosto", NOW)).toBe("2027-08-01");
  });

  it("giorno della settimana → prossima occorrenza", () => {
    // 1 set 2026 è martedì; "mercoledì" successivo = 2026-09-02
    expect(parseMarioSlotDate("mercoledì", NOW)).toBe("2026-09-02");
    expect(parseMarioSlotDate("lunedì prossimo", NOW)).toBe("2026-09-07");
  });

  it("giorno inesistente → undefined (chiede chiarimento a monte)", () => {
    expect(parseMarioSlotDate("31 febbraio", NOW)).toBeUndefined();
  });

  it("testo senza data → undefined", () => {
    expect(parseMarioSlotDate("anzi 45", NOW)).toBeUndefined();
    expect(parseMarioSlotDate("La Marra", NOW)).toBeUndefined();
  });
});

describe("FIX A.4.4 §3/§4/§13/§14 — data ESPLICITA completa (root cause bug live)", () => {
  it("'13/09/2026' e '13-09-2026' → 2026-09-13, anno LETTERALE (mai 'prossima occorrenza')", () => {
    expect(parseMarioSlotDate("13/09/2026", NOW)).toBe("2026-09-13");
    expect(parseMarioSlotDate("13-09-2026", NOW)).toBe("2026-09-13");
  });

  it("anno esplicito nel PASSATO resta quell'anno: mai spostato in avanti", () => {
    // NOW = 1 settembre 2026: "13/09/2025" è nel passato, ma l'anno è esplicito
    // e va rispettato letteralmente — mai la regola "prossima occorrenza".
    expect(parseMarioSlotDate("13/09/2025", NOW)).toBe("2025-09-13");
  });

  it("'13 settembre 2026' (mese per nome + anno esplicito) → 2026-09-13", () => {
    expect(parseMarioSlotDate("13 settembre 2026", NOW)).toBe("2026-09-13");
  });

  it("§4 validazione calendario reale: rifiuta date impossibili, mai una normalizzazione JS silenziosa", () => {
    expect(parseMarioSlotDate("31-02-2026", NOW)).toBeUndefined();
    expect(parseMarioSlotDate("32-01-2026", NOW)).toBeUndefined();
    expect(parseMarioSlotDate("00-09-2026", NOW)).toBeUndefined();
    expect(parseMarioSlotDate("29-02-2025", NOW)).toBeUndefined(); // 2025 non bisestile
  });

  it("§4 accetta 29 febbraio in anno bisestile", () => {
    expect(parseMarioSlotDate("29-02-2028", NOW)).toBe("2028-02-29");
  });

  it("messaggio reale del bug live: 'Possiamo caricare un bus...' poi '13/09/2026'", () => {
    expect(
      parseMarioSlotDate("Possiamo caricare un bus di 50 persone con partenza da Rimini gruppo La Marra?", NOW),
    ).toBeUndefined(); // nessuna data nel turno 1, corretto
    expect(parseMarioSlotDate("13/09/2026", NOW)).toBe("2026-09-13"); // turno 2: MAI 2025-01-15
  });
});

describe("FIX A.4.4 §2/§10/§15 — formatMarioDateForUser: SEMPRE DD-MM-YYYY, mai slash", () => {
  it("2026-09-13 → 13-09-2026", () => {
    expect(formatMarioDateForUser("2026-09-13")).toBe("13-09-2026");
  });
  it("2025-01-15 → 15-01-2025", () => {
    expect(formatMarioDateForUser("2025-01-15")).toBe("15-01-2025");
  });
  it("mai lo slash nell'output", () => {
    expect(formatMarioDateForUser("2026-09-13")).not.toContain("/");
  });
  it("null/undefined/non-ISO → null (mai un crash o un testo troncato)", () => {
    expect(formatMarioDateForUser(null)).toBeNull();
    expect(formatMarioDateForUser(undefined)).toBeNull();
    expect(formatMarioDateForUser("non una data")).toBeNull();
  });
});

describe("FIX A.4.5 §4/§12 — parseMarioDateRange", () => {
  it("'dal 13 al 20 settembre' → 2026-09-13 / 2026-09-20", () => {
    expect(parseMarioDateRange("dal 13 al 20 settembre", NOW)).toEqual({ startDate: "2026-09-13", endDate: "2026-09-20" });
  });
  it("'dal 13 al 20 settembre 2026' → stesso risultato (anno esplicito)", () => {
    expect(parseMarioDateRange("dal 13 al 20 settembre 2026", NOW)).toEqual({ startDate: "2026-09-13", endDate: "2026-09-20" });
  });
  it("'13-09-2026 al 20-09-2026' → 2026-09-13 / 2026-09-20", () => {
    expect(parseMarioDateRange("13-09-2026 al 20-09-2026", NOW)).toEqual({ startDate: "2026-09-13", endDate: "2026-09-20" });
  });
  it("'13/09/2026 - 20/09/2026' → 2026-09-13 / 2026-09-20", () => {
    expect(parseMarioDateRange("13/09/2026 - 20/09/2026", NOW)).toEqual({ startDate: "2026-09-13", endDate: "2026-09-20" });
  });
  it("FIX A.4.6 §5 — forma terse del bug live '13-20 settembre' → 2026-09-13 / 2026-09-20", () => {
    expect(parseMarioDateRange("13-20 settembre", NOW)).toEqual({ startDate: "2026-09-13", endDate: "2026-09-20" });
    expect(parseMarioDateRange("13-20 SETTEMBRE", NOW)).toEqual({ startDate: "2026-09-13", endDate: "2026-09-20" });
  });
  it("'dal 13 settembre al 20 settembre' → 2026-09-13 / 2026-09-20", () => {
    expect(parseMarioDateRange("dal 13 settembre al 20 settembre", NOW)).toEqual({ startDate: "2026-09-13", endDate: "2026-09-20" });
  });
  it("§12 'dal 30 settembre al 2 ottobre' → 2026-09-30 / 2026-10-02 (a cavallo di due mesi)", () => {
    expect(parseMarioDateRange("dal 30 settembre al 2 ottobre", NOW)).toEqual({ startDate: "2026-09-30", endDate: "2026-10-02" });
  });
  it("§12 'dal 20 al 13 settembre' → undefined (range invertito, mai una data indovinata)", () => {
    expect(parseMarioDateRange("dal 20 al 13 settembre", NOW)).toBeUndefined();
  });
  it("testo senza range → undefined", () => {
    expect(parseMarioDateRange("13 settembre", NOW)).toBeUndefined();
    expect(parseMarioDateRange("La Marra", NOW)).toBeUndefined();
  });
});

describe("FIX A.4.5 §5 — parseMarioDraftDateSlots (data singola o intervallo)", () => {
  it("data singola → solo serviceDate", () => {
    expect(parseMarioDraftDateSlots("13/09/2026", NOW)).toEqual({ serviceDate: "2026-09-13" });
  });
  it("intervallo → serviceDate=inizio, returnDate=fine", () => {
    expect(parseMarioDraftDateSlots("dal 13 al 20 settembre", NOW)).toEqual({ serviceDate: "2026-09-13", returnDate: "2026-09-20" });
  });
  it("nessuna data → undefined", () => {
    expect(parseMarioDraftDateSlots("anzi 45", NOW)).toBeUndefined();
  });
});
