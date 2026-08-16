import { describe, expect, it } from "vitest";
import { generateSuggestions, type OperationsSuggestionState } from "@/lib/operations-suggestions";
import type { Assignment, Hotel, Service } from "@/lib/types";

/**
 * Sprint Performance 14F — FASE 11. Proves that pre-filtering `services` to
 * `status NOT IN ('cancelled','completato') AND is_draft IS NOT TRUE` (the
 * SQL predicate applied by fetchActiveServicesForSuggestions() in
 * app/api/ops/suggestions/route.ts) produces byte-identical
 * generateSuggestions() output to passing the full, unfiltered dataset —
 * for the exact same reason: every consumer of `state.services` inside
 * lib/operations-suggestions.ts already applies this identical predicate
 * (isActiveService) before reading a service, so removing the excluded rows
 * earlier changes nothing about the output.
 *
 * Also covers, in a single shared fixture: current, historical (old date,
 * still open), cancelled, completed, draft, far-future (beyond the 30-day
 * suggestion horizon), bus overcapacity, geo issue, missing data, and an
 * assignment referencing a cancelled service.
 */

const TENANT = "tenant-1";
const NOW = new Date("2026-08-16T10:00:00.000Z");

function svc(id: string, overrides: Partial<Service> = {}): Service {
  return {
    id,
    tenant_id: TENANT,
    date: "2026-08-16",
    time: "10:00",
    direction: "arrival",
    vessel: "Alilauro",
    pax: 2,
    hotel_id: "hotel-active",
    customer_name: `Cliente ${id}`,
    phone: "3331234567",
    notes: "",
    status: "new",
    is_draft: false,
    ...overrides
  } as Service;
}

function hotel(id: string, overrides: Partial<Hotel> = {}): Hotel {
  return {
    id,
    tenant_id: TENANT,
    name: `Hotel ${id}`,
    address: "Via Roma 1",
    lat: 40.73,
    lng: 13.9,
    zone: "Ischia Porto",
    geo_status: "verified",
    ...overrides
  } as Hotel;
}

function assignment(id: string, serviceId: string, vehicleLabel: string, overrides: Partial<Assignment> = {}): Assignment {
  return {
    id,
    tenant_id: TENANT,
    service_id: serviceId,
    driver_user_id: null,
    vehicle_label: vehicleLabel,
    ...overrides
  };
}

function isActiveService(service: Service): boolean {
  return service.status !== "cancelled" && service.status !== "completato" && service.is_draft !== true;
}

describe("generateSuggestions — legacy vs SQL-status-filtered dataset parity", () => {
  const hotels: Hotel[] = [
    hotel("hotel-active", { geo_status: "verified" }),
    hotel("hotel-missing-geo", { geo_status: "missing", lat: null, lng: null }),
    // Only ever referenced by cancelled/completed/draft "landmine" services —
    // if the filter leaked one through, this would produce an EXTRA geo_issue
    // suggestion keyed by this hotel id.
    hotel("hotel-landmine-geo", { geo_status: "missing", lat: null, lng: null })
  ];

  const services: Service[] = [
    // --- current: bus overcapacity (source + target) ---
    svc("bus-over", { service_type: "bus_tour", capacity: 10, pax: 12, date: "2026-08-16", direction: "arrival" } as Partial<Service>),
    svc("bus-target", { service_type: "bus_tour", capacity: 20, pax: 3, date: "2026-08-16", direction: "arrival" } as Partial<Service>),

    // --- historical: old date, still "new" (never closed out) — must still
    // produce a missing_data suggestion (activeServices has no lower bound) ---
    svc("historical-open", {
      date: "2020-01-01",
      phone: "",
      hotel_id: "hotel-active"
    }),

    // --- far future: beyond the 30-day suggestion horizon ---
    // Excluded from the geo/missing-data loop (activeServices has an upper
    // horizon bound) but NOT from buildBuses (no horizon there at all) — this
    // bus must still trigger overcapacity in BOTH legacy and optimized runs,
    // proving the status/draft filter never introduces a date bound.
    svc("bus-future-far", { service_type: "bus_tour", capacity: 5, pax: 9, date: "2026-12-01", direction: "departure" } as Partial<Service>),

    // --- geo issue on a genuinely active service ---
    svc("geo-active", { hotel_id: "hotel-missing-geo", phone: "3339999999" }),

    // --- landmines: cancelled / completed / draft, each individually capable
    // of producing an EXTRA suggestion if the SQL filter leaked it through ---
    svc("cancelled-bus", { service_type: "bus_tour", capacity: 5, pax: 100, date: "2026-08-16", direction: "arrival", status: "cancelled" } as Partial<Service>),
    svc("completed-bus", { service_type: "bus_tour", capacity: 5, pax: 100, date: "2026-08-16", direction: "arrival", status: "completato" } as Partial<Service>),
    svc("draft-bus", { service_type: "bus_tour", capacity: 5, pax: 100, date: "2026-08-16", direction: "arrival", is_draft: true } as Partial<Service>),
    svc("cancelled-geo", { hotel_id: "hotel-landmine-geo", status: "cancelled" }),
    svc("cancelled-missing-phone", { phone: "", status: "cancelled" })
  ];

  // Assignment referencing a cancelled service: buildBuses() must skip it
  // (servicesById lookup built from the already-filtered active set), whether
  // or not the cancelled row itself is present in the input array.
  const assignments: Assignment[] = [assignment("a1", "cancelled-bus", "VAN-CANCELLED")];

  const legacyState: OperationsSuggestionState = { services, assignments, hotels, busLotConfigs: [], now: NOW } as OperationsSuggestionState;
  const optimizedState: OperationsSuggestionState = {
    services: services.filter(isActiveService),
    assignments,
    hotels,
    busLotConfigs: [],
    now: NOW
  } as OperationsSuggestionState;

  it("produces byte-identical output for the full dataset vs the pre-filtered (active-only) dataset", () => {
    const legacy = generateSuggestions(legacyState);
    const optimized = generateSuggestions(optimizedState);
    expect(optimized).toEqual(legacy);
  });

  it("still finds the current bus overcapacity suggestion", () => {
    const result = generateSuggestions(optimizedState);
    expect(result.some((s) => s.type === "overcapacity" && s.action_payload?.from_bus_id === "bus-over")).toBe(true);
  });

  it("still finds the historical (old-date, still-open) missing-data suggestion", () => {
    const result = generateSuggestions(optimizedState);
    expect(result.some((s) => s.type === "missing_data" && s.action_payload?.service_id === "historical-open")).toBe(true);
  });

  it("still finds the far-future bus overcapacity (no horizon in buildBuses)", () => {
    const result = generateSuggestions(optimizedState);
    expect(result.some((s) => s.type === "overcapacity" && s.action_payload?.from_bus_id === "bus-future-far")).toBe(true);
  });

  it("still finds the active geo_issue suggestion", () => {
    const result = generateSuggestions(optimizedState);
    expect(result.some((s) => s.type === "geo_issue" && s.action_payload?.hotel_id === "hotel-missing-geo")).toBe(true);
  });

  it("never produces a suggestion sourced from a cancelled/completed/draft landmine", () => {
    const result = generateSuggestions(optimizedState);
    expect(result.some((s) => s.action_payload?.from_bus_id === "cancelled-bus")).toBe(false);
    expect(result.some((s) => s.action_payload?.from_bus_id === "completed-bus")).toBe(false);
    expect(result.some((s) => s.action_payload?.from_bus_id === "draft-bus")).toBe(false);
    expect(result.some((s) => s.action_payload?.hotel_id === "hotel-landmine-geo")).toBe(false);
    expect(result.some((s) => s.action_payload?.service_id === "cancelled-missing-phone")).toBe(false);
  });
});
