import { describe, it, expect } from "vitest";
import { buildBusLinePdfHtml, type BusPdfAllocation, type BusPdfStop } from "@/lib/bus-export-pdf";

/**
 * Task "PDF PARTENZE BUS LINEA — fermata duplicata + SCARICO fuori ordine".
 *
 * Caso reale di riferimento: Linea Centro, 06/09/2026, CENTRO1 departure.
 * stop_order reale letto da tenant_bus_line_stops (audit read-only,
 * tenant_id d200b89a-64c7-4f8d-a430-95a33b83047a, bus_line_id
 * 75523299-187a-4775-a1d1-2402d7e11e15, direction=departure):
 *   VALMONTONE=1, ROMA TIBURTINA=2, NARNI=6, TERNI=7, FOLIGNO=9, PERUGIA=12
 * Pax attesi: Terni=18, Perugia=9, Roma=9, Foligno=8, Valmontone=6, Narni=4,
 * totale=54 — i conteggi NON cambiano, solo grouping/ordine.
 *
 * Bug originale: TERNI compariva in 3 blocchi separati nel corpo del PDF
 * (BATTISTELLI/MASSARELLI/FRANCA/PALIY, poi SARUBBI/MOSCA/SILVERI, poi
 * ANGELUZZI) perché il sort ordinava per orario prima dello stop, e lo
 * SCARICO usava un secondo sort indipendente che poteva divergere dal corpo.
 */

const REAL_STOP_IDS = {
  valmontone: "ed5911c8-b95c-4e59-9891-84a2fd3980ed",
  romaTiburtina: "ae9ae49c-1655-46bc-8145-707886d48f11",
  narni: "641ba53c-49ba-409c-acff-ebcd918e756d",
  terni: "e49a8739-d6ab-4f27-9837-9de0cbdb7872",
  foligno: "77986228-8d80-40b7-904e-158baf3393e9",
  perugia: "d436de5c-2e19-4688-b04c-cffd16409028",
} as const;

const realCentroStops: BusPdfStop[] = [
  { id: REAL_STOP_IDS.valmontone, stop_name: "VALMONTONE", pickup_note: "Casello", pickup_time: null, stop_order: 1 },
  { id: REAL_STOP_IDS.romaTiburtina, stop_name: "ROMA TIBURTINA", pickup_note: "Largo Mazzoni, di fronte negozio ITS Moda", pickup_time: null, stop_order: 2 },
  { id: REAL_STOP_IDS.narni, stop_name: "NARNI", pickup_note: null, pickup_time: null, stop_order: 6 },
  { id: REAL_STOP_IDS.terni, stop_name: "TERNI", pickup_note: "Terminal Bus Atc", pickup_time: null, stop_order: 7 },
  { id: REAL_STOP_IDS.foligno, stop_name: "FOLIGNO", pickup_note: "City Hotel", pickup_time: null, stop_order: 9 },
  { id: REAL_STOP_IDS.perugia, stop_name: "PERUGIA", pickup_note: "Pian di Massiano, stazione Minimetrò", pickup_time: null, stop_order: 12 },
];

function alloc(overrides: Partial<BusPdfAllocation> = {}): BusPdfAllocation {
  return {
    stop_id: null,
    stop_name: "",
    stop_city: null,
    stop_pickup_note: null,
    stop_pickup_time: null,
    hotel_pickup_time: null,
    pax_assigned: 1,
    customer_name: "CLIENTE",
    customer_phone: null,
    is_booking_group: false,
    hotel_name: null,
    agency_name: null,
    notes: null,
    group_notes_block: null,
    ...overrides,
  };
}

// Allocazioni deliberatamente INTERCALATE (mai contigue per stop_id) e con
// orari di pickup diversi per TERNI, per riprodurre esattamente lo scenario
// reale che generava i 3 blocchi separati — la sola posizione nell'array
// (ordine di arrivo delle allocations) e l'orario NON devono più influenzare
// il raggruppamento.
function realCentro1Allocations(): BusPdfAllocation[] {
  return [
    alloc({ stop_id: REAL_STOP_IDS.terni, stop_name: "TERNI", customer_name: "BATTISTELLI", pax_assigned: 4, hotel_pickup_time: "10:10" }),
    alloc({ stop_id: REAL_STOP_IDS.valmontone, stop_name: "VALMONTONE", customer_name: "ROSSI", pax_assigned: 6, hotel_pickup_time: "09:00" }),
    alloc({ stop_id: REAL_STOP_IDS.terni, stop_name: "TERNI", customer_name: "MASSARELLI", pax_assigned: 3, hotel_pickup_time: "10:00" }),
    alloc({ stop_id: REAL_STOP_IDS.romaTiburtina, stop_name: "ROMA TIBURTINA", customer_name: "VERDI", pax_assigned: 9, hotel_pickup_time: "08:30" }),
    alloc({ stop_id: REAL_STOP_IDS.terni, stop_name: "TERNI", customer_name: "FRANCA", pax_assigned: 2, hotel_pickup_time: "09:50" }),
    alloc({ stop_id: REAL_STOP_IDS.perugia, stop_name: "PERUGIA", customer_name: "BIANCHI", pax_assigned: 9, hotel_pickup_time: "11:00" }),
    alloc({ stop_id: REAL_STOP_IDS.terni, stop_name: "TERNI", customer_name: "PALIY", pax_assigned: 2, hotel_pickup_time: null }),
    alloc({ stop_id: REAL_STOP_IDS.foligno, stop_name: "FOLIGNO", customer_name: "NERI", pax_assigned: 8, hotel_pickup_time: "10:40" }),
    alloc({ stop_id: REAL_STOP_IDS.terni, stop_name: "TERNI", customer_name: "SARUBBI", pax_assigned: 3, hotel_pickup_time: "10:10" }),
    alloc({ stop_id: REAL_STOP_IDS.narni, stop_name: "NARNI", customer_name: "GIALLI", pax_assigned: 4, hotel_pickup_time: "09:30" }),
    alloc({ stop_id: REAL_STOP_IDS.terni, stop_name: "TERNI", customer_name: "MOSCA", pax_assigned: 2, hotel_pickup_time: "10:00" }),
    alloc({ stop_id: REAL_STOP_IDS.terni, stop_name: "TERNI", customer_name: "SILVERI", pax_assigned: 1, hotel_pickup_time: "10:10" }),
    alloc({ stop_id: REAL_STOP_IDS.terni, stop_name: "TERNI", customer_name: "ANGELUZZI", pax_assigned: 1, hotel_pickup_time: "09:50" }),
  ];
}

function countOccurrences(haystack: string, needle: string) {
  return haystack.split(needle).length - 1;
}

function buildRealCentro1Html() {
  return buildBusLinePdfHtml({
    direction: "departure",
    lineName: "Linea Centro",
    busLabel: "CENTRO1",
    dateIso: "2026-09-06",
    allocations: realCentro1Allocations(),
    stops: realCentroStops,
  });
}

describe("buildBusLinePdfHtml — PDF PARTENZE Linea Centro (caso reale CENTRO1 06/09/2026)", () => {
  it("1. ogni fermata compare in un solo blocco (una sola stop-row per città) nel corpo del manifest", () => {
    const html = buildRealCentro1Html();
    const bodyHtml = html.slice(0, html.indexOf("SCARICO"));
    for (const city of ["VALMONTONE", "ROMA TIBURTINA", "NARNI", "TERNI", "FOLIGNO", "PERUGIA"]) {
      const stopRowsForCity = bodyHtml.split("stop-row").filter((chunk) => chunk.includes(city)).length;
      expect(stopRowsForCity, `${city} deve avere una sola stop-row`).toBe(1);
    }
  });

  it("2. TERNI resta un blocco unico da 18 pax (8 clienti, mai diviso)", () => {
    const html = buildRealCentro1Html();
    expect(countOccurrences(html, "<strong>TERNI</strong>")).toBe(1);
    for (const name of ["BATTISTELLI", "MASSARELLI", "FRANCA", "PALIY", "SARUBBI", "MOSCA", "SILVERI", "ANGELUZZI"]) {
      expect(html).toContain(name);
    }
  });

  it("3. ROMA (TIBURTINA) resta un blocco unico da 9 pax", () => {
    const html = buildRealCentro1Html();
    expect(countOccurrences(html, "<strong>ROMA TIBURTINA</strong>")).toBe(1);
  });

  it("4. PERUGIA resta un blocco unico da 9 pax", () => {
    const html = buildRealCentro1Html();
    expect(countOccurrences(html, "<strong>PERUGIA</strong>")).toBe(1);
  });

  it("5. FOLIGNO resta un blocco unico da 8 pax", () => {
    const html = buildRealCentro1Html();
    expect(countOccurrences(html, "<strong>FOLIGNO</strong>")).toBe(1);
  });

  it("6. VALMONTONE resta un blocco unico da 6 pax", () => {
    const html = buildRealCentro1Html();
    expect(countOccurrences(html, "<strong>VALMONTONE</strong>")).toBe(1);
  });

  it("7. NARNI resta un blocco unico da 4 pax", () => {
    const html = buildRealCentro1Html();
    expect(countOccurrences(html, "<strong>NARNI</strong>")).toBe(1);
  });

  it("8. il totale passeggeri è 54 (18+9+9+8+6+4), i conteggi non cambiano", () => {
    const html = buildRealCentro1Html();
    expect(html).toContain("Totale passeggeri: <strong>54</strong>");
    expect(html).toContain('<td class="value">54</td>');
  });

  it("9. l'ordine del corpo del manifest segue esattamente tenant_bus_line_stops.stop_order (VALMONTONE, ROMA TIBURTINA, NARNI, TERNI, FOLIGNO, PERUGIA)", () => {
    const html = buildRealCentro1Html();
    const bodyOrder = ["VALMONTONE", "ROMA TIBURTINA", "NARNI", "TERNI", "FOLIGNO", "PERUGIA"]
      .map((city) => html.indexOf(`<strong>${city}</strong>`));
    expect(bodyOrder.every((i) => i > -1)).toBe(true);
    expect(bodyOrder).toEqual([...bodyOrder].sort((a, b) => a - b));
  });

  it("10. l'ordine dello SCARICO è identico all'ordine del corpo (nessun secondo sort indipendente)", () => {
    const html = buildRealCentro1Html();
    const scaricoSection = html.slice(html.indexOf("SCARICO"));
    const scaricoOrder = ["VALMONTONE", "ROMA TIBURTINA", "NARNI", "TERNI", "FOLIGNO", "PERUGIA"]
      .map((city) => scaricoSection.indexOf(city));
    expect(scaricoOrder.every((i) => i > -1)).toBe(true);
    expect(scaricoOrder).toEqual([...scaricoOrder].sort((a, b) => a - b));

    // Ogni riga SCARICO riporta il pax totale corretto per fermata.
    expect(scaricoSection).toContain("6 pax"); // VALMONTONE
    expect(scaricoSection).toContain("9 pax"); // ROMA TIBURTINA / PERUGIA
    expect(scaricoSection).toContain("4 pax"); // NARNI
    expect(scaricoSection).toContain("18 pax"); // TERNI
    expect(scaricoSection).toContain("8 pax"); // FOLIGNO
  });

  it("11. clienti con orari di pickup diversi (10:10, 10:00, 09:50, null) sulla stessa fermata NON creano nuovi blocchi", () => {
    const html = buildRealCentro1Html();
    // I clienti TERNI hanno orari 10:10 (BATTISTELLI, SARUBBI, SILVERI),
    // 10:00 (MASSARELLI, MOSCA), 09:50 (FRANCA, ANGELUZZI) e null (PALIY):
    // tutti devono restare sotto un'unica stop-row TERNI.
    expect(countOccurrences(html, "<strong>TERNI</strong>")).toBe(1);
    const terniBlockStart = html.indexOf("<strong>TERNI</strong>");
    const nextStopRowStart = html.indexOf("stop-row", terniBlockStart + 1);
    const terniBlock = nextStopRowStart > -1 ? html.slice(terniBlockStart, nextStopRowStart) : html.slice(terniBlockStart);
    for (const name of ["BATTISTELLI", "SARUBBI", "SILVERI", "MASSARELLI", "MOSCA", "FRANCA", "ANGELUZZI", "PALIY"]) {
      expect(terniBlock, `${name} deve essere nel blocco TERNI`).toContain(name);
    }
  });
});

describe("buildBusLinePdfHtml — PARTENZE: fermate senza stop_id valido", () => {
  it("stop_id nullo o non presente nel catalogo -> blocco finale 'FERMATA DA VERIFICARE', mai posizione forzata, pax mai persi", () => {
    const html = buildBusLinePdfHtml({
      direction: "departure",
      lineName: "Linea Centro",
      busLabel: "CENTRO1",
      dateIso: "2026-09-06",
      allocations: [
        alloc({ stop_id: REAL_STOP_IDS.terni, stop_name: "TERNI", customer_name: "BATTISTELLI", pax_assigned: 18 }),
        alloc({ stop_id: null, stop_name: "FERMATA SCONOSCIUTA", customer_name: "MISTERO", pax_assigned: 3 }),
        alloc({ stop_id: "id-non-in-catalogo", stop_name: "ALTRA IGNOTA", customer_name: "BOH", pax_assigned: 2 }),
      ],
      stops: [{ id: REAL_STOP_IDS.terni, stop_name: "TERNI", pickup_note: "Terminal Bus Atc", pickup_time: null, stop_order: 7 }],
    });
    expect(html).toContain("FERMATA DA VERIFICARE");
    expect(html).toContain("MISTERO");
    expect(html).toContain("BOH");
    expect(html).toContain("Totale passeggeri: <strong>23</strong>");
    // Il blocco di verifica è sempre l'ultimo, dopo TERNI.
    const terniIndex = html.indexOf("<strong>TERNI</strong>");
    const verifyIndex = html.indexOf("FERMATA DA VERIFICARE");
    expect(verifyIndex).toBeGreaterThan(terniIndex);
  });
});

describe("buildBusLinePdfHtml — PARTENZE: pickup hotel", () => {
  it("PDF mostra il pickup quando hotel_pickup_time esiste nella view/API", () => {
    const html = buildBusLinePdfHtml({
      direction: "departure",
      lineName: "Linea Centro",
      busLabel: "CENTRO1",
      dateIso: "2026-09-06",
      allocations: [
        alloc({
          stop_id: REAL_STOP_IDS.terni,
          stop_name: "TERNI",
          stop_pickup_note: "Terminal Bus Atc",
          customer_name: "FRANCA",
          hotel_name: "HOTEL TERME FELIX",
          hotel_pickup_time: "10:10:00",
          pax_assigned: 2,
        }),
      ],
      stops: [{ id: REAL_STOP_IDS.terni, stop_name: "TERNI", pickup_note: "Terminal Bus Atc", pickup_time: null, stop_order: 7 }],
    });

    expect(html).toContain("<td class=\"\">10:10</td>");
    expect(html).toContain("HOTEL TERME FELIX");
  });

  it("PDF non inventa pickup quando hotel_pickup_time e stop_pickup_time non esistono", () => {
    const html = buildBusLinePdfHtml({
      direction: "departure",
      lineName: "Linea Centro",
      busLabel: "CENTRO1",
      dateIso: "2026-09-06",
      allocations: [
        alloc({
          stop_id: REAL_STOP_IDS.terni,
          stop_name: "TERNI",
          stop_pickup_note: "Terminal Bus Atc",
          customer_name: "ANGELUZZI",
          hotel_name: "SOLEMARE",
          hotel_pickup_time: null,
          stop_pickup_time: null,
          pax_assigned: 2,
        }),
      ],
      stops: [{ id: REAL_STOP_IDS.terni, stop_name: "TERNI", pickup_note: "Terminal Bus Atc", pickup_time: null, stop_order: 7 }],
    });

    expect(html).toContain("<td class=\"\"></td><td class=\"\">SOLEMARE</td>");
    expect(html).not.toContain("09:50");
    expect(html).not.toContain("10:00");
    expect(html).not.toContain("10:10");
  });
});
