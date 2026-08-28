import { describe, it, expect } from "vitest";
import {
  detectSnavHeader,
  missingRequiredFields,
  parseSnavRows,
  parseInviare,
  SNAV_REQUIRED_FIELDS,
} from "@/lib/snav-convocation-parse";

const CANONICAL_HEADER = ["INVIARE", "NUMERO CLIENTE", "NOME CLIENTE", "DATA PARTENZA", "HOTEL", "PAX", "ORA PRELEVAMENTO", "ORA NAVE"];

function sheet(rows: unknown[][]): unknown[][] {
  return rows;
}

describe("detectSnavHeader — canonical SNAV format", () => {
  it("maps every canonical column to a distinct index", () => {
    const res = detectSnavHeader(sheet([CANONICAL_HEADER, ["SI", "3334372831", "Luca", "30/08/2026", "Hotel Park Imperial", "3", "16:40", "17:40"]]));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const idxs = SNAV_REQUIRED_FIELDS.map((f) => res.colMap[f]);
    expect(new Set(idxs).size).toBe(SNAV_REQUIRED_FIELDS.length);
    expect(res.colMap.pickupTime).toBe(6);
    expect(res.colMap.vesselTime).toBe(7);
    expect(missingRequiredFields(res.colMap)).toEqual([]);
  });

  it("tolerates equivalent column names (synonyms) and case/space noise", () => {
    const header = ["  Invio ", "Telefono cliente", "Nominativo", "Data viaggio", "Struttura", "Passeggeri", "Pickup", "Orario aliscafo"];
    const res = detectSnavHeader(sheet([header, ["x", "3331112222", "Anna", "2026-08-30", "Hotel Rossi", "2", "10:00", "11:10"]]));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(missingRequiredFields(res.colMap)).toEqual([]);
    expect(res.colMap.pickupTime).not.toBe(res.colMap.vesselTime);
  });

  it("keeps 'ora prelevamento' and 'ora nave' on distinct columns", () => {
    const res = detectSnavHeader(sheet([["INVIARE", "TELEFONO", "CLIENTE", "DATA", "HOTEL", "PAX", "PRELEVAMENTO", "ORA ALISCAFO"], ["si", "339", "Bea", "01/09/2026", "H", "1", "08:00", "09:00"]]));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.colMap.pickupTime).toBe(6);
    expect(res.colMap.vesselTime).toBe(7);
  });

  it("finds the header even when it is not the first row (title + blank rows before it)", () => {
    const raw = sheet([
      ["CONVOCAZIONI SNAV — AGOSTO"],
      [],
      ["Aggiornato al 29/08"],
      CANONICAL_HEADER,
      ["SI", "3334372831", "Luca", "30/08/2026", "Hotel Park Imperial", "3", "16:40", "17:40"],
    ]);
    const res = detectSnavHeader(raw, 10);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.headerRowIndex).toBe(3);
  });

  it("fails when the header is beyond the first 10 rows", () => {
    const raw = sheet([...Array(11).fill(["nota"]), CANONICAL_HEADER, ["SI", "339", "X", "01/09/2026", "H", "1", "08:00", "09:00"]]);
    expect(detectSnavHeader(raw, 10).ok).toBe(false);
  });

  it("is position-independent (columns in any order)", () => {
    const header = ["ORA NAVE", "HOTEL", "NOME CLIENTE", "PAX", "NUMERO CLIENTE", "INVIARE", "DATA PARTENZA", "ORA PRELEVAMENTO"];
    const dataRow = ["17:40", "Hotel Park Imperial", "Luca", "3", "3334372831", "SI", "30/08/2026", "16:40"];
    const res = detectSnavHeader(sheet([header, dataRow]));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const parsed = parseSnavRows([header, dataRow], 0, res.colMap);
    expect(parsed[0]).toMatchObject({
      customerName: "Luca",
      hotel: "Hotel Park Imperial",
      passengers: "3",
      phoneRaw: "3334372831",
      vesselTimeRaw: "17:40",
      pickupTimeRaw: "16:40",
    });
  });
});

describe("parseSnavRows", () => {
  const res = detectSnavHeader(sheet([CANONICAL_HEADER]));
  const colMap = res.ok ? res.colMap : {};

  it("skips fully-empty rows", () => {
    const raw = sheet([
      CANONICAL_HEADER,
      ["SI", "3334372831", "Luca", "30/08/2026", "Hotel Park Imperial", "3", "16:40", "17:40"],
      [],
      [null, null, null, null, null, null, null, null],
      ["SI", "3331112222", "Anna", "30/08/2026", "Hotel Rossi", "2", "10:00", "11:10"],
    ]);
    const rows = parseSnavRows(raw, 0, colMap);
    expect(rows.map((r) => r.customerName)).toEqual(["Luca", "Anna"]);
  });

  it("keeps the raw Excel cell (Date) for date/time columns — no premature stringify", () => {
    const dateObj = new Date(2026, 7, 30);
    const raw = sheet([CANONICAL_HEADER, ["SI", "3334372831", "Luca", dateObj, "Hotel Park Imperial", "3", new Date(1899, 11, 30, 16, 40), new Date(1899, 11, 30, 17, 40)]]);
    const [row] = parseSnavRows(raw, 0, colMap);
    expect(row.departureDateRaw).toBeInstanceOf(Date);
    expect(row.pickupTimeRaw).toBeInstanceOf(Date);
    expect(row.vesselTimeRaw).toBeInstanceOf(Date);
  });

  it("defaults inviare to true when the column is absent, and honours SI/NO otherwise", () => {
    expect(parseInviare("SI")).toBe(true);
    expect(parseInviare("no")).toBe(false);
    expect(parseInviare("X")).toBe(true);
    expect(parseInviare("")).toBe(false);
  });
});
