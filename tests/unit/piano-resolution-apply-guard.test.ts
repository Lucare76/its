import { describe, expect, it } from "vitest";

import { validateResolutionSuggestionApply } from "@/lib/piano-resolution-apply-guard";
import type { ConflictResolutionSuggestion } from "@/lib/piano-conflict-resolution-suggestions";

function suggestion(overrides: Partial<ConflictResolutionSuggestion> = {}): ConflictResolutionSuggestion {
  return {
    conflict_id: "conflict-mario",
    group_id: "group-mario",
    driver_name: "MARIO ZABATTA",
    vehicle_label: "VITO EXTRA LONG",
    conflict_type: "CONFLICT_REAL",
    severity: "media",
    involved_services: [
      {
        service_id: "iori",
        customer_name: "IORI",
        macro_category: "PARTENZA",
        operational_time: "12:15",
        pickup_label: "LA VILLA",
        destination_label: "Casamicciola",
        pax: 2,
      },
      {
        service_id: "rossi",
        customer_name: "ROSSI",
        macro_category: "PARTENZA",
        operational_time: "12:30",
        pickup_label: "LA VILLA",
        destination_label: "Casamicciola",
        pax: 2,
      },
    ],
    root_cause: "insufficient_buffer_same_pickup",
    recommended_action: "ACCORPARE_CON_CONFERMA",
    explanation: ["Stesso pickup e stesso porto."],
    suggested_order: [],
    alternative_action: null,
    candidate_moves: [],
    operator_confirmation_required: true,
    ...overrides,
  };
}

describe("validateResolutionSuggestionApply", () => {
  it("validates Mario Z merge as eligible for operator-decision persistence", () => {
    const decision = validateResolutionSuggestionApply({
      suggestions: [suggestion()],
      suggestion_id: "conflict-mario",
      group_id: "group-mario",
      action: "ACCORPARE_CON_CONFERMA",
    });

    expect(decision.ok).toBe(true);
    expect(decision.apply_status).toBe("eligible");
    expect(decision.message).toContain("validato");
  });

  it("blocks stale suggestions after server-side recalculation", () => {
    const decision = validateResolutionSuggestionApply({
      suggestions: [suggestion()],
      suggestion_id: "missing",
      group_id: "group-mario",
      action: "ACCORPARE_CON_CONFERMA",
    });

    expect(decision.ok).toBe(false);
    expect(decision.apply_status).toBe("stale");
  });

  it("allows Riccardo multi-drop warning with zero residual conflicts as operator confirmation", () => {
    const decision = validateResolutionSuggestionApply({
      suggestions: [suggestion({
        conflict_id: "conflict-riccardo",
        recommended_action: "MULTI_DROP",
        root_cause: "multi_drop_candidate",
        suggested_order: ["Casamicciola", "Ischia Porto"],
        alternative_action: "SEPARARE_SE_NON_CONFERMATO",
        involved_services: [
          {
            service_id: "catullo",
            customer_name: "CATULLO",
            macro_category: "PARTENZA",
            operational_time: "08:30",
            pickup_label: "LA VILLA",
            destination_label: "Casamicciola",
            pax: 2,
          },
          {
            service_id: "paoletti",
            customer_name: "PAOLETTI",
            macro_category: "PARTENZA",
            operational_time: "08:30",
            pickup_label: "LA VILLA",
            destination_label: "Ischia Porto",
            pax: 2,
          },
        ],
      })],
      suggestion_id: "conflict-riccardo",
      group_id: "group-mario",
      action: "MULTI_DROP",
    });

    expect(decision.ok).toBe(true);
    expect(decision.apply_status).toBe("eligible");
  });

  it("allows Ilaria multi-drop warning with suggested order", () => {
    const decision = validateResolutionSuggestionApply({
      suggestions: [suggestion({
        conflict_id: "warning",
        recommended_action: "MULTI_DROP",
        root_cause: "multi_drop_candidate",
        suggested_order: ["Cristallo", "Re Ferdinando"],
        involved_services: [
          {
            service_id: "polillo",
            customer_name: "POLILLO",
            macro_category: "ESCURSIONE",
            operational_time: "17:15",
            pickup_label: "MORTELLA",
            destination_label: "Re Ferdinando",
            pax: 2,
          },
          {
            service_id: "cam335",
            customer_name: "CAM 335",
            macro_category: "ESCURSIONE",
            operational_time: "17:15",
            pickup_label: "MORTELLA",
            destination_label: "Cristallo",
            pax: 1,
          },
        ],
      })],
      suggestion_id: "warning",
      group_id: "group-mario",
      action: "MULTI_DROP",
    });

    expect(decision.ok).toBe(true);
    expect(decision.apply_status).toBe("eligible");
  });

  it("blocks multi-drop without suggested order", () => {
    const decision = validateResolutionSuggestionApply({
      suggestions: [suggestion({
        conflict_id: "missing-order",
        recommended_action: "MULTI_DROP",
        root_cause: "multi_drop_candidate",
        suggested_order: [],
      })],
      suggestion_id: "missing-order",
      group_id: "group-mario",
      action: "MULTI_DROP",
    });

    expect(decision.ok).toBe(false);
    expect(decision.apply_status).toBe("not_safe");
  });

  it("blocks multi-drop without operator confirmation requirement", () => {
    const decision = validateResolutionSuggestionApply({
      suggestions: [suggestion({
        conflict_id: "no-confirmation",
        recommended_action: "MULTI_DROP",
        root_cause: "multi_drop_candidate",
        suggested_order: ["Casamicciola", "Ischia Porto"],
        operator_confirmation_required: false,
      })],
      suggestion_id: "no-confirmation",
      group_id: "group-mario",
      action: "MULTI_DROP",
    });

    expect(decision.ok).toBe(false);
    expect(decision.apply_status).toBe("not_safe");
  });

  it("does not apply locked services", () => {
    const decision = validateResolutionSuggestionApply({
      suggestions: [suggestion()],
      suggestion_id: "conflict-mario",
      group_id: "group-mario",
      action: "ACCORPARE_CON_CONFERMA",
      locked_service_ids: new Set(["iori"]),
    });

    expect(decision.ok).toBe(false);
    expect(decision.apply_status).toBe("locked");
  });
});
