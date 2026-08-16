import { describe, expect, it } from "vitest";
import { buildDashboardDataRequest } from "@/lib/dashboard-data-request";

describe("buildDashboardDataRequest", () => {
  it("builds the query string from today/next48h", () => {
    const { searchParams } = buildDashboardDataRequest({ today: "2026-08-16", next48h: "2026-08-18" });
    expect(searchParams.get("today")).toBe("2026-08-16");
    expect(searchParams.get("next48h")).toBe("2026-08-18");
  });

  it("produces the same request key for equivalent options called twice", () => {
    const a = buildDashboardDataRequest({ today: "2026-08-16", next48h: "2026-08-18" });
    const b = buildDashboardDataRequest({ today: "2026-08-16", next48h: "2026-08-18" });
    expect(a.requestKey).toBe(b.requestKey);
  });

  it("produces a different request key when today changes (e.g. Oggi -> Domani toggle)", () => {
    const a = buildDashboardDataRequest({ today: "2026-08-16", next48h: "2026-08-18" });
    const b = buildDashboardDataRequest({ today: "2026-08-17", next48h: "2026-08-18" });
    expect(a.requestKey).not.toBe(b.requestKey);
  });

  it("produces a different request key when next48h changes (time passing, independent of dayOffset)", () => {
    const a = buildDashboardDataRequest({ today: "2026-08-16", next48h: "2026-08-18" });
    const b = buildDashboardDataRequest({ today: "2026-08-16", next48h: "2026-08-19" });
    expect(a.requestKey).not.toBe(b.requestKey);
  });
});
