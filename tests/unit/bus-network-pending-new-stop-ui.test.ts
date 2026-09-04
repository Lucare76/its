import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * PROMPT "Fermate bus" — Fase B/5: "Crea nuova fermata" dall'approvazione
 * pending deve usare LO STESSO helper server di /bus-stops
 * (action "create_bus_line_stop" -> createBusLineStop, con anti-duplicato),
 * mai più "add_stop" (che non aveva alcun controllo anti-duplicato e creava
 * sempre anche la fermata gemella sull'altra direzione). Stesso vincolo di
 * "niente harness di render component in questo progetto" già documentato
 * in tests/unit/bus-stops-page-ui.test.ts: verifica a livello di sorgente.
 */
const source = readFileSync(join(process.cwd(), "app/(app)/bus-network/page.tsx"), "utf8");

function extractFunction(name: string): string {
  const start = source.indexOf(`const ${name} = useCallback(async () => {`);
  expect(start, `funzione ${name} non trovata`).toBeGreaterThan(-1);
  // Trova la chiusura "}, [...]);" della useCallback che segue.
  const end = source.indexOf("}, [", start);
  expect(end, `chiusura di ${name} non trovata`).toBeGreaterThan(start);
  const closeParen = source.indexOf(");", end);
  return source.slice(start, closeParen + 2);
}

describe("bus-network/page.tsx — confirmApprovePendingWithNewStop (Fase B/5)", () => {
  const fn = extractFunction("confirmApprovePendingWithNewStop");

  it("usa l'action 'create_bus_line_stop' (stesso helper server di /bus-stops), mai 'add_stop'", () => {
    expect(fn).toMatch(/action:\s*"create_bus_line_stop"/);
    expect(fn).not.toMatch(/"add_stop"/);
  });

  it("crea la fermata SOLO per la direzione del pending, non passa più lat/lng fittizi per una gemella sull'altra direzione", () => {
    expect(fn).toMatch(/bus_line_id: selectedLine\.id,\s*direction,/);
    expect(fn).not.toMatch(/lat: null, lng: null/);
  });

  it("su duplicato (409 + existing_stop_id) riusa la fermata esistente invece di bloccare l'approvazione", () => {
    expect(fn).toMatch(/res\.status === 409 && createBody\?\.existing_stop_id/);
    expect(fn).toMatch(/stopId = createBody\.existing_stop_id;/);
  });

  it("in ogni caso l'approvazione finale passa sempre da 'approve_pending' con lo stop_id risolto", () => {
    expect(fn).toMatch(/post\("approve_pending", \{/);
    expect(fn).toMatch(/stop_id: stopId,/);
  });
});
