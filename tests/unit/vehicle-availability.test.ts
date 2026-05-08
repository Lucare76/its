import { describe, expect, it } from "vitest";
import {
  isVehicleManuallyBlockedAtTime,
  isVehicleManuallyBlockedOnDate,
  manualVehicleBlockMessage,
} from "@/lib/server/vehicle-availability";

describe("vehicle availability", () => {
  it("blocca un mezzo manualmente indisponibile nella data del piano", () => {
    const vehicle = {
      blocked_from: "2026-05-13T00:00:00.000Z",
      blocked_until: "2026-05-13T23:59:59.000Z",
      is_blocked_manual: true,
    };

    expect(isVehicleManuallyBlockedOnDate(vehicle, "2026-05-13")).toBe(true);
    expect(isVehicleManuallyBlockedOnDate(vehicle, "2026-05-14")).toBe(false);
  });

  it("blocca solo i giri che si sovrappongono alla finestra manuale", () => {
    const vehicle = {
      blocked_from: "2026-05-13T10:30:00.000Z",
      blocked_until: "2026-05-13T12:00:00.000Z",
      is_blocked_manual: true,
    };

    expect(isVehicleManuallyBlockedAtTime(vehicle, "2026-05-13", "09:30", 90)).toBe(true);
    expect(isVehicleManuallyBlockedAtTime(vehicle, "2026-05-13", "12:00", 90)).toBe(false);
  });

  it("espone un messaggio operativo con la motivazione del blocco", () => {
    expect(manualVehicleBlockMessage({ blocked_reason: "Officina", is_blocked_manual: true }))
      .toBe("Mezzo bloccato in Flotta: Officina.");
  });
});
