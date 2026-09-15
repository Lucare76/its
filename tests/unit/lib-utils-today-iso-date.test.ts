import { describe, it, expect } from "vitest";
import { todayIsoDate } from "@/lib/utils";

/**
 * Fix P2 (audit pre-go-live): lib/utils.ts::todayIsoDate() usava
 * `new Date().toISOString().slice(0, 10)` (UTC), nonostante il commento
 * dicesse "in local time" — sbagliata nelle ore intorno alla mezzanotte
 * italiana (CET/CEST). Ora usa Intl.DateTimeFormat con
 * timeZone: "Europe/Rome" (stesso pattern già testato in
 * tests/unit/shuttle-schedules-rome-date.test.ts per le implementazioni
 * gemelle in app/api/shuttle-schedules/*).
 */
describe("lib/utils.ts::todayIsoDate — Europe/Rome, non UTC", () => {
  it("Caso 1 — ora solare: 23:30 UTC del 15/01 è già 16/01 a Roma (CET, +1)", () => {
    expect(todayIsoDate(new Date("2026-01-15T23:30:00.000Z"))).toBe("2026-01-16");
  });

  it("Caso 2 — ora legale: 22:30 UTC del 15/07 è già 16/07 a Roma (CEST, +2)", () => {
    expect(todayIsoDate(new Date("2026-07-15T22:30:00.000Z"))).toBe("2026-07-16");
  });

  it("Caso 3 — ora centrale della giornata: nessuna differenza inattesa fra UTC e Roma", () => {
    expect(todayIsoDate(new Date("2026-07-15T10:00:00.000Z"))).toBe("2026-07-15");
  });

  it("Caso 4a — transizione verso l'ora legale (ultima domenica di marzo): offset CET->CEST gestito senza offset hardcoded", () => {
    // Cambio 2026-03-29 01:00 UTC: stesso orario UTC (22:30) prima/dopo produce Rome-date diverso.
    expect(todayIsoDate(new Date("2026-03-28T22:30:00.000Z"))).toBe("2026-03-28");
    expect(todayIsoDate(new Date("2026-03-29T22:30:00.000Z"))).toBe("2026-03-30");
  });

  it("Caso 4b — transizione verso l'ora solare (ultima domenica di ottobre): offset CEST->CET gestito senza offset hardcoded", () => {
    // Cambio 2026-10-25 01:00 UTC: CEST(+2) -> CET(+1).
    expect(todayIsoDate(new Date("2026-10-24T21:30:00.000Z"))).toBe("2026-10-24");
    expect(todayIsoDate(new Date("2026-10-25T21:30:00.000Z"))).toBe("2026-10-25");
  });

  it("fine anno: 23:30 UTC del 31/12 è già 01/01 dell'anno successivo a Roma", () => {
    expect(todayIsoDate(new Date("2026-12-31T23:30:00.000Z"))).toBe("2027-01-01");
  });

  it("rollover di fine mese: 23:30 UTC del 31/01 è già 01/02 a Roma", () => {
    expect(todayIsoDate(new Date("2026-01-31T23:30:00.000Z"))).toBe("2026-02-01");
  });

  it("indipendenza dal timezone del processo: Intl con timeZone esplicito ignora process.env.TZ dell'ambiente Node", () => {
    const result = todayIsoDate(new Date("2026-07-15T22:30:00.000Z"));
    expect(result).toBe("2026-07-16");
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("nessun default a new Date() imprevisto: parametro `now` opzionale, sempre deterministico se passato", () => {
    const result = todayIsoDate(new Date("2026-07-31T10:00:00.000Z"));
    expect(result).toBe("2026-07-31");
    expect(result).not.toMatch(/\//); // mai il formato locale italiano DD/MM/YYYY
  });

  it("senza argomenti usa new Date() (comportamento di default preservato, retrocompatibile con il chiamante esistente)", () => {
    const result = todayIsoDate();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
