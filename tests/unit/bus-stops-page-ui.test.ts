import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * PROMPT "Fermate bus" — Fase 22: app/(app)/bus-stops/page.tsx è "use
 * client" con hook React: nessun harness di render component in questo
 * progetto (stesso vincolo già documentato in
 * tests/unit/booking-groups-hotel-ui.test.ts e
 * tests/unit/bus-tours-pickup-note-ui.test.ts). Questi test verificano il
 * contratto a livello di sorgente: wiring dei filtri, della tabella, del
 * riordino e della source of truth (mai un secondo campo).
 */
const source = readFileSync(join(process.cwd(), "app/(app)/bus-stops/page.tsx"), "utf8");

describe("bus-stops/page.tsx — wiring lista/filtri/riordino (Fase 22)", () => {
  it("1. la tabella renderizza pageStops (lista fermate) con nome fermata sempre uppercase", () => {
    expect(source).toMatch(/pageStops\.map\(\(\{ stop, status \}\) => \{/);
    expect(source).toMatch(/\{stop\.stop_name\.toUpperCase\(\)\}/);
  });

  it("2. filtro Linea: filteredStops esclude gli stop di linee diverse da lineFilter", () => {
    expect(source).toMatch(/if \(lineFilter !== "all" && stop\.bus_line_id !== lineFilter\) return false;/);
  });

  it("3. filtro Direzione: filteredStops esclude le direzioni diverse da directionFilter", () => {
    expect(source).toMatch(/if \(directionFilter !== "all" && stop\.direction !== directionFilter\) return false;/);
  });

  it("4. ricerca: il testo digitato viene confrontato con stop_name + city (mai altri campi)", () => {
    expect(source).toMatch(/const haystack = `\$\{stop\.stop_name\} \$\{stop\.city\}`\.toLowerCase\(\);/);
  });

  it("11. riordino: il campo Ordine fermata è collegato a stopOrder del draft e salvato con update_bus_line_stop", () => {
    expect(source).toMatch(/Ordine fermata/);
    expect(source).toMatch(/value=\{draft\.stopOrder\}/);
    expect(source).toMatch(/stop_order: stopOrderNum/);
    expect(source).toMatch(/"update_bus_line_stop"/);
  });

  it("17. una fermata senza pickup_note mostra il badge 'Punto di carico mancante' in tabella (caso NARNI)", () => {
    expect(source).toMatch(/Punto di carico mancante/);
    expect(source).toMatch(/stop\.pickup_note && stop\.pickup_note\.trim\(\)/);
  });

  it("source of truth: legge/scrive sempre tenant_bus_line_stops via le action condivise, mai services.meeting_point o bus_lot_configs", () => {
    expect(source).toMatch(/"list_bus_line_stops"/);
    expect(source).toMatch(/"create_bus_line_stop"/);
    expect(source).toMatch(/"update_bus_line_stop"/);
    expect(source).toMatch(/"delete_bus_line_stop"/);
    expect(source).not.toMatch(/meeting_point/);
    expect(source).not.toMatch(/bus_lot_configs/);
  });

  it("near-duplicate: warning mostrato ma la creazione non unisce mai automaticamente", () => {
    expect(source).toMatch(/Esiste una fermata simile/);
    expect(source).toMatch(/findNearDuplicateStopNamesClient/);
  });

  it("delete bloccato in UI se la fermata ha servizi collegati (service_count > 0)", () => {
    expect(source).toMatch(/disabled=\{busy \|\| selectedStop\.service_count > 0\}/);
  });
});

describe("bus-stops/page.tsx — drag&drop reorder (Fase B/1/2/3/8/9)", () => {
  it("1. canReorder è vero solo con UNA linea e UNA direzione selezionate, ordinamento 'Linea, Ordine' e nessun altro filtro attivo", () => {
    expect(source).toMatch(/const canReorder =\s*\n\s*lineFilter !== "all" &&\s*\n\s*directionFilter !== "all" &&\s*\n\s*sortBy === "line_order" &&\s*\n\s*statusFilter === "all" &&\s*\n\s*!manualOnly &&\s*\n\s*!search\.trim\(\);/);
  });

  it("2/3. quando canReorder è attivo, sortedStops mostra SOLO le fermate attive del gruppo lineFilter+directionFilter selezionato (mai un'altra linea o direzione)", () => {
    expect(source).toMatch(
      /stop\.bus_line_id === lineFilter && stop\.direction === directionFilter && stop\.active/
    );
  });

  it("il drag handle esiste solo quando canReorder è vero, mai sull'intera riga (niente draggable sulla <tr>)", () => {
    expect(source).toMatch(/draggable\s*\n\s*onDragStart=\{handleDragStart\(stop\.id\)\}/);
    expect(source).not.toMatch(/<tr[^>]*draggable/);
  });

  it("2. persistReorder invia SEMPRE l'azione reorder_bus_line_stops con l'elenco fermate del gruppo linea+direzione corrente", () => {
    expect(source).toMatch(/postBusNetworkAction\("reorder_bus_line_stops", \{/);
    expect(source).toMatch(/bus_line_id: lineFilter,/);
    expect(source).toMatch(/direction: directionFilter,/);
    expect(source).toMatch(/ordered_stop_ids: orderedIds,/);
  });

  it("9. aggiornamento ottimistico PRIMA della chiamata API, rollback allo snapshot precedente se fallisce, messaggio 'Ordine salvato' se ok — mai un refresh pagina manuale", () => {
    expect(source).toMatch(/const previousStops = stops;/);
    expect(source).toMatch(/setStops\(\(prev\) => prev\.map/); // ottimistico
    expect(source).toMatch(/setStops\(previousStops\);/); // rollback
    expect(source).toMatch(/setMessage\("Ordine salvato\."\);/);
    expect(source).not.toMatch(/window\.location\.reload/);
  });

  it("3. normalizeOrder chiama normalize_bus_line_stop_order scoped a UNA linea+direzione (mai un'azione globale su tutto il catalogo)", () => {
    expect(source).toMatch(/postBusNetworkAction\("normalize_bus_line_stop_order", \{/);
    expect(source).not.toMatch(/normalizza tutte le fermate/i);
  });
});
