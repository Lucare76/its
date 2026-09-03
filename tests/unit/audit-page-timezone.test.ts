import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * app/(app)/audit/page.tsx è "use client": nessun harness di render
 * component in questo progetto (vedi tests/unit/booking-groups-remove-passenger-ui.test.ts).
 * Verifica quindi il contratto a livello di sorgente.
 */
const source = readFileSync(
  join(process.cwd(), "app/(app)/audit/page.tsx"),
  "utf8"
);

describe("Audit page.tsx — timestamp in Europe/Rome", () => {
  it("importa formatItalianDateTime da @/lib/date-format", () => {
    expect(source).toMatch(/import\s*\{\s*formatItalianDateTime\s*\}\s*from\s*"@\/lib\/date-format"/);
  });

  it("usa formatItalianDateTime per mostrare item.at", () => {
    expect(source).toMatch(/formatItalianDateTime\(item\.at\)/);
  });

  it("non usa più toLocaleString(\"it-IT\") senza timeZone su item.at", () => {
    expect(source).not.toMatch(/new Date\(item\.at\)\.toLocaleString\("it-IT"\)/);
  });
});
