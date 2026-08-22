import { describe, expect, it } from "vitest";
import {
  matchesMedmarSearch,
  medmarSentDateKey,
  matchesMedmarSentDateFilter,
  normalizeMedmarSearchTerm,
  type MedmarSearchableGroup,
} from "@/lib/medmar-ticket-search";

function group(overrides: Partial<MedmarSearchableGroup> = {}): MedmarSearchableGroup {
  return {
    key: "g1",
    customerName: "Mario Rossi",
    hotel: "Hotel Ischia",
    pratica: "PR-100",
    phone: "+393331234567",
    agencyName: "Agenzia Viaggi Blu",
    allServiceIds: ["svc-1", "svc-2"],
    medmarNumero: "MED-999",
    medmarIdPrenotazione: "PREN-42",
    recipientEmail: "mario.rossi@example.com",
    recipientName: "Mario Rossi",
    ...overrides,
  };
}

describe("matchesMedmarSearch", () => {
  it("1. query vuota -> sempre true (nessun filtro attivo)", () => {
    expect(matchesMedmarSearch(group(), "")).toBe(true);
    expect(matchesMedmarSearch(group(), "   ")).toBe(true);
  });

  it("2. ricerca per nome cliente", () => {
    expect(matchesMedmarSearch(group(), "Mario")).toBe(true);
    expect(matchesMedmarSearch(group(), "Rossi")).toBe(true);
  });

  it("3. ricerca per codice Medmar (medmar_numero), anche parziale", () => {
    expect(matchesMedmarSearch(group(), "MED-999")).toBe(true);
    expect(matchesMedmarSearch(group(), "999")).toBe(true);
  });

  it("4. ricerca per id prenotazione Medmar", () => {
    expect(matchesMedmarSearch(group(), "PREN-42")).toBe(true);
    expect(matchesMedmarSearch(group(), "pren")).toBe(true);
  });

  it("5. ricerca per email destinatario", () => {
    expect(matchesMedmarSearch(group(), "mario.rossi@example.com")).toBe(true);
    expect(matchesMedmarSearch(group(), "example.com")).toBe(true);
  });

  it("6. ricerca per nome destinatario, agenzia, hotel, pratica, telefono, service id", () => {
    expect(matchesMedmarSearch(group(), "Agenzia Viaggi Blu")).toBe(true);
    expect(matchesMedmarSearch(group(), "Hotel Ischia")).toBe(true);
    expect(matchesMedmarSearch(group(), "PR-100")).toBe(true);
    expect(matchesMedmarSearch(group(), "3331234567")).toBe(true);
    expect(matchesMedmarSearch(group(), "svc-2")).toBe(true);
  });

  it("7. case-insensitive", () => {
    expect(matchesMedmarSearch(group(), "MARIO rossi")).toBe(true);
    expect(matchesMedmarSearch(group(), "med-999")).toBe(true);
  });

  it("8. trim degli spazi nella query", () => {
    expect(matchesMedmarSearch(group(), "   Mario   ")).toBe(true);
  });

  it("9. nessun match -> false", () => {
    expect(matchesMedmarSearch(group(), "codice-inesistente")).toBe(false);
  });

  it("10. non crasha con tutti i campi null (solo allServiceIds valorizzato)", () => {
    const nullGroup: MedmarSearchableGroup = {
      key: "g2",
      customerName: null,
      hotel: null,
      pratica: null,
      phone: null,
      agencyName: null,
      allServiceIds: [],
      medmarNumero: null,
      medmarIdPrenotazione: null,
      recipientEmail: null,
      recipientName: null,
    };
    expect(() => matchesMedmarSearch(nullGroup, "qualsiasi")).not.toThrow();
    expect(matchesMedmarSearch(nullGroup, "qualsiasi")).toBe(false);
    expect(matchesMedmarSearch(nullGroup, "")).toBe(true);
  });

  it("11. non crasha se solo alcuni campi sono null", () => {
    const partial = group({ medmarNumero: null, recipientEmail: null, agencyName: null });
    expect(() => matchesMedmarSearch(partial, "Mario")).not.toThrow();
    expect(matchesMedmarSearch(partial, "Mario")).toBe(true);
  });
});

describe("normalizeMedmarSearchTerm", () => {
  it("1. trim + lowercase", () => {
    expect(normalizeMedmarSearchTerm("  Mario ROSSI  ")).toBe("mario rossi");
  });

  it("2. mai crash su null/undefined", () => {
    expect(normalizeMedmarSearchTerm(null)).toBe("");
    expect(normalizeMedmarSearchTerm(undefined)).toBe("");
  });
});

describe("medmarSentDateKey", () => {
  it("1. usa delivered_at come data principale", () => {
    expect(medmarSentDateKey("2026-08-22T09:00:00.000Z", "2026-08-20T09:00:00.000Z")).toBe("2026-08-22");
  });

  it("2. fallback su updated_at se delivered_at manca", () => {
    expect(medmarSentDateKey(null, "2026-08-20T09:00:00.000Z")).toBe("2026-08-20");
  });

  it("3. nessuna delle due -> null (mai una data inventata)", () => {
    expect(medmarSentDateKey(null, null)).toBeNull();
    expect(medmarSentDateKey(undefined, undefined)).toBeNull();
  });
});

describe("matchesMedmarSentDateFilter", () => {
  const TODAY = "2026-08-22";

  it("1. filtro 'all' -> sempre true, anche senza dateKey", () => {
    expect(matchesMedmarSentDateFilter(null, "all", TODAY)).toBe(true);
    expect(matchesMedmarSentDateFilter("2026-01-01", "all", TODAY)).toBe(true);
  });

  it("2. filtro 'today' -> solo la data odierna", () => {
    expect(matchesMedmarSentDateFilter(TODAY, "today", TODAY)).toBe(true);
    expect(matchesMedmarSentDateFilter("2026-08-21", "today", TODAY)).toBe(false);
  });

  it("3. filtro 'yesterday' -> solo ieri", () => {
    expect(matchesMedmarSentDateFilter("2026-08-21", "yesterday", TODAY)).toBe(true);
    expect(matchesMedmarSentDateFilter(TODAY, "yesterday", TODAY)).toBe(false);
  });

  it("4. filtro '7d' -> include oggi e i 6 giorni precedenti, esclude il 7° giorno prima", () => {
    expect(matchesMedmarSentDateFilter(TODAY, "7d", TODAY)).toBe(true);
    expect(matchesMedmarSentDateFilter("2026-08-16", "7d", TODAY)).toBe(true); // -6 giorni, incluso
    expect(matchesMedmarSentDateFilter("2026-08-15", "7d", TODAY)).toBe(false); // -7 giorni, escluso
  });

  it("5. filtro 'month' -> stesso mese/anno di oggi", () => {
    expect(matchesMedmarSentDateFilter("2026-08-01", "month", TODAY)).toBe(true);
    expect(matchesMedmarSentDateFilter("2026-07-31", "month", TODAY)).toBe(false);
  });

  it("6. dateKey mancante -> non soddisfa nessun filtro specifico (solo 'all')", () => {
    expect(matchesMedmarSentDateFilter(null, "today", TODAY)).toBe(false);
    expect(matchesMedmarSentDateFilter(null, "7d", TODAY)).toBe(false);
    expect(matchesMedmarSentDateFilter(null, "month", TODAY)).toBe(false);
  });
});
