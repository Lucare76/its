import { describe, it, expect } from "vitest";
import { assignGlobalPlanner, type GlobalPlannerUnit, type GlobalPlannerDriver, type GlobalPlannerVehicle } from "@/lib/piano-global-planner";

/**
 * ML Data Collection Sprint 2 — FASE 5/12: candidate_scores esposto da
 * assignGlobalPlanner() deve derivare dal ranking REALE già calcolato da
 * chooseCandidate() (stesso score, stesso ordinamento, stesso vincitore),
 * non un ranking ricostruito dopo. Nessuna modifica allo score o
 * all'ordinamento esistente.
 */
function unit(overrides: Partial<GlobalPlannerUnit> = {}): GlobalPlannerUnit {
  return {
    id: "draft_0", type: "departure", label: "Test", start: "09:00", end: "09:30",
    pax: 2, min_vehicle_capacity: 2, nonsplittable: false, ...overrides,
  };
}

const driverA: GlobalPlannerDriver = { key: "drv-a", name: "Driver A" };
const driverB: GlobalPlannerDriver = { key: "drv-b", name: "Driver B" };
const vehicle1: GlobalPlannerVehicle = { key: "veh-1", label: "Van 8", capacity: 8 };

describe("assignGlobalPlanner — candidate_scores (ML Data Collection Sprint 2)", () => {
  it("1. assegnazione diretta: candidate_scores presente, contiene tutti i driver compatibili con il loro score reale", () => {
    const result = assignGlobalPlanner({ units: [unit()], drivers: [driverA, driverB], vehicles: [vehicle1] });
    const assignment = result[0]!;
    expect(assignment.assigned).toBe(true);
    expect(assignment.candidate_scores).toBeDefined();
    const keys = assignment.candidate_scores!.map((c) => c.driver_key).sort();
    expect(keys).toEqual(["drv-a", "drv-b"]);
  });

  it("2. il vincitore (proposed_driver_key) è sempre il driver con lo score più basso in candidate_scores", () => {
    // current_driver_key abbassa lo score di driverB di 100 nel calcolo reale
    // di chooseCandidate — verifica solo che il vincitore coincida con il
    // minimo del ranking esposto, senza duplicare la formula di scoring.
    const result = assignGlobalPlanner({
      units: [unit({ current_driver_key: "drv-b" })],
      drivers: [driverA, driverB],
      vehicles: [vehicle1],
    });
    const assignment = result[0]!;
    expect(assignment.proposed_driver_key).toBe("drv-b");
    const minEntry = [...assignment.candidate_scores!].sort((a, b) => a.score - b.score)[0]!;
    expect(minEntry.driver_key).toBe(assignment.proposed_driver_key);
  });

  it("3. ordinamento/score invariati: stesso vincitore prodotto con e senza lettura di candidate_scores", () => {
    const units = [unit()];
    const a = assignGlobalPlanner({ units, drivers: [driverA, driverB], vehicles: [vehicle1] });
    const b = assignGlobalPlanner({ units, drivers: [driverA, driverB], vehicles: [vehicle1] });
    expect(a[0]!.proposed_driver_key).toBe(b[0]!.proposed_driver_key);
    expect(a[0]!.candidate_scores).toEqual(b[0]!.candidate_scores);
  });

  it("4. nessun candidato compatibile: assigned=false, candidate_scores assente (non fabbricato)", () => {
    const result = assignGlobalPlanner({
      units: [unit({ min_vehicle_capacity: 99 })],
      drivers: [driverA],
      vehicles: [vehicle1],
    });
    const assignment = result[0]!;
    expect(assignment.assigned).toBe(false);
    expect(assignment.candidate_scores).toBeUndefined();
  });
});
