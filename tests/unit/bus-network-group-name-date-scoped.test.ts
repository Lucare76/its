import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Etichetta gruppo per data selezionata su /bus-network (dateUnitLoads).
 *
 * Audit "group_name stale" (caso reale: GIACOMONI spostato da BUS3 a BUS1 il
 * 13/09, ma tenant_bus_units.group_name su BUS3 resta statico = "GIACOMONI").
 * Verificato: `dateUnitLoads` (app/(app)/bus-network/page.tsx) GIÀ deriva il
 * nome gruppo mostrato SOLO da allocazioni/reservation della data
 * selezionata (Obiettivo E, introdotto per un incidente precedente identico
 * — "PARROCCHIA SANTA BEATA" che compariva su una data a cui non
 * apparteneva) — MAI da tenant_bus_units.group_name come fallback. Questo
 * file blocca una futura regressione che reintroducesse quel fallback.
 *
 * Nessun @testing-library/react in questo progetto (vitest.config.ts usa
 * environment "node"): verifica a livello di sorgente, stesso pattern già
 * usato per gli altri controlli UI di questa pagina.
 */
const source = readFileSync(
  join(process.cwd(), "app/(app)/bus-network/page.tsx"),
  "utf8"
);

function sliceBlock(marker: string, length = 2200): string {
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`marcatore non trovato nel sorgente: ${marker}`);
  return source.slice(start, start + length);
}

describe("dateUnitLoads — nome gruppo derivato per data selezionata (mai statico)", () => {
  const block = sliceBlock("const dateUnitLoads = useMemo(");

  it("le allocazioni usate per il nome sono filtrate per la data selezionata (allDateAllocations, già scoped su service_date === date)", () => {
    // allDateAllocations è definito altrove come payload.allocation_details
    // filtrato su service_date === date + direction — dateUnitLoads lo
    // consuma così com'è, senza mai riguardare altre date.
    expect(source).toMatch(/const allDateAllocations = useMemo\(\s*\(\) => payload\.allocation_details\.filter\(\s*\(a\) => a\.bus_line_id === selectedLine\?\.id && a\.service_date === date && a\.direction === direction/);
  });

  it("la reservation esclusiva considerata è filtrata per bus_unit_id + service_date === date (mai altre date)", () => {
    expect(block).toMatch(/payload\.booking_group_reservations\s*\?\.find\(\(r\) => r\.bus_unit_id === unit\.id && r\.service_date === date && r\.exclusive\)/);
  });

  it("il nome finale NON ricade mai su tenant_bus_units.group_name statico", () => {
    expect(block).toMatch(/group_name: allocatedGroupName \?\? reservationGroupName \?\? null/);
    // Il commento esplicito che documenta la regola: nessun fallback statico.
    expect(block).toMatch(/MAI più tenant_bus_units\.group_name come fallback/);
  });

  it("la data selezionata è nelle dipendenze del useMemo: cambiare data ricalcola il nome (scenario multi-data)", () => {
    expect(block).toMatch(/\[lineUnits, allDateAllocations, serviceById, payload\.booking_group_reservations, reservationConflictByUnit, date\]/);
  });
});

describe("busCards / vista Linea — il rendering usa sempre l'unit derivato da dateUnitLoads, mai quello grezzo", () => {
  it("busCards è costruito da dateUnitLoads (non da payload.units/lineUnits grezzi)", () => {
    expect(source).toMatch(/const busCards = useMemo\(\s*\(\) => dateUnitLoads\.map\(\(unit\) => \(\{\s*unit,/);
  });

  it("l'header della card (nome bus/gruppo) e l'editor 'aggiungi nome' leggono lo stesso unit derivato da busCards", () => {
    const cardsBlock = sliceBlock("{busCards.map(({ unit, allocations: cardAllocs }) => {", 20000);
    expect(cardsBlock).toMatch(/\{unit\.group_name \? \(/);
    expect(cardsBlock).toMatch(/setEditGroupNameValue\(unit\.group_name \?\? ""\)/);
    // Nessun secondo .map su lineUnits/payload.units grezzi tra l'apertura
    // del blocco card e l'editor del nome: stesso `unit` in tutto il blocco.
    const beforeEditor = cardsBlock.slice(0, cardsBlock.indexOf("setEditGroupNameValue(unit.group_name"));
    expect(beforeEditor).not.toMatch(/lineUnits\.map\(\(unit\)|payload\.units\.map\(\(unit\)/);
  });
});

describe("Scenario reale GIACOMONI (13/09): BUS1 mostra il nome, BUS3 no — anche con group_name legacy stale su BUS3", () => {
  it("la derivazione non consulta mai unit.group_name in input: il campo in output è sempre ricalcolato via spread+override", () => {
    const block = sliceBlock("const dateUnitLoads = useMemo(");
    // ...unit propaga i campi originali (spread), ma il campo group_name
    // viene sempre SOVRASCRITTO subito dopo dallo spread — mai letto come
    // input per decidere il nome mostrato.
    expect(block).toMatch(/return \{ \.\.\.unit, group_name: allocatedGroupName \?\? reservationGroupName \?\? null/);
  });
});
