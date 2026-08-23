import { describe, it, expect, beforeAll } from "vitest";
import { getTool } from "@/lib/mcp/registry";
import type { McpContext } from "@/lib/mcp/context";

type Row = Record<string, unknown>;

/**
 * Fake admin minimale multi-tabella: supporta select/eq/in/not/limit su
 * "services"/"hotels"/"assignments", stesso pattern (thenable-free, builder
 * esplicito) di tests/unit/mcp/get-service.test.ts.
 */
type PostgrestErrorLike = { code: string; message: string; details: null; hint: null };

function makeFakeAdmin(tables: Record<string, Row[]>, errorTables: Partial<Record<string, PostgrestErrorLike>> = {}) {
  return {
    from(table: string) {
      let filtered = tables[table] ?? [];
      const tableError = errorTables[table] ?? null;
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
        then(resolve: (result: { data: Row[] | null; error: PostgrestErrorLike | null }) => unknown) {
          return resolve(tableError ? { data: null, error: tableError } : { data: filtered, error: null });
        },
      };
      return builder;
    },
  };
}

/** Riproduce esattamente l'errore reale osservato in produzione (Sprint 6 fix-diagnosi): colonna mancante. */
const MISSING_COLUMN_ERROR: PostgrestErrorLike = {
  code: "42703",
  message: "column services.tour_name does not exist",
  details: null,
  hint: null,
};

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

function assignableServiceRow(overrides: Row = {}): Row {
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

describe("its.get_unassigned_services", () => {
  let tool: NonNullable<ReturnType<typeof getTool>>;

  beforeAll(async () => {
    await import("@/lib/mcp/tools/get-unassigned-services");
    const found = getTool("its.get_unassigned_services");
    if (!found) throw new Error("its.get_unassigned_services non registrato");
    tool = found;
  });

  it("restituisce un servizio assegnabile senza autista per la data richiesta", async () => {
    const admin = makeFakeAdmin({
      services: [assignableServiceRow()],
      hotels: [HOTEL_ROW],
      assignments: [],
    });
    const result = (await tool.handler(makeContext(admin), { date: "2026-08-23" })) as { services: unknown[]; count: number };
    expect(result.count).toBe(1);
  });

  it("esclude un servizio gia' assegnato", async () => {
    const admin = makeFakeAdmin({
      services: [assignableServiceRow()],
      hotels: [HOTEL_ROW],
      assignments: [{ service_id: "svc-1", tenant_id: "tenant-a", driver_user_id: "driver-1" }],
    });
    const result = (await tool.handler(makeContext(admin), { date: "2026-08-23" })) as { count: number };
    expect(result.count).toBe(0);
  });

  it("isolamento tenant: legge solo servizi del tenant del contesto", async () => {
    const admin = makeFakeAdmin({
      services: [assignableServiceRow({ id: "svc-a", tenant_id: "tenant-a" }), assignableServiceRow({ id: "svc-b", tenant_id: "tenant-b" })],
      hotels: [HOTEL_ROW],
      assignments: [],
    });
    const result = (await tool.handler(makeContext(admin, { tenantId: "tenant-a" }), { date: "2026-08-23" })) as {
      services: Array<{ id: string }>;
    };
    expect(result.services.map((s) => s.id)).toEqual(["svc-a"]);
  });

  it("default data = oggi (Europe/Rome) quando non passata", async () => {
    const admin = makeFakeAdmin({ services: [], hotels: [HOTEL_ROW], assignments: [] });
    const result = (await tool.handler(makeContext(admin), {})) as { date: string };
    expect(result.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("RBAC: allowedRoles limitato ad admin/operator/supervisor", () => {
    expect(tool.allowedRoles).toEqual(["admin", "operator", "supervisor"]);
  });

  it("input invalido (data malformata) rifiutato dallo schema", () => {
    const parsed = tool.inputSchema.safeParse({ date: "23-08-2026" });
    expect(parsed.success).toBe(false);
  });

  describe("regressione (Sprint 6 fix-diagnosi): colonna services.tour_name mancante in un ambiente", () => {
    it("la query services fallisce (42703) -> il tool risponde available:false invece di lanciare un errore MCP generico", async () => {
      const admin = makeFakeAdmin(
        { services: [assignableServiceRow()], hotels: [HOTEL_ROW], assignments: [] },
        { services: MISSING_COLUMN_ERROR }
      );
      const result = (await tool.handler(makeContext(admin), { date: "2026-08-23" })) as {
        available: boolean;
        services: unknown[];
        count: number;
      };
      expect(result.available).toBe(false);
      expect(result.services).toEqual([]);
      expect(result.count).toBe(0);
    });

    it("esito normale: available:true", async () => {
      const admin = makeFakeAdmin({ services: [assignableServiceRow()], hotels: [HOTEL_ROW], assignments: [] });
      const result = (await tool.handler(makeContext(admin), { date: "2026-08-23" })) as { available: boolean };
      expect(result.available).toBe(true);
    });
  });
});
