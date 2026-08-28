import { describe, it, expect } from "vitest";
import {
  detectMedmarHeader,
  missingRequiredFields,
  parseMedmarRows,
  parseInviare,
  findColumnIndex,
  normalizeHeader,
} from "@/lib/medmar-convocation-parse";

describe("medmar-convocation-parse: header detection (canonical 8-column format)", () => {
  it("finds the canonical header row: INVIARE, NUMERO CLIENTE, NOME CLIENTE, DATA PARTENZA, HOTEL, PAX, ORA PRELEVAMENTO, ORA NAVE", () => {
    const raw = [
      ["INVIARE", "NUMERO CLIENTE", "NOME CLIENTE", "DATA PARTENZA", "HOTEL", "PAX", "ORA PRELEVAMENTO", "ORA NAVE"],
      ["SI", "3334372831", "Luca", "07/09/2026", "Hotel La Villa", "2", "10:00", "11:10"],
    ];
    const result = detectMedmarHeader(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.headerRowIndex).toBe(0);
      expect(missingRequiredFields(result.colMap)).toHaveLength(0);
    }
  });

  it("does not require tratta/porto/compagnia/riferimento columns", () => {
    const raw = [
      ["Numero cliente", "Nome cliente", "Data partenza", "Hotel", "Pax", "Ora prelevamento", "Ora nave"],
      ["3331234567", "Mario Rossi", "10/09/2026", "Hotel Aurora", "3", "09:30", "10:45"],
    ];
    const result = detectMedmarHeader(raw);
    expect(result.ok).toBe(true);
  });

  it("maps 'ora prelevamento' and 'ora nave' to distinct column indices, never the same one", () => {
    const raw = [
      ["Numero cliente", "Nome cliente", "Data partenza", "Hotel", "Pax", "Ora prelevamento", "Ora nave"],
      ["3331234567", "Mario Rossi", "10/09/2026", "Hotel Aurora", "3", "09:30", "10:45"],
    ];
    const result = detectMedmarHeader(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.colMap.pickupTime).not.toBe(result.colMap.vesselTime);
    }
  });

  it("rejects a header where a single ambiguous column matches both pickupTime and vesselTime keywords", () => {
    const raw = [
      ["Numero cliente", "Nome cliente", "Data partenza", "Hotel", "Pax", "Prelevamento Nave"],
      ["3331234567", "Mario Rossi", "10/09/2026", "Hotel Aurora", "3", "09:30"],
    ];
    const result = detectMedmarHeader(raw, 2);
    expect(result.ok).toBe(false);
  });

  it("tolerates a title/blank row before the real header (scans first 10 rows)", () => {
    const raw = [
      ["Elenco convocazioni MEDMAR settembre"],
      [],
      ["Telefono cliente", "Nominativo", "Data", "Hotel", "Pax", "Prelevamento", "Nave"],
      ["3331234567", "Anna Verdi", "11/09/2026", "Hotel Bristol", "1", "08:00", "09:15"],
    ];
    const result = detectMedmarHeader(raw);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.headerRowIndex).toBe(2);
  });

  it("fails with a descriptive reason when no header is found in the first N rows", () => {
    const raw = [["a", "b"], ["c", "d"]];
    const result = detectMedmarHeader(raw, 2);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("Intestazioni colonne non trovate");
  });

  it("findColumnIndex / normalizeHeader are tolerant to case and punctuation", () => {
    expect(normalizeHeader("  Numero Cliente : ").trim()).toBe("numero cliente");
    expect(findColumnIndex(["Numero Cliente", "Nome"], [["numero", "cliente"]])).toBe(0);
    expect(findColumnIndex(["Nome"], [["numero", "cliente"]])).toBe(-1);
  });
});

describe("medmar-convocation-parse: row parsing", () => {
  const header = ["Inviare", "Numero cliente", "Nome cliente", "Data partenza", "Hotel", "Pax", "Ora prelevamento", "Ora nave"];
  const colMap = { inviare: 0, phoneRaw: 1, customerName: 2, travelDate: 3, hotel: 4, passengers: 5, pickupTime: 6, vesselTime: 7 };

  it("skips fully empty rows", () => {
    const raw = [
      header,
      ["SI", "3331234567", "Mario Rossi", "10/09/2026", "Hotel Aurora", "2", "09:00", "10:15"],
      ["", "", "", "", "", "", "", ""],
      [null, null, null, null, null, null, null, null],
      ["SI", "3339876543", "Luca Verdi", "11/09/2026", "Hotel Bristol", "3", "18:00", "19:15"],
    ];
    const rows = parseMedmarRows(raw, 0, colMap);
    expect(rows).toHaveLength(2);
    expect(rows[0].customerName).toBe("Mario Rossi");
    expect(rows[1].customerName).toBe("Luca Verdi");
  });

  it("parses the 'inviare' column with common truthy synonyms", () => {
    expect(parseInviare("SI")).toBe(true);
    expect(parseInviare("Sì")).toBe(true);
    expect(parseInviare("x")).toBe(true);
    expect(parseInviare("NO")).toBe(false);
    expect(parseInviare("")).toBe(false);
    expect(parseInviare(undefined)).toBe(false);
  });

  it("excludes a row when inviare = NO but keeps parsing it", () => {
    const raw = [header, ["NO", "3331234567", "Mario Rossi", "10/09/2026", "Hotel Aurora", "2", "09:00", "10:15"]];
    const rows = parseMedmarRows(raw, 0, colMap);
    expect(rows[0].inviare).toBe(false);
    expect(rows[0].customerName).toBe("Mario Rossi");
  });

  it("defaults inviare to true when the column is absent", () => {
    const raw = [header, ["", "3331234567", "Mario Rossi", "10/09/2026", "Hotel Aurora", "2", "09:00", "10:15"]];
    const { inviare: _inviare, ...colMapNoInviare } = colMap;
    const rows = parseMedmarRows(raw, 0, colMapNoInviare);
    expect(rows[0].inviare).toBe(true);
  });

  it("regression: Excel Date objects for DATA PARTENZA / ORA PRELEVAMENTO / ORA NAVE are kept raw (not stringified) for the formatter to handle", () => {
    const travelDate = new Date(2026, 8, 7); // 07/09/2026, local
    const pickup = new Date(1899, 11, 30, 10, 0); // Excel time-only cell
    const vessel = new Date(1899, 11, 30, 11, 10);
    const raw = [header, ["SI", "3334372831", "Luca", travelDate, "Hotel La Villa", "2", pickup, vessel]];
    const rows = parseMedmarRows(raw, 0, colMap);
    expect(rows[0].travelDateRaw).toBe(travelDate);
    expect(rows[0].pickupTimeRaw).toBe(pickup);
    expect(rows[0].vesselTimeRaw).toBe(vessel);
    expect(rows[0].hotel).toBe("Hotel La Villa");
    expect(rows[0].passengers).toBe("2");
  });
});
