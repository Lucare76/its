import { describe, expect, it } from "vitest";
import { estimateConsumption } from "@/lib/server/vehicle-consumption";

describe("stima dei consumi per mezzo", () => {
  it("segnala il superamento della soglia del mezzo e ignora i km non progressivi", () => {
    const result = estimateConsumption([
      { id: "second", fuel_date: "2026-11-02", km_at_fuel: 10200, liters: 30 },
      { id: "first", fuel_date: "2026-11-01", km_at_fuel: 10000, liters: 25 },
      { id: "mistake", fuel_date: "2026-11-03", km_at_fuel: 10200, liters: 40 },
    ], 5, 12);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: "second", liters_per_100km: 15, anomaly: true });
  });
});
