import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Elimina passeggero/nominativo da una fermata — verifica UI.
 *
 * app/(app)/booking-groups/page.tsx è "use client" con hook React: nessun
 * harness di render component in questo progetto (nessun
 * @testing-library/react, vitest.config.ts usa environment "node" — stesso
 * vincolo già documentato in tests/unit/mts-globe-post-confirm.test.ts e
 * tests/unit/booking-groups-hotel-ui.test.ts). Questo test verifica quindi
 * il contratto a livello di sorgente.
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

describe("Booking Groups page.tsx — pulsante Elimina nominativo (StopsSection)", () => {
  const stopsSectionBody = extractFunctionBody("StopsSection");

  it("il pulsante 'Elimina' è presente accanto a ogni nominativo, cablato su onRemovePassenger", () => {
    expect(stopsSectionBody).toMatch(/linked\.map\(\(sv\) =>/);
    expect(stopsSectionBody).toMatch(/Elimina/);
    expect(stopsSectionBody).toMatch(/onRemovePassenger\(s\.id, sv\.id\)/);
  });

  it("chiede conferma prima di eliminare", () => {
    expect(stopsSectionBody).toMatch(/window\.confirm\(/);
    expect(stopsSectionBody).toMatch(/eliminare questo passeggero/i);
  });

  it("usa il serviceId della riga cliccata (sv.id), non un id di gruppo o un nome", () => {
    expect(stopsSectionBody).toMatch(/setRemovingId\(sv\.id\)/);
    expect(stopsSectionBody).toMatch(/disabled=\{removingId === sv\.id\}/);
  });

  it("il pulsante si disabilita durante l'eliminazione (nessun doppio click concorrente sulla stessa riga)", () => {
    expect(stopsSectionBody).toMatch(/disabled=\{removingId === sv\.id\}/);
    expect(stopsSectionBody).toMatch(/Elimino…/);
  });
});

describe("Booking Groups page.tsx — action remove_group_passenger cablata da GroupDetail", () => {
  it("GroupDetail passa onRemovePassenger con action/booking_group_id/booking_group_stop_id/service_id", () => {
    const detailBody = extractFunctionBody("GroupDetail");
    expect(detailBody).toMatch(/onRemovePassenger=\{\(stopId, serviceId\) => post\(\{\s*action: "remove_group_passenger"/);
    expect(detailBody).toMatch(/booking_group_id: group\.id/);
    expect(detailBody).toMatch(/booking_group_stop_id: stopId/);
    expect(detailBody).toMatch(/service_id: serviceId/);
  });

  it("i conteggi pax del gruppo escludono i services con status='cancelled' (stessa regola server-side)", () => {
    const detailBody = extractFunctionBody("GroupDetail");
    expect(detailBody).toMatch(/services\.filter\(\(s\) => s\.status !== "cancelled"\)/);
    // Obiettivo G: i pax vanno calcolati SEPARATAMENTE per andata/ritorno
    // (mai sommati), ma sempre a partire da activeServices (cancellati
    // esclusi) — vedi computeBookingGroupStatusSummaryByDirection.
    expect(detailBody).toMatch(/arrivalServicePax: activeServices\.filter/);
    expect(detailBody).toMatch(/departureServicePax: activeServices\.filter/);
  });
});
