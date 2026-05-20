import { describe, expect, it } from "vitest";

import { buildResolutionPreview } from "@/lib/piano-conflict-resolution-preview";
import { buildRealGiroDiagnostics, type RealGiroDiagnosticAssignment, type RealGiroDiagnosticTripGroup } from "@/lib/piano-real-giro-diagnostics";
import { buildSuggestionHash } from "@/lib/server/piano-operator-decisions";
import { canDriverCoverInterval } from "@/lib/piano-driver-availability";
import type { AutoAssignPreviewHotel, AutoAssignPreviewService } from "@/lib/piano-assignable-preview";

const hotels: AutoAssignPreviewHotel[] = [
  { id: "re-ferdinando", name: "RE FERDINANDO", zone: "Ischia Porto" },
  { id: "punto-azzurro", name: "RESORT PUNTO AZZURRO", zone: "Forio" },
  { id: "president", name: "HOTEL TERME PRESIDENT", zone: "Ischia Porto" },
  { id: "forio", name: "HOTEL FORIO", zone: "Forio" },
  { id: "san-nicola", name: "HOTEL SAN NICOLA", zone: "Forio" },
  { id: "cristallo", name: "HOTEL CRISTALLO", zone: "Casamicciola" },
];

function group(overrides: Partial<RealGiroDiagnosticTripGroup> = {}): RealGiroDiagnosticTripGroup {
  return {
    id: "group-1",
    date: "2026-05-07",
    driver_profile_id: "driver-1",
    driver_user_id: "user-1",
    vehicle_label: "Vito",
    ...overrides,
  };
}

function assignment(serviceId: string, groupId = "group-1"): RealGiroDiagnosticAssignment {
  return {
    service_id: serviceId,
    group_id: groupId,
    driver_profile_id: "driver-1",
    driver_user_id: "user-1",
    vehicle_label: "Vito",
  };
}

function service(overrides: Partial<AutoAssignPreviewService>): AutoAssignPreviewService {
  return {
    id: "svc-1",
    date: "2026-05-07",
    time: "09:00",
    direction: "departure",
    customer_name: "CLIENTE TEST",
    pax: 2,
    service_type: "transfer",
    ...overrides,
  };
}

function vehicleInput(overrides: {
  groups: Array<{ id: string; driver_profile_id: string; vehicle_label: string | null }>;
  services: Array<Partial<AutoAssignPreviewService> & { id: string; group_id: string }>;
  vehicles: Array<{ id: string; label: string; capacity: number }>;
  drivers?: Array<{ driver_profile_id: string; driver_name: string; max_vehicle_capacity?: number | null }>;
}) {
  const drivers = overrides.drivers ?? overrides.groups.map((item) => ({
    driver_profile_id: item.driver_profile_id,
    driver_name: item.driver_profile_id,
    max_vehicle_capacity: null,
  }));
  return {
    date: "2026-05-07",
    services: overrides.services.map(({ group_id: _groupId, ...item }) => service({
      customer_name: item.id,
      hotel_id: "re-ferdinando",
      pickup_hotel: item.pickup_hotel ?? item.time ?? "09:00",
      booking_service_kind: "formula_medmar",
      service_type_code: "ferry_transfer",
      pax: item.pax ?? 2,
      ...item,
    })),
    hotels,
    assignments: overrides.services.map((item) => ({
      service_id: item.id,
      group_id: item.group_id,
      driver_profile_id: overrides.groups.find((groupItem) => groupItem.id === item.group_id)?.driver_profile_id ?? null,
      driver_user_id: null,
      vehicle_label: overrides.groups.find((groupItem) => groupItem.id === item.group_id)?.vehicle_label ?? null,
    })),
    tripGroups: overrides.groups.map((item) => group({
      id: item.id,
      driver_profile_id: item.driver_profile_id,
      driver_user_id: null,
      vehicle_label: item.vehicle_label,
    })),
    driverNamesByProfileId: new Map(drivers.map((driver) => [driver.driver_profile_id, driver.driver_name])),
    vehicles: overrides.vehicles,
    drivers,
  };
}

describe("buildRealGiroDiagnostics", () => {
  it("does not count a large vehicle shared on a valid timeline as vehicle conflict", () => {
    const result = buildRealGiroDiagnostics(vehicleInput({
      groups: [
        { id: "large-a", driver_profile_id: "driver-a", vehicle_label: "BUS 25" },
        { id: "large-b", driver_profile_id: "driver-b", vehicle_label: "BUS 25" },
      ],
      services: [
        { id: "svc-a", group_id: "large-a", pickup_hotel: "09:00", pax: 21 },
        { id: "svc-b", group_id: "large-b", pickup_hotel: "12:00", pax: 21 },
      ],
      vehicles: [{ id: "bus-25", label: "BUS 25", capacity: 25 }],
    }));

    expect(result.summary.vehicle_conflict_count).toBe(0);
    expect(result.vehicle_diagnostics.vehicle_binding.large_vehicle_shared_timeline_ok).toHaveLength(1);
  });

  it("counts a large vehicle shared with overlap as blocker", () => {
    const result = buildRealGiroDiagnostics(vehicleInput({
      groups: [
        { id: "large-a", driver_profile_id: "driver-a", vehicle_label: "BUS 25" },
        { id: "large-b", driver_profile_id: "driver-b", vehicle_label: "BUS 25" },
      ],
      services: [
        { id: "svc-a", group_id: "large-a", pickup_hotel: "09:00", pax: 21 },
        { id: "svc-b", group_id: "large-b", pickup_hotel: "09:10", pax: 21 },
      ],
      vehicles: [{ id: "bus-25", label: "BUS 25", capacity: 25 }],
    }));

    expect(result.summary.vehicle_conflict_count).toBe(1);
    expect(result.vehicle_diagnostics.vehicle_binding.large_vehicle_shared_timeline_conflict).toHaveLength(1);
  });

  it("counts a standard vehicle shared between different drivers as blocker", () => {
    const result = buildRealGiroDiagnostics(vehicleInput({
      groups: [
        { id: "std-a", driver_profile_id: "driver-a", vehicle_label: "VITO" },
        { id: "std-b", driver_profile_id: "driver-b", vehicle_label: "VITO" },
      ],
      services: [
        { id: "svc-a", group_id: "std-a", pickup_hotel: "09:00", pax: 2 },
        { id: "svc-b", group_id: "std-b", pickup_hotel: "12:00", pax: 2 },
      ],
      vehicles: [{ id: "vito", label: "VITO", capacity: 8 }],
    }));

    expect(result.summary.vehicle_conflict_count).toBe(1);
    expect(result.vehicle_diagnostics.vehicle_binding.standard_vehicle_same_day_conflict).toHaveLength(1);
  });

  it("counts a vehicle with insufficient capacity as blocker", () => {
    const result = buildRealGiroDiagnostics(vehicleInput({
      groups: [{ id: "under-capacity", driver_profile_id: "driver-a", vehicle_label: "VITO" }],
      services: [{ id: "svc-a", group_id: "under-capacity", pickup_hotel: "09:00", pax: 9 }],
      vehicles: [{ id: "vito", label: "VITO", capacity: 8 }],
    }));

    expect(result.summary.vehicle_conflict_count).toBe(1);
    expect(result.vehicle_diagnostics.vehicle_binding.vehicle_capacity_insufficient).toHaveLength(1);
  });

  it("counts a driver not eligible for the proposed vehicle as blocker", () => {
    const result = buildRealGiroDiagnostics(vehicleInput({
      groups: [{ id: "not-eligible", driver_profile_id: "driver-a", vehicle_label: "BUS 25" }],
      services: [{ id: "svc-a", group_id: "not-eligible", pickup_hotel: "09:00", pax: 21 }],
      vehicles: [{ id: "bus-25", label: "BUS 25", capacity: 25 }],
      drivers: [{ driver_profile_id: "driver-a", driver_name: "Driver A", max_vehicle_capacity: 8 }],
    }));

    expect(result.summary.vehicle_conflict_count).toBe(1);
    expect(result.vehicle_diagnostics.vehicle_binding.driver_vehicle_eligibility_blocker).toHaveLength(1);
  });

  it("keeps vehicle diagnostics clean after vehicle_binding_confirmed when binding is already aligned", () => {
    const result = buildRealGiroDiagnostics({
      ...vehicleInput({
        groups: [
          { id: "large-a", driver_profile_id: "driver-a", vehicle_label: "BUS 25" },
          { id: "large-b", driver_profile_id: "driver-b", vehicle_label: "BUS 25" },
        ],
        services: [
          { id: "svc-a", group_id: "large-a", pickup_hotel: "09:00", pax: 21 },
          { id: "svc-b", group_id: "large-b", pickup_hotel: "12:00", pax: 21 },
        ],
        vehicles: [{ id: "bus-25", label: "BUS 25", capacity: 25 }],
      }),
      operatorDecisions: [{
        id: "vehicle-binding-decision",
        tenant_id: "tenant-1",
        service_date: "2026-05-07",
        trip_group_id: null,
        suggestion_hash: "hash",
        confirmed_by: "operator-1",
        confirmed_at: "2026-05-19T12:00:00.000Z",
        status: "confirmed",
      }],
    });

    expect(result.summary.vehicle_conflict_count).toBe(0);
    expect(result.vehicle_diagnostics.vehicle_binding.changes_needed).toBe(0);
  });

  it("merges same-stop services inside a real group without zero-minute conflict", () => {
    const result = buildRealGiroDiagnostics({
      date: "2026-05-07",
      services: [
        service({
          id: "pettennuzzo",
          customer_name: "PETTENNUZZO",
          pax: 4,
          hotel_id: "re-ferdinando",
          pickup_hotel: "06:30",
          booking_service_kind: "formula_snav",
          service_type_code: "ferry_transfer",
          barca_compagnia: "SNAV",
          orario_barca: "07:10",
          ferry_details: { departure_port: "Casamicciola" },
        }),
        service({
          id: "cam",
          customer_name: "CAM 176X2 - 330X1",
          pax: 3,
          hotel_id: "re-ferdinando",
          pickup_hotel: "06:30",
          booking_service_kind: "formula_snav",
          service_type_code: "ferry_transfer",
          barca_compagnia: "SNAV",
          orario_barca: "07:10",
          ferry_details: { departure_port: "Casamicciola" },
        }),
      ],
      hotels,
      assignments: [assignment("pettennuzzo"), assignment("cam")],
      tripGroups: [group()],
    });

    expect(result.groups[0]?.same_stop_count).toBe(1);
    expect(result.groups[0]?.conflict_count).toBe(0);
    expect(result.groups[0]?.transitions[0]?.type).toBe("SAME_STOP");
  });

  it("marks different close services as not operational", () => {
    const result = buildRealGiroDiagnostics({
      date: "2026-05-07",
      services: [
        service({
          id: "president",
          customer_name: "NAVETTA PRESIDENT",
          hotel_id: "president",
          pickup_hotel: "08:35",
          booking_service_kind: "navetta",
          service_type_code: "bus_line",
          meeting_point: "Ischia Porto",
        }),
        service({
          id: "forio",
          customer_name: "NAVETTA FORIO",
          hotel_id: "forio",
          pickup_hotel: "08:40",
          booking_service_kind: "navetta",
          service_type_code: "bus_line",
          meeting_point: "Forio Porto",
        }),
      ],
      hotels,
      assignments: [assignment("president"), assignment("forio")],
      tripGroups: [group()],
    });

    expect(result.groups[0]?.status).toBe("NOT_OPERATIONAL");
    expect(result.groups[0]?.conflict_count).toBeGreaterThan(0);
    expect(result.resolution_suggestions[0]?.recommended_action).toBeTruthy();
  });

  it("reads a confirmed operator decision and removes that conflict from group status", () => {
    const baseInput = {
      tenantId: "tenant-1",
      date: "2026-05-07",
      services: [
        service({
          id: "iori",
          customer_name: "IORI",
          hotel_id: "re-ferdinando",
          pickup_hotel: "12:15",
          booking_service_kind: "formula_medmar",
          service_type_code: "ferry_transfer",
          barca_compagnia: "Medmar",
          orario_barca: "13:35",
          ferry_details: { departure_port: "Casamicciola" },
        }),
        service({
          id: "rossi",
          customer_name: "ROSSI",
          hotel_id: "re-ferdinando",
          pickup_hotel: "12:30",
          booking_service_kind: "formula_snav",
          service_type_code: "ferry_transfer",
          barca_compagnia: "SNAV",
          orario_barca: "14:00",
          ferry_details: { departure_port: "Casamicciola" },
        }),
      ],
      hotels,
      assignments: [assignment("iori"), assignment("rossi")],
      tripGroups: [group()],
    };
    const first = buildRealGiroDiagnostics(baseInput);
    const suggestion = first.resolution_suggestions[0]!;
    const preview = buildResolutionPreview(suggestion);
    const suggestionHash = buildSuggestionHash({
      tenant_id: "tenant-1",
      service_date: "2026-05-07",
      trip_group_id: suggestion.group_id,
      action: suggestion.recommended_action,
      service_ids: suggestion.involved_services.map((item) => item.service_id),
      before_json: preview.before,
      after_json: preview.after,
    });

    const confirmed = buildRealGiroDiagnostics({
      ...baseInput,
      operatorDecisions: [{
        id: "decision-1",
        tenant_id: "tenant-1",
        service_date: "2026-05-07",
        trip_group_id: suggestion.group_id,
        suggestion_hash: suggestionHash,
        confirmed_by: "operator-1",
        confirmed_at: "2026-05-18T12:00:00.000Z",
        status: "confirmed",
      }],
    });

    expect(first.groups[0]?.status).toBe("NOT_OPERATIONAL");
    expect(confirmed.groups[0]?.status).toBe("OK");
    expect(confirmed.groups[0]?.conflict_count).toBe(0);
    expect(confirmed.summary.groups_with_conflicts).toBe(0);
    expect(confirmed.resolution_suggestions[0]?.operator_confirmed).toBe(true);
    expect(confirmed.resolution_suggestions[0]?.operator_decision_id).toBe("decision-1");
  });

  it("reads a confirmed multi-drop decision and stops proposing it as active problem", () => {
    const baseInput = {
      tenantId: "tenant-1",
      date: "2026-05-07",
      services: [
        service({
          id: "polillo",
          time: "17:15",
          direction: "arrival",
          customer_name: "POLILLO",
          pax: 2,
          booking_service_kind: "excursion",
          service_type_code: "excursion",
          service_type: "bus_tour",
          excursion_details: { from: "MORTELLA", to: "RE FERDINANDO" },
        }),
        service({
          id: "cam335",
          time: "17:15",
          direction: "arrival",
          customer_name: "CAM 335",
          pax: 1,
          booking_service_kind: "excursion",
          service_type_code: "excursion",
          service_type: "bus_tour",
          excursion_details: { from: "MORTELLA", to: "CRISTALLO" },
        }),
      ],
      hotels,
      assignments: [assignment("polillo"), assignment("cam335")],
      tripGroups: [group()],
    };
    const first = buildRealGiroDiagnostics(baseInput);
    const suggestion = first.resolution_suggestions.find((item) => item.recommended_action === "MULTI_DROP")!;
    const preview = buildResolutionPreview(suggestion);
    const suggestionHash = buildSuggestionHash({
      tenant_id: "tenant-1",
      service_date: "2026-05-07",
      trip_group_id: suggestion.group_id,
      action: suggestion.recommended_action,
      service_ids: suggestion.involved_services.map((item) => item.service_id),
      before_json: preview.before,
      after_json: preview.after,
    });

    const confirmed = buildRealGiroDiagnostics({
      ...baseInput,
      operatorDecisions: [{
        id: "decision-multidrop",
        tenant_id: "tenant-1",
        service_date: "2026-05-07",
        trip_group_id: suggestion.group_id,
        suggestion_hash: suggestionHash,
        confirmed_by: "operator-1",
        confirmed_at: "2026-05-18T12:00:00.000Z",
        status: "confirmed",
      }],
    });

    expect(suggestion.recommended_action).toBe("MULTI_DROP");
    expect(first.groups[0]?.status).toBe("NOT_OPERATIONAL");
    expect(confirmed.groups[0]?.status).toBe("OK");
    expect(confirmed.summary.groups_with_conflicts).toBe(0);
    expect(confirmed.resolution_suggestions[0]?.operator_confirmed).toBe(true);
    expect(confirmed.resolution_suggestions[0]?.operator_decision_id).toBe("decision-multidrop");
  });

  it("matches confirmed multi-drop decisions by service ids when the original trip group changed", () => {
    const baseInput = {
      tenantId: "tenant-1",
      date: "2026-05-07",
      services: [
        service({
          id: "catullo",
          time: "08:30",
          direction: "arrival",
          customer_name: "CATULLO",
          booking_service_kind: "excursion",
          service_type_code: "excursion",
          service_type: "bus_tour",
          excursion_details: { from: "LA VILLA", to: "Casamicciola" },
        }),
        service({
          id: "lodi",
          time: "08:30",
          direction: "arrival",
          customer_name: "LODI",
          booking_service_kind: "excursion",
          service_type_code: "excursion",
          service_type: "bus_tour",
          excursion_details: { from: "LA VILLA", to: "Casamicciola" },
        }),
        service({
          id: "paoletti",
          time: "08:30",
          direction: "arrival",
          customer_name: "PAOLETTI",
          booking_service_kind: "excursion",
          service_type_code: "excursion",
          service_type: "bus_tour",
          excursion_details: { from: "LA VILLA", to: "Ischia Porto" },
        }),
        service({
          id: "lamantia",
          time: "08:30",
          direction: "arrival",
          customer_name: "LA MANTIA",
          booking_service_kind: "excursion",
          service_type_code: "excursion",
          service_type: "bus_tour",
          excursion_details: { from: "LA VILLA", to: "Casamicciola" },
        }),
      ],
      hotels,
      assignments: [
        assignment("catullo", "current-group"),
        assignment("lodi", "current-group"),
        assignment("paoletti", "current-group"),
        assignment("lamantia", "current-group"),
      ],
      tripGroups: [group({ id: "current-group" })],
    };
    const first = buildRealGiroDiagnostics(baseInput);
    const suggestion = first.resolution_suggestions.find((item) => item.recommended_action === "MULTI_DROP")!;

    const confirmed = buildRealGiroDiagnostics({
      ...baseInput,
      operatorDecisions: [{
        id: "decision-riccardo",
        tenant_id: "tenant-1",
        service_date: "2026-05-07",
        trip_group_id: "old-group",
        decision_type: "multi_drop_confirmed",
        action: "MULTI_DROP",
        suggestion_hash: "old-hash",
        payload_json: { suggestion: { involved_services: suggestion.involved_services } },
        before_json: null,
        after_json: null,
        confirmed_by: "operator-1",
        confirmed_at: "2026-05-18T12:00:00.000Z",
        status: "confirmed",
      }],
    });

    expect(first.groups[0]?.status).toBe("NOT_OPERATIONAL");
    expect(confirmed.groups[0]?.status).toBe("OK");
    expect(confirmed.summary.total_conflicts).toBe(0);
    expect(confirmed.resolution_suggestions[0]?.operator_confirmed).toBe(true);
    expect(confirmed.resolution_suggestions[0]?.operator_decision_type).toBe("multi_drop_confirmed");
  });

  it("matches confirmed accorpamento decisions by service ids when the original trip group changed", () => {
    const baseInput = {
      tenantId: "tenant-1",
      date: "2026-05-07",
      services: [
        service({
          id: "iori",
          customer_name: "IORI",
          hotel_id: "re-ferdinando",
          pickup_hotel: "12:15",
          booking_service_kind: "formula_medmar",
          service_type_code: "ferry_transfer",
          barca_compagnia: "Medmar",
          orario_barca: "13:30",
          ferry_details: { departure_port: "Casamicciola" },
        }),
        service({
          id: "rossi",
          customer_name: "ROSSI",
          hotel_id: "re-ferdinando",
          pickup_hotel: "12:30",
          booking_service_kind: "formula_snav",
          service_type_code: "ferry_transfer",
          barca_compagnia: "SNAV",
          orario_barca: "14:00",
          ferry_details: { departure_port: "Casamicciola" },
        }),
      ],
      hotels,
      assignments: [assignment("iori", "current-accorpamento"), assignment("rossi", "current-accorpamento")],
      tripGroups: [group({ id: "current-accorpamento" })],
    };
    const first = buildRealGiroDiagnostics(baseInput);
    const suggestion = first.resolution_suggestions.find((item) => item.recommended_action === "ACCORPARE_CON_CONFERMA")!;

    const confirmed = buildRealGiroDiagnostics({
      ...baseInput,
      operatorDecisions: [{
        id: "decision-accorpamento",
        tenant_id: "tenant-1",
        service_date: "2026-05-07",
        trip_group_id: "old-accorpamento",
        decision_type: "accorpamento_confirmed",
        action: "ACCORPARE_CON_CONFERMA",
        suggestion_hash: "old-hash",
        payload_json: { suggestion: { involved_services: suggestion.involved_services } },
        before_json: null,
        after_json: null,
        confirmed_by: "operator-1",
        confirmed_at: "2026-05-18T12:00:00.000Z",
        status: "confirmed",
      }],
    });

    expect(first.groups[0]?.status).toBe("NOT_OPERATIONAL");
    expect(confirmed.groups[0]?.status).toBe("OK");
    expect(confirmed.summary.groups_with_conflicts).toBe(0);
    expect(confirmed.resolution_suggestions[0]?.operator_decision_type).toBe("accorpamento_confirmed");
  });

  it("does not suppress a conflict with a superseded decision", () => {
    const baseInput = {
      tenantId: "tenant-1",
      date: "2026-05-07",
      services: [
        service({
          id: "polillo",
          time: "17:15",
          direction: "arrival",
          customer_name: "POLILLO",
          booking_service_kind: "excursion",
          service_type_code: "excursion",
          service_type: "bus_tour",
          excursion_details: { from: "MORTELLA", to: "RE FERDINANDO" },
        }),
        service({
          id: "cam335",
          time: "17:15",
          direction: "arrival",
          customer_name: "CAM 335",
          booking_service_kind: "excursion",
          service_type_code: "excursion",
          service_type: "bus_tour",
          excursion_details: { from: "MORTELLA", to: "CRISTALLO" },
        }),
      ],
      hotels,
      assignments: [assignment("polillo"), assignment("cam335")],
      tripGroups: [group()],
    };
    const first = buildRealGiroDiagnostics(baseInput);
    const suggestion = first.resolution_suggestions[0]!;
    const result = buildRealGiroDiagnostics({
      ...baseInput,
      operatorDecisions: [{
        id: "decision-superseded",
        tenant_id: "tenant-1",
        service_date: "2026-05-07",
        trip_group_id: suggestion.group_id,
        decision_type: "multi_drop_confirmed",
        action: "MULTI_DROP",
        suggestion_hash: "old-hash",
        payload_json: { suggestion: { involved_services: suggestion.involved_services } },
        before_json: null,
        after_json: null,
        confirmed_by: "operator-1",
        confirmed_at: "2026-05-18T12:00:00.000Z",
        status: "superseded",
      }],
    });

    expect(result.groups[0]?.status).toBe("NOT_OPERATIONAL");
    expect(result.summary.groups_with_conflicts).toBe(1);
    expect(result.resolution_suggestions[0]?.operator_confirmed).toBeUndefined();
  });

  it("turns President outbound/inbound into shuttle-pair instead of internal overlap", () => {
    const result = buildRealGiroDiagnostics({
      date: "2026-05-07",
      services: [
        service({
          id: "president-out",
          time: "08:30",
          direction: "departure",
          customer_name: "Hotel President",
          hotel_id: "president",
          booking_service_kind: "navetta",
          meeting_point: "Piazzale Trieste 6, Ischia (Caffè del Direttore)",
        }),
        service({
          id: "president-in",
          time: "08:35",
          direction: "arrival",
          customer_name: "Hotel President",
          hotel_id: "president",
          booking_service_kind: "navetta",
          meeting_point: "Piazzale Trieste 6, Ischia (Caffè del Direttore)",
        }),
      ],
      hotels,
      assignments: [assignment("president-out"), assignment("president-in")],
      tripGroups: [group()],
    });

    expect(result.groups[0]?.status).toBe("OK");
    expect(result.groups[0]?.shuttle_pair_count).toBe(1);
    expect(result.groups[0]?.conflict_count).toBe(0);
    expect(result.groups[0]?.shuttle_pairs[0]?.loop_label).toContain("NAVETTA CICLO");
    expect(result.summary.total_shuttle_pairs).toBe(1);
    expect(result.summary.overlaps_removed_by_shuttle_pair).toBe(1);
  });

  it("keeps real external conflict after President shuttle-pair", () => {
    const result = buildRealGiroDiagnostics({
      date: "2026-05-07",
      services: [
        service({
          id: "president-out",
          time: "08:30",
          direction: "departure",
          customer_name: "Hotel President",
          hotel_id: "president",
          booking_service_kind: "navetta",
          meeting_point: "Piazzale Trieste 6, Ischia (Caffè del Direttore)",
        }),
        service({
          id: "president-in",
          time: "08:35",
          direction: "arrival",
          customer_name: "Hotel President",
          hotel_id: "president",
          booking_service_kind: "navetta",
          meeting_point: "Piazzale Trieste 6, Ischia (Caffè del Direttore)",
        }),
        service({
          id: "forio",
          time: "08:40",
          direction: "departure",
          customer_name: "NAVETTA FORIO",
          hotel_id: "forio",
          booking_service_kind: "navetta",
          meeting_point: "Forio Porto",
        }),
      ],
      hotels,
      assignments: [assignment("president-out"), assignment("president-in"), assignment("forio")],
      tripGroups: [group()],
    });

    expect(result.groups[0]?.shuttle_pair_count).toBe(1);
    expect(result.groups[0]?.status).toBe("NOT_OPERATIONAL");
    expect(result.groups[0]?.conflict_count).toBeGreaterThan(0);
  });

  it("turns San Nicola / Citara recurring cycles into shuttle-pair", () => {
    const result = buildRealGiroDiagnostics({
      date: "2026-05-07",
      services: [
        service({
          id: "san-out",
          time: "09:30",
          direction: "departure",
          customer_name: "Hotel San Nicola",
          hotel_id: "san-nicola",
          booking_service_kind: "navetta",
          meeting_point: "Citara",
        }),
        service({
          id: "san-in",
          time: "09:55",
          direction: "arrival",
          customer_name: "Hotel San Nicola",
          hotel_id: "san-nicola",
          booking_service_kind: "navetta",
          meeting_point: "Citara",
        }),
      ],
      hotels,
      assignments: [assignment("san-out"), assignment("san-in")],
      tripGroups: [group()],
    });

    expect(result.groups[0]?.status).toBe("OK");
    expect(result.groups[0]?.shuttle_pair_count).toBe(1);
    expect(result.groups[0]?.conflict_count).toBe(0);
    expect(result.groups[0]?.shuttle_pairs[0]?.loop_label).toContain("San Nicola / Citara");
    expect(result.summary.total_shuttle_pairs).toBe(1);
  });

  it("does not turn Cristallo realistic timing into shuttle-pair", () => {
    const result = buildRealGiroDiagnostics({
      date: "2026-05-07",
      services: [
        service({
          id: "cri-out",
          time: "16:00",
          direction: "departure",
          customer_name: "Hotel Cristallo",
          hotel_id: "cristallo",
          booking_service_kind: "navetta",
          meeting_point: "Piazza Marina Casamicciola",
        }),
        service({
          id: "cri-in",
          time: "18:15",
          direction: "arrival",
          customer_name: "Hotel Cristallo",
          hotel_id: "cristallo",
          booking_service_kind: "navetta",
          meeting_point: "Piazza Marina Casamicciola",
        }),
      ],
      hotels,
      assignments: [assignment("cri-out"), assignment("cri-in")],
      tripGroups: [group()],
    });

    expect(result.groups[0]?.shuttle_pair_count).toBe(0);
  });

  it("keeps simultaneous excursions as real conflict, not shuttle-pair", () => {
    const result = buildRealGiroDiagnostics({
      date: "2026-05-07",
      services: [
        service({
          id: "exc-a",
          time: "17:15",
          direction: "arrival",
          customer_name: "CAM 1",
          pax: 1,
          booking_service_kind: "excursion",
          service_type_code: "excursion",
          service_type: "bus_tour",
          excursion_details: { from: "MORTELLA", to: "RE FERDINANDO" },
        }),
        service({
          id: "exc-b",
          time: "17:15",
          direction: "arrival",
          customer_name: "CAM 2",
          pax: 1,
          booking_service_kind: "excursion",
          service_type_code: "excursion",
          service_type: "bus_tour",
          excursion_details: { from: "MORTELLA", to: "CRISTALLO" },
        }),
      ],
      hotels,
      assignments: [assignment("exc-a"), assignment("exc-b")],
      tripGroups: [group()],
    });

    expect(result.groups[0]?.shuttle_pair_count).toBe(0);
    expect(result.groups[0]?.status).toBe("NOT_OPERATIONAL");
    expect(result.groups[0]?.conflict_count).toBeGreaterThan(0);
  });

  it("reports Mortella outbound and return excursions as a roundtrip cluster", () => {
    const result = buildRealGiroDiagnostics({
      date: "2026-05-07",
      services: [
        service({
          id: "mortella-out-re",
          time: "14:30",
          customer_name: "POLILLO",
          pax: 4,
          booking_service_kind: "excursion",
          service_type_code: "excursion",
          service_type: "bus_tour",
          excursion_details: { from: "RE FERDINANDO", to: "MORTELLA" },
        }),
        service({
          id: "mortella-out-cristallo",
          time: "14:50",
          customer_name: "CAM 335",
          pax: 1,
          booking_service_kind: "excursion",
          service_type_code: "excursion",
          service_type: "bus_tour",
          excursion_details: { from: "CRISTALLO", to: "MORTELLA" },
        }),
        service({
          id: "mortella-return-cristallo",
          time: "17:15",
          customer_name: "CAM 335",
          pax: 1,
          booking_service_kind: "excursion",
          service_type_code: "excursion",
          service_type: "bus_tour",
          excursion_details: { from: "MORTELLA", to: "CRISTALLO" },
        }),
        service({
          id: "mortella-return-re",
          time: "17:15",
          customer_name: "POLILLO",
          pax: 4,
          booking_service_kind: "excursion",
          service_type_code: "excursion",
          service_type: "bus_tour",
          excursion_details: { from: "MORTELLA", to: "RE FERDINANDO" },
        }),
      ],
      hotels,
      assignments: [
        assignment("mortella-out-re", "outbound"),
        assignment("mortella-out-cristallo", "outbound"),
        assignment("mortella-return-cristallo", "return"),
        assignment("mortella-return-re", "return"),
      ],
      tripGroups: [group({ id: "outbound" }), group({ id: "return" })],
    });

    expect(result.excursion_roundtrip_clusters).toHaveLength(1);
    expect(result.excursion_roundtrip_clusters[0]?.total_pax).toBe(5);
    expect(result.excursion_roundtrip_clusters[0]?.outbound_route).toEqual(["RE FERDINANDO", "CRISTALLO", "MORTELLA"]);
  });

  it("reports GPR Peter as an operator blocker when the large group is not splittable and the driver max is 16", () => {
    const result = buildRealGiroDiagnostics({
      date: "2026-05-07",
      services: [
        service({
          id: "gpr-peter",
          time: "15:00",
          customer_name: "GPR PETER",
          pax: 21,
          booking_service_kind: "excursion",
          service_type_code: "excursion",
          service_type: "bus_tour",
          excursion_details: { from: "PARCO AURORA", to: "MORTELLA" },
        }),
        service({
          id: "mortella-out-re",
          time: "14:30",
          customer_name: "POLILLO",
          pax: 4,
          booking_service_kind: "excursion",
          service_type_code: "excursion",
          service_type: "bus_tour",
          excursion_details: { from: "RE FERDINANDO", to: "MORTELLA" },
        }),
        service({
          id: "mortella-out-cristallo",
          time: "14:50",
          customer_name: "CAM 335",
          pax: 1,
          booking_service_kind: "excursion",
          service_type_code: "excursion",
          service_type: "bus_tour",
          excursion_details: { from: "CRISTALLO", to: "MORTELLA" },
        }),
        service({
          id: "mortella-return-cristallo",
          time: "17:15",
          customer_name: "CAM 335",
          pax: 1,
          booking_service_kind: "excursion",
          service_type_code: "excursion",
          service_type: "bus_tour",
          excursion_details: { from: "MORTELLA", to: "CRISTALLO" },
        }),
        service({
          id: "mortella-return-re",
          time: "17:15",
          customer_name: "POLILLO",
          pax: 4,
          booking_service_kind: "excursion",
          service_type_code: "excursion",
          service_type: "bus_tour",
          excursion_details: { from: "MORTELLA", to: "RE FERDINANDO" },
        }),
      ],
      hotels,
      assignments: [
        { ...assignment("gpr-peter", "gpr"), driver_profile_id: "riccardo", vehicle_label: "25 BIANCO" },
        { ...assignment("mortella-out-re", "mortella-re"), driver_profile_id: "riccardo", vehicle_label: "DUCATO MAXI" },
        { ...assignment("mortella-out-cristallo", "mortella-cam-out"), driver_profile_id: "ilaria", vehicle_label: "TRASPORTER" },
        { ...assignment("mortella-return-cristallo", "mortella-return"), driver_profile_id: "ilaria", vehicle_label: "TRASPORTER" },
        { ...assignment("mortella-return-re", "mortella-return"), driver_profile_id: "ilaria", vehicle_label: "TRASPORTER" },
      ],
      tripGroups: [
        group({ id: "gpr", driver_profile_id: "riccardo", vehicle_label: "25 BIANCO" }),
        group({ id: "mortella-re", driver_profile_id: "riccardo", vehicle_label: "DUCATO MAXI" }),
        group({ id: "mortella-cam-out", driver_profile_id: "ilaria", vehicle_label: "TRASPORTER" }),
        group({ id: "mortella-return", driver_profile_id: "ilaria", vehicle_label: "TRASPORTER" }),
      ],
      driverNamesByProfileId: new Map([
        ["riccardo", "RICCARDO"],
        ["ilaria", "ILARIA"],
        ["leo", "LEO"],
      ]),
      vehicles: [
        { id: "bus-25", label: "25 BIANCO", capacity: 25 },
        { id: "ducato", label: "DUCATO MAXI", capacity: 14 },
        { id: "transporter", label: "TRASPORTER", capacity: 8 },
      ],
      drivers: [
        {
          driver_profile_id: "riccardo",
          driver_name: "RICCARDO",
          max_vehicle_capacity: 16,
          availability: { available: true, available_from: "08:30", available_to: "19:00" },
        },
        {
          driver_profile_id: "ilaria",
          driver_name: "ILARIA",
          max_vehicle_capacity: 40,
          availability: { available: true, available_from: "08:30", available_to: "18:30" },
        },
        {
          driver_profile_id: "leo",
          driver_name: "LEO",
          max_vehicle_capacity: null,
          availability: { available: true, available_from: "16:00", available_to: "22:30" },
        },
      ],
    });

    const blocker = result.operator_required_decisions.find((decision) => decision.id.includes("gpr-peter"));
    expect(blocker?.type).toBe("driver_vehicle_eligibility_blocker");
    expect(blocker?.severity).toBe("blocker");
    expect(blocker?.message).toContain("21 pax");
    expect(blocker?.reasons.join(" ")).toContain("Gruppo non splittabile");
    expect(blocker?.reasons.join(" ")).toContain("Nessun autista alternativo");
    expect(
      result.resolution_suggestions.some((suggestion) =>
        suggestion.involved_services.some((candidate) => candidate.service_id === "mortella-out-cristallo")
      )
    ).toBe(false);
  });

  it("does not propose Leo for the Mortella outbound when Leo starts at 16:00", () => {
    const result = canDriverCoverInterval(
      { available: true, available_from: "16:00", available_to: "22:30" },
      { start_time: "14:30", end_time: "15:20" },
      { missingAvailability: "blocker" }
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("fascia oraria");
  });

  it("reports Mario Zabattta on a 25-seat vehicle and only lists available compatible vehicles", () => {
    const result = buildRealGiroDiagnostics({
      date: "2026-05-07",
      services: [
        service({
          id: "mario-9-pax",
          time: "17:25",
          customer_name: "D'ARIA PLACIDO",
          pax: 9,
          booking_service_kind: "formula_medmar",
          service_type_code: "ferry_transfer",
        }),
      ],
      hotels,
      assignments: [{ ...assignment("mario-9-pax", "mario-z-9"), driver_profile_id: "mario-zabattta", vehicle_label: "25 NAVARRA" }],
      tripGroups: [group({ id: "mario-z-9", driver_profile_id: "mario-zabattta", vehicle_label: "25 NAVARRA" })],
      driverNamesByProfileId: new Map([["mario-zabattta", "MARIO ZABATTTA"]]),
      vehicles: [
        { id: "navarra", label: "25 NAVARRA", capacity: 25 },
        { id: "ducato", label: "DUCATO MAXI", capacity: 14 },
      ],
      drivers: [{ driver_profile_id: "mario-zabattta", driver_name: "MARIO ZABATTTA", max_vehicle_capacity: 16 }],
    });

    const warning = result.operator_required_decisions[0];
    expect(warning?.type).toBe("vehicle_not_drivable_warning");
    expect(warning?.required_vehicle_capacity).toEqual({ min: 9, max: 16 });
    expect(warning?.compatible_available_vehicles).toEqual([{ label: "DUCATO MAXI", capacity: 14 }]);
    expect(warning?.compatible_available_vehicles?.some((vehicle) => vehicle.label === "TOMMASINI")).toBe(false);
  });

  it("uses island arrival time for FEST ROMON inside group diagnostics", () => {
    const result = buildRealGiroDiagnostics({
      date: "2026-05-07",
      services: [
        service({
          id: "fest",
          time: "08:40",
          arrival_time: "08:40",
          direction: "arrival",
          customer_name: "FEST ROMON CELINE",
          hotel_id: "punto-azzurro",
          booking_service_kind: "transfer_airport_hotel",
          service_type_code: "transfer_airport_hotel",
          place_type: "airport",
          meeting_point: "AEROPORTO",
          transport_code: "LX1712",
          ferry_details: {
            ferry_company: "Caremar",
            departure_time: "10:45",
            arrival_port: "Ischia Porto",
          },
        }),
      ],
      hotels,
      assignments: [assignment("fest")],
      tripGroups: [group()],
    });

    expect(result.groups[0]?.stops[0]?.operational_time).toBe("12:15");
    expect(result.groups[0]?.stops[0]?.operational_time).not.toBe("08:40");
  });

  it("marks a group with needs_review service as not operational", () => {
    const result = buildRealGiroDiagnostics({
      date: "2026-05-07",
      services: [
        service({
          id: "gpr",
          customer_name: "GPR PETER",
          pax: 21,
          booking_service_kind: "excursion",
          service_type_code: "excursion",
          service_type: "bus_tour",
          excursion_details: { from: "PARCO AURORA" },
        }),
      ],
      hotels,
      assignments: [assignment("gpr")],
      tripGroups: [group()],
    });

    expect(result.groups[0]?.status).toBe("NOT_OPERATIONAL");
    expect(result.groups[0]?.needs_review_count).toBe(1);
    expect(result.summary.total_needs_review).toBe(1);
  });

  it("marks a clean group as OK", () => {
    const result = buildRealGiroDiagnostics({
      date: "2026-05-07",
      services: [
        service({
          id: "a",
          customer_name: "PARTENZA A",
          hotel_id: "re-ferdinando",
          pickup_hotel: "08:00",
          booking_service_kind: "formula_medmar",
          service_type_code: "ferry_transfer",
          barca_compagnia: "Medmar",
          orario_barca: "08:40",
          ferry_details: { departure_port: "Casamicciola" },
        }),
        service({
          id: "b",
          customer_name: "PARTENZA B",
          hotel_id: "re-ferdinando",
          pickup_hotel: "09:00",
          booking_service_kind: "formula_snav",
          service_type_code: "ferry_transfer",
          barca_compagnia: "SNAV",
          orario_barca: "09:45",
          ferry_details: { departure_port: "Casamicciola" },
        }),
      ],
      hotels,
      assignments: [assignment("a"), assignment("b")],
      tripGroups: [group()],
      driverNamesByProfileId: new Map([["driver-1", "Mario"]]),
    });

    expect(result.groups[0]?.status).toBe("OK");
    expect(result.groups[0]?.driver_name).toBe("Mario");
    expect(result.summary.groups_ok).toBe(1);
    expect(result.resolution_suggestions).toHaveLength(0);
  });
});
