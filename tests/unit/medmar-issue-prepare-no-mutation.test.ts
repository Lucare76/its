// FASE 2B.4 — FASE I: garanzia strutturale che POST /prepare non possa
// importare/chiamare, direttamente o indirettamente, alcuna funzione
// mutativa Medmar (openTurn, lockAvailability, createBooking, payManual,
// unlockAvailability). Verifica statica sul codice sorgente dei moduli
// effettivamente importati da prepare/route.ts, non un mock a runtime:
// se uno di questi simboli comparisse nel sorgente, sarebbe un segnale che
// qualcuno ha iniziato a far dipendere /prepare dal client mutativo.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const FORBIDDEN_MODULE_REFERENCES = ["medmar-mutation-client"];
const FORBIDDEN_MUTATIVE_SYMBOLS = ["openTurn", "lockAvailability", "createBooking", "payManual", "unlockAvailability"];

function readSource(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

function assertNoMutativeReferences(source: string, fileLabel: string) {
  for (const forbiddenModule of FORBIDDEN_MODULE_REFERENCES) {
    expect(source, `${fileLabel} non deve importare ${forbiddenModule}`).not.toContain(forbiddenModule);
  }
  for (const symbol of FORBIDDEN_MUTATIVE_SYMBOLS) {
    expect(source, `${fileLabel} non deve referenziare ${symbol}`).not.toContain(symbol);
  }
}

describe("POST /api/services/medmar-issue/prepare — zero mutazioni Medmar, direttamente o indirettamente", () => {
  it("prepare/route.ts non importa il client mutativo Medmar ne' referenzia le sue funzioni", () => {
    assertNoMutativeReferences(readSource("app/api/services/medmar-issue/prepare/route.ts"), "prepare/route.ts");
  });

  it("issue-confirmation.ts (dipendenza diretta di /prepare) non importa il client mutativo Medmar", () => {
    assertNoMutativeReferences(readSource("lib/server/medmar-booking/issue-confirmation.ts"), "issue-confirmation.ts");
  });

  it("preflight.ts (dipendenza diretta di /prepare) non importa il client mutativo Medmar", () => {
    assertNoMutativeReferences(readSource("lib/server/medmar-booking/preflight.ts"), "preflight.ts");
  });

  it("issue-repository.ts (dipendenza diretta di /prepare, tramite loadServices) non importa il client mutativo Medmar", () => {
    assertNoMutativeReferences(readSource("lib/server/medmar-booking/issue-repository.ts"), "issue-repository.ts");
  });
});
