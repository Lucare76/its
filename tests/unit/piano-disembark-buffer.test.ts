/**
 * Test Regola 2: Buffer sbarco traghetto
 *
 * disembarkBufferMin è esportata da auto-assign/route.ts.
 * I test verificano che il buffer corretto venga applicato per ogni compagnia.
 */
import { describe, expect, it } from "vitest";
import { disembarkBufferMin } from "@/app/api/ops/piano-giorno/auto-assign/route";

describe("disembarkBufferMin", () => {
  it("Medmar → 20 minuti", () => {
    expect(disembarkBufferMin("Medmar Express")).toBe(20);
    expect(disembarkBufferMin("medmar rapido")).toBe(20);
    expect(disembarkBufferMin("MEDMAR")).toBe(20);
  });

  it("Caremar → 20 minuti", () => {
    expect(disembarkBufferMin("Caremar Traghetti")).toBe(20);
    expect(disembarkBufferMin("caremar")).toBe(20);
  });

  it("SNAV → 15 minuti", () => {
    expect(disembarkBufferMin("SNAV Ischia")).toBe(15);
    expect(disembarkBufferMin("snav")).toBe(15);
  });

  it("Alilauro → 15 minuti", () => {
    expect(disembarkBufferMin("Alilauro Gruson")).toBe(15);
    expect(disembarkBufferMin("alilauro")).toBe(15);
  });

  it("compagnia sconosciuta → 20 minuti (default)", () => {
    expect(disembarkBufferMin("NLG Linee")).toBe(20);
    expect(disembarkBufferMin("Tirrenia")).toBe(20);
    expect(disembarkBufferMin("")).toBe(20);
  });

  it("vessel null → 20 minuti (default)", () => {
    expect(disembarkBufferMin(null)).toBe(20);
  });

  it("nome vessel contiene il nome della compagnia in modo case-insensitive", () => {
    expect(disembarkBufferMin("Nave MedMar Ischia")).toBe(20);
    expect(disembarkBufferMin("Veloce SNAV Express")).toBe(15);
    expect(disembarkBufferMin("Traghetto ALILAURO")).toBe(15);
    expect(disembarkBufferMin("CaReMaR Ischia Porto")).toBe(20);
  });
});
