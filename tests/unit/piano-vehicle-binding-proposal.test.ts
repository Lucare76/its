import { describe, expect, it } from "vitest";
import { proposeVehicleDailyRealignment } from "@/lib/piano-vehicle-binding-proposal";

const vehicles = [
  { id: "white", label: "25 BIANCO", capacity: 25 },
  { id: "navarra", label: "25 NAVARRA", capacity: 25 },
  { id: "gray", label: "DUCATO GRIGIO", capacity: 8 },
  { id: "maxi", label: "DUCATO MAXI", capacity: 14 },
  { id: "vito", label: "VITO EXTRA LONG", capacity: 8 },
];

describe("vehicle binding proposal", () => {
  it("proposes a complete binding without duplicates when two vehicles are duplicated and two are free", () => {
    const result = proposeVehicleDailyRealignment({
      vehicles,
      drivers: [
        { driver_key: "mario", driver_name: "MARIO", current_vehicle_labels: ["DUCATO GRIGIO"], max_pax: 7 },
        { driver_key: "leo", driver_name: "LEO", current_vehicle_labels: ["DUCATO MAXI"], max_pax: 2 },
        { driver_key: "ilaria", driver_name: "ILARIA", current_vehicle_labels: ["DUCATO GRIGIO"], max_pax: 5 },
        { driver_key: "zabatta", driver_name: "MARIO ZABATTA", current_vehicle_labels: ["VITO EXTRA LONG"], max_pax: 8 },
        { driver_key: "riccardo", driver_name: "RICCARDO", current_vehicle_labels: ["VITO EXTRA LONG"], max_pax: 8 },
      ],
    });

    expect(result.current_conflicts.map((conflict) => conflict.label).sort()).toEqual(["DUCATO GRIGIO", "VITO EXTRA LONG"]);
    expect(result.conflicts_after).toHaveLength(0);
    expect(result.drivers_without_vehicle_after).toHaveLength(0);
    expect(result.vehicle_changes_required).toBe(2);
    expect(new Set(result.proposal.map((item) => item.to_vehicle_label))).toHaveLength(5);
    expect(result.proposal.map((item) => item.to_vehicle_label)).toEqual(expect.arrayContaining(["25 BIANCO", "25 NAVARRA"]));
  });

  it("keeps the current vehicle when it does not conflict", () => {
    const result = proposeVehicleDailyRealignment({
      vehicles,
      drivers: [
        { driver_key: "leo", driver_name: "LEO", current_vehicle_labels: ["DUCATO MAXI"], max_pax: 2 },
        { driver_key: "mario", driver_name: "MARIO", current_vehicle_labels: ["DUCATO GRIGIO"], max_pax: 4 },
      ],
    });

    expect(result.proposal.find((item) => item.driver_name === "LEO")?.to_vehicle_label).toBe("DUCATO MAXI");
    expect(result.proposal.find((item) => item.driver_name === "MARIO")?.to_vehicle_label).toBe("DUCATO GRIGIO");
    expect(result.vehicle_changes_required).toBe(0);
  });

  it("moves the minimum number of drivers needed to remove duplicated vehicles", () => {
    const result = proposeVehicleDailyRealignment({
      vehicles: vehicles.slice(0, 3),
      drivers: [
        { driver_key: "mario", driver_name: "MARIO", current_vehicle_labels: ["DUCATO GRIGIO"], max_pax: 4 },
        { driver_key: "ilaria", driver_name: "ILARIA", current_vehicle_labels: ["DUCATO GRIGIO"], max_pax: 4 },
      ],
    });

    expect(result.conflicts_after).toHaveLength(0);
    expect(result.vehicle_changes_required).toBe(1);
  });

  it("does not assign a vehicle with insufficient capacity", () => {
    const result = proposeVehicleDailyRealignment({
      vehicles: [{ id: "vito", label: "VITO EXTRA LONG", capacity: 8 }],
      drivers: [{ driver_key: "bus", driver_name: "BUS GROUP", current_vehicle_labels: ["VITO EXTRA LONG"], max_pax: 21 }],
    });

    expect(result.proposal[0]?.to_vehicle_label).toBeNull();
    expect(result.proposal[0]?.feasible).toBe(false);
    expect(result.drivers_without_vehicle_after).toEqual(["BUS GROUP"]);
    expect(result.overbooking_after).toHaveLength(0);
  });

  it("simulates zero binding conflicts after a feasible proposal", () => {
    const result = proposeVehicleDailyRealignment({
      vehicles,
      drivers: [
        { driver_key: "mario", driver_name: "MARIO", current_vehicle_labels: ["DUCATO GRIGIO"], max_pax: 7 },
        { driver_key: "ilaria", driver_name: "ILARIA", current_vehicle_labels: ["DUCATO GRIGIO"], max_pax: 5 },
        { driver_key: "leo", driver_name: "LEO", current_vehicle_labels: ["DUCATO MAXI"], max_pax: 2 },
      ],
    });

    expect(result.conflicts_after).toHaveLength(0);
  });
});
