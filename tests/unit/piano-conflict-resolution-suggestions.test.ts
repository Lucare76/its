import { describe, expect, it } from "vitest";

import { analyzeGiro } from "@/lib/piano-conflict-classifier";
import { generateConflictResolutionSuggestions } from "@/lib/piano-conflict-resolution-suggestions";
import type { RealGiroDiagnosticGroup } from "@/lib/piano-real-giro-diagnostics";
import type { MergedStop, ResolvedServiceForSameStop, SameStopMacroCategory } from "@/lib/piano-same-stop-merge";

function service(overrides: Partial<ResolvedServiceForSameStop> = {}): ResolvedServiceForSameStop {
  return {
    service_id: "svc-1",
    customer_name: "CLIENTE TEST",
    macro_category: "PARTENZA",
    assignable: true,
    needs_review: false,
    review_reasons: [],
    operational_time: "08:30",
    pickup_label: "LA VILLA",
    pickup_zone: "Forio",
    destination_label: "Casamicciola",
    destination_zone: "Casamicciola",
    pax: 2,
    ferry_company: "Medmar",
    ferry_departure_time: "10:10",
    port_departure: "Casamicciola",
    ...overrides,
  };
}

function stop(overrides: {
  stop_id: string;
  time?: string;
  macro?: SameStopMacroCategory;
  pickup?: string | null;
  destination?: string;
  destinationZone?: string | null;
  portDeparture?: string | null;
  pax?: number;
  serviceId?: string;
  customer?: string;
  locked?: boolean;
}): MergedStop {
  const macro = overrides.macro ?? "PARTENZA";
  const destination = overrides.destination ?? "Casamicciola";
  const item = service({
    service_id: overrides.serviceId ?? overrides.stop_id,
    customer_name: overrides.customer ?? overrides.stop_id,
    macro_category: macro,
    operational_time: overrides.time ?? "08:30",
    pickup_label: overrides.pickup ?? "LA VILLA",
    pickup_zone: overrides.pickup ?? "LA VILLA",
    destination_label: destination,
    destination_zone: overrides.destinationZone ?? destination,
    pax: overrides.pax ?? 2,
    port_departure: overrides.portDeparture ?? destination,
  }) as ResolvedServiceForSameStop & { locked_by_operator?: boolean };
  if (overrides.locked) item.locked_by_operator = true;

  return {
    stop_id: overrides.stop_id,
    services: [item],
    total_pax: overrides.pax ?? 2,
    operational_time: overrides.time ?? "08:30",
    pickup_label: overrides.pickup ?? "LA VILLA",
    destination_labels: [destination],
    macro_category: macro,
    ferry_company: item.ferry_company,
    ferry_departure_time: item.ferry_departure_time,
    ferry_arrival_time: item.ferry_arrival_time,
    port_departure: item.port_departure,
    port_arrival: item.port_arrival,
    is_merged: false,
    merge_reason: null,
    warnings: [],
  };
}

function group(params: {
  id: string;
  driver?: string | null;
  status?: RealGiroDiagnosticGroup["status"];
  stops: MergedStop[];
  duplicateFirstTransition?: boolean;
  vehicleCapacity?: number | null;
}): RealGiroDiagnosticGroup {
  const analysis = analyzeGiro(params.id, params.driver ?? null, params.stops);
  const transitions = params.duplicateFirstTransition && analysis.transitions[0]
    ? [
        analysis.transitions[0],
        {
          ...analysis.transitions[0],
          from_stop_label: analysis.transitions[0].to_stop_label,
          to_stop_label: analysis.transitions[0].from_stop_label,
        },
      ]
    : analysis.transitions;

  return {
    group_id: params.id,
    driver_name: params.driver ?? null,
    vehicle_label: "Vito",
    services_count: params.stops.reduce((sum, item) => sum + item.services.length, 0),
    stops_count: params.stops.length,
    same_stop_count: 0,
    shuttle_pair_count: 0,
    needs_review_count: 0,
    conflict_count: transitions.filter((transition) => transition.type === "CONFLICT_REAL" || transition.type === "OVERLAP").length,
    warning_count: transitions.filter((transition) => transition.type === "WARNING").length,
    status: params.status ?? (analysis.has_conflicts ? "NOT_OPERATIONAL" : "OK"),
    stops: params.stops,
    shuttle_pairs: [],
    transitions,
    needs_review: [],
    worst_conflict: analysis.worst_conflict,
    vehicle_capacity: params.vehicleCapacity,
  } as RealGiroDiagnosticGroup;
}

describe("generateConflictResolutionSuggestions", () => {
  it("marks Riccardo same-pickup same-time departures toward different ports as multi-drop", () => {
    const suggestions = generateConflictResolutionSuggestions([
      group({
        id: "riccardo",
        driver: "RICCARDO",
        stops: [
          stop({ stop_id: "cas", destination: "Casamicciola", portDeparture: "Casamicciola" }),
          stop({ stop_id: "ischia", destination: "Ischia Porto", portDeparture: "Ischia Porto", serviceId: "paoletti" }),
        ],
      }),
    ]);

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.root_cause).toBe("multi_drop_candidate");
    expect(suggestions[0]?.recommended_action).toBe("MULTI_DROP");
    expect(suggestions[0]?.operator_confirmation_required).toBe(true);
    expect(suggestions[0]?.suggested_order).toEqual(["Casamicciola", "Ischia Porto"]);
    expect(suggestions[0]?.alternative_action).toBe("SEPARARE_SE_NON_CONFERMATO");
  });

  it("expands Riccardo multi-drop to the complete same-time same-pickup cluster", () => {
    const catulloLodi = stop({ stop_id: "catullo-lodi", destination: "Casamicciola", portDeparture: "Casamicciola", serviceId: "catullo", customer: "CATULLO LUCIA", pax: 4 });
    catulloLodi.services = [
      service({ service_id: "catullo", customer_name: "CATULLO LUCIA", destination_label: "Casamicciola", pax: 2 }),
      service({ service_id: "lodi", customer_name: "LODI BARBARA", destination_label: "Casamicciola", pax: 2 }),
    ];
    catulloLodi.total_pax = 4;

    const suggestions = generateConflictResolutionSuggestions([
      group({
        id: "riccardo",
        driver: "RICCARDO",
        stops: [
          catulloLodi,
          stop({ stop_id: "paoletti", destination: "Ischia Porto", portDeparture: "Ischia Porto", serviceId: "paoletti", customer: "PAOLETTI ALESSANDRO" }),
          stop({ stop_id: "lamantia", destination: "Casamicciola", portDeparture: "Casamicciola", serviceId: "lamantia", customer: "LA MANTIA" }),
        ],
      }),
    ]);

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.recommended_action).toBe("MULTI_DROP");
    expect(suggestions[0]?.root_cause).toBe("multi_drop_candidate");
    expect(suggestions[0]?.suggested_order).toEqual(["Casamicciola", "Ischia Porto"]);
    expect(suggestions[0]?.involved_services.map((item) => item.service_id).sort()).toEqual([
      "catullo",
      "lamantia",
      "lodi",
      "paoletti",
    ]);
    expect(suggestions[0]?.involved_services.reduce((sum, item) => sum + (item.pax ?? 0), 0)).toBe(8);
    expect(suggestions[0]?.alternative_action).toBe("SEPARARE_SE_NON_CONFERMATO");
  });

  it("marks Ilaria excursion same-pickup different destinations as multi-drop candidate", () => {
    const suggestions = generateConflictResolutionSuggestions([
      group({
        id: "ilaria",
        driver: "ILARIA",
        stops: [
          stop({ stop_id: "polillo", macro: "ESCURSIONE", pickup: "MORTELLA", destination: "RE FERDINANDO", destinationZone: "Ischia Porto" }),
          stop({ stop_id: "cam335", macro: "ESCURSIONE", pickup: "MORTELLA", destination: "CRISTALLO", destinationZone: "Casamicciola" }),
        ],
      }),
    ]);

    expect(suggestions[0]?.root_cause).toBe("multi_drop_candidate");
    expect(suggestions[0]?.recommended_action).toBe("MULTI_DROP");
    expect(suggestions[0]?.operator_confirmation_required).toBe(true);
    expect(suggestions[0]?.suggested_order).toEqual(["CRISTALLO", "RE FERDINANDO"]);
  });

  it("suggests operator-confirmed merge for same pickup and same port close departures", () => {
    const suggestions = generateConflictResolutionSuggestions([
      group({
        id: "mario",
        driver: "MARIO ZABATTA",
        stops: [
          stop({ stop_id: "iori", time: "12:15", destination: "Casamicciola", portDeparture: "Casamicciola" }),
          stop({ stop_id: "rossi", time: "12:30", destination: "Casamicciola", portDeparture: "Casamicciola" }),
        ],
      }),
    ]);

    expect(suggestions[0]?.root_cause).toBe("insufficient_buffer_same_pickup");
    expect(suggestions[0]?.recommended_action).toBe("ACCORPARE_CON_CONFERMA");
    expect(suggestions[0]?.operator_confirmation_required).toBe(true);
  });

  it("groups duplicate transitions as one operational problem", () => {
    const suggestions = generateConflictResolutionSuggestions([
      group({
        id: "riccardo",
        duplicateFirstTransition: true,
        stops: [
          stop({ stop_id: "cas", destination: "Casamicciola", portDeparture: "Casamicciola" }),
          stop({ stop_id: "ischia", destination: "Ischia Porto", portDeparture: "Ischia Porto" }),
        ],
      }),
    ]);

    expect(suggestions).toHaveLength(1);
  });

  it("does not classify different pickups as multi-drop", () => {
    const suggestions = generateConflictResolutionSuggestions([
      group({
        id: "different-pickups",
        stops: [
          stop({ stop_id: "a", pickup: "LA VILLA", destination: "Casamicciola" }),
          stop({ stop_id: "b", pickup: "RE FERDINANDO", destination: "Ischia Porto" }),
        ],
      }),
    ]);

    expect(suggestions[0]?.root_cause).not.toBe("multi_drop_candidate");
    expect(suggestions[0]?.recommended_action).not.toBe("MULTI_DROP");
  });

  it("does not classify needs_review services as multi-drop", () => {
    const reviewStop = stop({ stop_id: "review", destination: "Ischia Porto" });
    reviewStop.services[0]!.needs_review = true;
    const suggestions = generateConflictResolutionSuggestions([
      group({
        id: "review",
        stops: [
          stop({ stop_id: "ok", destination: "Casamicciola" }),
          reviewStop,
        ],
      }),
    ]);

    expect(suggestions[0]?.root_cause).not.toBe("multi_drop_candidate");
    expect(suggestions[0]?.recommended_action).not.toBe("MULTI_DROP");
  });

  it("does not propose multi-drop when known vehicle capacity is exceeded", () => {
    const suggestions = generateConflictResolutionSuggestions([
      group({
        id: "capacity",
        vehicleCapacity: 3,
        stops: [
          stop({ stop_id: "a", destination: "Casamicciola", pax: 2 }),
          stop({ stop_id: "b", destination: "Ischia Porto", pax: 2 }),
        ],
      }),
    ]);

    expect(suggestions[0]?.recommended_action).toBe("DA_VERIFICARE_OPERATORE");
    expect(suggestions[0]?.root_cause).not.toBe("multi_drop_candidate");
  });

  it("does not propose automatic moves when a service is locked", () => {
    const suggestions = generateConflictResolutionSuggestions([
      group({
        id: "locked",
        stops: [
          stop({ stop_id: "locked-a", locked: true }),
          stop({ stop_id: "locked-b", pickup: "FORIO", destination: "Ischia Porto", portDeparture: "Ischia Porto" }),
        ],
      }),
    ]);

    expect(suggestions[0]?.root_cause).toBe("locked_manual");
    expect(suggestions[0]?.recommended_action).toBe("DA_VERIFICARE_OPERATORE");
    expect(suggestions[0]?.candidate_moves).toHaveLength(0);
  });

  it("suggests a new group when no existing group is compatible", () => {
    const suggestions = generateConflictResolutionSuggestions([
      group({
        id: "source",
        stops: [
          stop({ stop_id: "a", pickup: "FORIO", destination: "Casamicciola" }),
          stop({ stop_id: "b", pickup: "ISCHIA PORTO", destination: "Forio" }),
        ],
      }),
    ]);

    expect(suggestions[0]?.recommended_action).toBe("CREARE_NUOVO_GIRO");
  });

  it("returns compatible candidate moves with confidence and explanation", () => {
    const moving = stop({ stop_id: "b", pickup: "ISCHIA PORTO", destination: "Forio", serviceId: "move-me", pax: 1 });
    const suggestions = generateConflictResolutionSuggestions([
      group({
        id: "source",
        driver: "SOURCE",
        stops: [
          stop({ stop_id: "a", pickup: "FORIO", destination: "Casamicciola", pax: 4 }),
          moving,
        ],
      }),
      group({
        id: "candidate",
        driver: "CANDIDATE",
        stops: [stop({ stop_id: "later", time: "12:00", pickup: "Forio", destination: "Casamicciola" })],
      }),
    ]);

    expect(suggestions[0]?.candidate_moves[0]).toMatchObject({
      service_id: "move-me",
      from_driver: "SOURCE",
      to_driver: "CANDIDATE",
      to_group_id: "candidate",
    });
    expect(suggestions[0]?.candidate_moves[0]?.confidence).toBeGreaterThan(0);
  });
});
