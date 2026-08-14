import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Sprint Performance 8 — FASE 14: il layout globale non deve più aprire
 * connessioni IMAP (nessuna fetch a /api/email/operational-import, nessun
 * setInterval dedicato all'import email).
 */

const layoutSource = readFileSync(path.resolve(__dirname, "../../app/(app)/layout.tsx"), "utf8");

describe("app/(app)/layout.tsx — nessun polling IMAP", () => {
  it("non referenzia l'endpoint /api/email/operational-import", () => {
    expect(layoutSource).not.toContain("/api/email/operational-import");
  });

  it("non contiene un setInterval per l'import email (nessuna funzione doImport)", () => {
    expect(layoutSource).not.toMatch(/doImport/);
  });
});
