import { describe, it, expect } from "vitest";
import { formatMedmarDepartureDate, formatMedmarTime, parseMedmarDepartureDateIso } from "@/lib/medmar-convocation-format";

describe("formatMedmarDepartureDate — regression for the GMT/timestamp bug", () => {
  it("formats an Excel Date object (07/09/2026, a Monday) as 'LUNEDÌ 07 SETTEMBRE'", () => {
    const excelDate = new Date(2026, 8, 7); // month is 0-indexed: 8 = September
    expect(formatMedmarDepartureDate(excelDate)).toBe("LUNEDÌ 07 SETTEMBRE");
  });

  it("never contains GMT, a timestamp, or the year 1899", () => {
    const excelDate = new Date(2026, 8, 7);
    const out = formatMedmarDepartureDate(excelDate);
    expect(out).not.toMatch(/GMT/i);
    expect(out).not.toMatch(/1899/);
    expect(out).not.toMatch(/:\d{2}:\d{2}/);
  });

  it("accepts a YYYY-MM-DD string", () => {
    expect(formatMedmarDepartureDate("2026-09-07")).toBe("LUNEDÌ 07 SETTEMBRE");
  });

  it("accepts a DD/MM/YYYY string", () => {
    expect(formatMedmarDepartureDate("07/09/2026")).toBe("LUNEDÌ 07 SETTEMBRE");
  });

  it("accepts an Excel numeric date serial", () => {
    // Excel serial for 07/09/2026 (days since 30/12/1899, inclusive of the 1900 leap-year bug)
    const serial = Math.round((Date.UTC(2026, 8, 7) - Date.UTC(1899, 11, 30)) / 86_400_000);
    expect(formatMedmarDepartureDate(serial)).toBe("LUNEDÌ 07 SETTEMBRE");
  });

  it("falls back to the raw trimmed string for unparseable free-text", () => {
    expect(formatMedmarDepartureDate("prima settimana di settembre")).toBe("prima settimana di settembre");
  });
});

describe("parseMedmarDepartureDateIso", () => {
  it("returns the canonical YYYY-MM-DD form from an Excel Date object", () => {
    expect(parseMedmarDepartureDateIso(new Date(2026, 8, 7))).toBe("2026-09-07");
  });

  it("returns null for unparseable input", () => {
    expect(parseMedmarDepartureDateIso("boh")).toBeNull();
  });
});

describe("formatMedmarTime — regression for the 1899/GMT time bug", () => {
  it("formats an Excel time-only Date (anchored at 30/12/1899) as HH:mm", () => {
    expect(formatMedmarTime(new Date(1899, 11, 30, 10, 0))).toBe("10:00");
    expect(formatMedmarTime(new Date(1899, 11, 30, 11, 10))).toBe("11:10");
  });

  it("never contains 1899, GMT, or seconds", () => {
    const out = formatMedmarTime(new Date(1899, 11, 30, 10, 0));
    expect(out).not.toMatch(/1899/);
    expect(out).not.toMatch(/GMT/i);
    expect(out).toMatch(/^\d{2}:\d{2}$/);
  });

  it("formats an Excel time serial (fraction of a day)", () => {
    expect(formatMedmarTime(10 / 24)).toBe("10:00");
  });

  it("formats a plain HH:mm string as-is", () => {
    expect(formatMedmarTime("10:00")).toBe("10:00");
  });

  it("normalizes a HH.mm string to HH:mm", () => {
    expect(formatMedmarTime("10.00")).toBe("10:00");
  });
});
