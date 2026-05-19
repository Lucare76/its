import { describe, expect, it } from "vitest";
import { planAutoAssignPreview, estimateTravelBuffer, type PlannerDriver, type PlannerVehicle } from "@/lib/piano-auto-assign-planner";
import { vehicleResourceKey, vehicleIntervalsOverlap } from "@/lib/piano-vehicle-timeline";
import type { AutoAssignPreviewServiceRow } from "@/lib/piano-assignable-preview";

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

describe("planAutoAssignPreview", () => {
  it("groups two departures from the same hotel and same time window", () => {
    const result = planAutoAssignPreview({
      availability_confirmed: true,
      drivers,
      vehicles,
      services: [
        row({ service_id: "a", operational_time: "09:00", pickup_label: "Hotel La Villa", pickup_zone: "Forio", destination_label: "Casamicciola", destination_zone: "Casamicciola" }),
        row({ service_id: "b", operational_time: "09:10", pickup_label: "Hotel La Villa", pickup_zone: "Forio", destination_label: "Casamicciola", destination_zone: "Casamicciola" }),
      ],
    });

    expect(result.summary.planned_services_count).toBe(2);
    expect(result.proposed_groups).toHaveLength(1);
    expect(result.proposed_groups[0]?.explanation).toContain("Servizi nello stesso punto/hotel");
  });

  it("groups departures in the same zone when buffer is sufficient", () => {
    const result = planAutoAssignPreview({
      availability_confirmed: true,
      drivers,
      vehicles,
      services: [
        row({ service_id: "a", operational_time: "09:00", pickup_label: "Hotel A", pickup_zone: "Forio" }),
        row({ service_id: "b", operational_time: "09:35", pickup_label: "Hotel B", pickup_zone: "Forio" }),
      ],
    });

    expect(result.summary.planned_services_count).toBe(2);
    expect(result.proposed_groups).toHaveLength(1);
  });

  it("does not group Forio and Ischia Porto at the same time", () => {
    const result = planAutoAssignPreview({
      availability_confirmed: true,
      drivers,
      vehicles,
      services: [
        row({ service_id: "forio", operational_time: "09:00", pickup_label: "Hotel Forio", pickup_zone: "Forio", destination_label: "Forio", destination_zone: "Forio" }),
        row({ service_id: "ischia", operational_time: "09:05", pickup_label: "Hotel Ischia", pickup_zone: "Ischia Porto", destination_label: "Ischia Porto", destination_zone: "Ischia Porto" }),
      ],
    });

    expect(result.summary.planned_services_count).toBe(2);
    expect(result.proposed_groups).toHaveLength(2);
  });

  it("groups arrivals from the same port window", () => {
    const result = planAutoAssignPreview({
      availability_confirmed: true,
      drivers,
      vehicles,
      services: [
        row({ service_id: "a", macro_category: "ARRIVO", operational_time: "10:10", pickup_label: "Ischia Porto", pickup_zone: "Ischia Porto", destination_label: "Hotel A", destination_zone: "Ischia Porto" }),
        row({ service_id: "b", macro_category: "ARRIVO", operational_time: "10:20", pickup_label: "Ischia Porto", pickup_zone: "Ischia Porto", destination_label: "Hotel B", destination_zone: "Ischia Porto" }),
      ],
    });

    expect(result.proposed_groups).toHaveLength(1);
    expect(result.proposed_groups[0]?.macro_categories).toEqual(["ARRIVO"]);
  });

  it("keeps a 21 pax excursion as a dedicated warned group", () => {
    const result = planAutoAssignPreview({
      availability_confirmed: true,
      drivers,
      vehicles,
      services: [
        row({ service_id: "gpr", macro_category: "ESCURSIONE", pax: 21, capacity_required: 21, pickup_label: "Parco Aurora", pickup_zone: "Ischia Porto", destination_label: "Mortella", destination_zone: "Forio" }),
      ],
    });

    expect(result.proposed_groups).toHaveLength(1);
    expect(result.proposed_groups[0]?.vehicle_label).toBe("Bus 25");
    expect(result.proposed_groups[0]?.warnings).toContain("Escursione pax alto: giro dedicato consigliato");
  });

  it("does not plan services that resolver marked as needs_review", () => {
    const result = planAutoAssignPreview({
      availability_confirmed: true,
      drivers,
      vehicles,
      services: [
        row({ service_id: "cazzanti", assignable: false, needs_review: true, review_reasons: ["Porto imbarco non determinato"] }),
        row({ service_id: "fest", assignable: false, needs_review: true, review_reasons: ["Arrivo isola non determinato"] }),
        row({ service_id: "president", assignable: false, needs_review: true, review_reasons: ["Pickup navetta non abbastanza specifico"] }),
      ],
    });

    expect(result.summary.candidate_services).toBe(0);
    expect(result.proposed_groups).toHaveLength(0);
  });

  it("protects locked assignments and uses availability confirmation as a hard gate", () => {
    const result = planAutoAssignPreview({
      availability_confirmed: false,
      drivers,
      vehicles,
      services: [
        row({ service_id: "locked", is_locked: true, assignable: false }),
        row({ service_id: "candidate" }),
      ],
      locked_assignments: [{ service_id: "locked", driver_id: "driver-1", driver_name: "Mario", vehicle_label: "Vito" }],
    });

    expect(result.protected_locked).toHaveLength(1);
    expect(result.summary.candidate_services).toBe(1);
    expect(result.summary.planned_services_count).toBe(0);
    expect(result.unplanned[0]?.reason).toBe("Disponibilita del giorno non confermata");
  });

  it("uses conservative buffers for unknown zones", () => {
    const buffer = estimateTravelBuffer(
      row({ destination_label: "Luogo A", destination_zone: null }),
      row({ pickup_label: "Luogo B", pickup_zone: null })
    );

    expect(buffer.minutes).toBe(60);
    expect(buffer.warning).toContain("Zona sconosciuta");
  });

  it("uses five different vehicles for five overlapping compatible trips", () => {
    const manyDrivers: PlannerDriver[] = Array.from({ length: 5 }, (_, index) => ({
      id: `driver-${index + 1}`,
      name: `Driver ${index + 1}`,
    }));
    const manyVehicles: PlannerVehicle[] = Array.from({ length: 5 }, (_, index) => ({
      id: `vehicle-${index + 1}`,
      label: `Mezzo ${index + 1}`,
      capacity: 8,
    }));

    const result = planAutoAssignPreview({
      availability_confirmed: true,
      drivers: manyDrivers,
      vehicles: manyVehicles,
      services: Array.from({ length: 5 }, (_, index) => row({
        service_id: `svc-${index + 1}`,
        operational_time: "09:00",
        pickup_label: `Hotel ${index + 1}`,
        pickup_zone: index % 2 === 0 ? "Forio" : "Ischia Porto",
        destination_label: `Porto ${index + 1}`,
        destination_zone: index % 2 === 0 ? "Casamicciola" : "Ischia Porto",
      })),
    });

    expect(result.proposed_groups).toHaveLength(5);
    expect(new Set(result.proposed_groups.map((group) => group.vehicle_id)).size).toBe(5);
  });

  it("blocks reusing the same vehicle on overlapping trips", () => {
    const result = planAutoAssignPreview({
      availability_confirmed: true,
      drivers,
      vehicles: [{ id: "vito", label: "Vito", capacity: 8 }],
      services: [
        row({ service_id: "locked", is_locked: true, assignable: false, already_assigned: true, operational_time: "09:00" }),
        row({ service_id: "candidate", operational_time: "09:10" }),
      ],
      locked_assignments: [{
        service_id: "locked",
        driver_id: "driver-1",
        driver_name: "Mario",
        vehicle_id: "vito",
        vehicle_label: "Vito",
      }],
    });

    expect(result.proposed_groups).toHaveLength(0);
    expect(result.conflicts[0]?.reason).toBe("Nessun mezzo disponibile con capienza sufficiente");
  });

  it("allows the same vehicle on non-overlapping trips with sufficient buffer", () => {
    const result = planAutoAssignPreview({
      availability_confirmed: true,
      drivers,
      vehicles: [{ id: "vito", label: "Vito", capacity: 8 }],
      services: [
        row({ service_id: "locked", is_locked: true, assignable: false, already_assigned: true, operational_time: "09:00" }),
        row({ service_id: "candidate", operational_time: "10:30" }),
      ],
      locked_assignments: [{
        service_id: "locked",
        driver_id: "driver-1",
        driver_name: "Mario",
        vehicle_id: "vito",
        vehicle_label: "Vito",
      }],
    });

    expect(result.proposed_groups).toHaveLength(1);
    expect(result.proposed_groups[0]?.vehicle_id).toBe("vito");
  });

  it("allows a large vehicle to be shared by different drivers on non-overlapping large trips", () => {
    const result = planAutoAssignPreview({
      availability_confirmed: true,
      drivers,
      vehicles: [{ id: "bus25", label: "Bus 25", capacity: 25 }],
      services: [
        row({ service_id: "first", macro_category: "ESCURSIONE", operational_time: "09:00", pax: 21, capacity_required: 21 }),
        row({ service_id: "second", macro_category: "ESCURSIONE", operational_time: "11:00", pax: 21, capacity_required: 21, pickup_label: "Mortella" }),
      ],
    });

    expect(result.proposed_groups).toHaveLength(2);
    expect(new Set(result.proposed_groups.map((group) => group.vehicle_id))).toEqual(new Set(["bus25"]));
  });

  it("does not select vehicles with insufficient capacity", () => {
    const result = planAutoAssignPreview({
      availability_confirmed: true,
      drivers,
      vehicles: [{ id: "small", label: "Small", capacity: 3 }],
      services: [row({ service_id: "big", pax: 4, capacity_required: 4 })],
    });

    expect(result.proposed_groups).toHaveLength(0);
    expect(result.conflicts[0]?.conflict_type).toBe("capacity");
  });

  it("uses an unused vehicle before duplicating another vehicle", () => {
    const result = planAutoAssignPreview({
      availability_confirmed: true,
      drivers,
      vehicles: [
        { id: "vito", label: "Vito", capacity: 8 },
        { id: "ducato", label: "Ducato", capacity: 14 },
      ],
      services: [
        row({ service_id: "first", operational_time: "09:00", pickup_label: "Hotel A" }),
        row({ service_id: "second", macro_category: "ESCURSIONE", operational_time: "10:30", pickup_label: "Hotel B", destination_label: "Mortella", destination_zone: "Forio" }),
      ],
    });

    expect(result.proposed_groups).toHaveLength(2);
    expect(new Set(result.proposed_groups.map((group) => group.vehicle_id))).toEqual(new Set(["vito", "ducato"]));
  });

  it("uses vehicle_id as the primary timeline key when labels are duplicated", () => {
    const result = planAutoAssignPreview({
      availability_confirmed: true,
      drivers,
      vehicles: [
        { id: "vito-a", label: "VITO EXTRA LONG", capacity: 8 },
        { id: "vito-b", label: "VITO EXTRA LONG", capacity: 8 },
      ],
      services: [
        row({ service_id: "a", operational_time: "09:00", pickup_label: "Hotel A" }),
        row({ service_id: "b", operational_time: "09:00", pickup_label: "Hotel B" }),
      ],
    });

    expect(result.proposed_groups).toHaveLength(2);
    expect(new Set(result.proposed_groups.map((group) => group.vehicle_id))).toEqual(new Set(["vito-a", "vito-b"]));
  });

  it("falls back to vehicle_label with a warning when vehicle_id is missing", () => {
    expect(vehicleResourceKey({ id: null, label: "VITO EXTRA LONG" })).toEqual({
      key: "label:vito extra long",
      warning: "Mezzo \"VITO EXTRA LONG\" senza vehicle_id: validazione esclusivita basata su vehicle_label.",
    });
    expect(vehicleIntervalsOverlap({ start_min: 540, end_min: 570 }, { start_min: 560, end_min: 590 }, 20)).toBe(true);
  });
});
