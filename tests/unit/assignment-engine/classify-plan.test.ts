import { describe, expect, it } from "vitest";
import { classifyPlanItems, type PlanItemAssignmentInfo, type PlanItemDraft } from "@/lib/server/assignment-engine/classify-plan";
import type { AutoAssignPreviewResult, AutoAssignPreviewServiceRow } from "@/lib/piano-assignable-preview";
import type { PlannerResult, PlannerProposedGroup } from "@/lib/piano-auto-assign-planner";

function serviceRow(overrides: Partial<AutoAssignPreviewServiceRow>): AutoAssignPreviewServiceRow {
  return {
    service_id: "svc-1",
    customer_name: "Mario Rossi",
    macro_category: "ARRIVO",
    assignable: true,
    needs_review: false,
    review_reasons: [],
    is_locked: false,
    already_assigned: false,
    already_assigned_unlocked: false,
    confidence_score: 100,
    operational_time: "10:00",
    pickup_label: "Ischia Porto",
    pickup_type: "porto",
    pickup_zone: "Ischia Porto",
    destination_label: "Hotel Continental",
    destination_type: "hotel",
    destination_zone: "Ischia",
    pax: 2,
    capacity_required: 2,
    booking_service_kind: "transfer_port_hotel",
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

function preview(services: AutoAssignPreviewServiceRow[]): AutoAssignPreviewResult {
  return { services } as unknown as AutoAssignPreviewResult;
}

function group(overrides: Partial<PlannerProposedGroup>): PlannerProposedGroup {
  return {
    temp_group_id: "preview-0001",
    driver_id: "driver-1",
    driver_name: "Antonio",
    vehicle_id: "vehicle-1",
    vehicle_label: "Mercedes Vito",
    services: [{ service_id: "svc-1", customer_name: null, macro_category: "ARRIVO", operational_time: "10:00", pickup_label: null, pickup_zone: null, destination_label: null, destination_zone: null, pax: 2 }],
    start_time: "10:00",
    end_time: "10:00",
    total_pax: 2,
    macro_categories: ["ARRIVO"],
    zones: [],
    score: 90,
    confidence: 95,
    explanation: ["Capienza mezzo corretta"],
    warnings: [],
    ...overrides,
  };
}

function planning(overrides: Partial<PlannerResult>): PlannerResult {
  return {
    proposed_groups: [],
    unplanned: [],
    conflicts: [],
    protected_locked: [],
    summary: { candidate_services: 0, proposed_groups_count: 0, planned_services_count: 0, unplanned_count: 0, conflict_count: 0, locked_count: 0 },
    ...overrides,
  };
}

describe("classifyPlanItems", () => {
  it("classifies a high-score, no-warning group as auto_safe", () => {
    const items = classifyPlanItems({
      preview: preview([serviceRow({})]),
      planning: planning({ proposed_groups: [group({})] }),
      assignmentByServiceId: new Map(),
    });

    expect(items[0].status).toBe("auto_safe");
    expect(items[0].proposed_driver_name).toBe("Antonio");
  });

  it("classifies a group with a warning as review (Caso 9: score non dominante)", () => {
    const items = classifyPlanItems({
      preview: preview([serviceRow({})]),
      planning: planning({ proposed_groups: [group({ warnings: ["Zona sconosciuta: buffer prudente 60 minuti"] })] }),
      assignmentByServiceId: new Map(),
    });

    expect(items[0].status).toBe("review");
  });

  it("classifies a data-quality issue (needs_review) as review with alternatives", () => {
    const items = classifyPlanItems({
      preview: preview([serviceRow({ needs_review: true, review_reasons: ["Pickup mancante"] })]),
      planning: planning({}),
      assignmentByServiceId: new Map(),
      rankAlternatives: () => [{ driver_id: "d2", driver_name: "Giuseppe", vehicle_id: null, vehicle_label: null, score: 70, reason: [] }],
    });

    expect(items[0].status).toBe("review");
    expect(items[0].alternatives).toHaveLength(1);
  });

  it("classifies a service with no valid candidate as unresolved (Caso 10)", () => {
    const items = classifyPlanItems({
      preview: preview([serviceRow({})]),
      planning: planning({ unplanned: [{ service_id: "svc-1", customer_name: "Mario Rossi", reason: "Nessun autista disponibile nella finestra operativa" }] }),
      assignmentByServiceId: new Map(),
    });

    expect(items[0].status).toBe("unresolved");
    expect(items[0].reason.summary[0]).toContain("Nessun autista");
  });

  it("classifies an already-assigned locked service as manual, not overwritten by the planner", () => {
    const assignmentByServiceId = new Map<string, PlanItemAssignmentInfo>([
      ["svc-1", { driver_id: "driver-9", driver_name: "Giuseppe", vehicle_id: null, vehicle_label: "Ducato", locked_by_operator: true }],
    ]);
    const items = classifyPlanItems({
      preview: preview([serviceRow({ is_locked: true, already_assigned: true })]),
      planning: planning({}),
      assignmentByServiceId,
    });

    expect(items[0].status).toBe("manual");
    expect(items[0].proposed_driver_name).toBe("Giuseppe");
  });

  it("Caso 8/14: preserves a previously explicit-locked item unchanged, ignoring what the planner now proposes", () => {
    const previousItem: PlanItemDraft = {
      service_id: "svc-1",
      status: "locked",
      proposed_driver_id: "driver-1",
      proposed_driver_name: "Antonio",
      proposed_vehicle_id: null,
      proposed_vehicle_label: "Mercedes Vito",
      mission_group_key: null,
      score: 90,
      confidence: 95,
      reason: { summary: ["Bloccato da Mario"], details: {} },
      alternatives: [],
      warnings: [],
      suggested_fix: null,
      locked: true,
    };
    const previousItemsByServiceId = new Map([["svc-1", previousItem]]);

    // Il planner ora proporrebbe un autista diverso (Giuseppe) — non deve avere effetto.
    const items = classifyPlanItems({
      preview: preview([serviceRow({})]),
      planning: planning({ proposed_groups: [group({ driver_id: "driver-2", driver_name: "Giuseppe" })] }),
      assignmentByServiceId: new Map(),
      previousItemsByServiceId,
    });

    expect(items[0].status).toBe("locked");
    expect(items[0].proposed_driver_name).toBe("Antonio");
  });

  it("never silently drops a service the planner never evaluated (fail-safe to unresolved)", () => {
    const items = classifyPlanItems({
      preview: preview([serviceRow({})]),
      planning: planning({}),
      assignmentByServiceId: new Map(),
    });

    expect(items).toHaveLength(1);
    expect(items[0].status).toBe("unresolved");
  });

  it("Caso 15: classifies 400 services without crashing and stays fast", () => {
    const services = Array.from({ length: 400 }, (_, index) => serviceRow({ service_id: `svc-${index}` }));
    const groups = services.map((service, index) =>
      group({
        temp_group_id: `preview-${index}`,
        driver_id: `driver-${index % 40}`,
        driver_name: `Autista ${index % 40}`,
        services: [{ service_id: service.service_id, customer_name: null, macro_category: "ARRIVO", operational_time: "10:00", pickup_label: null, pickup_zone: null, destination_label: null, destination_zone: null, pax: 2 }],
      })
    );

    const startedAt = Date.now();
    const items = classifyPlanItems({
      preview: preview(services),
      planning: planning({ proposed_groups: groups }),
      assignmentByServiceId: new Map(),
    });
    const durationMs = Date.now() - startedAt;

    expect(items).toHaveLength(400);
    expect(durationMs).toBeLessThan(2000);
  });
});
