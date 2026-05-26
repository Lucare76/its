import { describe, expect, it } from "vitest";

import {
  analyzeGiro,
  classifyGiroTransitions,
  getGeoBuffer,
  getMacroArea,
  getPaxBuffer,
  getStopEndTime,
  type GiroAnalysis,
} from "@/lib/piano-conflict-classifier";
import type { MergedStop, SameStopMacroCategory } from "@/lib/piano-same-stop-merge";

type TestStop = MergedStop & {
  end_time?: string | null;
};

function makeStop(overrides: Partial<TestStop> = {}): TestStop {
  const macro = overrides.macro_category ?? "NAVETTA";
  const pickup = overrides.pickup_label ?? "Hotel A";
  const destination = overrides.destination_labels?.[0] ?? "Hotel B";
  const pax = overrides.total_pax ?? 2;

  return {
    stop_id: overrides.stop_id ?? `stop-${Math.random().toString(16).slice(2)}`,
    services: overrides.services ?? [
      {
        service_id: "service-1",
        customer_name: "CLIENTE TEST",
        macro_category: macro as SameStopMacroCategory,
        assignable: true,
        needs_review: false,
        review_reasons: [],
        operational_time: overrides.operational_time ?? "09:00",
        pickup_label: pickup,
        pickup_zone: "Forio",
        destination_label: destination,
        destination_zone: "Forio",
        pax,
      },
    ],
    total_pax: pax,
    operational_time: overrides.operational_time ?? "09:00",
    pickup_label: pickup,
    destination_labels: overrides.destination_labels ?? [destination],
    macro_category: macro as SameStopMacroCategory,
    ferry_company: overrides.ferry_company ?? null,
    ferry_departure_time: overrides.ferry_departure_time ?? null,
    ferry_arrival_time: overrides.ferry_arrival_time ?? null,
    port_departure: overrides.port_departure ?? null,
    port_arrival: overrides.port_arrival ?? null,
    is_merged: overrides.is_merged ?? false,
    merge_reason: overrides.merge_reason ?? null,
    warnings: overrides.warnings ?? [],
    end_time: overrides.end_time ?? null,
  };
}

function withZones(stop: TestStop, pickupZone: string | null, destinationZone: string | null): TestStop {
  return {
    ...stop,
    services: stop.services.map((service) => ({
      ...service,
      pickup_zone: pickupZone,
      destination_zone: destinationZone,
    })),
  };
}

describe("piano-conflict-classifier", () => {
  it("ricava macro-aree in modo case-insensitive", () => {
    expect(getMacroArea("Casamicciola")).toBe("NORD_OVEST");
    expect(getMacroArea("FORIO")).toBe("NORD_OVEST");
    expect(getMacroArea("Lacco Ameno")).toBe("NORD_OVEST");
    expect(getMacroArea("Sant'Angelo")).toBe("SUD_OVEST");
    expect(getMacroArea("Ischia Porto")).toBe("EST_SUD");
    expect(getMacroArea("barano")).toBe("EST_SUD");
    expect(getMacroArea(null)).toBeNull();
  });

  it("calcola buffer geografici conservativi", () => {
    expect(getGeoBuffer("Hotel President", "Hotel President", { samePoint: true }).minutes).toBe(5);
    expect(getGeoBuffer("Forio", "Forio").minutes).toBe(10);
    expect(getGeoBuffer("Forio", "Lacco Ameno").minutes).toBe(15);
    expect(getGeoBuffer("Forio", "Ischia Porto").minutes).toBe(30);

    const unknown = getGeoBuffer(null, "Forio");
    expect(unknown.minutes).toBe(40);
    expect(unknown.warnings).toContain("Zona non determinata: buffer prudente");
  });

  it("calcola buffer pax per fasce", () => {
    expect(getPaxBuffer(1)).toBe(0);
    expect(getPaxBuffer(5)).toBe(0);
    expect(getPaxBuffer(6)).toBe(5);
    expect(getPaxBuffer(10)).toBe(5);
    expect(getPaxBuffer(11)).toBe(10);
    expect(getPaxBuffer(21)).toBe(15);
    expect(getPaxBuffer(31)).toBe(20);
  });

  it("classifica conflitti reali quando il buffer non basta", () => {
    const conflictFiveVsThirty = classifyGiroTransitions([
      withZones(makeStop({ operational_time: "08:35", end_time: "08:35", destination_labels: ["Hotel President"] }), "Forio", "Forio"),
      withZones(makeStop({ operational_time: "08:40", pickup_label: "Ischia Porto" }), "Ischia Porto", "Ischia Porto"),
    ])[0]!;

    expect(conflictFiveVsThirty.type).toBe("CONFLICT_REAL");
    expect(conflictFiveVsThirty.minutes_available).toBe(5);
    expect(conflictFiveVsThirty.minutes_required).toBe(30);

    const conflictTenVsFifteen = classifyGiroTransitions([
      withZones(makeStop({ operational_time: "12:05", end_time: "12:05" }), "Forio", "Forio"),
      withZones(makeStop({ operational_time: "12:15", pickup_label: "Lacco Ameno" }), "Lacco Ameno", "Lacco Ameno"),
    ])[0]!;

    expect(conflictTenVsFifteen.type).toBe("CONFLICT_REAL");
    expect(conflictTenVsFifteen.minutes_available).toBe(10);
    expect(conflictTenVsFifteen.minutes_required).toBe(15);

    const largeExcursionConflict = classifyGiroTransitions([
      withZones(makeStop({
        macro_category: "ESCURSIONE",
        total_pax: 21,
        operational_time: "09:00",
        end_time: "09:00",
        destination_labels: ["Mortella"],
      }), "Forio", "Forio"),
      withZones(makeStop({ operational_time: "09:30", pickup_label: "Ischia Porto" }), "Ischia Porto", "Ischia Porto"),
    ])[0]!;

    expect(largeExcursionConflict.type).toBe("CONFLICT_REAL");
    expect(largeExcursionConflict.minutes_required).toBe(45);
  });

  it("classifica warning quando il margine e stretto", () => {
    const warningTwelveVsTen = classifyGiroTransitions([
      withZones(makeStop({ operational_time: "08:00", end_time: "08:00" }), "Forio", "Forio"),
      withZones(makeStop({ operational_time: "08:12" }), "Forio", "Forio"),
    ])[0]!;

    expect(warningTwelveVsTen.type).toBe("WARNING");
    expect(warningTwelveVsTen.margin).toBe(2);

    const warningTwentyThreeVsTwenty = classifyGiroTransitions([
      withZones(makeStop({ operational_time: "10:00", end_time: "10:00", total_pax: 6 }), "Forio", "Forio"),
      withZones(makeStop({ operational_time: "10:23", pickup_label: "Lacco Ameno" }), "Lacco Ameno", "Lacco Ameno"),
    ])[0]!;

    expect(warningTwentyThreeVsTwenty.type).toBe("WARNING");
    expect(warningTwentyThreeVsTwenty.minutes_required).toBe(20);
    expect(warningTwentyThreeVsTwenty.margin).toBe(3);
  });

  it("classifica OK quando il margine e sufficiente", () => {
    const okSameZone = classifyGiroTransitions([
      withZones(makeStop({ operational_time: "08:00", end_time: "08:00" }), "Forio", "Forio"),
      withZones(makeStop({ operational_time: "08:15" }), "Forio", "Forio"),
    ])[0]!;

    expect(okSameZone.type).toBe("OK");
    expect(okSameZone.margin).toBe(5);

    const okCrossArea = classifyGiroTransitions([
      withZones(makeStop({ operational_time: "11:00", end_time: "11:00" }), "Forio", "Forio"),
      withZones(makeStop({ operational_time: "12:00", pickup_label: "Ischia Porto" }), "Ischia Porto", "Ischia Porto"),
    ])[0]!;

    expect(okCrossArea.type).toBe("OK");
    expect(okCrossArea.minutes_required).toBe(30);
  });

  it("classifica overlap quando lo stop successivo inizia prima della fine stimata", () => {
    const overlap = classifyGiroTransitions([
      makeStop({ operational_time: "09:00", end_time: "09:20" }),
      makeStop({ operational_time: "09:10" }),
    ])[0]!;

    expect(overlap.type).toBe("OVERLAP");

    const notOverlap = classifyGiroTransitions([
      withZones(makeStop({ operational_time: "09:00", end_time: "09:20" }), "Forio", "Forio"),
      withZones(makeStop({ operational_time: "09:20" }), "Forio", "Forio"),
    ])[0]!;

    expect(notOverlap.type).not.toBe("OVERLAP");
    expect(notOverlap.type).toBe("CONFLICT_REAL");
  });

  it("riconosce same-stop gia mergeati senza warning 0 minuti", () => {
    const merged = makeStop({
      is_merged: true,
      merge_reason: "Stessa corsa, stesso porto e stessa destinazione",
      services: [
        {
          service_id: "service-a",
          macro_category: "PARTENZA",
          assignable: true,
          needs_review: false,
          review_reasons: [],
          operational_time: "06:30",
          pickup_label: "Re Ferdinando",
          destination_label: "Casamicciola",
          pax: 4,
        },
        {
          service_id: "service-b",
          macro_category: "PARTENZA",
          assignable: true,
          needs_review: false,
          review_reasons: [],
          operational_time: "06:30",
          pickup_label: "Re Ferdinando",
          destination_label: "Casamicciola",
          pax: 3,
        },
      ],
      total_pax: 7,
      macro_category: "PARTENZA",
      operational_time: "06:30",
      pickup_label: "Re Ferdinando",
      destination_labels: ["Casamicciola"],
    });

    const transitions = classifyGiroTransitions([merged]);

    expect(transitions).toHaveLength(1);
    expect(transitions[0]?.type).toBe("SAME_STOP");
    expect(transitions[0]?.minutes_required).toBe(0);
  });

  it("stima end_time prudenziale per macro-categoria", () => {
    expect(getStopEndTime(makeStop({ macro_category: "NAVETTA", operational_time: "09:00" })).time).toBe("09:15");
    expect(getStopEndTime(makeStop({ macro_category: "ARRIVO", operational_time: "09:00", total_pax: 11 })).time).toBe("09:20");

    const excursion = getStopEndTime(makeStop({ macro_category: "ESCURSIONE", operational_time: "09:00", total_pax: 21 }));
    expect(excursion.time).toBe("09:45");
    expect(excursion.warnings).toContain("Durata escursione non determinata");
  });

  it("analizza un giro con conteggi e worst conflict", () => {
    const analysis: GiroAnalysis = analyzeGiro("giro-1", "Mario", [
      withZones(makeStop({ operational_time: "08:00", end_time: "08:00" }), "Forio", "Forio"),
      withZones(makeStop({ operational_time: "08:12" }), "Forio", "Forio"),
      withZones(makeStop({ operational_time: "09:00", pickup_label: "Ischia Porto" }), "Ischia Porto", "Ischia Porto"),
      withZones(makeStop({ operational_time: "09:05", pickup_label: "Barano" }), "Barano", "Barano"),
    ]);

    expect(analysis.warning_count).toBeGreaterThanOrEqual(1);
    expect(analysis.conflict_count + analysis.overlap_count).toBeGreaterThan(0);
    expect(analysis.has_conflicts).toBe(true);
    expect(analysis.worst_conflict).not.toBeNull();
  });

  // ─── Regola 4: escursioni direzioni opposte ──────────────────────────────────

  // end_time = time per evitare che getStopEndTime aggiunga 30 min di durata stimata
  function makeEscursione(time: string, destinationZone: string, pax = 2): TestStop {
    return {
      ...makeStop({ macro_category: "ESCURSIONE", operational_time: time, total_pax: pax, end_time: time }),
      services: [{
        service_id: `esc-${time}`,
        macro_category: "ESCURSIONE",
        assignable: true,
        needs_review: false,
        review_reasons: [],
        operational_time: time,
        pickup_label: "Hotel Partenza",
        pickup_zone: null,
        destination_label: destinationZone,
        destination_zone: destinationZone,
        pax,
      }],
      destination_labels: [destinationZone],
      pickup_label: "Hotel Partenza",
      end_time: time,
    };
  }

  it("Regola 4: escursioni consecutive verso macro-aree diverse → CONFLICT_REAL", () => {
    // Felix (EST_SUD) → Nitrodi (EST_SUD)  poi  Cristallo (EST_SUD) → Mortella (NORD_OVEST)
    const nitrodi = makeEscursione("14:30", "Barano");        // dest: EST_SUD
    const mortella = makeEscursione("14:50", "Forio");        // dest: NORD_OVEST
    const transitions = classifyGiroTransitions([nitrodi, mortella]);
    expect(transitions[0]?.type).toBe("CONFLICT_REAL");
    expect(transitions[0]?.reason).toContain("direzioni opposte");
    expect(transitions[0]?.from_macro_area).toBe("EST_SUD");
    expect(transitions[0]?.to_macro_area).toBe("NORD_OVEST");
  });

  it("Regola 4: escursioni consecutive stessa macro-area con buffer < 30 → CONFLICT_REAL", () => {
    // Mortella (NORD_OVEST) → Citara (NORD_OVEST) con solo 20 min (end_time = operational_time)
    const e1 = makeEscursione("09:00", "Forio");
    const e2 = makeEscursione("09:20", "Casamicciola");
    const transitions = classifyGiroTransitions([e1, e2]);
    // 20 min disponibili, 30+pax richiesti → CONFLICT_REAL
    expect(transitions[0]?.type).toBe("CONFLICT_REAL");
    expect(transitions[0]?.minutes_available).toBe(20);
    expect(transitions[0]?.minutes_required).toBeGreaterThanOrEqual(30);
  });

  it("Regola 4: escursioni consecutive stessa macro-area con buffer >= 30 → OK", () => {
    // 45 min disponibili, geo 40 (pickup sconosciuto), margin=5 → OK
    const e1 = makeEscursione("09:00", "Forio");
    const e2 = makeEscursione("09:45", "Casamicciola");
    const transitions = classifyGiroTransitions([e1, e2]);
    expect(transitions[0]?.type).toBe("OK");
  });

  it("Regola 4: escursione 21 pax + altra dopo 20 min stessa area → CONFLICT_REAL (buffer pax)", () => {
    // 20 min disponibili, 30 (area) + 15 (pax) = 45 richiesti → CONFLICT_REAL
    const e1 = makeEscursione("14:30", "Forio", 21);
    const e2 = makeEscursione("14:50", "Forio");
    const transitions = classifyGiroTransitions([e1, e2]);
    expect(transitions[0]?.type).toBe("CONFLICT_REAL");
    expect(transitions[0]?.minutes_required).toBeGreaterThanOrEqual(45); // 30 + 15 pax buffer
  });

  it("Regola 4: escursione seguita da PARTENZA → regola opposte NON si applica", () => {
    // Non è ESCURSIONE+ESCURSIONE, la regola speciale non deve attivarsi
    const esc = makeEscursione("09:00", "Forio");
    const partenza = withZones(
      makeStop({ macro_category: "PARTENZA", operational_time: "10:30", pickup_label: "Hotel A" }),
      "Forio", "Ischia Porto",
    );
    const transitions = classifyGiroTransitions([esc, partenza]);
    // Il reason non deve contenere "direzioni opposte" (sarebbe la regola esclusiva escursioni)
    expect(transitions[0]?.reason).not.toContain("direzioni opposte");
  });
});
