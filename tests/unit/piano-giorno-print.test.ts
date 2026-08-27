import { describe, expect, it } from "vitest";
import {
  buildPrintSections,
  buildShuttlePrintGroups,
  cleanPrintNote,
  resolveOperationalPickup,
  transportReference,
  type PrintService,
} from "@/lib/piano-giorno-print";

const DATE = "2026-08-27";

function service(overrides: Partial<PrintService> = {}): PrintService {
  return {
    id: "svc-1",
    tenant_id: "tenant-1",
    date: DATE,
    time: "17:00",
    direction: "departure",
    customer_name: "ROSSI MARIO",
    customer_first_name: null,
    customer_last_name: null,
    pax: 2,
    hotel_id: "hotel-1",
    vessel: "MEDMAR Napoli 17:00",
    phone: "333111222",
    notes: "",
    status: "new",
    service_type: "transfer",
    booking_service_kind: "formula_medmar_napoli",
    service_type_code: null,
    pickup_hotel: "14:20",
    pickup_time: null,
    arrival_time: "15:50",
    departure_time: "17:00",
    orario_barca: "16:00",
    barca_compagnia: "Ischia Porto",
    porto_bruno: null,
    meeting_point: "Ischia Porto",
    ferry_details: {},
    ...overrides,
  };
}

const hotel = { id: "hotel-1", tenant_id: "tenant-1", name: "LA VILLA", address: "", zone: "Forio" as const, lat: null, lng: null };

function runSections(services: PrintService[], hotels: Map<string, typeof hotel> = new Map([[hotel.id, hotel]])) {
  return buildPrintSections({
    services,
    date: DATE,
    hotels,
    agencies: new Map(),
    assignments: [],
    tripGroups: [],
    members: new Map(),
  });
}

describe("piano-giorno print — regole ARRIVO", () => {
  it("ARRIVO non legge mai orario_barca ne' barca_compagnia (possono appartenere al rientro)", () => {
    const sections = runSections([
      service({
        id: "arr",
        direction: "arrival",
        arrival_date: DATE,
        arrival_time: "10:10",
        vessel: "MEDMAR Napoli 08:40",
        orario_barca: "17:00", // gamba di rientro futuro, come MEROLA/DI BERNARDO reali
        barca_compagnia: "Ischia Porto",
      }),
    ]);
    const row = sections.ARRIVO[0]!;
    expect(row.ferryOrTransportTime).not.toBe("17:00");
    expect(row.ferryOrTransportTime).toBe("08:40");
    expect(row.companyOrVehicle).not.toBe("Ischia Porto");
  });

  it("MEROLA: arrivo 10:10, non stampa 17:00 come ora nave", () => {
    const sections = runSections([
      service({
        id: "merola",
        direction: "arrival",
        customer_first_name: "GIANLUCA",
        customer_last_name: "MEROLA",
        arrival_date: DATE,
        arrival_time: "10:10",
        vessel: "MEDMAR Napoli 08:40",
        orario_barca: "17:00",
        barca_compagnia: "Ischia Porto",
        departure_date: "2026-08-30",
        departure_time: "15:15",
      }),
    ]);
    const row = sections.ARRIVO[0]!;
    expect(row.time).toBe("10:10");
    expect(row.ferryOrTransportTime).toBe("08:40");
    expect(row.ferryOrTransportTime).not.toBe("17:00");
    expect(row.companyOrVehicle).toBe("MEDMAR");
  });

  it("DI BERNARDO: arrivo 10:45, non stampa 15:00 come ora nave", () => {
    const sections = runSections([
      service({
        id: "dibernardo",
        direction: "arrival",
        customer_first_name: "NUNZIA",
        customer_last_name: "DI BERNARDO",
        arrival_date: DATE,
        arrival_time: "10:45",
        vessel: "MEDMAR Pozzuoli 09:40",
        orario_barca: "15:00",
        barca_compagnia: "Ischia Porto",
        departure_date: "2026-08-30",
        departure_time: "13:15",
        booking_service_kind: "formula_medmar_pozzuoli",
      }),
    ]);
    const row = sections.ARRIVO[0]!;
    expect(row.time).toBe("10:45");
    expect(row.ferryOrTransportTime).toBe("09:40");
    expect(row.ferryOrTransportTime).not.toBe("15:00");
  });

  it("DI FIORE: arrivo 10:10, porto Ischia Porto, compagnia MEDMAR, ora nave 08:40", () => {
    const sections = runSections([
      service({
        id: "difiore",
        direction: "arrival",
        customer_first_name: "FRANCESCO SAVERIO",
        customer_last_name: "DI FIORE",
        arrival_date: DATE,
        arrival_time: "10:10",
        vessel: "MEDMAR Napoli 08:40",
        meeting_point: "Ischia Porto",
        orario_barca: null,
        barca_compagnia: null,
      }),
    ]);
    const row = sections.ARRIVO[0]!;
    expect(row.time).toBe("10:10");
    expect(row.portOrOrigin).toBe("Ischia Porto");
    expect(row.companyOrVehicle).toBe("MEDMAR");
    expect(row.ferryOrTransportTime).toBe("08:40");
  });

  it("NIKOLAENKO: transfer aeroporto, riferimento e' il volo, mai testo ferry", () => {
    const sections = runSections([
      service({
        id: "nikolaenko",
        direction: "arrival",
        customer_first_name: "MR. NIKOLAENKO",
        customer_last_name: "WJATSCHESLAW",
        booking_service_kind: "transfer_airport_hotel",
        vessel: "Volo LH 334",
        transport_code: "LH 334",
        arrival_date: DATE,
        arrival_time: "12:30",
        orario_barca: null,
        barca_compagnia: null,
      }),
    ]);
    const row = sections.ARRIVO[0]!;
    expect(row.reference).toBe("LH 334");
    expect(row.reference).not.toMatch(/MEDMAR|SNAV/i);
    expect(row.ferryOrTransportTime).toBe("12:30");
  });
});

describe("piano-giorno print — regole PARTENZA", () => {
  it("pickup da resolveOperationalPickup, mai da service.time o departure_time", () => {
    const result = resolveOperationalPickup(service({ pickup_hotel: null, pickup_time: null, time: "11:10", departure_time: "11:10" }));
    expect(result.value).toBe("⚠ PICKUP DA VERIFICARE");
    expect(result.value).not.toBe("11:10");
  });

  it("usa pickup_hotel prima di pickup_time", () => {
    expect(resolveOperationalPickup(service({ pickup_hotel: "09:15", pickup_time: "09:30" })).value).toBe("09:15");
    expect(resolveOperationalPickup(service({ pickup_hotel: null, pickup_time: "09:30" })).value).toBe("09:30");
  });

  it("compagnia da booking_service_kind, mai da barca_compagnia (porto storico)", () => {
    const sections = runSections([
      service({ id: "dep", departure_date: DATE, barca_compagnia: "Casamicciola", vessel: "SNAV 17:40", booking_service_kind: "formula_snav" }),
    ]);
    const row = sections.PARTENZA[0]!;
    expect(row.companyOrVehicle).toBe("SNAV");
    expect(row.companyOrVehicle).not.toBe("Casamicciola");
    expect(row.companyOrVehicle).not.toBe("Ischia Porto");
  });

  it("destinazione ferry pulita: mai 'MEDMAR Napoli 17:00' o 'SNAV 17:40', solo il nome citta'", () => {
    const medmar = runSections([service({ id: "m", departure_date: DATE, vessel: "MEDMAR Napoli 17:00", booking_service_kind: "formula_medmar_napoli" })]).PARTENZA[0]!;
    expect(medmar.destination).toBe("Napoli");
    expect(medmar.destination).not.toContain("MEDMAR");

    const snav = runSections([service({ id: "s", departure_date: DATE, vessel: "SNAV 17:40", booking_service_kind: "formula_snav" })]).PARTENZA[0]!;
    expect(snav.destination).toBe("Napoli");
    expect(snav.destination).not.toContain("SNAV");

    const pozzuoli = runSections([service({ id: "p", departure_date: DATE, vessel: "MEDMAR Pozzuoli 11:10", booking_service_kind: "formula_medmar_pozzuoli" })]).PARTENZA[0]!;
    expect(pozzuoli.destination).toBe("Pozzuoli");
  });

  it("porto partenza: barca_compagnia reinterpretato come porto storico solo per PARTENZA, poi meeting_point, poi '-'", () => {
    const withBarcaCompagnia = runSections([service({ id: "a", departure_date: DATE, barca_compagnia: "Ischia Porto", meeting_point: null })]).PARTENZA[0]!;
    expect(withBarcaCompagnia.departurePort).toBe("Ischia Porto");

    const withMeetingPointOnly = runSections([service({ id: "b", departure_date: DATE, barca_compagnia: null, meeting_point: "Casamicciola" })]).PARTENZA[0]!;
    expect(withMeetingPointOnly.departurePort).toBe("Casamicciola");

    const withNeither = runSections([service({ id: "c", departure_date: DATE, barca_compagnia: null, meeting_point: null })]).PARTENZA[0]!;
    expect(withNeither.departurePort).toBe("-");
  });

  it("ora nave partenza usa orario_barca", () => {
    const row = runSections([service({ id: "d", departure_date: DATE, orario_barca: "17:00" })]).PARTENZA[0]!;
    expect(row.ferryOrTransportTime).toBe("17:00");
  });
});

describe("piano-giorno print — RIF. TRENO/VOLO", () => {
  it("mai MEDMAR/SNAV/ferry, solo per kind treno/aeroporto con codice reale", () => {
    expect(transportReference(service({ booking_service_kind: "formula_medmar_napoli", transport_code: null, vessel: "MEDMAR Napoli 17:00" }))).toBe("-");
    expect(transportReference(service({ booking_service_kind: "formula_snav", transport_code: null, vessel: "SNAV 17:40" }))).toBe("-");
  });

  it("placeholder 'TRENO' senza numero reale -> '-' (BIRAGO/SUORATO)", () => {
    expect(transportReference(service({ booking_service_kind: "transfer_train_hotel", transport_code: "TRENO", train_arrival_number: null, train_departure_number: null }))).toBe("-");
  });

  it("codice reale con numero -> mostrato (volo NIKOLAENKO)", () => {
    expect(transportReference(service({ booking_service_kind: "transfer_airport_hotel", transport_code: "LH 334" }))).toBe("LH 334");
  });
});

describe("piano-giorno print — note", () => {
  it("rimuove note tecniche e marker import", () => {
    expect(cleanPrintNote("[pdf_import] row 4\nImport operational_v2 riga 12\nNota cliente")).toBe("Nota cliente");
  });

  it("protezione legacy: filtra il pax breakdown Formula MEDMAR/SNAV autogenerato nei record non bonificati", () => {
    expect(cleanPrintNote("Formula MEDMAR - Infant 0-4: 0; Bambini 4-12: 0; Adulti 12+: 3.")).toBe("");
    expect(cleanPrintNote("Formula SNAV - Infant 0-4: 1; Bambini 4-12: 0; Adulti 12+: 2.")).toBe("");
    expect(cleanPrintNote("Infant 0-1,99 anni: 2 (quota fissa EUR 2.50 cad.)")).toBe("");
    expect(cleanPrintNote("Animali piccola taglia max 10 kg: 1. Biglietto animale a cura del cliente in biglietteria.")).toBe("");
  });

  it("protezione legacy: preserva la nota libera anche se accanto al breakdown autogenerato", () => {
    expect(cleanPrintNote("Formula MEDMAR - Infant 0-4: 0; Bambini 4-12: 0; Adulti 12+: 3.\nCliente su sedia a rotelle")).toBe("Cliente su sedia a rotelle");
  });

  it("stampa: nessuna riga contiene testo Formula/Infant/Bambini/Adulti anche con notes DB contaminate", () => {
    const sections = runSections([
      service({ id: "a", direction: "arrival", arrival_date: DATE, notes: "Formula MEDMAR - Infant 0-4: 0; Bambini 4-12: 0; Adulti 12+: 2." }),
      service({ id: "b", departure_date: DATE, notes: "Formula SNAV - Infant 0-4: 0; Bambini 4-12: 0; Adulti 12+: 2." }),
    ]);
    for (const row of [...sections.ARRIVO, ...sections.PARTENZA]) {
      expect(row.notes).not.toMatch(/Formula|Infant|Bambini|Adulti/i);
    }
  });
});

describe("piano-giorno print — sezioni e unicita'", () => {
  it("navette e escursioni sono sezioni separate e non finiscono in arrivi/partenze", () => {
    const sections = runSections([
      service({ id: "nav", booking_service_kind: "navetta", direction: "arrival" }),
      service({ id: "exc", booking_service_kind: "excursion", service_type: "bus_tour" }),
    ]);
    expect(sections.NAVETTA).toHaveLength(1);
    expect(sections.ESCURSIONE).toHaveLength(1);
    expect(sections.ARRIVO).toHaveLength(0);
    expect(sections.PARTENZA).toHaveLength(0);
  });

  it("ogni service.id compare una sola volta in tutto l'output", () => {
    const services = [
      service({ id: "dup", direction: "arrival", arrival_date: DATE }),
      service({ id: "dup", direction: "arrival", arrival_date: DATE }),
      service({ id: "b", departure_date: DATE }),
    ];
    const sections = runSections(services);
    const allIds = [...sections.ARRIVO, ...sections.PARTENZA, ...sections.NAVETTA, ...sections.ESCURSIONE].map((r) => r.serviceId);
    expect(allIds.length).toBe(new Set(allIds).size);
    expect(allIds.filter((id) => id === "dup")).toHaveLength(1);
  });
});

describe("piano-giorno print — navette raggruppate per struttura (hotel_id)", () => {
  const hotels = new Map([
    ["h-president", { name: "HOTEL TERME PRESIDENT", zone: "Ischia Porto" }],
    ["h-cristallo", { name: "HOTEL CRISTALLO", zone: "Casamicciola" }],
    ["h-sannicola", { name: "HOTEL SAN NICOLA", zone: "Forio" }],
  ]);

  it("raggruppa per hotel_id (non customer_name): CITARA finisce sotto SAN NICOLA, non in gruppo separato", () => {
    const services = [
      service({ id: "p1", hotel_id: "h-president", customer_name: "Hotel President", time: "08:30", booking_service_kind: "navetta" }),
      service({ id: "c1", hotel_id: "h-cristallo", customer_name: "Hotel Cristallo", time: "09:30", booking_service_kind: "navetta" }),
      service({ id: "sn1", hotel_id: "h-sannicola", customer_name: "Hotel San Nicola", time: "09:30", booking_service_kind: "navetta" }),
      service({ id: "citara1", hotel_id: "h-sannicola", customer_name: "CITARA", meeting_point: "CITARA", time: "18:30", booking_service_kind: "navetta" }),
    ];
    const groups = buildShuttlePrintGroups({
      services,
      hotels,
      assignments: [],
      tripGroups: new Map(),
      members: new Map(),
    });

    const keys = groups.map((g) => g.key);
    expect(keys).toEqual(["PRESIDENT", "CRISTALLO", "SAN NICOLA"]);
    expect(keys).not.toContain("CITARA");

    const sanNicola = groups.find((g) => g.key === "SAN NICOLA")!;
    expect(sanNicola.rows.map((r) => r.serviceId)).toEqual(expect.arrayContaining(["sn1", "citara1"]));
    expect(sanNicola.rows).toHaveLength(2);
  });

  it("39 navette reali: PRESIDENT 27, CRISTALLO 6, SAN NICOLA 6 (incluse le 3 CITARA)", () => {
    const services = [
      ...Array.from({ length: 27 }, (_, i) => service({ id: `pres-${i}`, hotel_id: "h-president", time: `0${8 + (i % 9)}:00`, booking_service_kind: "navetta" })),
      ...Array.from({ length: 6 }, (_, i) => service({ id: `cris-${i}`, hotel_id: "h-cristallo", time: `1${i}:00`, booking_service_kind: "navetta" })),
      ...Array.from({ length: 3 }, (_, i) => service({ id: `sn-${i}`, hotel_id: "h-sannicola", time: `0${9 + i}:00`, booking_service_kind: "navetta" })),
      ...Array.from({ length: 3 }, (_, i) => service({ id: `citara-${i}`, hotel_id: "h-sannicola", meeting_point: "CITARA", time: `18:${10 + i}`, booking_service_kind: "navetta" })),
    ];
    const groups = buildShuttlePrintGroups({ services, hotels, assignments: [], tripGroups: new Map(), members: new Map() });
    const byKey = Object.fromEntries(groups.map((g) => [g.key, g.rows.length]));
    expect(byKey.PRESIDENT).toBe(27);
    expect(byKey.CRISTALLO).toBe(6);
    expect(byKey["SAN NICOLA"]).toBe(6);
  });

  it("ordine cronologico dentro ogni gruppo", () => {
    const services = [
      service({ id: "late", hotel_id: "h-president", time: "19:00", booking_service_kind: "navetta" }),
      service({ id: "early", hotel_id: "h-president", time: "08:30", booking_service_kind: "navetta" }),
    ];
    const groups = buildShuttlePrintGroups({ services, hotels, assignments: [], tripGroups: new Map(), members: new Map() });
    const president = groups.find((g) => g.key === "PRESIDENT")!;
    expect(president.rows.map((r) => r.serviceId)).toEqual(["early", "late"]);
  });

  it("hotel non riconosciuto finisce in ALTRE, mai scartato silenziosamente", () => {
    const services = [service({ id: "unknown", hotel_id: "h-altro", time: "10:00", booking_service_kind: "navetta" })];
    const groups = buildShuttlePrintGroups({
      services,
      hotels: new Map([["h-altro", { name: "HOTEL SCONOSCIUTO", zone: null }]]),
      assignments: [],
      tripGroups: new Map(),
      members: new Map(),
    });
    const allIds = groups.flatMap((g) => g.rows.map((r) => r.serviceId));
    expect(allIds).toContain("unknown");
  });
});
