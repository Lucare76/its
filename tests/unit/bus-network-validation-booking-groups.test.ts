import { describe, expect, it } from "vitest";
import { validateBusAllocationRequest } from "@/lib/server/bus-network-validation";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SERVICE_ID = "11111111-1111-4111-8111-111111111111";
const LINE_ID = "22222222-2222-4222-8222-222222222222";
const UNIT_ID = "33333333-3333-4333-8333-333333333333";
const STOP_ID = "44444444-4444-4444-8444-444444444444";

type Row = Record<string, unknown>;

function makeAuth(seed: Record<string, Row[]>) {
  function builder(table: string) {
    const filters: Row = {};
    const rowsForFilters = () => (seed[table] ?? []).filter((r) => Object.entries(filters).every(([k, v]) => r[k] === v));
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = (col: string, val: unknown) => { filters[col] = val; return b; };
    b.maybeSingle = async () => ({ data: rowsForFilters()[0] ?? null, error: null });
    return b;
  }
  return {
    admin: { from: (table: string) => builder(table) },
    membership: { tenant_id: TENANT, role: "operator" },
    user: { id: "u1" },
  } as never;
}

describe("validateBusAllocationRequest - booking groups", () => {
  it("per servizi booking group accetta la linea della fermata esplicita anche se la derivazione automatica diverge", async () => {
    const auth = makeAuth({
      services: [{
        id: SERVICE_ID,
        tenant_id: TENANT,
        direction: "arrival",
        booking_service_kind: "bus_city_hotel",
        service_type_code: "bus_line",
        booking_group_id: "bg-1",
        booking_group_stop_id: "bgs-1",
        bus_city_origin: "Barano",
        meeting_point: "Chiesa di San Rocco",
        time: "05:20",
      }],
      tenant_bus_lines: [{ id: LINE_ID, tenant_id: TENANT, code: "CENTRO", name: "Linea Centro", family_code: "CENTRO", family_name: "Linea Centro", active: true }],
      tenant_bus_units: [{ id: UNIT_ID, tenant_id: TENANT, bus_line_id: LINE_ID, label: "CENTRO 1", capacity: 54, status: "open" }],
      tenant_bus_line_stops: [{ id: STOP_ID, tenant_id: TENANT, bus_line_id: LINE_ID, direction: "arrival", stop_name: "Chiesa di San Rocco", city: "Barano", active: true }],
    });

    await expect(validateBusAllocationRequest(auth, {
      tenantId: TENANT,
      serviceId: SERVICE_ID,
      busLineId: LINE_ID,
      busUnitId: UNIT_ID,
      stopId: STOP_ID,
      stopName: "Chiesa di San Rocco",
      direction: "arrival",
    })).resolves.toMatchObject({ line: { id: LINE_ID }, stop: { id: STOP_ID } });
  });

  it("continua a bloccare servizi non booking group su linea incoerente", async () => {
    const auth = makeAuth({
      services: [{
        id: SERVICE_ID,
        tenant_id: TENANT,
        direction: "arrival",
        booking_service_kind: "bus_city_hotel",
        service_type_code: "bus_line",
        bus_city_origin: "Barano",
        time: "05:20",
      }],
      tenant_bus_lines: [{ id: LINE_ID, tenant_id: TENANT, code: "CENTRO", name: "Linea Centro", family_code: "CENTRO", family_name: "Linea Centro", active: true }],
      tenant_bus_units: [{ id: UNIT_ID, tenant_id: TENANT, bus_line_id: LINE_ID, label: "CENTRO 1", capacity: 54, status: "open" }],
      tenant_bus_line_stops: [{ id: STOP_ID, tenant_id: TENANT, bus_line_id: LINE_ID, direction: "arrival", stop_name: "Chiesa di San Rocco", city: "Barano", active: true }],
    });

    await expect(validateBusAllocationRequest(auth, {
      tenantId: TENANT,
      serviceId: SERVICE_ID,
      busLineId: LINE_ID,
      busUnitId: UNIT_ID,
      stopId: STOP_ID,
      stopName: "Chiesa di San Rocco",
      direction: "arrival",
    })).rejects.toThrow(/non e coerente con la linea bus scelta/i);
  });
});
