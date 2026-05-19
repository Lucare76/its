import { describe, expect, it } from "vitest";
import {
  buildSameStopMergeKey,
  mergeSameStops,
  type ResolvedServiceForSameStop,
} from "@/lib/piano-same-stop-merge";

function resolved(overrides: Partial<ResolvedServiceForSameStop>): ResolvedServiceForSameStop {
  return {
    service_id: overrides.service_id ?? "svc-1",
    customer_name: overrides.customer_name ?? "TEST",
    macro_category: overrides.macro_category ?? "PARTENZA",
    assignable: overrides.assignable ?? true,
    needs_review: overrides.needs_review ?? false,
    review_reasons: overrides.review_reasons ?? [],
    operational_time: overrides.operational_time ?? "09:00",
    pickup_label: overrides.pickup_label ?? "Hotel Test",
    pickup_zone: overrides.pickup_zone ?? "Forio",
    destination_label: overrides.destination_label ?? "Casamicciola",
    destination_zone: overrides.destination_zone ?? null,
    pax: overrides.pax ?? 2,
    ferry_company: overrides.ferry_company ?? "SNAV",
    ferry_departure_time: overrides.ferry_departure_time ?? "10:00",
    ferry_arrival_time: overrides.ferry_arrival_time ?? null,
    port_departure: overrides.port_departure ?? "Casamicciola",
    port_arrival: overrides.port_arrival ?? null,
    booking_service_kind: overrides.booking_service_kind ?? null,
    service_type_code: overrides.service_type_code ?? null,
  };
}

function arrival(overrides: Partial<ResolvedServiceForSameStop>) {
  return resolved({
    macro_category: "ARRIVO",
    pickup_label: overrides.port_arrival ?? "Ischia Porto",
    pickup_zone: overrides.port_arrival ?? "Ischia Porto",
    destination_label: "Hotel Test",
    destination_zone: "Forio",
    ferry_company: "Medmar",
    ferry_departure_time: "13:30",
    ferry_arrival_time: "14:30",
    port_departure: null,
    port_arrival: "Ischia Porto",
    ...overrides,
  });
}

describe("mergeSameStops", () => {
  it("merges case A PETTENNUZZO and CAM176X2 departure", () => {
    const stops = mergeSameStops([
      resolved({ service_id: "pettennuzzo", customer_name: "PETTENNUZZO", pax: 4, operational_time: "06:30", pickup_label: "Re Ferdinando", ferry_company: "SNAV", ferry_departure_time: "07:10", port_departure: "Casamicciola" }),
      resolved({ service_id: "cam176", customer_name: "CAM 176X2 - 330X1", pax: 3, operational_time: "06:30", pickup_label: "Re Ferdinando", ferry_company: "SNAV", ferry_departure_time: "07:10", port_departure: "Casamicciola" }),
    ]);

    expect(stops).toHaveLength(1);
    expect(stops[0]?.total_pax).toBe(7);
    expect(stops[0]?.is_merged).toBe(true);
    expect(stops[0]?.warnings).toHaveLength(0);
    expect(stops[0]?.merge_reason).toContain("Stesso pickup");
  });

  it("merges case F IORI and SCARANI same La Villa Medmar 13:35", () => {
    const stops = mergeSameStops([
      resolved({ service_id: "iori", customer_name: "IORI", pax: 2, operational_time: "12:15", pickup_label: "La Villa", ferry_company: "Medmar", ferry_departure_time: "13:35", port_departure: "Casamicciola" }),
      resolved({ service_id: "scarani", customer_name: "SCARANI", pax: 2, operational_time: "12:15", pickup_label: "La Villa", ferry_company: "Medmar", ferry_departure_time: "13:35", port_departure: "Casamicciola" }),
    ]);

    expect(stops).toHaveLength(1);
    expect(stops[0]?.total_pax).toBe(4);
    expect(stops[0]?.is_merged).toBe(true);
  });

  it("merges case G DIOLOSA and ROSSI same La Villa SNAV 14:00", () => {
    const stops = mergeSameStops([
      resolved({ service_id: "diolosa", customer_name: "DIOLOSA'", pax: 2, operational_time: "12:30", pickup_label: "La Villa", ferry_company: "SNAV", ferry_departure_time: "14:00", port_departure: "Casamicciola" }),
      resolved({ service_id: "rossi", customer_name: "ROSSI", pax: 2, operational_time: "12:30", pickup_label: "La Villa", ferry_company: "SNAV", ferry_departure_time: "14:00", port_departure: "Casamicciola" }),
    ]);

    expect(stops).toHaveLength(1);
    expect(stops[0]?.total_pax).toBe(4);
    expect(stops[0]?.warnings).toHaveLength(0);
  });

  it("merges case B RIGATELLI and SPADA same arrival ferry and hotel", () => {
    const stops = mergeSameStops([
      arrival({ service_id: "rigatelli", customer_name: "RIGATELLI", pax: 2, operational_time: "14:30", destination_label: "Hotel Terme Colella", destination_zone: "Forio" }),
      arrival({ service_id: "spada", customer_name: "SPADA", pax: 1, operational_time: "14:30", destination_label: "Hotel Terme Colella", destination_zone: "Forio" }),
    ]);

    expect(stops).toHaveLength(1);
    expect(stops[0]?.total_pax).toBe(3);
    expect(stops[0]?.is_merged).toBe(true);
  });

  it("merges case C D'ARIA and GUIDA same SNAV Casamicciola and Colella", () => {
    const stops = mergeSameStops([
      arrival({ service_id: "daria", customer_name: "D'ARIA", pax: 2, operational_time: "17:25", ferry_company: "SNAV", ferry_departure_time: "16:20", ferry_arrival_time: "17:25", port_arrival: "Casamicciola", pickup_label: "Casamicciola", destination_label: "Hotel Terme Colella", destination_zone: "Forio" }),
      arrival({ service_id: "guida", customer_name: "GUIDA", pax: 7, operational_time: "17:25", ferry_company: "SNAV", ferry_departure_time: "16:20", ferry_arrival_time: "17:25", port_arrival: "Casamicciola", pickup_label: "Casamicciola", destination_label: "Hotel Terme Colella", destination_zone: "Forio" }),
    ]);

    expect(stops).toHaveLength(1);
    expect(stops[0]?.total_pax).toBe(9);
    expect(stops[0]?.warnings).toHaveLength(0);
  });

  it("merges case D DE SILVA and PINNA same Medmar Ischia Porto Punto Azzurro", () => {
    const stops = mergeSameStops([
      arrival({ service_id: "desilva", customer_name: "DE SILVA", pax: 2, operational_time: "15:40", ferry_company: "Medmar", ferry_departure_time: "14:20", ferry_arrival_time: "15:40", port_arrival: "Ischia Porto", pickup_label: "Ischia Porto", destination_label: "Resort Punto Azzurro", destination_zone: "Forio" }),
      arrival({ service_id: "pinna", customer_name: "PINNA", pax: 2, operational_time: "15:40", ferry_company: "Medmar", ferry_departure_time: "14:20", ferry_arrival_time: "15:40", port_arrival: "Ischia Porto", pickup_label: "Ischia Porto", destination_label: "Resort Punto Azzurro", destination_zone: "Forio" }),
    ]);

    expect(stops).toHaveLength(1);
    expect(stops[0]?.total_pax).toBe(4);
  });

  it("merges case E PETTENNUZZO and CAM176X2 return same SNAV Casamicciola", () => {
    const stops = mergeSameStops([
      arrival({ service_id: "pettennuzzo-return", customer_name: "PETTENNUZZO", pax: 4, operational_time: "17:25", ferry_company: "SNAV", ferry_departure_time: "16:20", ferry_arrival_time: "17:25", port_arrival: "Casamicciola", pickup_label: "Casamicciola", destination_label: "Re Ferdinando", destination_zone: "Ischia Porto" }),
      arrival({ service_id: "cam176-return", customer_name: "CAM 176X2", pax: 3, operational_time: "17:25", ferry_company: "SNAV", ferry_departure_time: "16:20", ferry_arrival_time: "17:25", port_arrival: "Casamicciola", pickup_label: "Casamicciola", destination_label: "Re Ferdinando", destination_zone: "Ischia Porto" }),
    ]);

    expect(stops).toHaveLength(1);
    expect(stops[0]?.total_pax).toBe(7);
  });

  it("merges case H different arrival destinations in same macro area", () => {
    const stops = mergeSameStops([
      arrival({ service_id: "grasso", customer_name: "GRASSO", pax: 2, operational_time: "15:50", ferry_company: "Medmar", ferry_departure_time: "14:20", ferry_arrival_time: "15:50", port_arrival: "Ischia Porto", destination_label: "Hotel Terme Colella", destination_zone: "Forio" }),
      arrival({ service_id: "giulia", customer_name: "GIULIA", pax: 2, operational_time: "15:50", ferry_company: "Medmar", ferry_departure_time: "14:20", ferry_arrival_time: "15:50", port_arrival: "Ischia Porto", destination_label: "Royal Palm Hotel Terme", destination_zone: "Forio" }),
    ]);

    expect(stops).toHaveLength(1);
    expect(stops[0]?.total_pax).toBe(4);
    expect(stops[0]?.destination_labels).toEqual(["Hotel Terme Colella", "Royal Palm Hotel Terme"]);
    expect(stops[0]?.merge_reason).toContain("macro-area");
  });

  it("does not merge case H when one destination zone is missing", () => {
    const stops = mergeSameStops([
      arrival({ service_id: "grasso", customer_name: "GRASSO", destination_label: "Hotel Terme Colella", destination_zone: "Forio" }),
      arrival({ service_id: "giulia", customer_name: "GIULIA", destination_label: "Royal Palm Hotel Terme", destination_zone: null }),
    ]);

    expect(stops).toHaveLength(2);
  });

  it("splits case I into CATULLO+LODI, PAOLETTI, and LA MANTIA", () => {
    const stops = mergeSameStops([
      resolved({ service_id: "catullo", customer_name: "CATULLO", operational_time: "08:30", pickup_label: "La Villa", ferry_company: "Medmar", ferry_departure_time: "10:10", port_departure: "Casamicciola" }),
      resolved({ service_id: "paoletti", customer_name: "PAOLETTI", operational_time: "08:30", pickup_label: "La Villa", ferry_company: "Medmar", ferry_departure_time: "10:35", port_departure: "Casamicciola" }),
      resolved({ service_id: "lamantia", customer_name: "LA MANTIA", operational_time: "08:30", pickup_label: "La Villa", ferry_company: "SNAV", ferry_departure_time: "09:45", port_departure: "Casamicciola" }),
      resolved({ service_id: "lodi", customer_name: "LODI", operational_time: "08:30", pickup_label: "La Villa", ferry_company: "Medmar", ferry_departure_time: "10:10", port_departure: "Casamicciola" }),
    ]);

    expect(stops).toHaveLength(3);
    expect(stops.map((stop) => stop.services.map((service) => service.service_id).sort())).toContainEqual(["catullo", "lodi"]);
  });

  it("does not merge same pickup with different ferry company or time", () => {
    const stops = mergeSameStops([
      resolved({ service_id: "a", pickup_label: "La Villa", ferry_company: "Medmar", ferry_departure_time: "10:10" }),
      resolved({ service_id: "b", pickup_label: "La Villa", ferry_company: "SNAV", ferry_departure_time: "10:10" }),
      resolved({ service_id: "c", pickup_label: "La Villa", ferry_company: "Medmar", ferry_departure_time: "10:35" }),
    ]);

    expect(stops).toHaveLength(3);
  });

  it("does not merge when island ports are different", () => {
    const stops = mergeSameStops([
      resolved({ service_id: "a", pickup_label: "La Villa", ferry_company: "Medmar", ferry_departure_time: "10:10", port_departure: "Casamicciola" }),
      resolved({ service_id: "b", pickup_label: "La Villa", ferry_company: "Medmar", ferry_departure_time: "10:10", port_departure: "Ischia Porto" }),
    ]);

    expect(stops).toHaveLength(2);
  });

  it("merges 14 minute time difference but not 16 minute difference", () => {
    const mergeable = mergeSameStops([
      resolved({ service_id: "a", operational_time: "08:30" }),
      resolved({ service_id: "b", operational_time: "08:44" }),
    ]);
    const notMergeable = mergeSameStops([
      resolved({ service_id: "a", operational_time: "08:30" }),
      resolved({ service_id: "b", operational_time: "08:46" }),
    ]);

    expect(mergeable).toHaveLength(1);
    expect(notMergeable).toHaveLength(2);
  });

  it("never merges navette even with same time and route", () => {
    const stops = mergeSameStops([
      resolved({ service_id: "a", macro_category: "NAVETTA", pickup_label: "Hotel President", destination_label: "Caffe del Direttore", operational_time: "08:30" }),
      resolved({ service_id: "b", macro_category: "NAVETTA", pickup_label: "Hotel President", destination_label: "Caffe del Direttore", operational_time: "08:30" }),
    ]);

    expect(stops).toHaveLength(2);
    expect(stops.every((stop) => !stop.is_merged)).toBe(true);
  });

  it("does not merge needs_review services", () => {
    const stops = mergeSameStops([
      resolved({ service_id: "a", needs_review: true, assignable: false, review_reasons: ["Porto arrivo isola non determinato"] }),
      resolved({ service_id: "b", needs_review: true, assignable: false, review_reasons: ["Porto arrivo isola non determinato"] }),
    ]);

    expect(stops).toHaveLength(2);
  });

  it("splits same-stop by max vehicle capacity with first-fit decreasing", () => {
    const stops = mergeSameStops([
      resolved({ service_id: "a", pax: 10 }),
      resolved({ service_id: "b", pax: 8 }),
      resolved({ service_id: "c", pax: 4 }),
    ], { maxVehicleCapacity: 16 });

    expect(stops).toHaveLength(2);
    expect(stops.map((stop) => stop.total_pax).sort((a, b) => b - a)).toEqual([14, 8]);
    expect(stops.every((stop) => stop.warnings.includes("Gruppo same-stop splittato per capienza"))).toBe(true);
  });

  it("keeps over-capacity same-stop as one stop when maxVehicleCapacity is missing", () => {
    const stops = mergeSameStops([
      resolved({ service_id: "a", pax: 9 }),
      resolved({ service_id: "b", pax: 9 }),
    ]);

    expect(stops).toHaveLength(1);
    expect(stops[0]?.total_pax).toBe(18);
  });

  it("returns correct output shape and chronological ordering", () => {
    const stops = mergeSameStops([
      resolved({ service_id: "late", operational_time: "12:00", pickup_label: "La Villa", ferry_departure_time: "13:35" }),
      resolved({ service_id: "early-a", operational_time: "06:30", pickup_label: "Re Ferdinando", ferry_company: "SNAV", ferry_departure_time: "07:10", port_departure: "Casamicciola", destination_label: "Casamicciola" }),
      resolved({ service_id: "early-b", operational_time: "06:30", pickup_label: "Re Ferdinando", ferry_company: "SNAV", ferry_departure_time: "07:10", port_departure: "Casamicciola", destination_label: "Casamicciola" }),
    ]);

    expect(stops[0]?.operational_time).toBe("06:30");
    expect(stops[0]?.is_merged).toBe(true);
    expect(stops[0]?.merge_reason).toBeTruthy();
    expect(stops[0]?.destination_labels).toEqual(["Casamicciola"]);
    expect(stops[1]?.is_merged).toBe(false);
  });

  it("builds stable review and shuttle merge keys with service id", () => {
    expect(buildSameStopMergeKey(resolved({ service_id: "nav", macro_category: "NAVETTA" }))).toBe("shuttle|nav");
    expect(buildSameStopMergeKey(resolved({ service_id: "review", assignable: false, needs_review: true }))).toBe("review|review");
  });
});
