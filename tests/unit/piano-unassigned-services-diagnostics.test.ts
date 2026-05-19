import { describe, expect, it } from "vitest";
import { buildUnassignedServicesDiagnostics } from "@/lib/piano-unassigned-services-diagnostics";
import type { AutoAssignPreviewHotel, AutoAssignPreviewService } from "@/lib/piano-assignable-preview";

const hotels: AutoAssignPreviewHotel[] = [
  { id: "villa", name: "LA VILLA", zone: "Forio" },
  { id: "president", name: "HOTEL TERME PRESIDENT", zone: "Ischia Porto" },
];

function service(overrides: Partial<AutoAssignPreviewService>): AutoAssignPreviewService {
  return {
    id: "svc",
    date: "2026-07-05",
    time: "08:30",
    direction: "departure",
    customer_name: "CLIENTE",
    pax: 2,
    booking_service_kind: "formula_medmar",
    service_type_code: "ferry_transfer",
    ...overrides,
  };
}

describe("buildUnassignedServicesDiagnostics", () => {
  it("resolves services without trip groups and separates needs_review", () => {
    const result = buildUnassignedServicesDiagnostics({
      date: "2026-07-05",
      hotels,
      services: [
        service({
          id: "ok",
          hotel_id: "villa",
          pickup_hotel: "08:30",
          barca_compagnia: "Medmar",
          orario_barca: "10:10",
          ferry_details: { departure_port: "Casamicciola" },
        }),
        service({
          id: "review",
          booking_service_kind: "excursion",
          service_type_code: "excursion",
          service_type: "bus_tour",
          customer_name: "GPR PETER",
          pax: 21,
          excursion_details: { from: "PARCO AURORA" },
        }),
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.mode).toBe("unassigned_services");
    expect(result.summary.total_services).toBe(2);
    expect(result.summary.assignable_count).toBe(1);
    expect(result.summary.needs_review_count).toBe(1);
    expect(result.needs_review[0]?.service_id).toBe("review");
    expect(result.summary.stop_count).toBe(1);
  });

  it("applies same-stop merge before suggestions", () => {
    const result = buildUnassignedServicesDiagnostics({
      date: "2026-07-05",
      hotels,
      services: [
        service({
          id: "catullo",
          customer_name: "CATULLO",
          hotel_id: "villa",
          pickup_hotel: "08:30",
          barca_compagnia: "Medmar",
          orario_barca: "10:10",
          ferry_details: { departure_port: "Casamicciola" },
        }),
        service({
          id: "lodi",
          customer_name: "LODI",
          hotel_id: "villa",
          pickup_hotel: "08:30",
          barca_compagnia: "Medmar",
          orario_barca: "10:10",
          ferry_details: { departure_port: "Casamicciola" },
        }),
      ],
    });

    expect(result.summary.same_stop_count).toBe(1);
    expect(result.same_stop_groups[0]?.services.map((item) => item.service_id).sort()).toEqual(["catullo", "lodi"]);
    expect(result.summary.accorpamento_candidate_count).toBe(0);
  });

  it("detects complete multi-drop candidates from same pickup and time", () => {
    const result = buildUnassignedServicesDiagnostics({
      date: "2026-07-05",
      hotels,
      services: [
        service({
          id: "catullo",
          customer_name: "CATULLO",
          hotel_id: "villa",
          pickup_hotel: "08:30",
          barca_compagnia: "Medmar",
          orario_barca: "10:10",
          ferry_details: { departure_port: "Casamicciola" },
        }),
        service({
          id: "lodi",
          customer_name: "LODI",
          hotel_id: "villa",
          pickup_hotel: "08:30",
          barca_compagnia: "Medmar",
          orario_barca: "10:10",
          ferry_details: { departure_port: "Casamicciola" },
        }),
        service({
          id: "lamantia",
          customer_name: "LA MANTIA",
          hotel_id: "villa",
          booking_service_kind: "formula_snav",
          pickup_hotel: "08:30",
          barca_compagnia: "SNAV",
          orario_barca: "09:45",
          ferry_details: { departure_port: "Casamicciola" },
        }),
        service({
          id: "paoletti",
          customer_name: "PAOLETTI",
          hotel_id: "villa",
          booking_service_kind: "formula_medmar_napoli",
          pickup_hotel: "08:30",
          barca_compagnia: "Medmar",
          orario_barca: "10:35",
          ferry_details: { departure_port: "Ischia Porto" },
        }),
      ],
    });

    expect(result.summary.multi_drop_candidate_count).toBe(1);
    expect(result.suggestions[0]?.action).toBe("MULTI_DROP");
    expect(result.suggestions[0]?.suggested_order).toEqual(["Casamicciola", "Ischia Porto"]);
    expect(result.suggestions[0]?.involved_services.map((item) => item.service_id).sort()).toEqual([
      "catullo",
      "lamantia",
      "lodi",
      "paoletti",
    ]);
    expect(result.suggestions[0]?.total_pax).toBe(8);
  });

  it("detects shuttle-pair candidates without treating them as suggestions", () => {
    const result = buildUnassignedServicesDiagnostics({
      date: "2026-07-05",
      hotels,
      services: [
        service({
          id: "president-out",
          time: "08:30",
          direction: "departure",
          customer_name: "Hotel President",
          hotel_id: "president",
          booking_service_kind: "navetta",
          service_type_code: "bus_line",
          meeting_point: "Piazzale Trieste 6, Ischia (Caffe del Direttore)",
        }),
        service({
          id: "president-in",
          time: "08:35",
          direction: "arrival",
          customer_name: "Hotel President",
          hotel_id: "president",
          booking_service_kind: "navetta",
          service_type_code: "bus_line",
          meeting_point: "Piazzale Trieste 6, Ischia (Caffe del Direttore)",
        }),
      ],
    });

    expect(result.summary.shuttle_pair_count).toBe(1);
    expect(result.shuttle_pairs[0]?.loop_label).toContain("NAVETTA CICLO");
    expect(result.summary.multi_drop_candidate_count).toBe(0);
  });

  it("detects accorpamento candidates for same pickup, same time, same destination stops", () => {
    const result = buildUnassignedServicesDiagnostics({
      date: "2026-07-05",
      hotels,
      services: [
        service({
          id: "iori",
          customer_name: "IORI",
          hotel_id: "villa",
          pickup_hotel: "12:15",
          barca_compagnia: "Medmar",
          orario_barca: "13:35",
          ferry_details: { departure_port: "Casamicciola" },
        }),
        service({
          id: "rossi",
          customer_name: "ROSSI",
          hotel_id: "villa",
          pickup_hotel: "12:15",
          barca_compagnia: "SNAV",
          orario_barca: "14:00",
          booking_service_kind: "formula_snav",
          ferry_details: { departure_port: "Casamicciola" },
        }),
      ],
    });

    expect(result.summary.accorpamento_candidate_count).toBe(1);
    expect(result.suggestions[0]?.action).toBe("ACCORPARE_CON_CONFERMA");
    expect(result.suggestions[0]?.total_pax).toBe(4);
  });
});
