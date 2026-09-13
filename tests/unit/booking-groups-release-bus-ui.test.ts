import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * "Libera bus del gruppo" — verifica UI (BusReservationSection).
 *
 * app/(app)/booking-groups/page.tsx è "use client" con hook React: nessun
 * harness di render component in questo progetto (nessun
 * @testing-library/react, vitest.config.ts usa environment "node" — stesso
 * vincolo già documentato in tests/unit/booking-groups-remove-passenger-ui.test.ts
 * e tests/unit/booking-groups-hotel-ui.test.ts). Questo test verifica quindi
 * il contratto a livello di sorgente: il bottone invia l'id corretto
 * (r.id, la riga cliccata) all'action delete_bus_reservation — mai un id di
 * gruppo/bus/data — con conferma esplicita prima della chiamata.
 */
const source = readFileSync(
  join(process.cwd(), "app/(app)/booking-groups/page.tsx"),
  "utf8"
);

function extractFunctionBody(fnName: string): string {
  const start = source.indexOf(`function ${fnName}(`);
  if (start === -1) throw new Error(`function ${fnName} non trovata nel sorgente`);
  const nextFn = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, nextFn === -1 ? undefined : nextFn);
}

describe("Booking Groups page.tsx — pulsante 'Libera bus' (BusReservationSection)", () => {
  const sectionBody = extractFunctionBody("BusReservationSection");

  it("10. il pulsante è cablato su onRelease(r.id) — l'id della RIGA cliccata, non group.id/bus_unit_id/service_date", () => {
    expect(sectionBody).toMatch(/reservations\.map\(\(r\) =>/);
    expect(sectionBody).toMatch(/Libera bus/);
    expect(sectionBody).toMatch(/releaseReservation\(r\)/);
    expect(sectionBody).toMatch(/await onRelease\(r\.id\)/);
  });

  it("mostra una conferma esplicita, non ambigua, prima della chiamata", () => {
    expect(sectionBody).toMatch(/window\.confirm\(/);
    expect(sectionBody).toMatch(/Vuoi liberare il bus/);
    expect(sectionBody).toMatch(/non verranno cancellat/i);
  });

  it("il pulsante si disabilita durante la richiesta (nessun doppio click concorrente sulla stessa riga)", () => {
    expect(sectionBody).toMatch(/disabled=\{releasingId === r\.id\}/);
    expect(sectionBody).toMatch(/setReleasingId\(r\.id\)/);
  });

  it("è concettualmente separato da 'Disalloca selezionati': nessuna action delete_allocations_bulk invocata qui", () => {
    expect(sectionBody).not.toMatch(/action:\s*"delete_allocations_bulk"/);
    expect(sectionBody).not.toMatch(/\.from\("tenant_bus_allocations"\)/);
  });
});

describe("Booking Groups page.tsx — action delete_bus_reservation cablata da GroupDetail", () => {
  it("GroupDetail passa onRelease che chiama action delete_bus_reservation con solo l'id", () => {
    const detailBody = extractFunctionBody("GroupDetail");
    expect(detailBody).toMatch(/onRelease=\{\(id\) => post\(\{\s*action: "delete_bus_reservation",\s*id\s*\}\)\}/);
  });
});
