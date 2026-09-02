import { describe, expect, it } from "vitest";
import { summarizeBusReservationConflicts } from "@/lib/bus-network-reservations";

describe("summarizeBusReservationConflicts", () => {
  it("due reservation stessa data/nome ma gruppi diversi -> conflitto", () => {
    const conflicts = summarizeBusReservationConflicts([
      { id: "r-real", booking_group_id: "bg-real", bus_unit_id: "bus-1", service_date: "2026-09-06", exclusive: true, booking_group_name: "GRUPPO GIACOMONI", booking_group_kind: "bus_exclusive" },
      { id: "r-orphan", booking_group_id: "bg-orphan", bus_unit_id: "bus-3", service_date: "2026-09-06", exclusive: true, booking_group_name: "GIACOMONI", booking_group_kind: "bus_exclusive" },
    ], "2026-09-06");

    expect(conflicts).toEqual([{
      serviceDate: "2026-09-06",
      normalizedGroupName: "giacomoni",
      reservationIds: ["r-real", "r-orphan"],
      bookingGroupIds: ["bg-real", "bg-orphan"],
      busUnitIds: ["bus-1", "bus-3"],
      groupNames: ["GRUPPO GIACOMONI", "GIACOMONI"],
    }]);
  });

  it("stesso gruppo su due bus e stessa data -> conflitto", () => {
    const conflicts = summarizeBusReservationConflicts([
      { id: "r1", booking_group_id: "bg-real", bus_unit_id: "bus-1", service_date: "2026-09-06", exclusive: true, booking_group_name: "GRUPPO GIACOMONI", booking_group_kind: "bus_exclusive" },
      { id: "r2", booking_group_id: "bg-real", bus_unit_id: "bus-2", service_date: "2026-09-06", exclusive: true, booking_group_name: "GRUPPO GIACOMONI", booking_group_kind: "bus_exclusive" },
    ], "2026-09-06");

    expect(conflicts).toMatchObject([{
      reservationIds: ["r1", "r2"],
      bookingGroupIds: ["bg-real"],
      busUnitIds: ["bus-1", "bus-2"],
    }]);
  });

  it("ignora date diverse, non exclusive e gruppi non bus_exclusive", () => {
    const conflicts = summarizeBusReservationConflicts([
      { id: "r-date", booking_group_id: "bg-a", bus_unit_id: "bus-1", service_date: "2026-09-13", exclusive: true, booking_group_name: "GIACOMONI", booking_group_kind: "bus_exclusive" },
      { id: "r-shared", booking_group_id: "bg-b", bus_unit_id: "bus-2", service_date: "2026-09-06", exclusive: false, booking_group_name: "GIACOMONI", booking_group_kind: "bus_exclusive" },
      { id: "r-kind", booking_group_id: "bg-c", bus_unit_id: "bus-3", service_date: "2026-09-06", exclusive: true, booking_group_name: "GIACOMONI", booking_group_kind: "bus_group" },
    ], "2026-09-06");

    expect(conflicts).toEqual([]);
  });
});
