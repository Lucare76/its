import { describe, it, expect } from "vitest";
import { detectExplicitHydrofoilIntent } from "@/lib/excel-hydrofoil-intent";

describe("detectExplicitHydrofoilIntent", () => {
  it("1. testo esplicito 'aliscafo' -> true", () => {
    expect(detectExplicitHydrofoilIntent("Transfer aliscafo")).toBe(true);
  });

  it("2. variante case-insensitive ('ALISCAFO') -> true", () => {
    expect(detectExplicitHydrofoilIntent("SUPPL. ALISCAFO")).toBe(true);
  });

  it("2b. variante con accenti/diacritici normalizzati -> true", () => {
    expect(detectExplicitHydrofoilIntent("Aliscafo veloce", null)).toBe(true);
  });

  it("3. 'hydrofoil' (inglese, gia' valore riconosciuto nel dominio PDF) -> true", () => {
    expect(detectExplicitHydrofoilIntent("HYDROFOIL SNAV")).toBe(true);
  });

  it("4. solo 'SNAV' -> false (nei dati reali SNAV compare anche per Formula SNAV, non e' affidabile da solo)", () => {
    expect(detectExplicitHydrofoilIntent("SNAV 14:00")).toBe(false);
  });

  it("5. solo 'MEDMAR' -> false", () => {
    expect(detectExplicitHydrofoilIntent("MEDMAR Napoli")).toBe(false);
  });

  it("6. testo treno standard -> false", () => {
    expect(detectExplicitHydrofoilIntent("Stazione Napoli Centrale")).toBe(false);
  });

  it("7. testo volo standard -> false", () => {
    expect(detectExplicitHydrofoilIntent("Volo FR1234")).toBe(false);
  });

  it("8. testo ambiguo (nessuna parola pertinente) -> false", () => {
    expect(detectExplicitHydrofoilIntent("Cliente VIP, richiesta camera vista mare")).toBe(false);
  });

  it("9. nessun riferimento nave (stringhe vuote/null) -> false", () => {
    expect(detectExplicitHydrofoilIntent("", null, undefined)).toBe(false);
  });

  it("12. falso positivo: parola simile ma non pertinente ('scafo' da sola) -> false", () => {
    expect(detectExplicitHydrofoilIntent("Manutenzione scafo barca privata")).toBe(false);
  });

  it("combina piu' campi (reference + notes) -> true se anche uno solo contiene il segnale", () => {
    expect(detectExplicitHydrofoilIntent("FR1234", "Aeroporto Napoli", "SUPPL. ALISCAFO richiesto dal cliente")).toBe(true);
  });
});
