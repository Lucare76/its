import { describe, expect, it } from "vitest";
import { parseMtsGlobeRows } from "@/lib/server/agency-imports/mts-globe-parser";

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

describe("parseMtsGlobeRows", () => {
  it("gruppa due righe con lo stesso Voucher No (arrivo+partenza) in un solo booking round_trip", () => {
    const rows = [
      baseRow({ "Voucher No": "V1", "Service Base Code": "Arrivi", "Start Date": "30.08.2026" }),
      baseRow({
        "Voucher No": "V1",
        "Service Base Code": "Partenza",
        "Start Date": "06.09.2026",
        "Pick-Up": "AMTSIT1JQK - Hotel Terme Royal Palm",
        "Drop-Off": "NAP-DUS W43429 10:10-12:25"
      })
    ];
    const result = parseMtsGlobeRows(rows);
    expect(result.errors).toHaveLength(0);
    expect(result.bookings).toHaveLength(1);
    expect(result.bookings[0].legs).toHaveLength(2);
    expect(result.bookings[0].serviceScope).toBe("round_trip");
  });

  it("Voucher con solo Arrivi produce booking outbound_only con 1 leg", () => {
    const rows = [baseRow({ "Voucher No": "V2", "Service Base Code": "Arrivi" })];
    const result = parseMtsGlobeRows(rows);
    expect(result.bookings[0].serviceScope).toBe("outbound_only");
    expect(result.bookings[0].legs).toHaveLength(1);
  });

  it("Voucher con solo Partenza produce booking return_only", () => {
    const rows = [
      baseRow({
        "Voucher No": "V3",
        "Service Base Code": "Partenza",
        "Pick-Up": "AMTSIT1JQK - Hotel Terme Royal Palm",
        "Drop-Off": "NAP-DUS W43429 10:10-12:25"
      })
    ];
    const result = parseMtsGlobeRows(rows);
    expect(result.bookings[0].serviceScope).toBe("return_only");
    expect(result.bookings[0].legs[0].legType).toBe("departure");
  });

  it("riga Intermedio genera leg hotel_change con hotel origine e destinazione", () => {
    const rows = [
      baseRow({
        "Voucher No": "V4",
        "Service Base Code": "Intermedio",
        "Flight": " ",
        "Dep Airport": " ",
        "Dep Time": " ",
        "Arr Airport": " ",
        "Arr Time": " ",
        "Pick-Up": "AMTSIT1JQK - Hotel Terme Royal Palm",
        "Drop-Off": "AITNAPKI08 - Best Western Plus Hotel Plaza Napoli"
      })
    ];
    const result = parseMtsGlobeRows(rows);
    expect(result.errors).toHaveLength(0);
    const leg = result.bookings[0].legs[0];
    expect(leg.legType).toBe("hotel_change");
    expect(leg.hotelFromRaw).toBe("Hotel Terme Royal Palm");
    expect(leg.hotelToRaw).toBe("Best Western Plus Hotel Plaza Napoli");
  });

  it("hotel con nome semplice (senza codice-trattino) viene comunque estratto", () => {
    const rows = [baseRow({ "Voucher No": "V5", "Drop-Off": "Park Imperial Terme" })];
    const result = parseMtsGlobeRows(rows);
    expect(result.bookings[0].legs[0].hotelNameRaw).toBe("Park Imperial Terme");
  });

  it("più pax (adults+children) sommati correttamente", () => {
    const rows = [baseRow({ "Voucher No": "V6", "Adults": "3", "Children": "1", "Infants": "0" })];
    const result = parseMtsGlobeRows(rows);
    expect(result.bookings[0].pax).toBe(4);
  });

  it("riga con Voucher No mancante va in errore, non genera booking", () => {
    const rows = [baseRow({ "Voucher No": "" })];
    const result = parseMtsGlobeRows(rows);
    expect(result.bookings).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toMatch(/Voucher No mancante/);
  });

  it("data non valida genera errore riga", () => {
    const rows = [baseRow({ "Voucher No": "V7", "Start Date": "31.13.2026" })];
    const result = parseMtsGlobeRows(rows);
    expect(result.errors[0].message).toMatch(/Data non valida/);
  });

  it("riga Arrivi incompleta (hotel mancante) genera errore, non booking", () => {
    const rows = [baseRow({ "Voucher No": "V8", "Drop-Off": "" })];
    const result = parseMtsGlobeRows(rows);
    expect(result.bookings).toHaveLength(0);
    expect(result.errors[0].message).toMatch(/hotel \(Drop-Off\) mancante/);
  });

  it("pax a zero genera errore, non booking", () => {
    const rows = [baseRow({ "Voucher No": "V9", "Adults": "0", "Children": "0", "Infants": "0" })];
    const result = parseMtsGlobeRows(rows);
    expect(result.bookings).toHaveLength(0);
    expect(result.errors[0].message).toMatch(/Pax non valido/);
  });

  it("tipo operazione sconosciuto genera errore", () => {
    const rows = [baseRow({ "Voucher No": "V10", "Service Base Code": "Escursione" })];
    const result = parseMtsGlobeRows(rows);
    expect(result.errors[0].message).toMatch(/Tipo operazione non riconosciuto/);
  });

  it("righe duplicate identiche nello stesso voucher vengono deduplicate", () => {
    const dupe = baseRow({
      "Voucher No": "V11",
      "Service Base Code": "Partenza",
      "Pick-Up": "AMTSIT1JP8 - Hermitage Resort",
      "Drop-Off": "NAP-TSR W43556 17:10-19:45"
    });
    const rows = [dupe, { ...dupe, "Grouping Id": "different-grouping-id" }];
    const result = parseMtsGlobeRows(rows);
    expect(result.bookings).toHaveLength(1);
    expect(result.bookings[0].legs).toHaveLength(1);
    expect(result.bookings[0].duplicateLegsSkipped).toBe(1);
  });

  it("titolo (Mr./Mrs./Frau.) viene rimosso dal nome cliente", () => {
    const rows = [baseRow({ "Voucher No": "V12", "Lead Pax": "Frau. Lambertz, Kristine" })];
    const result = parseMtsGlobeRows(rows);
    expect(result.bookings[0].customerName).toBe("Lambertz, Kristine");
  });
});
