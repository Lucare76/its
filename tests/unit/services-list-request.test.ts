import { describe, expect, it } from "vitest";
import { buildServicesListFilterKey, buildServicesListRequest, type ServicesListFilters } from "@/lib/services-list-request";

const baseFilters: ServicesListFilters = {
  status: "all",
  serviceType: "all",
  vessel: "all",
  zone: "all",
  driverUserId: "all",
  search: "",
  source: "all",
  reviewed: "all",
  agency: "all",
  quality: "all"
};

describe("buildServicesListRequest", () => {
  it("maps 'all' sentinels to empty/undefined query values", () => {
    const { body } = buildServicesListRequest({ tenantId: "tenant-1", filters: baseFilters, page: 1, pageSize: 50 });
    expect(body).toEqual({
      tenant_id: "tenant-1",
      status: [],
      service_type: undefined,
      ship: "",
      zone: "",
      driver_user_id: undefined,
      search: "",
      source: "all",
      reviewed: "all",
      agency: "all",
      quality: "all",
      page: 1,
      page_size: 50
    });
  });

  it("passes through concrete filter values", () => {
    const { body } = buildServicesListRequest({
      tenantId: "tenant-1",
      filters: {
        status: "assigned",
        serviceType: "bus_tour",
        vessel: "Alilauro",
        zone: "Ischia Porto",
        driverUserId: "driver-1",
        search: "  Rossi  ",
        source: "pdf",
        reviewed: "no",
        agency: "Agenzia XYZ",
        quality: "low"
      },
      page: 2,
      pageSize: 25
    });
    expect(body).toEqual({
      tenant_id: "tenant-1",
      status: ["assigned"],
      service_type: "bus_tour",
      ship: "Alilauro",
      zone: "Ischia Porto",
      driver_user_id: "driver-1",
      search: "Rossi",
      source: "pdf",
      reviewed: "no",
      agency: "Agenzia XYZ",
      quality: "low",
      page: 2,
      page_size: 25
    });
  });

  it("produces the same request key for equivalent options called twice", () => {
    const first = buildServicesListRequest({ tenantId: "t1", filters: baseFilters, page: 1, pageSize: 50 });
    const second = buildServicesListRequest({ tenantId: "t1", filters: baseFilters, page: 1, pageSize: 50 });
    expect(first.requestKey).toBe(second.requestKey);
  });

  it("produces a different request key when a filter changes", () => {
    const a = buildServicesListRequest({ tenantId: "t1", filters: { ...baseFilters, search: "Rossi" }, page: 1, pageSize: 50 });
    const b = buildServicesListRequest({ tenantId: "t1", filters: { ...baseFilters, search: "Bianchi" }, page: 1, pageSize: 50 });
    expect(a.requestKey).not.toBe(b.requestKey);
  });

  it("produces a different request key when only the page changes", () => {
    const a = buildServicesListRequest({ tenantId: "t1", filters: baseFilters, page: 1, pageSize: 50 });
    const b = buildServicesListRequest({ tenantId: "t1", filters: baseFilters, page: 2, pageSize: 50 });
    expect(a.requestKey).not.toBe(b.requestKey);
  });

  it("trims and lowercases search for the filter key, but not for the request body", () => {
    const a = buildServicesListRequest({ tenantId: "t1", filters: { ...baseFilters, search: "Rossi" }, page: 1, pageSize: 50 });
    const b = buildServicesListRequest({ tenantId: "t1", filters: { ...baseFilters, search: "  rossi  " }, page: 1, pageSize: 50 });
    expect(a.requestKey).toBe(b.requestKey);
    expect(b.body.search).toBe("rossi");
  });
});

describe("buildServicesListFilterKey", () => {
  it("ignores page/pageSize entirely — same filters, same key regardless of page", () => {
    const key = buildServicesListFilterKey(baseFilters);
    expect(key).toBe(buildServicesListFilterKey({ ...baseFilters }));
  });

  it("changes when any filter field changes", () => {
    const key = buildServicesListFilterKey(baseFilters);
    expect(buildServicesListFilterKey({ ...baseFilters, status: "cancelled" })).not.toBe(key);
    expect(buildServicesListFilterKey({ ...baseFilters, serviceType: "bus_tour" })).not.toBe(key);
    expect(buildServicesListFilterKey({ ...baseFilters, vessel: "Snav" })).not.toBe(key);
    expect(buildServicesListFilterKey({ ...baseFilters, zone: "Forio" })).not.toBe(key);
    expect(buildServicesListFilterKey({ ...baseFilters, driverUserId: "driver-1" })).not.toBe(key);
    expect(buildServicesListFilterKey({ ...baseFilters, search: "Rossi" })).not.toBe(key);
    expect(buildServicesListFilterKey({ ...baseFilters, source: "pdf" })).not.toBe(key);
    expect(buildServicesListFilterKey({ ...baseFilters, reviewed: "no" })).not.toBe(key);
    expect(buildServicesListFilterKey({ ...baseFilters, agency: "Agenzia XYZ" })).not.toBe(key);
    expect(buildServicesListFilterKey({ ...baseFilters, quality: "low" })).not.toBe(key);
  });
});
