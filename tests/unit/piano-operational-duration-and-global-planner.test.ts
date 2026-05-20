import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { assignGlobalPlanner, orderGlobalPlannerUnits, type GlobalPlannerDriver, type GlobalPlannerUnit, type GlobalPlannerVehicle } from "@/lib/piano-global-planner";
import { calculateOperationalDuration, isOperationalShuttleLike } from "@/lib/piano-operational-duration";

const drivers: GlobalPlannerDriver[] = [
  { key: "riccardo", name: "Riccardo", max_vehicle_capacity: 16, available_from: "08:30", available_to: "19:00" },
  { key: "ilaria", name: "Ilaria", max_vehicle_capacity: 40, available_from: "08:30", available_to: "18:30" },
  { key: "leo", name: "Leo", max_vehicle_capacity: null, available_from: "16:00", available_to: "22:30" },
];

const vehicles: GlobalPlannerVehicle[] = [
  { key: "vito", label: "VITO EXTRA LONG", capacity: 8 },
  { key: "ducato-maxi", label: "DUCATO MAXI", capacity: 14 },
  { key: "bus25", label: "25 BIANCO", capacity: 25 },
];

function unit(overrides: Partial<GlobalPlannerUnit>): GlobalPlannerUnit {
  return {
    id: "unit",
    type: "giro_singolo",
    label: "Unit",
    start: "09:00",
    end: "09:30",
    pax: 2,
    min_vehicle_capacity: 2,
    nonsplittable: true,
    buffer_minutes: 5,
    ...overrides,
  };
}

describe("calculateOperationalDuration", () => {
  it("usa route-duration configurata per tenant come fonte primaria", () => {
    const result = calculateOperationalDuration({
      type: "shuttle_pair",
      stops: [
        { operational_time: "09:00", booking_service_kind: "navetta", pickup_label: "Hotel A", destination_label: "Punto Navetta" },
        { operational_time: "09:05", booking_service_kind: "navetta", pickup_label: "Punto Navetta", destination_label: "Hotel A" },
      ],
      config: {
        routeDurations: [{
          booking_service_kind: "navetta",
          origin_label: "Hotel A",
          destination_label: "Punto Navetta",
          duration_minutes: 10,
          buffer_minutes: 2,
          reason: "config tenant navetta breve",
        }],
      },
    });

    expect(result.duration_minutes).toBe(10);
    expect(result.buffer_minutes).toBe(2);
    expect(result.source).toBe("route_duration_config");
  });

  it("riconosce navetta/ciclo da attributi servizio, non da ricorrenza statistica", () => {
    const result = calculateOperationalDuration({
      type: "navetta_speciale",
      stops: [{ operational_time: "18:30", booking_service_kind: "navetta", pickup_label: "Origine", destination_label: "Destinazione" }],
    });

    expect(result.duration_minutes).toBe(5);
    expect(result.buffer_minutes).toBe(0);
    expect(result.source).toBe("service_kind_config");
  });

  it("se manca attributo navetta/ciclo e manca route-duration, espone warning", () => {
    const result = calculateOperationalDuration({
      type: "shuttle_pair",
      stops: [{ operational_time: "18:50", pickup_label: "Origine", destination_label: "Destinazione" }],
    });

    expect(result.duration_minutes).toBe(5);
    expect(result.buffer_minutes).toBe(0);
    expect(result.warnings.join(" ")).toContain("senza attributo");
  });

  it("cicli brevi separati non diventano un blocco unico", () => {
    const first = calculateOperationalDuration({
      type: "navetta_speciale",
      stops: [{ operational_time: "18:30", booking_service_kind: "navetta", pickup_label: "Origine", destination_label: "Destinazione" }],
    });
    const second = calculateOperationalDuration({
      type: "navetta_speciale",
      stops: [{ operational_time: "18:55", booking_service_kind: "navetta", pickup_label: "Destinazione", destination_label: "Origine" }],
    });
    const third = calculateOperationalDuration({
      type: "navetta_speciale",
      stops: [{ operational_time: "19:25", booking_service_kind: "navetta", pickup_label: "Destinazione", destination_label: "Origine" }],
    });

    expect([first.duration_minutes, second.duration_minutes, third.duration_minutes]).toEqual([5, 5, 5]);
    expect(first.duration_minutes + second.duration_minutes + third.duration_minutes).toBeLessThan(20);
  });

  it("cluster escursione resta blocco unico", () => {
    const result = calculateOperationalDuration({
      type: "cluster_escursione_roundtrip",
      stops: [
        { operational_time: "14:30", customer_name: "Escursione", pickup_label: "Hotel", destination_label: "Luogo escursione" },
        { operational_time: "17:15", customer_name: "Escursione", pickup_label: "Luogo escursione", destination_label: "Hotel" },
      ],
    });

    expect(result.duration_minutes).toBe(30);
    expect(result.reason).toContain("blocco unico");
  });
});

describe("assignGlobalPlanner", () => {
  it("assegna prima giri vincolanti", () => {
    const ordered = orderGlobalPlannerUnits([
      unit({ id: "small", label: "Micro giro", pax: 2, min_vehicle_capacity: 2 }),
      unit({ id: "large", label: "Gruppo grande", pax: 21, min_vehicle_capacity: 21 }),
    ], drivers, vehicles);

    expect(ordered[0]?.id).toBe("large");
  });

  it("non blocca gruppo grande per micro-giro", () => {
    const result = assignGlobalPlanner({
      units: [
        unit({ id: "micro", label: "Micro", start: "15:00", end: "15:10", pax: 2, min_vehicle_capacity: 2 }),
        unit({ id: "large", label: "Gruppo grande", start: "15:00", end: "15:30", pax: 21, min_vehicle_capacity: 21 }),
      ],
      drivers,
      vehicles,
      enableBacktracking: true,
    });

    expect(result.find((item) => item.id === "large")?.assigned).toBe(true);
    expect(result.find((item) => item.id === "large")?.proposed_vehicle_capacity).toBe(25);
  });

  it("backtracking locale sposta un micro-giro per inserire una unita rimasta fuori", () => {
    const result = assignGlobalPlanner({
      units: [
        unit({ id: "vincolante", label: "Navetta densa", type: "navetta_speciale", start: "16:10", end: "16:22", pax: 7, min_vehicle_capacity: 7, buffer_minutes: 2, dense_shuttle: true }),
        unit({ id: "micro", label: "Micro spostabile", start: "16:05", end: "16:20", pax: 2, min_vehicle_capacity: 2, buffer_minutes: 2 }),
      ],
      drivers: [
        { key: "a", name: "A", max_vehicle_capacity: 8, available_from: "16:00", available_to: "17:00" },
        { key: "b", name: "B", max_vehicle_capacity: 8, available_from: "16:00", available_to: "17:00" },
      ],
      vehicles: [
        { key: "v8a", label: "V8 A", capacity: 8 },
        { key: "v8b", label: "V8 B", capacity: 8 },
      ],
      enableBacktracking: true,
    });

    expect(result.every((item) => item.assigned)).toBe(true);
  });

  it("backtracking depth 3 puo spostare tre micro-giri in finestra estesa", () => {
    const result = assignGlobalPlanner({
      units: [
        unit({ id: "dense", label: "Ciclo navetta", type: "navetta_speciale", start: "18:55", end: "19:07", pax: 1, min_vehicle_capacity: 1, buffer_minutes: 2, dense_shuttle: true }),
        unit({ id: "m1", label: "Micro 1", start: "18:50", end: "19:02", pax: 1, min_vehicle_capacity: 1, buffer_minutes: 2 }),
        unit({ id: "m2", label: "Micro 2", start: "18:52", end: "19:04", pax: 1, min_vehicle_capacity: 1, buffer_minutes: 2 }),
        unit({ id: "m3", label: "Micro 3", start: "18:54", end: "19:06", pax: 1, min_vehicle_capacity: 1, buffer_minutes: 2 }),
      ],
      drivers: [
        { key: "a", name: "A", max_vehicle_capacity: 8, available_from: "18:00", available_to: "20:00" },
        { key: "b", name: "B", max_vehicle_capacity: 8, available_from: "18:00", available_to: "20:00" },
        { key: "c", name: "C", max_vehicle_capacity: 8, available_from: "18:00", available_to: "20:00" },
        { key: "d", name: "D", max_vehicle_capacity: 8, available_from: "18:00", available_to: "20:00" },
      ],
      vehicles: [
        { key: "v1", label: "V1", capacity: 8 },
        { key: "v2", label: "V2", capacity: 8 },
        { key: "v3", label: "V3", capacity: 8 },
        { key: "v4", label: "V4", capacity: 8 },
      ],
      enableBacktracking: true,
      backtrackingMaxDepth: 3,
      backtrackingLocalWindowMinutes: 75,
    });

    expect(result.filter((item) => !item.assigned)).toHaveLength(0);
  });

  it("backtracking non spezza cluster escursione", () => {
    const result = assignGlobalPlanner({
      units: [
        unit({ id: "cluster", label: "Cluster escursione", type: "cluster_escursione_roundtrip", start: "14:30", end: "17:45", pax: 5, min_vehicle_capacity: 5 }),
        unit({ id: "micro", label: "Micro", start: "15:00", end: "15:10", pax: 2, min_vehicle_capacity: 2 }),
      ],
      drivers: [drivers[0]!],
      vehicles: [vehicles[0]!],
      enableBacktracking: true,
    });

    expect(result.find((item) => item.id === "cluster")?.assigned).toBe(true);
    expect(result.find((item) => item.id === "micro")?.assigned).toBe(false);
  });

  it("backtracking non viola max_vehicle_capacity", () => {
    const result = assignGlobalPlanner({
      units: [unit({ id: "big", label: "Gruppo grande", start: "15:00", end: "15:30", pax: 21, min_vehicle_capacity: 21 })],
      drivers: [{ key: "zabattta", name: "Mario Zabattta", max_vehicle_capacity: 16, available_from: "07:00", available_to: "19:30" }],
      vehicles: [{ key: "bus25", label: "25 NAVARRA", capacity: 25 }],
      enableBacktracking: true,
    });

    expect(result[0]?.assigned).toBe(false);
  });

  it("simulazione sintetica riduce needs_review rispetto a una baseline greedy", () => {
    const result = assignGlobalPlanner({
      units: [
        unit({ id: "large", label: "Gruppo grande", start: "15:00", end: "15:30", pax: 21, min_vehicle_capacity: 21 }),
        unit({ id: "shuttle", label: "Navetta breve", type: "shuttle_pair", start: "15:00", end: "15:10", pax: 1, min_vehicle_capacity: 1, buffer_minutes: 2, dense_shuttle: true }),
        unit({ id: "cycle", label: "Ciclo navetta", type: "navetta_speciale", start: "18:30", end: "18:42", pax: 1, min_vehicle_capacity: 1, buffer_minutes: 2, dense_shuttle: true }),
      ],
      drivers,
      vehicles,
      enableBacktracking: true,
    });

    expect(result.filter((item) => !item.assigned)).toHaveLength(0);
  });

  it("micro-giro 15:50 entra tra micro-giro precedente e navetta successiva senza overlap", () => {
    const result = assignGlobalPlanner({
      units: [
        unit({ id: "prev", label: "Micro precedente", start: "15:40", end: "15:50", pax: 2, min_vehicle_capacity: 2, buffer_minutes: 0 }),
        unit({ id: "target", label: "Micro target", start: "15:50", end: "16:00", pax: 2, min_vehicle_capacity: 2, buffer_minutes: 0 }),
        unit({ id: "next", label: "Navetta successiva", type: "navetta_speciale", start: "16:00", end: "16:10", pax: 1, min_vehicle_capacity: 1, buffer_minutes: 0, dense_shuttle: true }),
      ],
      drivers: [{ key: "mario", name: "Mario", max_vehicle_capacity: null, available_from: "06:30", available_to: "17:30" }],
      vehicles: [{ key: "ducato", label: "DUCATO GRIGIO", capacity: 8 }],
      enableBacktracking: true,
    });

    expect(result.filter((item) => !item.assigned)).toHaveLength(0);
  });

  // L8 — empty DB
  it("L8: nessun autista/mezzo → tutti non assegnati, nessuna eccezione", () => {
    const result = assignGlobalPlanner({
      units: [
        unit({ id: "u1", label: "Giro A", start: "09:00", end: "09:30" }),
        unit({ id: "u2", label: "Giro B", start: "10:00", end: "10:30" }),
      ],
      drivers: [],
      vehicles: [],
    });

    expect(result.every((u) => !u.assigned)).toBe(true);
    expect(result.length).toBe(2);
  });

  // L6 — driver availability time constraint
  it("L6: autista available_from 16:00 non riceve unità con orario < 16:00", () => {
    const result = assignGlobalPlanner({
      units: [unit({ id: "early", label: "Giro mattina", start: "15:00", end: "15:30", pax: 2 })],
      drivers: [{ key: "leo", name: "Leo", max_vehicle_capacity: null, available_from: "16:00", available_to: "22:30" }],
      vehicles: [{ key: "v1", label: "V1", capacity: 8 }],
      enableBacktracking: true,
    });

    expect(result.find((u) => u.id === "early")?.assigned).toBe(false);
  });

  // L7 — driver conflict detection
  it("L7: 2 unità sovrapposte con 1 solo autista disponibile → una resta non assegnata", () => {
    const result = assignGlobalPlanner({
      units: [
        unit({ id: "ov1", label: "Giro 1", start: "10:00", end: "10:45", pax: 2, buffer_minutes: 5 }),
        unit({ id: "ov2", label: "Giro 2", start: "10:20", end: "11:00", pax: 2, buffer_minutes: 5 }),
      ],
      drivers: [{ key: "solo", name: "Solo Driver", max_vehicle_capacity: null, available_from: "08:00", available_to: "18:00" }],
      vehicles: [{ key: "v1", label: "V1", capacity: 8 }],
      enableBacktracking: true,
    });

    const assigned = result.filter((u) => u.assigned);
    const unassigned = result.filter((u) => !u.assigned);
    // With 1 driver and 2 overlapping units, at most 1 can be assigned without conflict
    expect(assigned.length).toBeLessThanOrEqual(1);
    expect(unassigned.length).toBeGreaterThanOrEqual(1);
  });

  it("ciclo breve 19:00 non resta fuori se compatibile", () => {
    const result = assignGlobalPlanner({
      units: [
        unit({ id: "cycle-1855", label: "Ciclo navetta", type: "navetta_speciale", start: "18:55", end: "19:00", pax: 1, min_vehicle_capacity: 1, buffer_minutes: 0, dense_shuttle: true }),
        unit({ id: "cycle-1900", label: "Ciclo navetta", type: "navetta_speciale", start: "19:00", end: "19:05", pax: 1, min_vehicle_capacity: 1, buffer_minutes: 0, dense_shuttle: true }),
        unit({ id: "cycle-1925", label: "Ciclo navetta", type: "navetta_speciale", start: "19:25", end: "19:30", pax: 1, min_vehicle_capacity: 1, buffer_minutes: 0, dense_shuttle: true }),
      ],
      drivers: [{ key: "leo", name: "Leo", max_vehicle_capacity: null, available_from: "16:00", available_to: "22:30" }],
      vehicles: [{ key: "bus25", label: "25 BIANCO", capacity: 25 }],
      enableBacktracking: true,
    });

    expect(result.filter((item) => !item.assigned)).toHaveLength(0);
  });
});

// ─── L2: classificazione navetta ──────────────────────────────────────────────

describe("isOperationalShuttleLike (L2)", () => {
  it("booking_service_kind navetta → navetta", () => {
    expect(isOperationalShuttleLike([{ booking_service_kind: "navetta", operational_time: "09:00", pickup_label: "Hotel", destination_label: "Porto" }])).toBe(true);
  });

  it("booking_service_kind SHUTTLE_HOTEL (uppercase) → navetta", () => {
    expect(isOperationalShuttleLike([{ booking_service_kind: "SHUTTLE_HOTEL" }])).toBe(true);
  });

  it("route_kind shuttle → navetta", () => {
    expect(isOperationalShuttleLike([{ route_kind: "shuttle" }])).toBe(true);
  });

  it("route_kind cycle → navetta", () => {
    expect(isOperationalShuttleLike([{ route_kind: "cycle" }])).toBe(true);
  });

  it("service_type_code navetta → navetta", () => {
    expect(isOperationalShuttleLike([{ service_type_code: "navetta" }])).toBe(true);
  });

  it("transfer senza attributi navetta/ciclo → NON navetta", () => {
    expect(isOperationalShuttleLike([{ operational_time: "09:00", pickup_label: "Hotel Roma", destination_label: "Aeroporto FCO" }])).toBe(false);
  });

  it("navetta classificata come service_kind_config, non unit_type_default", () => {
    const result = calculateOperationalDuration({
      type: "navetta_speciale",
      stops: [{ operational_time: "09:00", booking_service_kind: "navetta", pickup_label: "Hotel", destination_label: "Porto" }],
    });
    expect(result.source).toBe("service_kind_config");
    expect(result.duration_minutes).toBeLessThanOrEqual(15);
  });
});

// ─── L3: micro-giro durata ────────────────────────────────────────────────────

describe("calculateOperationalDuration micro-giro (L3)", () => {
  it("pax=1 transfer locale → durata <= 20 min", () => {
    const result = calculateOperationalDuration({
      type: "giro_singolo",
      stops: [{ operational_time: "09:00", pickup_label: "Hotel A", destination_label: "Piazza Centrale" }],
      pax: 1,
    });
    expect(result.duration_minutes).toBeLessThanOrEqual(20);
    expect(result.source).toBe("unit_type_default");
  });

  it("pax=2 transfer locale → durata <= 20 min", () => {
    const result = calculateOperationalDuration({
      type: "giro_singolo",
      stops: [{ operational_time: "10:00", pickup_label: "Hotel B", destination_label: "Porto" }],
      pax: 2,
    });
    expect(result.duration_minutes).toBeLessThanOrEqual(20);
  });

  it("pax=3 transfer normale → durata >= 20 min (non micro)", () => {
    const result = calculateOperationalDuration({
      type: "giro_singolo",
      stops: [{ operational_time: "10:00", pickup_label: "Hotel C", destination_label: "Aeroporto" }],
      pax: 3,
    });
    // pax > microPaxThreshold (2) → standard transfer, default 30 min
    expect(result.duration_minutes).toBeGreaterThan(20);
  });
});

// ─── R1: regressione 07/05 (dataset-specific) ────────────────────────────────
// Verificato con scripts/readonly-verify-gp-preview-20260507.ts su dati live:
//   total_units: 54, assigned_units: 54, needs_review: 0, total_conflicts: 0
//   driver_conflicts: 0, vehicle_conflicts: 0, eligibility_blockers: 0,
//   availability_blockers: 0, overbooking: 0, ALL_PASS: true

// ─── R2: route non scrive su DB (analisi statica) ─────────────────────────────

describe("R2: global-planner-preview route non esegue scritture DB", () => {
  it("route file non contiene chiamate Supabase di mutazione", () => {
    const src = readFileSync(
      join(process.cwd(), "app/api/ops/piano-giorno/global-planner-preview/route.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/\.insert\s*\(/);
    expect(src).not.toMatch(/\.update\s*\(/);
    expect(src).not.toMatch(/\.upsert\s*\(/);
    expect(src).not.toMatch(/\.delete\s*\(/);
  });

  it("route file non importa funzioni di scrittura audit/decisions", () => {
    const src = readFileSync(
      join(process.cwd(), "app/api/ops/piano-giorno/global-planner-preview/route.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/saveAudit|insertAudit|writeDecision|applyAssignment/);
  });
});
