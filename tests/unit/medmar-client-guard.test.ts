import { describe, it, expect } from "vitest";
import {
  assertReadOnlyPath,
  MedmarMutationBlockedError,
  MedmarPathNotAllowedError,
  MEDMAR_API_PATH_PREFIX,
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

  it("accetta i 2 path read-only reali con prefisso esatto", () => {
    expect(() => assertReadOnlyPath(`${MEDMAR_API_PATH_PREFIX}/corse/59?id_tratta=59&partenza_data_dal=2026-08-20&dopo_le=08:40:00&vendibile=1&page=1`)).not.toThrow();
    expect(() => assertReadOnlyPath(`${MEDMAR_API_PATH_PREFIX}/biglietti/vendibili/131943?id_tariffa=&id_biglietto=`)).not.toThrow();
  });

  it("hardening Fase 1.7: un path con tail corretto ma prefisso diverso/mancante NON deve più superare il guard (era il 'mismatch tail-only' segnalato in Fase 1.6)", () => {
    expect(() => assertReadOnlyPath("/foo/bar/corse/123")).toThrow(MedmarPathNotAllowedError);
    expect(() => assertReadOnlyPath("/mutate/corse/456")).toThrow(MedmarPathNotAllowedError);
    expect(() => assertReadOnlyPath("/corse/123")).toThrow(MedmarPathNotAllowedError);
    expect(() => assertReadOnlyPath("/anything/biglietti/vendibili/1")).toThrow(MedmarPathNotAllowedError);
    expect(() => assertReadOnlyPath("/biglietti/vendibili/1")).toThrow(MedmarPathNotAllowedError);
  });

  it("hardening Fase 1.7: segmenti extra tra il prefisso e il tail atteso vengono rifiutati", () => {
    expect(() => assertReadOnlyPath(`${MEDMAR_API_PATH_PREFIX}/extra/corse/123`)).toThrow(MedmarPathNotAllowedError);
    expect(() => assertReadOnlyPath(`${MEDMAR_API_PATH_PREFIX}/extra/biglietti/vendibili/1`)).toThrow(MedmarPathNotAllowedError);
  });

  it("path con segmento finale non numerico continua a essere rifiutato (nessuna regressione)", () => {
    expect(() => assertReadOnlyPath(`${MEDMAR_API_PATH_PREFIX}/corse/abc`)).toThrow(MedmarPathNotAllowedError);
    expect(() => assertReadOnlyPath(`${MEDMAR_API_PATH_PREFIX}/biglietti/vendibili/abc`)).toThrow(MedmarPathNotAllowedError);
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
