import { describe, it, expect } from "vitest";
import { buildBusLinePdfHtml, type BusPdfAllocation } from "@/lib/bus-export-pdf";
import { buildArrivalWorkbook, buildDepartureWorkbook } from "@/lib/bus-export-excel";

/**
 * PROMPT "FIX PDF/EXPORT/LISTE OPERATIVE: HOTEL + NOTE GRUPPO" — copertura
 * per il bug: `displayHotel`/`withExportPassengerContact` azzeravano sempre
 * l'hotel per le righe di gruppo (is_booking_group), anche quando
 * booking_group.hotel_id era valorizzato; e note gruppo/fermata non
 * venivano mai lette da PDF/Excel. Le fixture qui simulano l'output di
 * `withExportPassengerContact` (page.tsx) — cioè un'allocazione con
 * hotel_name/group_notes_block già risolti — perché quella funzione vive
 * in un componente client e non è testabile in isolamento.
 */

function alloc(overrides: Partial<BusPdfAllocation> = {}): BusPdfAllocation {
  return {
    stop_name: "PESARO",
    stop_city: "Pesaro",
    stop_pickup_note: null,
    stop_pickup_time: "05:20",
    hotel_pickup_time: null,
    pax_assigned: 6,
    customer_name: "GIACOMONI",
    customer_phone: null,
    is_booking_group: false,
    hotel_name: null,
    agency_name: null,
    notes: null,
    group_notes_block: null,
    ...overrides,
  };
}

describe("buildBusLinePdfHtml — Obiettivo A: hotel del gruppo nel PDF", () => {
  it("riga di gruppo con hotel risolto dal gruppo -> il PDF mostra l'hotel, non lo azzera più", () => {
    const html = buildBusLinePdfHtml({
      direction: "arrival",
      lineName: "Bus esclusivi gruppi",
      dateIso: "2026-09-06",
      busLabel: "GRUPPO EX 3",
      allocations: [alloc({ is_booking_group: true, hotel_name: "GRAND HOTEL DELLE TERME" })],
    });
    expect(html).toContain("GRAND HOTEL DELLE TERME");
  });

  it("riga di gruppo SENZA hotel risolto -> cella vuota, nessun dato inventato (comportamento attuale equivalente)", () => {
    const html = buildBusLinePdfHtml({
      direction: "arrival",
      lineName: "Bus esclusivi gruppi",
      dateIso: "2026-09-06",
      allocations: [alloc({ is_booking_group: true, hotel_name: null, notes: null })],
    });
    expect(html).not.toContain("Hotel N/D");
  });

  it("servizio individuale (is_booking_group false): comportamento invariato, hotel del service mostrato normalmente", () => {
    const html = buildBusLinePdfHtml({
      direction: "arrival",
      lineName: "Linea Adriatica",
      dateIso: "2026-09-06",
      allocations: [alloc({ is_booking_group: false, hotel_name: "Hotel Individuale", customer_name: "Rossi Mario" })],
    });
    expect(html).toContain("Hotel Individuale");
    expect(html).toContain("Rossi Mario");
  });
});

describe("buildBusLinePdfHtml — Obiettivo B/C: note gruppo/fermata/servizio composte", () => {
  it("group_notes_block valorizzato -> compare nel PDF insieme all'eventuale nota gia' esistente", () => {
    const html = buildBusLinePdfHtml({
      direction: "arrival",
      lineName: "Bus esclusivi gruppi",
      dateIso: "2026-09-06",
      allocations: [alloc({
        is_booking_group: true,
        hotel_name: "GRAND HOTEL DELLE TERME",
        group_notes_block: "Gruppo: portare documenti · Fermata: parcheggio custodito",
      })],
    });
    expect(html).toContain("portare documenti");
    expect(html).toContain("parcheggio custodito");
  });

  it("nessuna nota gruppo/fermata/servizio -> nessuna riga vuota o testo inventato", () => {
    const html = buildBusLinePdfHtml({
      direction: "arrival",
      lineName: "Bus esclusivi gruppi",
      dateIso: "2026-09-06",
      allocations: [alloc({ is_booking_group: true, hotel_name: "Hotel X", group_notes_block: null, notes: null })],
    });
    expect(html).not.toContain("Gruppo:");
    expect(html).not.toContain("Fermata:");
    expect(html).not.toContain("Servizio:");
  });
});

describe("buildBusLinePdfHtml — FIX MIRATO \"FORMATO SCARICO ATTESO\": SCARICO PDF ritorno", () => {
  const giacomoniStops = (direction: "arrival" | "departure") => [
    { stop_name: "CATTOLICA", pickup_note: "CASELLO A14", pickup_time: "05:20", stop_order: 1 },
    { stop_name: "PESARO", pickup_note: "CASELLO A14", pickup_time: "05:35", stop_order: 2 },
    { stop_name: "FANO", pickup_note: "PARCHEGGIO CASELLO A14", pickup_time: "06:00", stop_order: 3 },
    { stop_name: "MAROTTA", pickup_note: "PARCHEGGIO CASELLO A14", pickup_time: "06:20", stop_order: 4 },
  ].map((s) => ({ ...s, stop_order: direction === "departure" ? 5 - s.stop_order : s.stop_order }));

  const giacomoniAllocations = (): BusPdfAllocation[] => [
    alloc({ stop_name: "MAROTTA", stop_pickup_note: "PARCHEGGIO CASELLO A14", pax_assigned: 18, is_booking_group: true }),
    alloc({ stop_name: "FANO", stop_pickup_note: "PARCHEGGIO CASELLO A14", pax_assigned: 10, is_booking_group: true }),
    alloc({ stop_name: "PESARO", stop_pickup_note: "CASELLO A14", pax_assigned: 6, is_booking_group: true }),
    alloc({ stop_name: "CATTOLICA", stop_pickup_note: "CASELLO A14", pax_assigned: 4, is_booking_group: true }),
  ];

  it("mostra TUTTE le 4 fermate (mai solo MAROTTA) anche se il catalogo passato è incompleto", () => {
    const html = buildBusLinePdfHtml({
      direction: "departure",
      lineName: "Bus esclusivi gruppi",
      dateIso: "2026-09-13",
      busLabel: "GRUPPO EX 3",
      allocations: giacomoniAllocations(),
      // Catalogo incompleto (solo MAROTTA) — root cause del bug reale: le
      // altre 3 fermate NON devono sparire dallo SCARICO solo perché
      // mancano/non combaciano nel catalogo passato al PDF.
      stops: [{ stop_name: "MAROTTA", pickup_note: "PARCHEGGIO CASELLO A14", pickup_time: "09:00", stop_order: 1 }],
    });
    expect(html).toContain("SCARICO");
    expect(html).toContain("MAROTTA - PARCHEGGIO CASELLO A14");
    expect(html).toContain("FANO - PARCHEGGIO CASELLO A14");
    expect(html).toContain("PESARO - CASELLO A14");
    expect(html).toContain("CATTOLICA - CASELLO A14");
    expect(html).toContain("18 pax");
    expect(html).toContain("10 pax");
    expect(html).toContain("6 pax");
    expect(html).toContain("4 pax");
  });

  it("ordina lo SCARICO per sort_order (MAROTTA, FANO, PESARO, CATTOLICA), mai alfabetico né per orario", () => {
    const html = buildBusLinePdfHtml({
      direction: "departure",
      lineName: "Bus esclusivi gruppi",
      dateIso: "2026-09-13",
      busLabel: "GRUPPO EX 3",
      allocations: giacomoniAllocations(),
      stops: giacomoniStops("departure"),
    });
    const unloadSection = html.slice(html.indexOf("SCARICO"));
    const order = ["MAROTTA", "FANO", "PESARO", "CATTOLICA"].map((city) => unloadSection.indexOf(city));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("PDF Andata (arrival): nessuna sezione SCARICO", () => {
    const html = buildBusLinePdfHtml({
      direction: "arrival",
      lineName: "Bus esclusivi gruppi",
      dateIso: "2026-09-06",
      busLabel: "GRUPPO EX 1",
      allocations: giacomoniAllocations(),
      stops: giacomoniStops("arrival"),
    });
    expect(html).not.toContain("SCARICO");
  });
});

describe("buildArrivalWorkbook/buildDepartureWorkbook — Obiettivo A/B/C nell'export Excel", () => {
  it("Andata: hotel del gruppo e note composte compaiono nelle celle corrette", async () => {
    const wb = await buildArrivalWorkbook(
      [{
        stop_name: "PESARO",
        stop_pickup_time: "05:20",
        pax_assigned: 6,
        customer_name: "GIACOMONI",
        hotel_name: "GRAND HOTEL DELLE TERME RE FERDINANDO",
        notes: null,
        group_notes_block: "Gruppo: nota gruppo",
      }],
      [],
      null,
      null,
      null,
    );
    const ws = wb.worksheets[0];
    // shortenHotelName (comportamento invariato) rimuove parole generiche
    // come "grand"/"hotel"/"terme": verifichiamo la parte che sopravvive.
    const allValues = ws.getSheetValues().flat().map((v) => String(v ?? ""));
    expect(allValues.some((v) => v.includes("FERDINANDO"))).toBe(true);
    expect(allValues.some((v) => v.includes("nota gruppo"))).toBe(true);
  });

  it("Ritorno: hotel del gruppo e note composte compaiono nelle celle corrette", async () => {
    const wb = await buildDepartureWorkbook(
      [{
        stop_name: "PESARO",
        hotel_pickup_time: "08:30",
        pax_assigned: 6,
        customer_name: "GIACOMONI",
        hotel_name: "GRAND HOTEL DELLE TERME RE FERDINANDO",
        notes: null,
        group_notes_block: "Fermata: nota fermata ritorno",
      }],
      [],
      null,
      null,
      null,
    );
    const ws = wb.worksheets[0];
    const allValues = ws.getSheetValues().flat().map((v) => String(v ?? ""));
    expect(allValues.some((v) => v.includes("FERDINANDO"))).toBe(true);
    expect(allValues.some((v) => v.includes("nota fermata ritorno"))).toBe(true);
  });

  it("servizio individuale: nessuna nota gruppo aggiunta, nota originale invariata", async () => {
    const wb = await buildArrivalWorkbook(
      [{
        stop_name: "RIMINI",
        stop_pickup_time: "05:10",
        pax_assigned: 1,
        customer_name: "Rossi Mario",
        hotel_name: "Hotel Individuale",
        notes: "richiesta seggiolino",
        group_notes_block: null,
      }],
      [],
      null,
      null,
      null,
    );
    const ws = wb.worksheets[0];
    const allValues = ws.getSheetValues().flat().map((v) => String(v ?? ""));
    expect(allValues.some((v) => v.includes("richiesta seggiolino"))).toBe(true);
    expect(allValues.some((v) => v.includes("Gruppo:") || v.includes("Fermata:") || v.includes("Servizio:"))).toBe(false);
  });
});
