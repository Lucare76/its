import { describe, expect, it } from "vitest";
import {
  formatDateItFromIso,
  formatCreatedAtLabel,
  hasReturnLeg,
  practiceNumberHeading,
  createdByLabel,
} from "@/lib/booking-success-summary";

describe("formatDateItFromIso", () => {
  it("1. converte YYYY-MM-DD in DD/MM/YYYY", () => {
    expect(formatDateItFromIso("2026-08-25")).toBe("25/08/2026");
  });

  it("2. input mancante -> null", () => {
    expect(formatDateItFromIso(null)).toBeNull();
    expect(formatDateItFromIso(undefined)).toBeNull();
  });

  it("3. formato inatteso -> null (mai un valore inventato)", () => {
    expect(formatDateItFromIso("non-una-data")).toBeNull();
  });
});

describe("formatCreatedAtLabel — data e ora creazione (dal created_at persistito)", () => {
  it("1. formatta in 'DD/MM/YYYY alle HH:mm' usando esattamente l'ISO passato, mai new Date() locale", () => {
    // 2026-08-22T11:32:00Z == 13:32 in Europe/Rome (CEST, +2 in agosto)
    expect(formatCreatedAtLabel("2026-08-22T11:32:00.000Z")).toBe("22/08/2026 alle 13:32");
  });

  it("2. input mancante -> null", () => {
    expect(formatCreatedAtLabel(null)).toBeNull();
    expect(formatCreatedAtLabel(undefined)).toBeNull();
  });

  it("3. ISO non valido -> null (mai un valore inventato)", () => {
    expect(formatCreatedAtLabel("not-a-date")).toBeNull();
  });
});

describe("hasReturnLeg — A/R usa un unico numero pratica (decide solo se mostrare 'Ritorno')", () => {
  it("1. id_return presente -> true", () => {
    expect(hasReturnLeg({ id_return: "svc-2", trip_leg: null })).toBe(true);
  });

  it("2. trip_leg 'round_trip' -> true anche senza id_return esplicito", () => {
    expect(hasReturnLeg({ id_return: null, trip_leg: "round_trip" })).toBe(true);
  });

  it("3. nessuno dei due -> false (one-way)", () => {
    expect(hasReturnLeg({ id_return: null, trip_leg: "outbound_only" })).toBe(false);
    expect(hasReturnLeg({})).toBe(false);
  });
});

describe("practiceNumberHeading — mai l'UUID come identificativo principale", () => {
  it("1. numero pratica presente -> 'Pratica ITS-2026-154'", () => {
    expect(practiceNumberHeading("ITS-2026-154")).toBe("Pratica ITS-2026-154");
  });

  it("2. numero pratica assente -> fallback neutro, mai un UUID", () => {
    const heading = practiceNumberHeading(null);
    expect(heading).toBe("Prenotazione registrata");
    expect(heading).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });
});

describe("createdByLabel — utente che ha creato la pratica (dt 'Operatore' separato in UI, mai ridondante)", () => {
  it("1. nome operatore presente -> solo il nome, senza prefisso ridondante", () => {
    expect(createdByLabel("Mario Rossi")).toBe("Mario Rossi");
  });

  it("2. nome assente -> fallback 'Operatore', mai un UUID utente", () => {
    expect(createdByLabel(null)).toBe("Operatore");
    expect(createdByLabel(undefined)).toBe("Operatore");
  });
});
