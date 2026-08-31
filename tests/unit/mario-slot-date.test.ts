import { describe, it, expect } from "vitest";
import { parseMarioSlotDate } from "@/lib/server/mario-assistant/date-time";

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
