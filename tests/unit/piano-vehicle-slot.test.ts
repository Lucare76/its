/**
 * Test Regola 3: Mezzo fisso per autista per giornata
 *
 * resolveVehicleSlotForTime è esportata da auto-assign/route.ts.
 * I test verificano che il vehicle_id corretto venga selezionato in base alla fascia oraria.
 */
import { describe, expect, it } from "vitest";
import { resolveVehicleSlotForTime } from "@/app/api/ops/piano-giorno/auto-assign/route";

const VID1 = "vehicle-uuid-1";
const VID2 = "vehicle-uuid-2";

function toMin(t: string) {
  const [h, m] = t.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

describe("resolveVehicleSlotForTime", () => {
  it("restituisce vehicle_1 quando l'orario è nella fascia 1", () => {
    const avail = {
      vehicle_1_id: VID1, vehicle_1_from: "07:00", vehicle_1_to: "14:00",
      vehicle_2_id: null, vehicle_2_from: null, vehicle_2_to: null,
    };
    expect(resolveVehicleSlotForTime(avail, toMin("09:00"))).toBe(VID1);
    expect(resolveVehicleSlotForTime(avail, toMin("07:00"))).toBe(VID1);
    expect(resolveVehicleSlotForTime(avail, toMin("13:59"))).toBe(VID1);
  });

  it("restituisce null quando l'orario è fuori dalla fascia dichiarata", () => {
    const avail = {
      vehicle_1_id: VID1, vehicle_1_from: "07:00", vehicle_1_to: "12:00",
      vehicle_2_id: null, vehicle_2_from: null, vehicle_2_to: null,
    };
    expect(resolveVehicleSlotForTime(avail, toMin("12:00"))).toBeNull(); // to è escluso
    expect(resolveVehicleSlotForTime(avail, toMin("15:00"))).toBeNull();
  });

  it("restituisce vehicle_2 quando l'orario è nella fascia 2", () => {
    const avail = {
      vehicle_1_id: VID1, vehicle_1_from: "07:00", vehicle_1_to: "14:00",
      vehicle_2_id: VID2, vehicle_2_from: "14:00", vehicle_2_to: "22:00",
    };
    expect(resolveVehicleSlotForTime(avail, toMin("14:00"))).toBe(VID2);
    expect(resolveVehicleSlotForTime(avail, toMin("18:30"))).toBe(VID2);
    expect(resolveVehicleSlotForTime(avail, toMin("21:59"))).toBe(VID2);
  });

  it("fascia senza from → parte da mezzanotte (0)", () => {
    const avail = {
      vehicle_1_id: VID1, vehicle_1_from: null, vehicle_1_to: "14:00",
      vehicle_2_id: null, vehicle_2_from: null, vehicle_2_to: null,
    };
    expect(resolveVehicleSlotForTime(avail, toMin("00:00"))).toBe(VID1);
    expect(resolveVehicleSlotForTime(avail, toMin("06:00"))).toBe(VID1);
  });

  it("fascia senza to → arriva a fine giornata (1440)", () => {
    const avail = {
      vehicle_1_id: VID1, vehicle_1_from: "08:00", vehicle_1_to: null,
      vehicle_2_id: null, vehicle_2_from: null, vehicle_2_to: null,
    };
    expect(resolveVehicleSlotForTime(avail, toMin("23:59"))).toBe(VID1);
  });

  it("nessun mezzo dichiarato → null", () => {
    const avail = {
      vehicle_1_id: null, vehicle_1_from: null, vehicle_1_to: null,
      vehicle_2_id: null, vehicle_2_from: null, vehicle_2_to: null,
    };
    expect(resolveVehicleSlotForTime(avail, toMin("10:00"))).toBeNull();
  });

  it("vehicle_1 senza fascia → copre tutta la giornata (default)", () => {
    const avail = {
      vehicle_1_id: VID1, vehicle_1_from: null, vehicle_1_to: null,
      vehicle_2_id: VID2, vehicle_2_from: null, vehicle_2_to: null,
    };
    // vehicle_1 ha priorità e copre [0, 1440) → vehicle_2 non viene mai raggiunto
    expect(resolveVehicleSlotForTime(avail, toMin("09:00"))).toBe(VID1);
    expect(resolveVehicleSlotForTime(avail, toMin("20:00"))).toBe(VID1);
  });
});
