import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * FIX MIRATO — GIACOMONI: una ricerca testuale attiva (query non vuota) non
 * deve mai essere nascosta dal tab di stato ("Aperti" esclude "operational").
 * Senza la query attiva, il tab "Aperti" continua a escludere "operational"
 * come prima.
 *
 * app/(app)/booking-groups/page.tsx è "use client" con hook React: nessun
 * harness di render component in questo progetto (vedi
 * booking-groups-hotel-ui.test.ts per lo stesso vincolo/pattern). Questo test
 * verifica quindi il contratto a livello di sorgente della funzione
 * `visibleGroups`.
 */
const source = readFileSync(
  join(process.cwd(), "app/(app)/booking-groups/page.tsx"),
  "utf8"
);

function extractVisibleGroups(src: string): string {
  const start = src.indexOf("const visibleGroups = useMemo(");
  const end = src.indexOf(");", start) + 2;
  return src.slice(start, end);
}

describe("Booking Groups page.tsx — filtro stato vs ricerca testuale (fix GIACOMONI)", () => {
  it("con query non vuota il filtro di stato viene bypassato (query in cima al filter)", () => {
    const block = extractVisibleGroups(source);
    expect(block).toMatch(/if \(query\.trim\(\)\) return true;/);
    // deve essere il primo check, prima di "all"/"open", cosi' una ricerca
    // attiva ha sempre precedenza sul tab selezionato.
    const queryCheckIndex = block.indexOf("if (query.trim()) return true;");
    const allCheckIndex = block.indexOf('if (statusFilter === "all")');
    expect(queryCheckIndex).toBeGreaterThan(-1);
    expect(allCheckIndex).toBeGreaterThan(-1);
    expect(queryCheckIndex).toBeLessThan(allCheckIndex);
  });

  it("senza ricerca il tab 'Aperti' continua a escludere cancelled e operational", () => {
    const block = extractVisibleGroups(source);
    expect(block).toMatch(
      /if \(statusFilter === "open"\) return g\.status !== "cancelled" && g\.status !== "operational";/
    );
  });

  it("query e' nella dependency list dello useMemo (ricalcolo ad ogni digitazione)", () => {
    const block = extractVisibleGroups(source);
    expect(block).toMatch(/\[groups, statusFilter, query\]/);
  });
});
