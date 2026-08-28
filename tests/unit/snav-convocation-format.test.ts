import { describe, it, expect } from "vitest";
import {
  formatSnavDepartureDate,
  parseSnavDepartureDateIso,
  formatSnavTime,
} from "@/lib/snav-convocation-format";

describe("formatSnavDepartureDate — civil date, no timezone, no GMT", () => {
  it("formats a JS Date (from xlsx cellDates) as 'WEEKDAY DD MONTH' in Italian uppercase", () => {
    // 2026-08-30 is a Sunday
    expect(formatSnavDepartureDate(new Date(2026, 7, 30))).toBe("DOMENICA 30 AGOSTO");
  });

  it("formats an ISO string and a DD/MM/YYYY string identically", () => {
    expect(formatSnavDepartureDate("2026-08-30")).toBe("DOMENICA 30 AGOSTO");
    expect(formatSnavDepartureDate("30/08/2026")).toBe("DOMENICA 30 AGOSTO");
  });

  it("formats an Excel date serial", () => {
    // Excel serial 46264 === 2026-08-30
    expect(formatSnavDepartureDate(46264)).toBe("DOMENICA 30 AGOSTO");
  });

  it("never emits GMT / 1899 / a timestamp", () => {
    const out = formatSnavDepartureDate(new Date(2026, 7, 30));
    expect(out).not.toMatch(/GMT/i);
    expect(out).not.toContain("1899");
    expect(out).not.toMatch(/\d{2}:\d{2}/);
  });

  it("does not let a UTC conversion shift the civil day (early-morning Date)", () => {
    // A Date built by xlsx at local midnight for 30/08 must still read as the 30th.
    expect(formatSnavDepartureDate(new Date(2026, 7, 30, 0, 0, 0))).toBe("DOMENICA 30 AGOSTO");
  });
});

describe("parseSnavDepartureDateIso — canonical YYYY-MM-DD for the daily log", () => {
  it("returns the canonical form for Date / serial / strings", () => {
    expect(parseSnavDepartureDateIso(new Date(2026, 7, 30))).toBe("2026-08-30");
    expect(parseSnavDepartureDateIso(46264)).toBe("2026-08-30");
    expect(parseSnavDepartureDateIso("30/08/2026")).toBe("2026-08-30");
    expect(parseSnavDepartureDateIso("2026-08-30")).toBe("2026-08-30");
  });

  it("returns null for an unparseable value", () => {
    expect(parseSnavDepartureDateIso("")).toBeNull();
    expect(parseSnavDepartureDateIso("prossima settimana")).toBeNull();
  });
});

describe("formatSnavTime — always HH:mm, never 1899 / GMT / seconds", () => {
  it("turns an Excel-epoch Date (30/12/1899) into HH:mm", () => {
    expect(formatSnavTime(new Date(1899, 11, 30, 16, 40))).toBe("16:40");
    expect(formatSnavTime(new Date(1899, 11, 30, 17, 40))).toBe("17:40");
  });

  it("turns an Excel time serial (fraction of a day) into HH:mm", () => {
    // 16:40 === 1000 minutes === 1000 / 1440 of a day
    expect(formatSnavTime(1000 / 1440)).toBe("16:40");
    expect(formatSnavTime(1060 / 1440)).toBe("17:40");
  });

  it("accepts HH:mm and HH.mm strings", () => {
    expect(formatSnavTime("16:40")).toBe("16:40");
    expect(formatSnavTime("17.40")).toBe("17:40");
    expect(formatSnavTime("9:05")).toBe("09:05");
  });

  it("never emits 1899 / GMT / seconds", () => {
    const out = formatSnavTime(new Date(1899, 11, 30, 16, 40, 33));
    expect(out).toBe("16:40");
    expect(out).not.toContain("1899");
    expect(out).not.toMatch(/GMT/i);
    expect(out).not.toMatch(/\d{2}:\d{2}:\d{2}/);
  });
});
