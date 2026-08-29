import { describe, it, expect } from "vitest";
import {
  resolveCoverageForRow,
  diffConvocationData,
  buildFallbackKey,
  buildCoverageSummary,
  type CoverageInputRow,
  type MedmarSentSnapshot,
} from "@/lib/medmar-convocation-coverage";
import { MEDMAR_DEPARTURE_KINDS, isMedmarDepartureKind } from "@/lib/medmar-generate-from-services";

function row(overrides: Partial<CoverageInputRow> = {}): CoverageInputRow {
  return {
    status: "pronto",
    service_id: "svc-1",
    phone_e164: "+393331234567",
    customer_name: "Mario Rossi",
    travel_date_iso: "2026-09-07",
    hotel: "Hotel Aurora",
    passengers: "2",
    pickup_time: "09:00",
    vessel_time: "11:10",
    ...overrides,
  };
}

function snapshot(overrides: Partial<MedmarSentSnapshot> = {}): MedmarSentSnapshot {
  return {
    source_row_id: "r-1",
    phone_e164: "+393331234567",
    customer_name: "Mario Rossi",
    travel_date_iso: "2026-09-07",
    hotel: "Hotel Aurora",
    passengers: "2",
    pickup_time: "09:00",
    vessel_time: "11:10",
    sent_at: "2026-09-06T08:00:00.000Z",
    ...overrides,
  };
}

describe("resolveCoverageForRow", () => {
  it("1. service_id never sent -> new", () => {
    const result = resolveCoverageForRow(row(), new Map(), new Map());
    expect(result.coverage_status).toBe("new");
  });

  it("2. service_id sent successfully with identical data -> sent", () => {
    const byServiceId = new Map([["svc-1", snapshot()]]);
    const result = resolveCoverageForRow(row(), byServiceId, new Map());
    expect(result.coverage_status).toBe("sent");
    expect(result.previous_send?.source_row_id).toBe("r-1");
  });

  it("6. pickup_time changed -> changed", () => {
    const byServiceId = new Map([["svc-1", snapshot({ pickup_time: "09:00" })]]);
    const result = resolveCoverageForRow(row({ pickup_time: "09:30" }), byServiceId, new Map());
    expect(result.coverage_status).toBe("changed");
    expect(result.changed_fields).toEqual([{ field: "pickup_time", label: "Pickup", from: "09:00", to: "09:30" }]);
  });

  it("7. vessel_time changed -> changed", () => {
    const byServiceId = new Map([["svc-1", snapshot({ vessel_time: "11:10" })]]);
    const result = resolveCoverageForRow(row({ vessel_time: "12:00" }), byServiceId, new Map());
    expect(result.coverage_status).toBe("changed");
    expect(result.changed_fields?.[0]).toMatchObject({ field: "vessel_time", label: "Nave" });
  });

  it("8. phone changed -> changed", () => {
    const byServiceId = new Map([["svc-1", snapshot({ phone_e164: "+393331234567" })]]);
    const result = resolveCoverageForRow(row({ phone_e164: "+393479876543" }), byServiceId, new Map());
    expect(result.coverage_status).toBe("changed");
    expect(result.changed_fields?.some((f) => f.field === "phone_e164")).toBe(true);
  });

  it("9. hotel changed -> changed", () => {
    const byServiceId = new Map([["svc-1", snapshot({ hotel: "Hotel Aurora" })]]);
    const result = resolveCoverageForRow(row({ hotel: "Hotel Bristol" }), byServiceId, new Map());
    expect(result.coverage_status).toBe("changed");
    expect(result.changed_fields?.some((f) => f.field === "hotel")).toBe(true);
  });

  it("10. pax changed -> changed", () => {
    const byServiceId = new Map([["svc-1", snapshot({ passengers: "2" })]]);
    const result = resolveCoverageForRow(row({ passengers: "3" }), byServiceId, new Map());
    expect(result.coverage_status).toBe("changed");
    expect(result.changed_fields?.some((f) => f.field === "passengers")).toBe(true);
  });

  it("11. all data unchanged -> sent", () => {
    const byServiceId = new Map([["svc-1", snapshot()]]);
    const result = resolveCoverageForRow(row(), byServiceId, new Map());
    expect(result.coverage_status).toBe("sent");
    expect(result.changed_fields).toBeUndefined();
  });

  it("12. invalid row (missing/invalid data) -> invalid, regardless of send history", () => {
    const byServiceId = new Map([["svc-1", snapshot()]]);
    const result = resolveCoverageForRow(row({ status: "numero_non_valido" }), byServiceId, new Map());
    expect(result.coverage_status).toBe("invalid");
  });

  it("unambiguous phone+date+vessel fallback (no service_id match) counts as sent", () => {
    const key = buildFallbackKey("+393331234567", "2026-09-07", "11:10");
    const byFallbackKey = new Map([[key!, [snapshot()]]]);
    const result = resolveCoverageForRow(row({ service_id: "svc-unmatched" }), new Map(), byFallbackKey);
    expect(result.coverage_status).toBe("sent");
  });

  it("ambiguous fallback (2+ candidates) is treated as new, never as a false 'already sent'", () => {
    const key = buildFallbackKey("+393331234567", "2026-09-07", "11:10");
    const byFallbackKey = new Map([[key!, [snapshot({ source_row_id: "r-1" }), snapshot({ source_row_id: "r-2" })]]]);
    const result = resolveCoverageForRow(row({ service_id: "svc-unmatched" }), new Map(), byFallbackKey);
    expect(result.coverage_status).toBe("new");
  });
});

describe("diffConvocationData", () => {
  it("returns no diffs for identical data (case/whitespace tolerant)", () => {
    const a = snapshot();
    const b = { ...snapshot(), hotel: "  Hotel Aurora  " };
    expect(diffConvocationData(a, b)).toEqual([]);
  });

  it("reports every changed field", () => {
    const a = snapshot();
    const b = snapshot({ hotel: "Hotel B", passengers: "4" });
    const diffs = diffConvocationData(a, b);
    expect(diffs.map((d) => d.field).sort()).toEqual(["hotel", "passengers"]);
  });
});

describe("buildCoverageSummary — coherent totals", () => {
  it("17. new + sent + changed + invalid = found", () => {
    const summary = buildCoverageSummary(["new", "sent", "sent", "changed", "invalid"]);
    expect(summary).toEqual({ found: 5, new: 1, sent: 2, changed: 1, invalid: 1 });
    expect(summary.new + summary.sent + summary.changed + summary.invalid).toBe(summary.found);
  });

  it("11. zero convocations for the day -> all zero", () => {
    const summary = buildCoverageSummary([]);
    expect(summary).toEqual({ found: 0, new: 0, sent: 0, changed: 0, invalid: 0 });
  });
});

describe("13/27. SNAV is never treated as a MEDMAR departure", () => {
  it("MEDMAR_DEPARTURE_KINDS excludes formula_snav", () => {
    expect((MEDMAR_DEPARTURE_KINDS as readonly string[])).not.toContain("formula_snav");
  });

  it("isMedmarDepartureKind rejects formula_snav", () => {
    expect(isMedmarDepartureKind("formula_snav")).toBe(false);
    expect(isMedmarDepartureKind("formula_medmar_napoli")).toBe(true);
    expect(isMedmarDepartureKind("formula_medmar_pozzuoli")).toBe(true);
  });
});

describe("Sprint scenario (spec §23): A, B, C then B changes, then D arrives", () => {
  it("step 1: A and B already sent, C new -> found 3, sent 2, new 1", () => {
    const sentA = snapshot({ source_row_id: "rA" });
    const sentB = snapshot({ source_row_id: "rB" });
    const byServiceId = new Map([["A", sentA], ["B", sentB]]);

    const rows = [
      row({ service_id: "A" }),
      row({ service_id: "B" }),
      row({ service_id: "C" }),
    ];
    const results = rows.map((r) => resolveCoverageForRow(r, byServiceId, new Map()));
    const summary = buildCoverageSummary(results.map((r) => r.coverage_status));

    expect(summary).toEqual({ found: 3, new: 1, sent: 2, changed: 0, invalid: 0 });
  });

  it("step 2: B's pickup changes -> found 3, sent 1, new 1, changed 1", () => {
    const sentA = snapshot({ source_row_id: "rA" });
    const sentB = snapshot({ source_row_id: "rB", pickup_time: "09:00" });
    const byServiceId = new Map([["A", sentA], ["B", sentB]]);

    const rows = [
      row({ service_id: "A" }),
      row({ service_id: "B", pickup_time: "09:30" }),
      row({ service_id: "C" }),
    ];
    const results = rows.map((r) => resolveCoverageForRow(r, byServiceId, new Map()));
    const summary = buildCoverageSummary(results.map((r) => r.coverage_status));

    expect(summary).toEqual({ found: 3, new: 1, sent: 1, changed: 1, invalid: 0 });
  });

  it("step 3: D arrives -> found 4, sent 1, new 2, changed 1", () => {
    const sentA = snapshot({ source_row_id: "rA" });
    const sentB = snapshot({ source_row_id: "rB", pickup_time: "09:00" });
    const byServiceId = new Map([["A", sentA], ["B", sentB]]);

    const rows = [
      row({ service_id: "A" }),
      row({ service_id: "B", pickup_time: "09:30" }),
      row({ service_id: "C" }),
      row({ service_id: "D" }),
    ];
    const results = rows.map((r) => resolveCoverageForRow(r, byServiceId, new Map()));
    const summary = buildCoverageSummary(results.map((r) => r.coverage_status));

    expect(summary).toEqual({ found: 4, new: 2, sent: 1, changed: 1, invalid: 0 });
  });
});
