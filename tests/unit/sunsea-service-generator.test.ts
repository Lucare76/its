import { describe, expect, it } from "vitest";
import { parseMtsGlobeRows } from "@/lib/server/agency-imports/mts-globe-parser";
import { generateSunSeaServices, type ResolvedHotelForLeg } from "@/lib/server/agency-imports/sunsea-service-generator";

function baseRow(overrides: Record<string, unknown> = {}) {
  return {
    "Voucher No": "1000001",
    "Grouping Id": "9000001",
    "Start Date": "30.08.2026",
    "Service Base Code": "Arrivi",
    "Flight": "W43428",
    "Dep Airport": "DUS",
    "Dep Time": "06:40:00",
    "Arr Airport": "NAP",
    "Arr Time": "08:50:00",
    "Pick-Up": "DUS-NAP W43428 06:40-08:50",
    "Drop-Off": "AMTSIT1JQK - Hotel Terme Royal Palm",
    "Resort": "Forio d Ischia",
    "Provider Name": "SUN AND SEA SRLS",
    "Lead Pax": "Mr. Rossi, Mario",
    "Adults": "2",
    "Children": "0",
    "Infants": "0",
    "Service Unit": "Shared",
    "Cost SCY": "78.40",
    ...overrides
  };
}

const MATCHED_HOTEL_ID = "11111111-1111-1111-1111-111111111111";
const MATCHED_HOTEL_ID_2 = "22222222-2222-2222-2222-222222222222";

describe("generateSunSeaServices", () => {
  it("Voucher solo Arrivi genera esattamente 1 servizio transfer_airport_hotel arrival", () => {
    const { bookings } = parseMtsGlobeRows([baseRow({ "Voucher No": "V1" })]);
    const resolved: ResolvedHotelForLeg[] = [{ legRowIndex: bookings[0].legs[0].rowIndex, hotelId: MATCHED_HOTEL_ID, matchConfidence: "matched" }];
    const services = generateSunSeaServices(bookings[0], resolved);
    expect(services).toHaveLength(1);
    expect(services[0].bookingServiceKind).toBe("transfer_airport_hotel");
    expect(services[0].direction).toBe("arrival");
    expect(services[0].hotelId).toBe(MATCHED_HOTEL_ID);
    expect(services[0].warnings).toHaveLength(0);
  });

  it("Voucher con Arrivi+Partenza (A/R) genera esattamente 2 servizi, mai inventati", () => {
    const { bookings } = parseMtsGlobeRows([
      baseRow({ "Voucher No": "V2", "Service Base Code": "Arrivi" }),
      baseRow({
        "Voucher No": "V2",
        "Service Base Code": "Partenza",
        "Start Date": "06.09.2026",
        "Pick-Up": "AMTSIT1JQK - Hotel Terme Royal Palm",
        "Drop-Off": "NAP-DUS W43429 10:10-12:25"
      })
    ]);
    const resolved: ResolvedHotelForLeg[] = bookings[0].legs.map((leg) => ({
      legRowIndex: leg.rowIndex,
      hotelId: MATCHED_HOTEL_ID,
      matchConfidence: "matched" as const
    }));
    const services = generateSunSeaServices(bookings[0], resolved);
    expect(services).toHaveLength(2);
    expect(services.map((s) => s.direction).sort()).toEqual(["arrival", "departure"]);
  });

  it("Voucher solo Partenza (equivalente a SOLO RIENTRO) genera solo il servizio di rientro, mai l'andata", () => {
    const { bookings } = parseMtsGlobeRows([
      baseRow({
        "Voucher No": "V3",
        "Service Base Code": "Partenza",
        "Pick-Up": "AMTSIT1JQK - Hotel Terme Royal Palm",
        "Drop-Off": "NAP-DUS W43429 10:10-12:25"
      })
    ]);
    const resolved: ResolvedHotelForLeg[] = [{ legRowIndex: bookings[0].legs[0].rowIndex, hotelId: MATCHED_HOTEL_ID, matchConfidence: "matched" }];
    const services = generateSunSeaServices(bookings[0], resolved);
    expect(services).toHaveLength(1);
    expect(services[0].direction).toBe("departure");
  });

  it("riga Intermedio genera 1 servizio transfer_hotel_hotel con hotelId e hotelToId distinti", () => {
    const { bookings } = parseMtsGlobeRows([
      baseRow({
        "Voucher No": "V4",
        "Service Base Code": "Intermedio",
        "Pick-Up": "AMTSIT1JQK - Hotel Terme Royal Palm",
        "Drop-Off": "AITNAPKI08 - Best Western Plus Hotel Plaza Napoli"
      })
    ]);
    const legRowIndex = bookings[0].legs[0].rowIndex;
    const resolved: ResolvedHotelForLeg[] = [
      { legRowIndex, hotelId: MATCHED_HOTEL_ID, matchConfidence: "matched" },
      { legRowIndex: -legRowIndex, hotelId: MATCHED_HOTEL_ID_2, matchConfidence: "matched" }
    ];
    const services = generateSunSeaServices(bookings[0], resolved);
    expect(services).toHaveLength(1);
    expect(services[0].bookingServiceKind).toBe("transfer_hotel_hotel");
    expect(services[0].hotelId).toBe(MATCHED_HOTEL_ID);
    expect(services[0].hotelToId).toBe(MATCHED_HOTEL_ID_2);
  });

  it("hotel non riconosciuto produce warning e hotelId null, senza bloccare la generazione", () => {
    const { bookings } = parseMtsGlobeRows([baseRow({ "Voucher No": "V5" })]);
    const resolved: ResolvedHotelForLeg[] = [{ legRowIndex: bookings[0].legs[0].rowIndex, hotelId: null, matchConfidence: "unmatched" }];
    const services = generateSunSeaServices(bookings[0], resolved);
    expect(services[0].hotelId).toBeNull();
    expect(services[0].warnings.length).toBeGreaterThan(0);
  });

  it("Intermedio senza Dep/Arr Time in riga: time vuoto (mai '00:00' inventato) e warning esplicito", () => {
    const { bookings } = parseMtsGlobeRows([
      baseRow({
        "Voucher No": "V6",
        "Service Base Code": "Intermedio",
        "Flight": " ",
        "Dep Airport": " ",
        "Dep Time": " ",
        "Arr Airport": " ",
        "Arr Time": " ",
        "Pick-Up": "AMTSIT1JQK - Hotel Terme Royal Palm",
        "Drop-Off": "AITNAPKI08 - Best Western Plus Hotel Plaza Napoli"
      })
    ]);
    const legRowIndex = bookings[0].legs[0].rowIndex;
    const resolved: ResolvedHotelForLeg[] = [
      { legRowIndex, hotelId: MATCHED_HOTEL_ID, matchConfidence: "matched" },
      { legRowIndex: -legRowIndex, hotelId: MATCHED_HOTEL_ID_2, matchConfidence: "matched" }
    ];
    const services = generateSunSeaServices(bookings[0], resolved);
    expect(services[0].time).toBe("");
    expect(services[0].time).not.toBe("00:00");
    expect(services[0].warnings).toContain("Orario transfer Intermedio mancante.");
  });

  it("Intermedio con Dep Time reale in riga: lo usa come time, nessun warning orario", () => {
    const { bookings } = parseMtsGlobeRows([
      baseRow({
        "Voucher No": "V7",
        "Service Base Code": "Intermedio",
        "Pick-Up": "AMTSIT1JQK - Hotel Terme Royal Palm",
        "Drop-Off": "AITNAPKI08 - Best Western Plus Hotel Plaza Napoli",
        "Dep Time": "09:15:00"
      })
    ]);
    const legRowIndex = bookings[0].legs[0].rowIndex;
    const resolved: ResolvedHotelForLeg[] = [
      { legRowIndex, hotelId: MATCHED_HOTEL_ID, matchConfidence: "matched" },
      { legRowIndex: -legRowIndex, hotelId: MATCHED_HOTEL_ID_2, matchConfidence: "matched" }
    ];
    const services = generateSunSeaServices(bookings[0], resolved);
    expect(services[0].time).toBe("09:15");
    expect(services[0].warnings).not.toContain("Orario transfer Intermedio mancante.");
  });
});
