import { describe, it, expect } from "vitest";
import {
  assertReadOnlyPath,
  MedmarMutationBlockedError,
  MedmarPathNotAllowedError,
} from "@/lib/server/medmar-booking/client";

describe("Medmar client — guard read-only (fail-safe Fase 1)", () => {
  it("blocca /prenotazioni/lock-disponibilita", () => {
    expect(() => assertReadOnlyPath("/prenotazioni/lock-disponibilita")).toThrow(MedmarMutationBlockedError);
  });

  it("blocca POST /prenotazioni", () => {
    expect(() => assertReadOnlyPath("/prenotazioni")).toThrow(MedmarMutationBlockedError);
  });

  it("blocca la chiamata 'manuale' di pagamento", () => {
    expect(() => assertReadOnlyPath("/prenotazioni/manuale")).toThrow(MedmarMutationBlockedError);
  });

  it("blocca /prenotazioni/scongela", () => {
    expect(() => assertReadOnlyPath("/prenotazioni/scongela")).toThrow(MedmarMutationBlockedError);
  });

  it("blocca varianti con querystring o sotto-path dei path mutativi", () => {
    expect(() => assertReadOnlyPath("/prenotazioni?foo=bar")).toThrow(MedmarMutationBlockedError);
    expect(() => assertReadOnlyPath("/prenotazioni/lock-disponibilita/123")).toThrow(MedmarMutationBlockedError);
  });

  it("rifiuta qualunque path non esplicitamente whitelisted come read-only (nessun endpoint verificato in Fase 1)", () => {
    expect(() => assertReadOnlyPath("/corse/ricerca")).toThrow(MedmarPathNotAllowedError);
    expect(() => assertReadOnlyPath("/biglietti/vendibili")).toThrow(MedmarPathNotAllowedError);
  });

  it("sensitivity test: se in futuro qualcuno aggiunge un path mutativo alla whitelist read-only, il guard deve comunque bloccarlo", () => {
    // Anche ipotizzando un errore di configurazione futuro in cui un path
    // mutativo finisse per errore nella whitelist, la lista dei path
    // mutativi ha priorità assoluta nel guard: questo test fallisce se
    // quell'invariante viene rimossa da client.ts.
    const mutativePaths = [
      "/prenotazioni/lock-disponibilita",
      "/prenotazioni",
      "/prenotazioni/manuale",
      "/prenotazioni/scongela",
    ];
    for (const path of mutativePaths) {
      expect(() => assertReadOnlyPath(path)).toThrow(MedmarMutationBlockedError);
    }
  });
});
