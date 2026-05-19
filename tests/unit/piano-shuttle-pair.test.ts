import { describe, expect, it } from "vitest";

import { detectShuttlePairs, type ShuttlePairStop } from "@/lib/piano-shuttle-pair";

function stop(overrides: Partial<ShuttlePairStop> = {}): ShuttlePairStop {
  const pickup = overrides.pickup_label ?? "HOTEL TERME PRESIDENT";
  const destination = overrides.destination_labels?.[0] ?? "Piazzale Trieste 6, Ischia (Caffe del Direttore)";
  return {
    stop_id: overrides.stop_id ?? `stop-${Math.random().toString(16).slice(2)}`,
    macro_category: overrides.macro_category ?? "NAVETTA",
    operational_time: overrides.operational_time ?? "08:30",
    pickup_label: pickup,
    destination_labels: overrides.destination_labels ?? [destination],
    total_pax: overrides.total_pax ?? 1,
    services: overrides.services ?? [{
      assignable: true,
      needs_review: false,
      customer_name: "Hotel President",
      pickup_label: pickup,
      destination_label: destination,
      pax: overrides.total_pax ?? 1,
    }],
    is_merged: overrides.is_merged ?? false,
    warnings: overrides.warnings ?? [],
  };
}

function presidentPair(time: string, returnTime: string) {
  return [
    stop({
      stop_id: `president-out-${time}`,
      operational_time: time,
      pickup_label: "HOTEL TERME PRESIDENT",
      destination_labels: ["Piazzale Trieste 6, Ischia (Caffè del Direttore)"],
    }),
    stop({
      stop_id: `president-in-${returnTime}`,
      operational_time: returnTime,
      pickup_label: "Piazzale Trieste 6, Ischia (Caffe del Direttore)",
      destination_labels: ["HOTEL TERME PRESIDENT"],
    }),
  ];
}

describe("detectShuttlePairs", () => {
  it("recognizes President 08:30 to 08:35 as SHUTTLE_PAIR", () => {
    const result = detectShuttlePairs(presidentPair("08:30", "08:35"), {
      enabledHotelNames: ["hotel terme president"],
    });

    expect(result.shuttle_pairs).toHaveLength(1);
    expect(result.remaining_stops).toHaveLength(0);
    expect(result.shuttle_pairs[0]?.type).toBe("SHUTTLE_PAIR");
    expect(result.shuttle_pairs[0]?.loop_label).toBe("NAVETTA CICLO - HOTEL TERME PRESIDENT ↔ Caffe del Direttore - ore 08:30");
  });

  it("recognizes 15 President pairs at +5 minutes", () => {
    const times = [
      ["08:30", "08:35"],
      ["09:00", "09:05"],
      ["09:30", "09:35"],
      ["10:30", "10:35"],
      ["11:30", "11:35"],
      ["12:00", "12:05"],
      ["12:30", "12:35"],
      ["15:00", "15:05"],
      ["16:00", "16:05"],
      ["17:00", "17:05"],
      ["18:00", "18:05"],
      ["18:30", "18:35"],
      ["19:00", "19:05"],
      ["21:00", "21:05"],
      ["22:30", "22:35"],
    ];
    const stops = times.flatMap(([out, back]) => presidentPair(out, back));
    const result = detectShuttlePairs(stops, { enabledHotelNames: ["hotel terme president"] });

    expect(result.shuttle_pairs).toHaveLength(15);
    expect(result.remaining_stops).toHaveLength(0);
  });

  it("recognizes delta 10 but not delta 11", () => {
    expect(detectShuttlePairs(presidentPair("08:30", "08:40")).shuttle_pairs).toHaveLength(1);
    expect(detectShuttlePairs(presidentPair("08:30", "08:41")).shuttle_pairs).toHaveLength(0);
  });

  it("requires inverted pickup and destination", () => {
    const result = detectShuttlePairs([
      stop({ stop_id: "a", pickup_label: "HOTEL TERME PRESIDENT", destination_labels: ["Piazzale Trieste"] }),
      stop({ stop_id: "b", operational_time: "08:35", pickup_label: "HOTEL TERME PRESIDENT", destination_labels: ["Piazzale Trieste"] }),
    ]);

    expect(result.shuttle_pairs).toHaveLength(0);
    expect(result.remaining_stops).toHaveLength(2);
  });

  it("does not recognize same-direction navette", () => {
    const result = detectShuttlePairs([
      stop({ stop_id: "a", pickup_label: "HOTEL TERME PRESIDENT", destination_labels: ["Piazzale Trieste"] }),
      stop({ stop_id: "b", operational_time: "08:35", pickup_label: "HOTEL TERME PRESIDENT", destination_labels: ["Piazzale Trieste"] }),
    ]);

    expect(result.shuttle_pairs).toHaveLength(0);
  });

  it("does not recognize needs_review stops", () => {
    const [outbound, inbound] = presidentPair("08:30", "08:35");
    outbound!.services = outbound!.services.map((service) => ({ ...service, needs_review: true }));
    const result = detectShuttlePairs([outbound!, inbound!]);

    expect(result.shuttle_pairs).toHaveLength(0);
  });

  it("does not recognize San Nicola with delta 25 when maxDelta is 10", () => {
    const result = detectShuttlePairs([
      stop({
        stop_id: "san-out",
        operational_time: "09:30",
        pickup_label: "HOTEL SAN NICOLA",
        destination_labels: ["Citara"],
        services: [{ assignable: true, needs_review: false, customer_name: "Hotel San Nicola", pickup_label: "HOTEL SAN NICOLA", destination_label: "Citara" }],
      }),
      stop({
        stop_id: "san-in",
        operational_time: "09:55",
        pickup_label: "Citara",
        destination_labels: ["HOTEL SAN NICOLA"],
        services: [{ assignable: true, needs_review: false, customer_name: "Hotel San Nicola", pickup_label: "Citara", destination_label: "HOTEL SAN NICOLA" }],
      }),
    ]);

    expect(result.shuttle_pairs).toHaveLength(0);
    expect(result.remaining_stops).toHaveLength(2);
  });

  it("does not recognize Cristallo outside threshold", () => {
    const result = detectShuttlePairs([
      stop({
        stop_id: "cri-out",
        operational_time: "16:00",
        pickup_label: "HOTEL CRISTALLO",
        destination_labels: ["Piazza Marina Casamicciola"],
        services: [{ assignable: true, needs_review: false, customer_name: "Hotel Cristallo", pickup_label: "HOTEL CRISTALLO", destination_label: "Piazza Marina Casamicciola" }],
      }),
      stop({
        stop_id: "cri-in",
        operational_time: "18:15",
        pickup_label: "Piazza Marina Casamicciola",
        destination_labels: ["HOTEL CRISTALLO"],
        services: [{ assignable: true, needs_review: false, customer_name: "Hotel Cristallo", pickup_label: "Piazza Marina Casamicciola", destination_label: "HOTEL CRISTALLO" }],
      }),
    ]);

    expect(result.shuttle_pairs).toHaveLength(0);
  });

  it("does not recognize non-navetta stops", () => {
    const [outbound, inbound] = presidentPair("08:30", "08:35");
    outbound!.macro_category = "ESCURSIONE";
    const result = detectShuttlePairs([outbound!, inbound!]);

    expect(result.shuttle_pairs).toHaveLength(0);
  });

  it("keeps unpaired stops in remaining_stops", () => {
    const lone = stop({ stop_id: "lone", operational_time: "12:00" });
    const result = detectShuttlePairs([...presidentPair("08:30", "08:35"), lone]);

    expect(result.shuttle_pairs).toHaveLength(1);
    expect(result.remaining_stops.map((item) => item.stop_id)).toEqual(["lone"]);
  });

  it("sorts shuttle_pairs by start_time", () => {
    const result = detectShuttlePairs([
      ...presidentPair("09:00", "09:05"),
      ...presidentPair("08:30", "08:35"),
    ]);

    expect(result.shuttle_pairs.map((pair) => pair.start_time)).toEqual(["08:30", "09:00"]);
  });

  it("does not mutate input stops", () => {
    const stops = presidentPair("08:30", "08:35");
    const before = JSON.stringify(stops);

    detectShuttlePairs(stops);

    expect(JSON.stringify(stops)).toBe(before);
  });
});
