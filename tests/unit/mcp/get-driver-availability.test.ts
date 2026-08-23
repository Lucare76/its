import { describe, it, expect, beforeAll, vi } from "vitest";
import { getTool } from "@/lib/mcp/registry";
import type { McpContext } from "@/lib/mcp/context";
import type { DriverRegistryEntry } from "@/lib/server/driver-registry";

const mockListDriverRegistry = vi.fn<[], Promise<DriverRegistryEntry[]>>();
vi.mock("@/lib/server/driver-registry", () => ({
  listDriverRegistry: (...args: unknown[]) => mockListDriverRegistry(...(args as [])),
}));

type Row = Record<string, unknown>;

function makeFakeAdmin(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      let filtered = tables[table] ?? [];
      const builder = {
        select() {
          return builder;
        },
        eq(field: string, value: unknown) {
          filtered = filtered.filter((row) => row[field] === value);
          return builder;
        },
        in(field: string, values: unknown[]) {
          filtered = filtered.filter((row) => values.includes(row[field]));
          return builder;
        },
        then(resolve: (result: { data: Row[]; error: null }) => unknown) {
          return resolve({ data: filtered, error: null });
        },
      };
      return builder;
    },
  };
}

function makeContext(admin: unknown, overrides: Partial<McpContext> = {}): McpContext {
  return {
    requestId: "req-1",
    userId: "user-1",
    userEmail: "test@example.com",
    tenantId: "tenant-a",
    role: "operator",
    admin: admin as McpContext["admin"],
    ...overrides,
  };
}

const DRIVER: DriverRegistryEntry = {
  id: "driver-profile-1",
  user_id: "driver-user-1",
  full_name: "Mario Rossi",
  phone: "+39123456789",
  username: "mario.rossi",
  active: true,
  has_access: true,
  access_suspended: false,
  role: "driver",
  max_vehicle_capacity: 8,
};

describe("its.get_driver_availability", () => {
  let tool: NonNullable<ReturnType<typeof getTool>>;

  beforeAll(async () => {
    await import("@/lib/mcp/tools/get-driver-availability");
    const found = getTool("its.get_driver_availability");
    if (!found) throw new Error("its.get_driver_availability non registrato");
    tool = found;
  });

  it("driver senza assegnazioni: assigned_services vuoto, count 0", async () => {
    mockListDriverRegistry.mockResolvedValueOnce([DRIVER]);
    const admin = makeFakeAdmin({ services: [], assignments: [] });
    const result = (await tool.handler(makeContext(admin), { date: "2026-08-23" })) as {
      drivers: Array<{ full_name: string; assigned_services_count: number; assigned_services: unknown[] }>;
    };
    expect(result.drivers[0]!.assigned_services_count).toBe(0);
    expect(result.drivers[0]!.assigned_services).toEqual([]);
  });

  it("driver con un servizio assegnato: orario/direzione/mezzo esposti (slot occupato, nessuno scoring)", async () => {
    mockListDriverRegistry.mockResolvedValueOnce([DRIVER]);
    const admin = makeFakeAdmin({
      services: [{ id: "svc-1", tenant_id: "tenant-a", date: "2026-08-23", time: "18:30", direction: "arrival" }],
      assignments: [{ service_id: "svc-1", tenant_id: "tenant-a", driver_user_id: "driver-user-1", vehicle_label: "Van 1" }],
    });
    const result = (await tool.handler(makeContext(admin), { date: "2026-08-23" })) as {
      drivers: Array<{ assigned_services: Array<{ id: string; time: string; direction: string; vehicle_label: string }> }>;
    };
    expect(result.drivers[0]!.assigned_services).toEqual([
      { id: "svc-1", time: "18:30", direction: "arrival", vehicle_label: "Van 1" },
    ]);
  });

  it("motivo di indisponibilita' gia' noto (access_suspended) esposto senza deduzioni", async () => {
    mockListDriverRegistry.mockResolvedValueOnce([{ ...DRIVER, access_suspended: true }]);
    const admin = makeFakeAdmin({ services: [], assignments: [] });
    const result = (await tool.handler(makeContext(admin), { date: "2026-08-23" })) as {
      drivers: Array<{ access_suspended: boolean }>;
    };
    expect(result.drivers[0]!.access_suspended).toBe(true);
  });

  it("nessuna PII nell'output (no telefono)", async () => {
    mockListDriverRegistry.mockResolvedValueOnce([DRIVER]);
    const admin = makeFakeAdmin({ services: [], assignments: [] });
    const result = (await tool.handler(makeContext(admin), { date: "2026-08-23" })) as Record<string, unknown>;
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("+39123456789");
  });

  it("RBAC: allowedRoles limitato ad admin/operator/supervisor", () => {
    expect(tool.allowedRoles).toEqual(["admin", "operator", "supervisor"]);
  });
});
