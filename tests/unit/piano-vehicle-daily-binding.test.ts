import { describe, expect, it } from "vitest";
import { buildVehicleDailyBinding, driverDailyBindingKey } from "@/lib/piano-vehicle-daily-binding";

const drivers = [
  { driver_profile_id: "d1", driver_name: "Mario" },
  { driver_profile_id: "d2", driver_name: "Ilaria" },
  { driver_profile_id: "d3", driver_name: "Leo" },
  { driver_profile_id: "d4", driver_name: "Riccardo" },
  { driver_profile_id: "d5", driver_name: "Mario Zabatta" },
];

const vehicles = [
  { id: "v1", label: "25 BIANCO", capacity: 25 },
  { id: "v2", label: "25 NAVARRA", capacity: 25 },
  { id: "v3", label: "DUCATO GRIGIO", capacity: 8 },
  { id: "v4", label: "DUCATO MAXI", capacity: 14 },
  { id: "v5", label: "VITO EXTRA LONG", capacity: 8 },
];

describe("vehicleDailyBinding", () => {
  it("assigns five different vehicles to five available drivers", () => {
    const result = buildVehicleDailyBinding({ drivers, vehicles });

    expect(result.mode).toBe("fixed_vehicle_per_driver");
    expect(result.driver_to_vehicle.size).toBe(5);
    expect(new Set(Array.from(result.driver_to_vehicle.values()).map((vehicle) => vehicle.id)).size).toBe(5);
    expect(result.unassigned_drivers).toHaveLength(0);
    expect(result.unused_vehicles).toHaveLength(0);
  });

  it("blocks the same vehicle assigned to two drivers on the same date even without time overlap", () => {
    const result = buildVehicleDailyBinding({
      drivers: drivers.slice(0, 2),
      vehicles: vehicles.slice(0, 2),
      assignments: [
        { driver_profile_id: "d1", driver_name: "Mario", id: "v1", label: "25 BIANCO", group_id: "morning" },
        { driver_profile_id: "d2", driver_name: "Ilaria", id: "v1", label: "25 BIANCO", group_id: "evening" },
      ],
    });

    expect(result.conflicts[0]?.conflict_type).toBe("same_vehicle_different_driver_same_day");
    expect(result.conflicts[0]?.message).toBe("Mezzo gia assegnato a un altro autista per questa giornata.");
  });

  it("allows the same vehicle for multiple trips of the same driver", () => {
    const result = buildVehicleDailyBinding({
      drivers: drivers.slice(0, 1),
      vehicles: vehicles.slice(0, 1),
      assignments: [
        { driver_profile_id: "d1", driver_name: "Mario", id: "v1", label: "25 BIANCO", group_id: "a" },
        { driver_profile_id: "d1", driver_name: "Mario", id: "v1", label: "25 BIANCO", group_id: "b" },
      ],
    });

    expect(result.conflicts).toHaveLength(0);
    expect(result.driver_to_vehicle.get("profile:d1")?.id).toBe("v1");
  });

  it("suggests a free vehicle when a duplicated vehicle has an unused alternative", () => {
    const result = buildVehicleDailyBinding({
      drivers: drivers.slice(0, 3),
      vehicles: vehicles.slice(0, 3),
      assignments: [
        { driver_profile_id: "d1", driver_name: "Mario", id: "v1", label: "25 BIANCO", group_id: "a" },
        { driver_profile_id: "d2", driver_name: "Ilaria", id: "v1", label: "25 BIANCO", group_id: "b" },
      ],
    });

    expect(result.suggestions[0]?.from_vehicle_label).toBe("25 BIANCO");
    expect(result.suggestions[0]?.to_vehicle_label).not.toBe("25 BIANCO");
    expect(result.suggestions[0]?.to_vehicle_label).toBeTruthy();
  });

  it("uses vehicle_id as the primary key when labels are duplicated", () => {
    const result = buildVehicleDailyBinding({
      drivers: drivers.slice(0, 2),
      vehicles: [
        { id: "vito-a", label: "VITO EXTRA LONG", capacity: 8 },
        { id: "vito-b", label: "VITO EXTRA LONG", capacity: 8 },
      ],
    });

    expect(new Set(Array.from(result.driver_to_vehicle.values()).map((vehicle) => vehicle.id))).toEqual(new Set(["vito-a", "vito-b"]));
  });

  it("falls back to vehicle_label with a warning when vehicle_id is missing", () => {
    const result = buildVehicleDailyBinding({
      drivers: drivers.slice(0, 1),
      vehicles: [{ label: "VITO EXTRA LONG", capacity: 8 }],
      assignments: [{ driver_profile_id: "d1", driver_name: "Mario", label: "VITO EXTRA LONG" }],
    });

    expect(result.driver_to_vehicle.get("profile:d1")?.label).toBe("VITO EXTRA LONG");
    expect(result.warnings[0]).toContain("senza vehicle_id");
  });

  it("uses shared vehicle mode when vehicles are fewer than drivers", () => {
    const result = buildVehicleDailyBinding({
      drivers,
      vehicles: vehicles.slice(0, 3),
    });

    expect(result.mode).toBe("shared_vehicles");
    expect(result.unassigned_drivers.map(driverDailyBindingKey).filter(Boolean)).toHaveLength(5);
  });
});
