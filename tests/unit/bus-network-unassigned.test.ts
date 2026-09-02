import { describe, expect, it } from "vitest";
import {
  formatBusNetworkUnassignedSummary,
  summarizeBusNetworkUnassigned,
  type BusNetworkUnassignedService,
} from "@/lib/bus-network-unassigned";

function service(overrides: Partial<BusNetworkUnassignedService>): BusNetworkUnassignedService {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    pax: overrides.pax ?? 1,
    ...overrides,
  };
}

describe("bus network unassigned summary", () => {
  it("conta un gruppo bus_exclusive una sola volta anche con piu fermate/services", () => {
    const summary = summarizeBusNetworkUnassigned([
      service({ id: "svc-1", pax: 10, booking_group_id: "bg-giacomoni", booking_group_kind: "bus_exclusive", booking_group_stop_id: "stop-1" }),
      service({ id: "svc-2", pax: 8, booking_group_id: "bg-giacomoni", booking_group_kind: "bus_exclusive", booking_group_stop_id: "stop-2" }),
      service({ id: "svc-3", pax: 12, booking_group_id: "bg-giacomoni", booking_group_kind: "bus_exclusive", booking_group_stop_id: "stop-3" }),
      service({ id: "svc-4", pax: 8, booking_group_id: "bg-giacomoni", booking_group_kind: "bus_exclusive", booking_group_stop_id: "stop-4" }),
    ]);

    expect(summary).toMatchObject({
      itemCount: 1,
      pax: 38,
      exclusiveGroupCount: 1,
      stopBlockCount: 0,
      individualCount: 0,
    });
    expect(formatBusNetworkUnassignedSummary(summary)).toBe("1 gruppo da assegnare · 38 pax");
  });

  it("per gruppi non esclusivi conta blocchi fermata distinti", () => {
    const summary = summarizeBusNetworkUnassigned([
      service({ id: "svc-1", pax: 2, booking_group_id: "bg-shared", booking_group_kind: "bus_group", booking_group_stop_id: "stop-a" }),
      service({ id: "svc-2", pax: 3, booking_group_id: "bg-shared", booking_group_kind: "bus_group", booking_group_stop_id: "stop-a" }),
      service({ id: "svc-3", pax: 4, booking_group_id: "bg-shared", booking_group_kind: "bus_group", booking_group_stop_id: "stop-b" }),
    ]);

    expect(summary).toMatchObject({
      itemCount: 2,
      pax: 9,
      exclusiveGroupCount: 0,
      stopBlockCount: 2,
      individualCount: 0,
    });
    expect(formatBusNetworkUnassignedSummary(summary)).toBe("2 fermate da assegnare · 9 pax");
  });

  it("per servizi individuali mantiene il conteggio per service", () => {
    const summary = summarizeBusNetworkUnassigned([
      service({ id: "svc-1", pax: 2 }),
      service({ id: "svc-2", pax: 1 }),
    ]);

    expect(summary).toMatchObject({
      itemCount: 2,
      pax: 3,
      exclusiveGroupCount: 0,
      stopBlockCount: 0,
      individualCount: 2,
    });
    expect(formatBusNetworkUnassignedSummary(summary)).toBe("2 servizi da assegnare · 3 pax");
  });
});
