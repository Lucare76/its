import { describe, expect, it } from "vitest";
import { buildTenantDataRequest } from "@/lib/supabase/tenant-data-request";

describe("buildTenantDataRequest", () => {
  it("reproduces the exact legacy query string when no options are given", () => {
    const { searchParams, requestKey } = buildTenantDataRequest();

    expect(searchParams.toString()).toBe("include_inbound_emails=false");
    expect(searchParams.has("datasets")).toBe(false);
    expect(searchParams.has("service_scope")).toBe(false);
    expect(requestKey).toBe("legacy:false");
  });

  it("keeps the legacy shape when only includeInboundEmails is set", () => {
    const { searchParams, requestKey } = buildTenantDataRequest({ includeInboundEmails: true });

    expect(searchParams.toString()).toBe("include_inbound_emails=true");
    expect(requestKey).toBe("legacy:true");
  });

  it("builds a date-scope request with all datasets when datasets is omitted", () => {
    const { searchParams, requestKey } = buildTenantDataRequest({
      serviceScope: { mode: "date", date: "2026-08-15" }
    });

    expect(searchParams.get("service_scope")).toBe("date");
    expect(searchParams.get("date")).toBe("2026-08-15");
    expect(searchParams.get("datasets")).toBe(
      "services,assignments,statusEvents,hotels,memberships,busLotConfigs"
    );
    expect(requestKey).toBe(
      "services,assignments,statusEvents,hotels,memberships,busLotConfigs|date:2026-08-15"
    );
  });

  it("only requests explicitly opted-in datasets", () => {
    const { searchParams, requestKey } = buildTenantDataRequest({
      datasets: { services: true, hotels: true },
      serviceScope: { mode: "date", date: "2026-08-15" }
    });

    expect(searchParams.get("datasets")).toBe("services,hotels");
    expect(requestKey).toBe("services,hotels|date:2026-08-15");
  });

  it("includes inboundEmails only when explicitly opted in", () => {
    const withFlagInDatasets = buildTenantDataRequest({
      datasets: { services: true, inboundEmails: true },
      serviceScope: { mode: "date", date: "2026-08-15" }
    });
    expect(withFlagInDatasets.searchParams.get("datasets")).toBe("services,inboundEmails");

    const withoutFlag = buildTenantDataRequest({
      datasets: { services: true },
      serviceScope: { mode: "date", date: "2026-08-15" }
    });
    expect(withoutFlag.searchParams.get("datasets")).toBe("services");
  });

  it("builds a range-scope request", () => {
    const { searchParams, requestKey } = buildTenantDataRequest({
      datasets: { services: true },
      serviceScope: { mode: "range", from: "2026-08-10", to: "2026-08-17" }
    });

    expect(searchParams.get("service_scope")).toBe("range");
    expect(searchParams.get("from")).toBe("2026-08-10");
    expect(searchParams.get("to")).toBe("2026-08-17");
    expect(requestKey).toBe("services|range:2026-08-10:2026-08-17");
  });

  it("builds an ids-scope request with a sorted, order-independent ids param and key", () => {
    const a = buildTenantDataRequest({
      datasets: { services: true },
      serviceScope: { mode: "ids", ids: ["b-id", "a-id"] }
    });
    const b = buildTenantDataRequest({
      datasets: { services: true },
      serviceScope: { mode: "ids", ids: ["a-id", "b-id"] }
    });

    expect(a.searchParams.get("ids")).toBe("a-id,b-id");
    expect(a.requestKey).toBe(b.requestKey);
  });

  it("produces different request keys for different scopes with the same datasets", () => {
    const dateScope = buildTenantDataRequest({
      datasets: { services: true },
      serviceScope: { mode: "date", date: "2026-08-15" }
    });
    const nextDayScope = buildTenantDataRequest({
      datasets: { services: true },
      serviceScope: { mode: "date", date: "2026-08-16" }
    });

    expect(dateScope.requestKey).not.toBe(nextDayScope.requestKey);
  });

  it("produces the same request key for equivalent options called twice", () => {
    const first = buildTenantDataRequest({
      datasets: { services: true, hotels: true },
      serviceScope: { mode: "date", date: "2026-08-15" }
    });
    const second = buildTenantDataRequest({
      datasets: { services: true, hotels: true },
      serviceScope: { mode: "date", date: "2026-08-15" }
    });

    expect(first.requestKey).toBe(second.requestKey);
  });
});
