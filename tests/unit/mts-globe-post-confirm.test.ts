import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Obiettivo A — post-confirm MTS Globe non rilancia più la preview
 * automaticamente.
 *
 * Il componente app/(app)/agency-imports/mts-globe/page.tsx è "use client"
 * e usa hook React (useState/useRouter): il progetto non ha un harness di
 * render component (nessun @testing-library/react, vitest.config.ts usa
 * environment "node", non "jsdom" — vedi tests/unit/ops-search-route.test.ts
 * per lo stesso vincolo/pattern già in uso su un altro file). Questi test
 * verificano quindi il contratto a livello di sorgente, come già fatto per
 * il file di ricerca (describe "Performance" in ops-search-route.test.ts),
 * non un render effettivo.
 */
const source = readFileSync(
  join(process.cwd(), "app/(app)/agency-imports/mts-globe/page.tsx"),
  "utf8"
);

function extractFunctionBody(fnName: string): string {
  const start = source.indexOf(`function ${fnName}(`);
  if (start === -1) throw new Error(`function ${fnName} non trovata nel sorgente`);
  let depth = 0;
  let i = source.indexOf("{", start);
  const bodyStart = i;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return source.slice(bodyStart, i + 1);
}

describe("MTS Globe page.tsx — handleConfirm non rilancia la preview dopo successo", () => {
  const handleConfirmBody = extractFunctionBody("handleConfirm");

  it("in caso di successo non chiama più runPreview()", () => {
    // Split sul ramo di errore (return anticipato) per isolare solo il
    // codice eseguito dopo un confirm riuscito.
    const successBranch = handleConfirmBody.split("setConfirmResult(data as ConfirmResult);")[1] ?? "";
    expect(successBranch).not.toMatch(/runPreview\(/);
  });

  it("dopo il successo azzera preview/applyFeedback/everHadIntermedioGroups (nessun residuo della vecchia preview)", () => {
    const successBranch = handleConfirmBody.split("setConfirmResult(data as ConfirmResult);")[1] ?? "";
    expect(successBranch).toMatch(/setPreview\(null\)/);
    expect(successBranch).toMatch(/setApplyFeedback\(null\)/);
    expect(successBranch).toMatch(/setEverHadIntermedioGroups\(false\)/);
  });

  it("il ramo di errore del confirm resta invariato: mostra il messaggio ed esce prima di toccare confirmResult", () => {
    expect(handleConfirmBody).toMatch(/setMessage\(data\.error \?\? "Errore durante il confirm\."\);\s*\n\s*return;/);
  });
});

describe("MTS Globe page.tsx — schermata finale post-import", () => {
  it("mostra i 4 contatori richiesti dal risultato di confirm (nessun dato perso)", () => {
    expect(source).toMatch(/Prenotazioni caricate:.*confirmResult\.importedBookingCount/);
    expect(source).toMatch(/Servizi creati:.*confirmResult\.importedServiceCount/);
    expect(source).toMatch(/Duplicate saltate:.*confirmResult\.skippedDuplicateCount/);
    expect(source).toMatch(/Errori:.*confirmResult\.failedBookings\.length/);
  });

  it("distingue import completato da import parziale in base a failedBookings.length", () => {
    expect(source).toMatch(/confirmResult\.failedBookings\.length > 0 \? "5\. Import parziale" : "5\. Import completato"/);
    expect(source).toMatch(/Import parziale:/);
    expect(source).toMatch(/Import completato/);
  });

  it("elenca il dettaglio dei failedBookings quando presenti", () => {
    expect(source).toMatch(/confirmResult\.failedBookings\.map\(\(f\) => \(/);
    expect(source).toMatch(/Voucher \{f\.voucherNo\}: \{f\.message\}/);
  });

  it("offre i 3 pulsanti di uscita dalla schermata finale", () => {
    expect(source).toMatch(/Carica un altro file/);
    expect(source).toMatch(/Vai alle prenotazioni/);
    expect(source).toMatch(/Nuova preview/);
  });

  it("'Carica un altro file' resetta lo stato e l'input file (nessun residuo del file precedente)", () => {
    const resetBody = extractFunctionBody("resetForNewFile");
    for (const call of [
      "setFileName(null)",
      "setRawRows([])",
      "setPreview(null)",
      "setConfirmResult(null)",
      "setMessage(null)",
    ]) {
      expect(resetBody).toContain(call);
    }
    expect(resetBody).toMatch(/fileInputRef\.current\.value = ""/);
  });

  it("'Nuova preview' è una richiesta esplicita dell'operatore (reapplyCorrections), mai automatica", () => {
    expect(source).toMatch(/onClick=\{\(\) => void reapplyCorrections\(\)\}\s*disabled=\{previewLoading\}>\s*\n\s*\{previewLoading \? "Caricamento…" : "Nuova preview"\}/);
  });
});
