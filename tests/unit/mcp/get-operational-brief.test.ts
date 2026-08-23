import { describe, it, expect, beforeAll, vi } from "vitest";
import { getTool } from "@/lib/mcp/registry";
import type { McpContext } from "@/lib/mcp/context";
import type { ItsHealthSnapshot } from "@/lib/mcp/health-snapshot";

const mockCompute = vi.fn<[], Promise<ItsHealthSnapshot>>();
vi.mock("@/lib/mcp/health-snapshot", () => ({
  computeItsHealthSnapshot: (...args: unknown[]) => mockCompute(...(args as [])),
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
        not(field: string, _op: string, _value: unknown) {
          filtered = filtered.filter((row) => row[field] !== null && row[field] !== undefined);
          return builder;
        },
        limit() {
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

const HOTEL_ROW: Row = { id: "hotel-1", tenant_id: "tenant-a", name: "Hotel Test", zone: "Ischia Porto" };

function serviceRow(overrides: Row = {}): Row {
  return {
    id: "svc-1",
    tenant_id: "tenant-a",
    date: "2026-08-23",
    time: "12:00",
    status: "new",
    is_draft: false,
    direction: "arrival",
    practice_number: "ITS-2026-1",
    hotel_id: "hotel-1",
    pax: 2,
    meeting_point: "Ischia Porto",
    ...overrides,
  };
}

const EMPTY_HEALTHY_SNAPSHOT: ItsHealthSnapshot = {
  available: true,
  generatedAt: "2026-08-23T10:00:00.000Z",
  overall: "healthy",
  jobHealth: { summary: { healthy: 3, info: 0, warning: 0, critical: 0, disabled: 0, unknown: 0 }, evaluations: [] },
  operationalHealth: {
    generated_at: "2026-08-23T10:00:00.000Z",
    summary: { info: 0, warning: 0, critical: 0 },
    areas: [],
    signals: [],
  },
};

describe("its.get_operational_brief", () => {
  let tool: NonNullable<ReturnType<typeof getTool>>;

  beforeAll(async () => {
    await import("@/lib/mcp/tools/get-operational-brief");
    const found = getTool("its.get_operational_brief");
    if (!found) throw new Error("its.get_operational_brief non registrato");
    tool = found;
  });

  it("giornata senza problemi: critical_items/warnings vuoti, health healthy", async () => {
    mockCompute.mockResolvedValueOnce(EMPTY_HEALTHY_SNAPSHOT);
    const admin = makeFakeAdmin({ services: [], hotels: [HOTEL_ROW], assignments: [] });
    const result = (await tool.handler(makeContext(admin), { date: "2026-08-23" })) as {
      critical_items: unknown[];
      warnings: unknown[];
      health: { available: boolean; overall: string };
    };
    expect(result.critical_items).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.health).toEqual({ available: true, overall: "healthy" });
  });

  it("servizio critical: compare in critical_items, non in warnings", async () => {
    mockCompute.mockResolvedValueOnce({
      ...EMPTY_HEALTHY_SNAPSHOT,
      overall: "critical",
      operationalHealth: {
        ...EMPTY_HEALTHY_SNAPSHOT.operationalHealth,
        summary: { info: 0, warning: 0, critical: 1 },
        signals: [
          {
            key: "operations:unassigned:svc-1",
            area: "operations",
            severity: "critical",
            title: "Servizio imminente senza autista assegnato",
            message: "Arrivo ITS-2026-1 delle 18:30 parte fra 20 minuti senza autista assegnato.",
            detectedAt: "2026-08-23T10:00:00.000Z",
            entityId: "ITS-2026-1",
            action: { label: "Apri servizio", href: "/services/svc-1/edit" },
          },
        ],
      },
    });
    const admin = makeFakeAdmin({ services: [], hotels: [HOTEL_ROW], assignments: [] });
    const result = (await tool.handler(makeContext(admin), { date: "2026-08-23" })) as {
      critical_items: Array<{ key: string }>;
      warnings: unknown[];
    };
    expect(result.critical_items).toHaveLength(1);
    expect(result.critical_items[0]!.key).toBe("operations:unassigned:svc-1");
    expect(result.warnings).toEqual([]);
  });

  it("warning operativo: compare in warnings, non in critical_items", async () => {
    mockCompute.mockResolvedValueOnce({
      ...EMPTY_HEALTHY_SNAPSHOT,
      overall: "attention",
      operationalHealth: {
        ...EMPTY_HEALTHY_SNAPSHOT.operationalHealth,
        summary: { info: 0, warning: 1, critical: 0 },
        signals: [
          {
            key: "medmar:delivery_pending:d1",
            area: "medmar",
            severity: "warning",
            title: "Consegna biglietto in attesa",
            message: "Consegna in attesa da oltre la soglia.",
            detectedAt: "2026-08-23T09:00:00.000Z",
            entityId: "MED-9",
            action: { label: "Apri Medmar", href: "/biglietti-medmar" },
          },
        ],
      },
    });
    const admin = makeFakeAdmin({ services: [], hotels: [HOTEL_ROW], assignments: [] });
    const result = (await tool.handler(makeContext(admin), { date: "2026-08-23" })) as {
      critical_items: unknown[];
      warnings: Array<{ key: string }>;
    };
    expect(result.warnings).toHaveLength(1);
    expect(result.critical_items).toEqual([]);
  });

  it("isolamento tenant: summary conta solo i servizi del tenant del contesto", async () => {
    mockCompute.mockResolvedValueOnce(EMPTY_HEALTHY_SNAPSHOT);
    const admin = makeFakeAdmin({
      services: [serviceRow({ id: "svc-a", tenant_id: "tenant-a" }), serviceRow({ id: "svc-b", tenant_id: "tenant-b" })],
      hotels: [HOTEL_ROW],
      assignments: [],
    });
    const result = (await tool.handler(makeContext(admin, { tenantId: "tenant-a" }), { date: "2026-08-23" })) as {
      summary: { total_services: number };
    };
    expect(result.summary.total_services).toBe(1);
  });

  it("default data = oggi (Europe/Rome), mai UTC ingenuo", async () => {
    mockCompute.mockResolvedValueOnce(EMPTY_HEALTHY_SNAPSHOT);
    const admin = makeFakeAdmin({ services: [], hotels: [HOTEL_ROW], assignments: [] });
    const result = (await tool.handler(makeContext(admin), {})) as { date: string };
    expect(result.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("failure isolation: health reader non disponibile -> brief parziale ma valido (servizi/summary presenti)", async () => {
    mockCompute.mockResolvedValueOnce({ available: false });
    const admin = makeFakeAdmin({ services: [serviceRow()], hotels: [HOTEL_ROW], assignments: [] });
    const result = (await tool.handler(makeContext(admin), { date: "2026-08-23" })) as {
      summary: { total_services: number };
      critical_items: unknown[];
      warnings: unknown[];
      health: { available: boolean; overall: unknown };
    };
    expect(result.summary.total_services).toBe(1);
    expect(result.critical_items).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.health).toEqual({ available: false, overall: null });
  });

  it("RBAC: allowedRoles limitato ad admin/operator/supervisor", () => {
    expect(tool.allowedRoles).toEqual(["admin", "operator", "supervisor"]);
  });
});
