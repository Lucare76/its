import { describe, it, expect } from "vitest";
import { formatItalianDateTime } from "@/lib/date-format";

describe("formatItalianDateTime", () => {
  it("mostra l'orario in Europe/Rome (CEST, +2h su UTC) durante l'ora legale", () => {
    // 2026-09-03T14:28:00Z in estate (CEST, UTC+2) → 16:28 italiane.
    const result = formatItalianDateTime("2026-09-03T14:28:00.000Z");
    expect(result).toContain("16:28");
    expect(result).toContain("03/09/2026");
  });

  it("mostra l'orario in Europe/Rome (CET, +1h su UTC) durante l'ora solare", () => {
    // 2026-01-15T14:28:00Z in inverno (CET, UTC+1) → 15:28 italiane.
    const result = formatItalianDateTime("2026-01-15T14:28:00.000Z");
    expect(result).toContain("15:28");
    expect(result).toContain("15/01/2026");
  });

  it("accetta anche un oggetto Date", () => {
    const result = formatItalianDateTime(new Date("2026-09-03T14:28:00.000Z"));
    expect(result).toContain("16:28");
  });
});
