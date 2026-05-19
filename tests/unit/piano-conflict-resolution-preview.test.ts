import { describe, expect, it } from "vitest";

import {
  buildResolutionPreview,
  canApplyResolutionPreview,
  canConfirmMultiDropPreview,
  resolutionConfirmationLabel,
} from "@/lib/piano-conflict-resolution-preview";
import type { ConflictResolutionSuggestion } from "@/lib/piano-conflict-resolution-suggestions";

function suggestion(overrides: Partial<ConflictResolutionSuggestion> = {}): ConflictResolutionSuggestion {
  return {
    conflict_id: "conflict-1",
    group_id: "group-1",
    driver_name: "RICCARDO",
    vehicle_label: "VITO EXTRA LONG",
    conflict_type: "OVERLAP",
    severity: "alta",
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
    root_cause: "multi_drop_candidate",
    recommended_action: "MULTI_DROP",
    explanation: [],
    suggested_order: ["Casamicciola", "Ischia Porto"],
    alternative_action: "SEPARARE_SE_NON_CONFERMATO",
    candidate_moves: [
      {
        service_id: "paoletti",
        from_driver: "RICCARDO",
        to_driver: "MARIO",
        to_group_id: "group-2",
        confidence: 85,
        reason: "compatibile",
        risks: [],
      },
    ],
    operator_confirmation_required: true,
    ...overrides,
  };
}

describe("buildResolutionPreview", () => {
  it("builds Riccardo multi-drop preview", () => {
    const preview = buildResolutionPreview(suggestion());

    expect(preview.action).toBe("MULTI_DROP");
    expect(preview.before).toHaveLength(2);
    expect(preview.after[0]?.detail).toContain("La Villa → Casamicciola → Ischia Porto");
    expect(preview.after[0]?.detail).toContain("4 pax totali");
    expect(preview.simulated_status).toBe("WARNING");
    expect(preview.residual_conflicts).toBe(0);
    expect(preview.total_pax).toBe(4);
    expect(preview.final_stops[0]?.detail).toContain("La Villa → Casamicciola → Ischia Porto");
    expect(preview.warnings.join(" ")).toContain("Nessuna modifica");
    expect(canApplyResolutionPreview(preview)).toBe(false);
    expect(canConfirmMultiDropPreview(preview, suggestion())).toBe(true);
    expect(resolutionConfirmationLabel(preview)).toBe("Conferma multi-drop");
  });

  it("builds Ilaria multi-drop preview", () => {
    const preview = buildResolutionPreview(suggestion({
      driver_name: "ILARIA",
      involved_services: [
        {
          service_id: "polillo",
          customer_name: "POLILLO",
          macro_category: "ESCURSIONE",
          operational_time: "17:15",
          pickup_label: "MORTELLA",
          destination_label: "RE FERDINANDO",
          pax: 4,
        },
        {
          service_id: "cam335",
          customer_name: "CAM 335",
          macro_category: "ESCURSIONE",
          operational_time: "17:15",
          pickup_label: "MORTELLA",
          destination_label: "CRISTALLO",
          pax: 1,
        },
      ],
      suggested_order: ["CRISTALLO", "RE FERDINANDO"],
    }));

    expect(preview.after[0]?.detail).toContain("Mortella → Cristallo → Re Ferdinando");
    expect(preview.requires_operator_confirmation).toBe(true);
    expect(preview.simulated_status).toBe("WARNING");
    expect(preview.residual_conflicts).toBe(0);
    expect(preview.residual_warnings).toBe(1);
    expect(canApplyResolutionPreview(preview)).toBe(false);
    expect(canConfirmMultiDropPreview(preview, suggestion({
      driver_name: "ILARIA",
      involved_services: [
        {
          service_id: "polillo",
          customer_name: "POLILLO",
          macro_category: "ESCURSIONE",
          operational_time: "17:15",
          pickup_label: "MORTELLA",
          destination_label: "RE FERDINANDO",
          pax: 4,
        },
        {
          service_id: "cam335",
          customer_name: "CAM 335",
          macro_category: "ESCURSIONE",
          operational_time: "17:15",
          pickup_label: "MORTELLA",
          destination_label: "CRISTALLO",
          pax: 1,
        },
      ],
      suggested_order: ["CRISTALLO", "RE FERDINANDO"],
    }))).toBe(true);
  });

  it("builds Mario Z merge preview", () => {
    const preview = buildResolutionPreview(suggestion({
      driver_name: "MARIO ZABATTA",
      root_cause: "insufficient_buffer_same_pickup",
      recommended_action: "ACCORPARE_CON_CONFERMA",
      alternative_action: null,
      suggested_order: [],
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
      candidate_moves: [],
    }));

    expect(preview.action).toBe("ACCORPARE_CON_CONFERMA");
    expect(preview.after[0]?.label).toContain("12:15–12:30");
    expect(preview.after[0]?.detail).toContain("La Villa → Casamicciola");
    expect(preview.simulated_status).toBe("OK");
    expect(preview.residual_conflicts).toBe(0);
    expect(preview.residual_warnings).toBe(0);
    expect(canApplyResolutionPreview(preview)).toBe(true);
    expect(resolutionConfirmationLabel(preview)).toBe("Conferma e applica");
  });

  it("does not confirm multi-drop when order or pickup is incomplete", () => {
    const noOrderSuggestion = suggestion({ suggested_order: [] });
    const noOrderPreview = buildResolutionPreview(noOrderSuggestion);
    expect(canConfirmMultiDropPreview(noOrderPreview, noOrderSuggestion)).toBe(false);

    const noPickupSuggestion = suggestion({
      involved_services: [
        {
          service_id: "a",
          customer_name: "A",
          macro_category: "PARTENZA",
          operational_time: "08:30",
          pickup_label: null,
          destination_label: "Casamicciola",
          pax: 2,
        },
        {
          service_id: "b",
          customer_name: "B",
          macro_category: "PARTENZA",
          operational_time: "08:30",
          pickup_label: "LA VILLA",
          destination_label: "Ischia Porto",
          pax: 2,
        },
      ],
    });
    const noPickupPreview = buildResolutionPreview(noPickupSuggestion);
    expect(canConfirmMultiDropPreview(noPickupPreview, noPickupSuggestion)).toBe(false);
  });

  it("builds separate alternative preview without applying it", () => {
    const preview = buildResolutionPreview(suggestion(), { alternative: true });

    expect(preview.action).toBe("SEPARARE_SE_NON_CONFERMATO");
    expect(preview.after[0]?.detail).toContain("MARIO");
    expect(preview.warnings.join(" ")).toContain("Nessuna modifica");
    expect(canApplyResolutionPreview(preview)).toBe(false);
  });
});
