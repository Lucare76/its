import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * PROMPT "Modificabile punto di carico da /bus-tours" — Fase 2/5.
 *
 * app/(app)/bus-tours/page.tsx è "use client" con hook React: nessun harness
 * di render component in questo progetto (stesso vincolo documentato in
 * tests/unit/booking-groups-hotel-ui.test.ts). Questi test verificano quindi
 * il contratto a livello di sorgente: il campo "Punto di carico" e' cablato
 * sulla source of truth canonica (tenant_bus_line_stops.pickup_note via
 * l'azione update_stop_pickup_note già usata da /bus-network), non su un
 * campo/tabella duplicato, e non tocca capacità/waitlist/note del lotto.
 */
const source = readFileSync(join(process.cwd(), "app/(app)/bus-tours/page.tsx"), "utf8");

function bodyOf(source: string, startMarker: string, endMarker: string) {
  const start = source.indexOf(startMarker);
  expect(start, `marker di inizio non trovato: ${startMarker}`).toBeGreaterThan(-1);
  const end = source.indexOf(endMarker, start + startMarker.length);
  expect(end, `marker di fine non trovato: ${endMarker}`).toBeGreaterThan(-1);
  return source.slice(start, end);
}

const SAVE_PICKUP_NOTE_MARKER = "const savePickupNote = async";
const SAVE_LOT_CONFIG_MARKER = "const saveLotConfig = async";
const savePickupNoteBody = () => bodyOf(source, SAVE_PICKUP_NOTE_MARKER, "\n  const lotSummary = useMemo");
const saveLotConfigBody = () => bodyOf(source, SAVE_LOT_CONFIG_MARKER, "\n  const createMissingLotConfigs = async");

describe("bus-tours/page.tsx — campo Punto di carico (Fase 2/3)", () => {
  it("1. il campo mostra il valore attuale quando presente (precompilato dal draft o dalla fermata risolta)", () => {
    expect(source).toMatch(/value=\{pickupNoteDrafts\[selectedLot\.key\] \?\? selectedLotStopLink\.pickupNote \?\? ""\}/);
  });

  it("2. se null mostra placeholder 'Inserisci punto di carico' (campo vuoto, mai testo inventato)", () => {
    expect(source).toMatch(/placeholder="Inserisci punto di carico"/);
  });

  it("3. il salvataggio chiama l'azione canonica update_stop_pickup_note con lo stop_id risolto (mai un nuovo campo/tabella)", () => {
    const handlerBody = savePickupNoteBody();
    expect(handlerBody).toMatch(/action:\s*"update_stop_pickup_note"/);
    expect(handlerBody).toMatch(/stop_id:\s*link\.stopId/);
  });

  it("4. dopo il salvataggio il valore mostrato si aggiorna subito dallo stato locale, senza un secondo fetch/refresh", () => {
    const handlerBody = savePickupNoteBody();
    expect(handlerBody).toMatch(/setStopLinkByLotKey\(\(prev\) => \(\{ \.\.\.prev, \[lot\.key\]: \{ \.\.\.link, pickupNote: draftValue \|\| null \} \}\)\)/);
    expect(handlerBody).not.toMatch(/refresh\(\)/);
  });

  it("5. lotto senza fermata unica collegata: il salvataggio è bloccato e il campo non è editabile", () => {
    const handlerBody = savePickupNoteBody();
    expect(handlerBody).toMatch(/link\.status !== "linked"/);
    expect(source).toMatch(/disabled=\{selectedLotStopLink\?\.status !== "linked"/);
    expect(source).toMatch(/Fermata non collegata/);
  });

  it("6. il salvataggio del punto di carico è una funzione separata da saveLotConfig: nessun impatto su capacità/waitlist/note del lotto", () => {
    const lotConfigBody = saveLotConfigBody();
    expect(lotConfigBody).not.toMatch(/update_stop_pickup_note/);
    expect(lotConfigBody).toMatch(/bus_lot_configs/);
    // savePickupNote non scrive mai su bus_lot_configs (capacità/soglia/waitlist/note restano intoccate).
    const pickupNoteBody = savePickupNoteBody();
    expect(pickupNoteBody).not.toMatch(/bus_lot_configs/);
    expect(pickupNoteBody).not.toMatch(/capacity|waitlist|minimumPassengers|lowSeatThreshold/i);
  });

  it("la risoluzione fermata usa solo l'id (tenant_bus_allocations.stop_id), mai un match per nome", () => {
    expect(source).toMatch(/resolveBusLotStopId/);
    expect(source).toMatch(/from\("tenant_bus_allocations"\)/);
    expect(source).toMatch(/from\("tenant_bus_line_stops"\)/);
  });
});
