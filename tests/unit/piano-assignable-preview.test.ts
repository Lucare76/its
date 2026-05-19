import { describe, expect, it } from "vitest";
import { buildAutoAssignPreview, getAutoAssignPreviewUiMode } from "@/lib/piano-assignable-preview";

describe("buildAutoAssignPreview", () => {
  it("groups resolver review reasons into operational problem groups", () => {
    const preview = buildAutoAssignPreview({
      date: "2026-05-07",
      services: [{
        id: "svc-gpr",
        date: "2026-05-07",
        time: "09:30",
        direction: "departure",
        customer_name: "GPR PETER",
        pax: 21,
        booking_service_kind: "excursion",
        service_type_code: "excursion",
        service_type: "bus_tour",
        excursion_details: { from: "PARCO AURORA" },
      }],
      hotels: [],
      assignments: [],
    });

    expect(preview.ok).toBe(true);
    expect(preview.summary.total_services).toBe(1);
    expect(preview.summary.needs_review_count).toBe(1);
    expect(preview.by_macro_category.escursioni.count).toBe(1);
    expect(preview.problem_groups.excursion_destination_missing).toHaveLength(1);
    expect(preview.top_problems[0]?.service_id).toBe("svc-gpr");
    expect(preview.preview_status.status).toBe("PARTIAL");
  });

  it("protects locked manual assignments without turning them into resolver errors", () => {
    const preview = buildAutoAssignPreview({
      date: "2026-05-07",
      services: [{
        id: "svc-locked",
        date: "2026-05-07",
        time: "09:00",
        direction: "departure",
        customer_name: "HOTEL PRESIDENT",
        pax: 1,
        hotel_id: "hotel-president",
        booking_service_kind: "navetta",
        service_type_code: "bus_line",
        meeting_point: "Piazzale Trieste 6, Ischia (Caffe del Direttore)",
      }],
      hotels: [{ id: "hotel-president", name: "HOTEL TERME PRESIDENT", zone: "Ischia Porto" }],
      tripGroups: [{ id: "group-1", status: "active" }],
      assignments: [{ service_id: "svc-locked", group_id: "group-1", locked_by_operator: true }],
    });

    expect(preview.summary.locked_count).toBe(1);
    expect(preview.summary.assignable_count).toBe(0);
    expect(preview.locked).toHaveLength(1);
    expect(preview.problem_groups.locked_manual).toHaveLength(1);
    expect(preview.top_problems).toHaveLength(0);
    expect(preview.services[0]?.needs_review).toBe(false);
  });

  it("marks already assigned unlocked services separately from candidates", () => {
    const preview = buildAutoAssignPreview({
      date: "2026-05-07",
      services: [{
        id: "svc-assigned",
        date: "2026-05-07",
        time: "09:00",
        direction: "departure",
        customer_name: "HOTEL PRESIDENT",
        pax: 1,
        hotel_id: "hotel-president",
        booking_service_kind: "navetta",
        service_type_code: "bus_line",
        meeting_point: "Piazzale Trieste 6, Ischia (Caffe del Direttore)",
      }],
      hotels: [{ id: "hotel-president", name: "HOTEL TERME PRESIDENT", zone: "Ischia Porto" }],
      tripGroups: [{ id: "group-1", status: "active" }],
      assignments: [{ service_id: "svc-assigned", group_id: "group-1", locked_by_operator: false }],
    });

    expect(preview.summary.already_assigned_count).toBe(1);
    expect(preview.summary.assignable_count).toBe(0);
    expect(preview.already_assigned_unlocked).toHaveLength(1);
    expect(preview.services[0]?.already_assigned_unlocked).toBe(true);
  });

  it("computes island operational_time for FEST ROMON CELINE in preview", () => {
    const preview = buildAutoAssignPreview({
      date: "2026-05-07",
      services: [{
        id: "svc-fest",
        date: "2026-05-07",
        time: "08:40",
        arrival_time: "08:40",
        direction: "arrival",
        customer_name: "FEST ROMON CELINE",
        pax: 2,
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
      }],
      hotels: [{ id: "punto-azzurro", name: "RESORT PUNTO AZZURRO", zone: "Forio" }],
      assignments: [],
    });

    expect(preview.services[0]?.macro_category).toBe("ARRIVO");
    expect(preview.services[0]?.operational_time).toBe("12:15");
    expect(preview.services[0]?.ferry_departure_time).toBe("10:45");
    expect(preview.services[0]?.ferry_arrival_time).toBe("12:15");
    expect(preview.assignable).toHaveLength(1);
  });

  it("keeps needs_review services out of same-stop merge", () => {
    const preview = buildAutoAssignPreview({
      date: "2026-05-07",
      services: [
        {
          id: "svc-review",
          date: "2026-05-07",
          time: "09:30",
          direction: "departure",
          customer_name: "GPR PETER",
          pax: 21,
          booking_service_kind: "excursion",
          service_type_code: "excursion",
          service_type: "bus_tour",
          excursion_details: { from: "PARCO AURORA" },
        },
        {
          id: "svc-ok",
          date: "2026-05-07",
          time: "06:30",
          direction: "departure",
          customer_name: "PETTENNUZZO",
          pax: 4,
          hotel_id: "re-ferdinando",
          booking_service_kind: "formula_snav",
          service_type_code: "ferry_transfer",
          pickup_hotel: "06:30",
          barca_compagnia: "SNAV",
          orario_barca: "07:10",
          ferry_details: { departure_port: "Casamicciola" },
        },
      ],
      hotels: [{ id: "re-ferdinando", name: "RE FERDINANDO", zone: "Ischia Porto" }],
      assignments: [],
    });

    expect(preview.needs_review).toHaveLength(1);
    expect(preview.merged_stops).toHaveLength(1);
    expect(preview.merged_stops[0]?.services.map((service) => service.service_id)).toEqual(["svc-ok"]);
    expect(preview.preview_status.status).toBe("PARTIAL");
  });

  it("applies same-stop merge only to assignable services", () => {
    const preview = buildAutoAssignPreview({
      date: "2026-05-07",
      services: [
        {
          id: "svc-pettennuzzo",
          date: "2026-05-07",
          time: "06:30",
          direction: "departure",
          customer_name: "PETTENNUZZO",
          pax: 4,
          hotel_id: "re-ferdinando",
          booking_service_kind: "formula_snav",
          service_type_code: "ferry_transfer",
          pickup_hotel: "06:30",
          barca_compagnia: "SNAV",
          orario_barca: "07:10",
          ferry_details: { departure_port: "Casamicciola" },
        },
        {
          id: "svc-cam",
          date: "2026-05-07",
          time: "06:30",
          direction: "departure",
          customer_name: "CAM 176X2 - 330X1",
          pax: 3,
          hotel_id: "re-ferdinando",
          booking_service_kind: "formula_snav",
          service_type_code: "ferry_transfer",
          pickup_hotel: "06:30",
          barca_compagnia: "SNAV",
          orario_barca: "07:10",
          ferry_details: { departure_port: "Casamicciola" },
        },
      ],
      hotels: [{ id: "re-ferdinando", name: "RE FERDINANDO", zone: "Ischia Porto" }],
      assignments: [],
    });

    expect(preview.same_stop_groups).toHaveLength(1);
    expect(preview.same_stop_groups[0]?.total_pax).toBe(7);
    expect(preview.conflict_summary.same_stop_count).toBe(1);
    expect(preview.summary.same_stop_groups_count).toBe(1);
    expect(preview.giro_analyses[0]?.transitions[0]?.type).toBe("SAME_STOP");
  });

  it("marks preview NOT_READY when conflict classifier finds real conflicts", () => {
    const preview = buildAutoAssignPreview({
      date: "2026-05-07",
      services: [
        {
          id: "svc-a",
          date: "2026-05-07",
          direction: "departure",
          customer_name: "NAVETTA A",
          pax: 1,
          hotel_id: "hotel-president",
          booking_service_kind: "navetta",
          service_type_code: "bus_line",
          pickup_hotel: "08:35",
          meeting_point: "Ischia Porto",
        },
        {
          id: "svc-b",
          date: "2026-05-07",
          direction: "departure",
          customer_name: "NAVETTA B",
          pax: 1,
          hotel_id: "hotel-forio",
          booking_service_kind: "navetta",
          service_type_code: "bus_line",
          pickup_hotel: "08:40",
          meeting_point: "Forio Porto",
        },
      ],
      hotels: [
        { id: "hotel-president", name: "HOTEL PRESIDENT", zone: "Ischia Porto" },
        { id: "hotel-forio", name: "HOTEL FORIO", zone: "Forio" },
      ],
      assignments: [],
    });

    expect(preview.conflict_summary.conflict_real_count + preview.conflict_summary.overlap_count).toBeGreaterThan(0);
    expect(preview.preview_status.status).toBe("NOT_READY");
  });

  it("marks preview READY when same-zone departures have enough margin", () => {
    const preview = buildAutoAssignPreview({
      date: "2026-05-07",
      services: [
        {
          id: "svc-a",
          date: "2026-05-07",
          direction: "departure",
          customer_name: "PARTENZA A",
          pax: 2,
          hotel_id: "hotel-a",
          booking_service_kind: "formula_medmar",
          service_type_code: "ferry_transfer",
          pickup_hotel: "08:00",
          barca_compagnia: "Medmar",
          orario_barca: "08:40",
          ferry_details: { departure_port: "Forio Porto" },
        },
        {
          id: "svc-b",
          date: "2026-05-07",
          direction: "departure",
          customer_name: "PARTENZA B",
          pax: 2,
          hotel_id: "hotel-b",
          booking_service_kind: "formula_snav",
          service_type_code: "ferry_transfer",
          pickup_hotel: "08:27",
          barca_compagnia: "SNAV",
          orario_barca: "09:00",
          ferry_details: { departure_port: "Forio Porto" },
        },
      ],
      hotels: [
        { id: "hotel-a", name: "HOTEL A", zone: "Forio" },
        { id: "hotel-b", name: "HOTEL B", zone: "Forio" },
      ],
      assignments: [],
    });

    expect(preview.conflict_summary.warning_count).toBe(0);
    expect(preview.preview_status.status).toBe("READY");
  });

  it("marks preview READY when all assignable stops have sufficient margins", () => {
    const preview = buildAutoAssignPreview({
      date: "2026-05-07",
      services: [
        {
          id: "svc-a",
          date: "2026-05-07",
          direction: "departure",
          customer_name: "PARTENZA A",
          pax: 2,
          hotel_id: "hotel-a",
          booking_service_kind: "formula_medmar",
          service_type_code: "ferry_transfer",
          pickup_hotel: "08:00",
          barca_compagnia: "Medmar",
          orario_barca: "08:40",
          ferry_details: { departure_port: "Forio Porto" },
        },
        {
          id: "svc-b",
          date: "2026-05-07",
          direction: "departure",
          customer_name: "PARTENZA B",
          pax: 2,
          hotel_id: "hotel-b",
          booking_service_kind: "formula_snav",
          service_type_code: "ferry_transfer",
          pickup_hotel: "08:35",
          barca_compagnia: "SNAV",
          orario_barca: "09:00",
          ferry_details: { departure_port: "Forio Porto" },
        },
      ],
      hotels: [
        { id: "hotel-a", name: "HOTEL A", zone: "Forio" },
        { id: "hotel-b", name: "HOTEL B", zone: "Forio" },
      ],
      assignments: [],
    });

    expect(preview.preview_status.status).toBe("READY");
    expect(preview.summary.conflict_count).toBe(0);
    expect(preview.summary.warning_count).toBe(0);
  });

  it("switches to sunday_massive for Sundays and very large days", () => {
    expect(getAutoAssignPreviewUiMode("2026-05-10", 20)).toBe("sunday_massive");
    expect(getAutoAssignPreviewUiMode("2026-05-07", 251)).toBe("sunday_massive");
    expect(getAutoAssignPreviewUiMode("2026-05-07", 101)).toBe("intense_day");
    expect(getAutoAssignPreviewUiMode("2026-05-07", 100)).toBe("normal");
  });
});
