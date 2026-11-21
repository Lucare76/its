import { describe, expect, it } from "vitest";
import { planAutoAssignPreview, type PlannerDriver, type PlannerVehicle } from "@/lib/piano-auto-assign-planner";
import { buildArrivalConvocations, type ConvocationArrival } from "@/lib/piano-arrival-convocations";
import { collectiveImpact, collectiveConvocationSchema, resolveCollectiveReservations, timeMinutes, type CollectiveReservation } from "@/lib/piano-collective-convocations";
import { classifyPlanItems } from "@/lib/server/assignment-engine/classify-plan";
import type { AutoAssignPreviewResult, AutoAssignPreviewServiceRow } from "@/lib/piano-assignable-preview";
const drivers: PlannerDriver[] = [
  { id: "driver-1", name: "Mario" },
  { id: "driver-2", name: "Luigi" },
];

const vehicles: PlannerVehicle[] = [
  { id: "vito", label: "Vito", capacity: 8 },
  { id: "ducato", label: "Ducato", capacity: 14 },
  { id: "bus25", label: "Bus 25", capacity: 25 },
];

function row(overrides: Partial<AutoAssignPreviewServiceRow>): AutoAssignPreviewServiceRow {
  return {
    service_id: "svc-1",
    customer_name: "Cliente",
    macro_category: "PARTENZA",
    assignable: true,
    needs_review: false,
    review_reasons: [],
    is_locked: false,
    already_assigned: false,
    already_assigned_unlocked: false,
    confidence_score: 100,
    operational_time: "09:00",
    pickup_label: "Hotel Test",
    pickup_type: "hotel",
    pickup_zone: "Forio",
    destination_label: "Casamicciola",
    destination_type: "porto",
    destination_zone: "Casamicciola",
    pax: 2,
    capacity_required: 2,
    booking_service_kind: null,
    service_type_code: null,
    connection_label: null,
    ferry_company: null,
    ferry_departure_time: null,
    ferry_arrival_time: null,
    port_departure: null,
    port_arrival: null,
    soft_preferences: [],
    hard_constraints: [],
    ...overrides,
  };
}


const event: CollectiveReservation = { date: "2026-10-18", event_key: "ferry", active: true,
  arrival: "15:40", last_departure: "16:30", margin_min: 25, margin_max: 35,
  port: "Ischia Porto", label: "15:40 MEDMAR Ischia Porto", serviceIds: ["collective"] };
const raw: ConvocationArrival = { id: "collective", direction: "arrival", status: "new", time: "15:40", pax: 2,
  vessel: "MEDMAR", meeting_point: "Ischia Porto", origin_place_type: "port", origin_place_id: "port-1", hotel_id: "hotel-1", orario_barca: "14:20" };
function run(services: AutoAssignPreviewServiceRow[], events = [event]) {
  return planAutoAssignPreview({ services, drivers, vehicles, availability_confirmed: true, collectiveReservations: events });
}
function classify(services: AutoAssignPreviewServiceRow[]) {
  return classifyPlanItems({ preview: { services } as AutoAssignPreviewResult, planning: run(services),
    assignmentByServiceId: new Map(), collectiveReservations: [event] });
}
describe("convocazioni collettive", () => {
  it("binds only the chosen ferry, including later imported bookings for the same run", () => {
    const key = buildArrivalConvocations([raw], new Map())[0].id;
    const events = resolveCollectiveReservations([{ ...event, event_key: key }], [raw,
      { ...raw, id: "new-booking" }, { ...raw, id: "other-ferry", orario_barca: "14:00" },
      { ...raw, id: "other-port", origin_place_id: "port-2" }, { ...raw, id: "cancelled", status: "cancelled" }]);
    expect(events[0].serviceIds).toEqual(["collective", "new-booking"]);
    expect(resolveCollectiveReservations([{ ...event, event_key: key, active: false }], [raw])).toEqual([]);
  });
  it("counts the 25–35 minutes once from the last departure", () => {
    expect(timeMinutes(event.last_departure) + event.margin_min).toBe(timeMinutes("16:55"));
    expect(timeMinutes(event.last_departure) + event.margin_max).toBe(timeMinutes("17:05"));
    expect(collectiveImpact([event], timeMinutes("16:55"), 30).uncertain).toBe(event);
  });
  it("validates dates, times and reversed margins", () => {
    const payload = { date: event.date, event_key: event.event_key, active: true, last_departure: "16:30", margin_min: 25, margin_max: 35 };
    expect(collectiveConvocationSchema.safeParse(payload).success).toBe(true);
    for (const invalid of [{ last_departure: "25:30" }, { date: "2026-02-31" }, { margin_min: 35, margin_max: 25 }, { margin_max: 60 }])
      expect(collectiveConvocationSchema.safeParse({ ...payload, ...invalid }).success).toBe(false);
  });
  it("does not assign individual drivers to collective bookings or fabricate assignments", () => {
    const services = [row({ service_id: "collective", operational_time: "15:40", macro_category: "ARRIVO", needs_review: true })];
    expect(run(services).proposed_groups).toEqual([]);
    const item = classify(services)[0];
    expect(item.reason.details.collective).toBe(true);
    expect(item.proposed_driver_id).toBeNull();
    expect(item.alternatives).toEqual([]);
    expect(item.status).toBe("manual");
  });
  it("protects the whole team at the port and labels exceptions for Mario", () => {
    const services = [row({ operational_time: "16:00" })];
    expect(run(services).proposed_groups).toEqual([]);
    expect(classify(services)[0].status).toBe("review");
    expect(classify(services)[0].reason.summary.join(" ")).toContain("Mario");
  });
  it("allows proposals after departure but never auto-confirms an uncertain release", () => {
    const services = [row({ operational_time: "16:55" })];
    expect(run(services).proposed_groups).toHaveLength(1);
    expect(classify(services)[0].status).toBe("review");
    expect(classify(services)[0].warnings.join(" ")).toContain("Mario");
  });
  it("checks completion and travel to the port before a convocation", () => {
    const services = [row({ operational_time: "15:10", pickup_zone: "Forio", destination_zone: "Forio", destination_label: "Forio" })];
    expect(run(services).proposed_groups).toEqual([]);
    expect(run([row({ operational_time: "12:00" })]).proposed_groups).toHaveLength(1);
  });
  it("supports multiple ferries without merging reservations", () => {
    const second = { ...event, event_key: "second", arrival: "18:00", last_departure: "18:40", serviceIds: ["second-booking"] };
    expect(run([row({ operational_time: "18:10" })], [event, second]).proposed_groups).toEqual([]);
  });
  it("preserves daily shifts, capacity and driver eligibility after TUTTI", () => {
    const result = planAutoAssignPreview({ services: [row({ operational_time: "16:55", pax: 20 })],
      drivers: [{ id: "a", name: "A", available_from: "05:00", available_to: "16:00" }, { id: "b", name: "B", max_vehicle_capacity: 8 }],
      vehicles, availability_confirmed: true, collectiveReservations: [event] });
    expect(result.proposed_groups).toEqual([]);
  });
  it("leaves ordinary days unchanged when no collective event is configured", () => {
    expect(run([row({ operational_time: "16:00" })], []).proposed_groups).toHaveLength(1);
  });
});
