import { describe, it, expect, beforeAll } from "vitest";
import { getTool } from "@/lib/mcp/registry";
import type { McpContext } from "@/lib/mcp/context";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SERVICE_A = "11111111-1111-4111-8111-111111111111";
const SERVICE_OTHER_TENANT = "11111111-1111-4111-8111-111111111112";
const DRIVER_PROFILE_A = "22222222-2222-4222-8222-222222222222";
const DRIVER_PROFILE_OTHER_TENANT = "22222222-2222-4222-8222-222222222223";
const DRIVER_USER_A = "33333333-3333-4333-8333-333333333333";
const VEHICLE_A = "44444444-4444-4444-8444-444444444444";
const VEHICLE_OTHER_TENANT = "44444444-4444-4444-8444-444444444445";
const TEST_DATE = "2026-08-20";

type Row = Record<string, unknown>;

function makeFakeAdmin(tables: Record<string, Row[]>) {
  function chain(table: string) {
    let rows = tables[table] ?? [];
    const builder: any = {
      eq(field: string, value: unknown) {
        rows = rows.filter((r) => r[field] === value);
        return builder;
      },
      neq(field: string, value: unknown) {
        rows = rows.filter((r) => r[field] !== value);
        return builder;
      },
      in(field: string, values: unknown[]) {
        rows = rows.filter((r) => values.includes(r[field]));
        return builder;
      },
      order() {
        return builder;
      },
      limit() {
        return builder;
      },
      maybeSingle() {
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
      then(resolve: (v: { data: Row[]; error: null }) => unknown, reject?: (e: unknown) => unknown) {
        return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
      },
    };
    return builder;
  }
  return {
    from(table: string) {
      return { select: () => chain(table) };
    },
  };
}

function makeContext(tenantId: string, admin: unknown): McpContext {
  return {
    requestId: "req-1",
    userId: "user-1",
    userEmail: "op@test.dev",
    tenantId,
    role: "operator",
    admin: admin as McpContext["admin"],
  };
}

function baseTables(): Record<string, Row[]> {
  return {
    services: [
      {
        id: SERVICE_A,
        tenant_id: TENANT_A,
        date: TEST_DATE,
        status: "new",
        is_draft: false,
        time: "10:00:00",
        direction: "departure",
        pickup_hotel: null,
        hotel_id: null,
        meeting_point: null,
        arrival_time: null,
        orario_barca: null,
        porto_bruno: null,
        barca_compagnia: null,
        booking_service_kind: null,
        service_type_code: null,
        service_type: "transfer",
        vessel: null,
        ferry_details: null,
        pax: 2,
      },
      { id: SERVICE_OTHER_TENANT, tenant_id: TENANT_B, date: TEST_DATE, status: "new", is_draft: false, time: "10:00:00" },
    ],
    driver_profiles: [
      { id: DRIVER_PROFILE_A, tenant_id: TENANT_A, user_id: DRIVER_USER_A, full_name: "Mario Autista", phone: "+391234", active: true },
      { id: DRIVER_PROFILE_OTHER_TENANT, tenant_id: TENANT_B, user_id: null, full_name: "Altro Tenant", phone: null, active: true },
    ],
    memberships: [{ user_id: DRIVER_USER_A, tenant_id: TENANT_A, role: "driver", full_name: "Mario Autista", suspended: false, max_vehicle_capacity: null }],
    vehicles: [
      { id: VEHICLE_A, tenant_id: TENANT_A, label: "Bus 1", plate: "AA000BB", capacity: 8, vehicle_size: "medium", active: true, habitual_driver_user_id: null, habitual_driver_profile_id: null },
      { id: VEHICLE_OTHER_TENANT, tenant_id: TENANT_B, label: "Bus X", plate: "ZZ000ZZ", capacity: 8, vehicle_size: "medium", active: true, habitual_driver_user_id: null, habitual_driver_profile_id: null },
    ],
    assignments: [],
    trip_groups: [],
    daily_availability_confirmations: [{ tenant_id: TENANT_A, date: TEST_DATE, confirmed: true }],
  };
}

describe("its.preview_assign_driver (Fase 25)", () => {
  let tool: NonNullable<ReturnType<typeof getTool>>;

  beforeAll(async () => {
    process.env.AGENCY_ACTION_SECRET = "test-secret-not-real";
    await import("@/lib/mcp/tools/preview-assign-driver");
    const found = getTool("its.preview_assign_driver");
    if (!found) throw new Error("its.preview_assign_driver non registrato");
    tool = found;
  });

  it("e' READ e non scrive mai nulla (nessun metodo insert/update/delete esposto dal fake)", () => {
    expect(tool.category).toBe("READ");
  });

  it("1. servizio valido + autista libero: canAssign true, confirmationToken presente", async () => {
    const context = makeContext(TENANT_A, makeFakeAdmin(baseTables()));
    const result: any = await tool.handler(context, { serviceId: SERVICE_A, driverId: DRIVER_PROFILE_A, vehicleId: null });
    expect(result.canAssign).toBe(true);
    expect(result.conflicts).toEqual([]);
    expect(typeof result.confirmationToken).toBe("string");
    expect(result.expiresAt).not.toBeNull();
  });

  it("2. servizio di altro tenant: MCP_NOT_FOUND", async () => {
    const context = makeContext(TENANT_A, makeFakeAdmin(baseTables()));
    await expect(
      tool.handler(context, { serviceId: SERVICE_OTHER_TENANT, driverId: DRIVER_PROFILE_A, vehicleId: null })
    ).rejects.toMatchObject({ code: "MCP_NOT_FOUND" });
  });

  it("3. autista di altro tenant: MCP_NOT_FOUND", async () => {
    const context = makeContext(TENANT_A, makeFakeAdmin(baseTables()));
    await expect(
      tool.handler(context, { serviceId: SERVICE_A, driverId: DRIVER_PROFILE_OTHER_TENANT, vehicleId: null })
    ).rejects.toMatchObject({ code: "MCP_NOT_FOUND" });
  });

  it("4. mezzo di altro tenant: MCP_NOT_FOUND", async () => {
    const context = makeContext(TENANT_A, makeFakeAdmin(baseTables()));
    await expect(
      tool.handler(context, { serviceId: SERVICE_A, driverId: DRIVER_PROFILE_A, vehicleId: VEHICLE_OTHER_TENANT })
    ).rejects.toMatchObject({ code: "MCP_NOT_FOUND" });
  });

  it("6. autista occupato (overlap): conflitto DRIVER_OVERLAP, canAssign false, nessun token", async () => {
    const tables = baseTables();
    tables.trip_groups = [{ id: "grp-1", tenant_id: TENANT_A, date: TEST_DATE, status: "active", driver_user_id: DRIVER_USER_A }];
    tables.assignments = [
      { id: "asg-1", tenant_id: TENANT_A, service_id: "other-service", group_id: "grp-1", driver_user_id: DRIVER_USER_A, services: { date: TEST_DATE, time: "10:00:00", direction: "departure", pickup_hotel: null } },
    ];
    const context = makeContext(TENANT_A, makeFakeAdmin(tables));
    const result: any = await tool.handler(context, { serviceId: SERVICE_A, driverId: DRIVER_PROFILE_A, vehicleId: null });
    expect(result.canAssign).toBe(false);
    expect(result.conflicts.some((c: any) => c.code === "DRIVER_OVERLAP")).toBe(true);
    expect(result.confirmationToken).toBeNull();
  });

  it("8. autista non attivo: conflitto DRIVER_NOT_ACTIVE", async () => {
    const tables = baseTables();
    tables.driver_profiles = tables.driver_profiles.map((d) => (d.id === DRIVER_PROFILE_A ? { ...d, active: false } : d));
    const context = makeContext(TENANT_A, makeFakeAdmin(tables));
    const result: any = await tool.handler(context, { serviceId: SERVICE_A, driverId: DRIVER_PROFILE_A, vehicleId: null });
    expect(result.canAssign).toBe(false);
    expect(result.conflicts.some((c: any) => c.code === "DRIVER_NOT_ACTIVE")).toBe(true);
  });

  it("10. servizio non assegnabile (completato): conflitto SERVICE_NOT_ASSIGNABLE", async () => {
    const tables = baseTables();
    tables.services[0].status = "completato";
    const context = makeContext(TENANT_A, makeFakeAdmin(tables));
    const result: any = await tool.handler(context, { serviceId: SERVICE_A, driverId: DRIVER_PROFILE_A, vehicleId: null });
    expect(result.canAssign).toBe(false);
    expect(result.conflicts.some((c: any) => c.code === "SERVICE_NOT_ASSIGNABLE")).toBe(true);
  });

  it("11. output senza PII (no phone/email/notes)", async () => {
    const context = makeContext(TENANT_A, makeFakeAdmin(baseTables()));
    const result: any = await tool.handler(context, { serviceId: SERVICE_A, driverId: DRIVER_PROFILE_A, vehicleId: null });
    const raw = JSON.stringify(result);
    expect(raw).not.toMatch(/\+391234/);
    expect(raw.toLowerCase()).not.toMatch(/phone|email|notes/);
  });
});
