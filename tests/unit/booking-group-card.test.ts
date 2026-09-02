import { describe, it, expect } from "vitest";
import { formatStopLine, groupSearchResults, GROUP_KIND_LABEL, type GroupableRow } from "@/lib/booking-group-card";

/**
 * Copertura per la logica di raggruppamento condivisa tra /ricerca e /inbox
 * (la vera pagina "Prenotazioni" della sidebar). Prima di questa sessione
 * /inbox non raggruppava affatto per booking_group_id, mostrando 4 card
 * separate per il gruppo GIACOMONI.
 */

function row(overrides: Partial<GroupableRow> = {}): GroupableRow {
  return { id: "s1", pax: 1, direction: "arrival", ...overrides };
}

describe("groupSearchResults", () => {
  it("4 services stesso booking_group_id -> 1 solo item di tipo group", () => {
    const items = groupSearchResults([
      row({ id: "s-cattolica", pax: 4, booking_group_id: "bg-giacomoni" }),
      row({ id: "s-pesaro", pax: 6, booking_group_id: "bg-giacomoni" }),
      row({ id: "s-fano", pax: 10, booking_group_id: "bg-giacomoni" }),
      row({ id: "s-marotta", pax: 18, booking_group_id: "bg-giacomoni" }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("group");
    if (items[0].type === "group") {
      expect(items[0].services).toHaveLength(4);
      expect(items[0].services.reduce((sum, s) => sum + s.pax, 0)).toBe(38);
    }
  });

  it("service senza booking_group_id -> resta individuale, mai raggruppato", () => {
    const items = groupSearchResults([row({ id: "s1", booking_group_id: null })]);
    expect(items).toEqual([{ type: "individual", result: row({ id: "s1", booking_group_id: null }) }]);
  });

  it("due gruppi diversi -> due item group distinti, mai mescolati", () => {
    const items = groupSearchResults([
      row({ id: "s1", booking_group_id: "bg-a" }),
      row({ id: "s2", booking_group_id: "bg-b" }),
    ]);
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.type === "group")).toBe(true);
  });

  it("gruppo + individuale mescolati nell'ordine originale -> ogni gruppo compare una sola volta, alla prima occorrenza", () => {
    const items = groupSearchResults([
      row({ id: "ind-1", booking_group_id: null }),
      row({ id: "s1", booking_group_id: "bg-a" }),
      row({ id: "s2", booking_group_id: "bg-a" }),
      row({ id: "ind-2", booking_group_id: null }),
    ]);
    expect(items.map((i) => i.type)).toEqual(["individual", "group", "individual"]);
  });

  it("array vuoto -> array vuoto", () => {
    expect(groupSearchResults([])).toEqual([]);
  });
});

describe("formatStopLine", () => {
  it("città + punto di carico diversi -> 'CITTÀ - PUNTO — N pax — HH:MM'", () => {
    expect(formatStopLine(row({ bus_city_origin: "CATTOLICA", meeting_point: "CASELLO A14", pax: 4, time: "05:20:00" })))
      .toBe("CATTOLICA - CASELLO A14 — 4 pax — 05:20");
  });

  it("punto di carico uguale alla città -> non duplica", () => {
    expect(formatStopLine(row({ bus_city_origin: "PESARO", meeting_point: "PESARO", pax: 6, time: "05:35" })))
      .toBe("PESARO — 6 pax — 05:35");
  });

  it("nessun orario -> nessun trattino finale", () => {
    expect(formatStopLine(row({ bus_city_origin: "FANO", pax: 10, time: null })))
      .toBe("FANO — 10 pax");
  });

  it("nessuna fermata nota -> 'Fermata da definire', mai un dato inventato", () => {
    expect(formatStopLine(row({ bus_city_origin: null, meeting_point: null, pax: 1 })))
      .toBe("Fermata da definire — 1 pax");
  });
});

describe("GROUP_KIND_LABEL", () => {
  it("bus_exclusive -> 'Bus esclusivo'", () => {
    expect(GROUP_KIND_LABEL.bus_exclusive).toBe("Bus esclusivo");
  });
});
