import { describe, expect, it } from "vitest";

import { buildResolutionPreview } from "@/lib/piano-conflict-resolution-preview";
import { buildRealGiroDiagnostics, type RealGiroDiagnosticAssignment, type RealGiroDiagnosticTripGroup } from "@/lib/piano-real-giro-diagnostics";
import { buildSuggestionHash } from "@/lib/server/piano-operator-decisions";
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

describe("buildRealGiroDiagnostics", () => {
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

  it("does not turn San Nicola delta 25 into shuttle-pair", () => {
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

    expect(result.groups[0]?.shuttle_pair_count).toBe(0);
    expect(result.summary.total_shuttle_pairs).toBe(0);
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
