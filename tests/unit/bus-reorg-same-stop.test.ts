import { describe, it, expect } from "vitest";
import { planBusReorganization, type ReorgBus, type ReorgAllocation, type ReorgNewPassenger } from "@/lib/bus-reorg-planner";

describe("planBusReorganization — raggruppamento stessa fermata", () => {
  const makeBuses = (...specs: Array<[string, string, number]>): ReorgBus[] =>
    specs.map(([id, label, capacity]) => ({ id, label, capacity, lineId: "line-1" }));

  const makeAllocs = (...specs: Array<[string, string, string, number]>): ReorgAllocation[] =>
    specs.map(([id, busId, stopName, pax]) => ({ id, busId, stopName, pax, serviceId: `svc-${id}` }));

  it("assegna nuovi pax al bus che ha già la stessa fermata (con spazio)", () => {
    const buses = makeBuses(["b1", "Centro 1", 54], ["b2", "Centro 2", 54]);
    const existing: ReorgAllocation[] = makeAllocs(
      ["a1", "b1", "PERUGIA", 20],
      ["a2", "b1", "FOLIGNO", 10],
    );
    const newPax: ReorgNewPassenger[] = [{ stopName: "PERUGIA", pax: 5 }];

    const result = planBusReorganization(buses, existing, newPax);
    expect(result.assignments[0].busId).toBe("b1");
    expect(result.moves).toHaveLength(0);
  });

  it("sposta pax di altre fermate per fare posto alla stessa fermata", () => {
    const buses = makeBuses(["b1", "Centro 1", 54], ["b2", "Centro 2", 54]);
    const existing: ReorgAllocation[] = makeAllocs(
      ["a1", "b1", "PERUGIA", 40],
      ["a2", "b1", "FOLIGNO", 10],
    );
    // Bus 1 ha 50/54. Arrivano 6 da Perugia → non ci stanno (50+6=56>54)
    // Deve spostare Foligno (10) su bus 2, poi Perugia ci sta (40+6=46)
    const newPax: ReorgNewPassenger[] = [{ stopName: "PERUGIA", pax: 6 }];

    const result = planBusReorganization(buses, existing, newPax);
    expect(result.assignments[0].busId).toBe("b1");
    expect(result.moves.length).toBeGreaterThan(0);
    expect(result.moves[0].fromBusId).toBe("b1");
    expect(result.moves[0].toBusId).toBe("b2");
    expect(result.moves[0].stopName).toBe("FOLIGNO");
  });

  it("non sposta se non c'è un bus destinazione con capienza", () => {
    const buses = makeBuses(["b1", "Centro 1", 54], ["b2", "Centro 2", 54]);
    const existing: ReorgAllocation[] = makeAllocs(
      ["a1", "b1", "PERUGIA", 40],
      ["a2", "b1", "FOLIGNO", 10],
      ["a3", "b2", "SPOLETO", 50],
    );
    // Bus 2 ha 50/54, non può prendere 10 di Foligno (50+10=60>54)
    const newPax: ReorgNewPassenger[] = [{ stopName: "PERUGIA", pax: 6 }];

    const result = planBusReorganization(buses, existing, newPax);
    // Non può riorganizzare → skip (nessun bus con capienza per spostare Foligno)
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].stopName).toBe("PERUGIA");
  });

  it("nuova fermata senza bus esistente → assegna al primo libero", () => {
    const buses = makeBuses(["b1", "Centro 1", 54], ["b2", "Centro 2", 54]);
    const existing: ReorgAllocation[] = makeAllocs(
      ["a1", "b1", "PERUGIA", 30],
    );
    const newPax: ReorgNewPassenger[] = [{ stopName: "FOLIGNO", pax: 5 }];

    const result = planBusReorganization(buses, existing, newPax);
    expect(result.assignments[0]).toBeDefined();
    expect(result.moves).toHaveLength(0);
  });

  it("sposta il gruppo più piccolo per minimizzare gli spostamenti", () => {
    const buses = makeBuses(["b1", "Centro 1", 54], ["b2", "Centro 2", 54]);
    const existing: ReorgAllocation[] = makeAllocs(
      ["a1", "b1", "PERUGIA", 35],
      ["a2", "b1", "FOLIGNO", 12],
      ["a3", "b1", "SPOLETO", 3],
    );
    // Bus 1 ha 50/54. Arrivano 6 da Perugia (50+6=56>54).
    // Deve spostare il gruppo più piccolo che libera abbastanza spazio.
    // Spoleto (3 pax) non basta (50-3+6=53 ok!). Sì basta: 50-3=47, 47+6=53≤54
    const newPax: ReorgNewPassenger[] = [{ stopName: "PERUGIA", pax: 6 }];

    const result = planBusReorganization(buses, existing, newPax);
    expect(result.assignments[0].busId).toBe("b1");
    expect(result.moves).toHaveLength(1);
    expect(result.moves[0].stopName).toBe("SPOLETO");
    expect(result.moves[0].pax).toBe(3);
  });

  it("gestisce più gruppi di nuovi passeggeri", () => {
    const buses = makeBuses(["b1", "Centro 1", 54], ["b2", "Centro 2", 54]);
    const existing: ReorgAllocation[] = [];
    const newPax: ReorgNewPassenger[] = [
      { stopName: "PERUGIA", pax: 30 },
      { stopName: "FOLIGNO", pax: 20 },
    ];

    const result = planBusReorganization(buses, existing, newPax);
    expect(result.assignments).toHaveLength(2);
    // Tutti i Perugia sullo stesso bus
    const perugia = result.assignments.find(a => a.stopName === "PERUGIA");
    const foligno = result.assignments.find(a => a.stopName === "FOLIGNO");
    expect(perugia).toBeDefined();
    expect(foligno).toBeDefined();
  });
});
