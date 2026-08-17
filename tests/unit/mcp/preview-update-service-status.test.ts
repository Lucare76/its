import { describe, it, expect, beforeAll } from "vitest";
import { getTool } from "@/lib/mcp/registry";
import { verifyUpdateServiceStatusConfirmationToken, __resetConfirmationRegistryForTests } from "@/lib/mcp/confirmation";
import type { McpContext } from "@/lib/mcp/context";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SERVICE_A = "11111111-1111-4111-8111-111111111111";

type Row = Record<string, unknown>;

function makeFakeAdmin(seedTables: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = { services: [], assignments: [], ...seedTables };
  return {
    from(table: string) {
      return {
        select() {
          let filtered = tables[table] ?? [];
          const builder = {
            eq(field: string, value: unknown) {
              filtered = filtered.filter((r) => r[field] === value);
              return builder;
            },
            maybeSingle() {
              return Promise.resolve({ data: filtered[0] ? { ...filtered[0] } : null, error: null });
            },
          };
          return builder;
        },
      };
    },
  };
}

function makeContext(tenantId: string, admin: unknown): McpContext {
  return { requestId: "req-1", userId: "user-1", userEmail: "op@test.dev", tenantId, role: "operator", admin: admin as McpContext["admin"] };
}

function serviceRow(overrides: Row = {}): Row {
  return {
    id: SERVICE_A,
    tenant_id: TENANT_A,
    date: "2026-08-20",
    time: "10:00",
    status: "new",
    service_type: "transfer",
    booking_service_kind: null,
    ...overrides,
  };
}

describe("its.preview_update_service_status (MCP Sprint 3)", () => {
  let tool: NonNullable<ReturnType<typeof getTool>>;

  beforeAll(async () => {
    process.env.AGENCY_ACTION_SECRET = "test-secret-not-real";
    await import("@/lib/mcp/tools/preview-update-service-status");
    const found = getTool("its.preview_update_service_status");
    if (!found) throw new Error("its.preview_update_service_status non registrato");
    tool = found;
  });

  it("e' READ, ruoli ops (non driver/agency/assistenza/autista)", () => {
    expect(tool.category).toBe("READ");
    expect(tool.allowedRoles).toEqual(expect.arrayContaining(["admin", "operator", "supervisor"]));
    expect(tool.allowedRoles).not.toEqual(expect.arrayContaining(["driver"]));
    expect(tool.allowedRoles).not.toEqual(expect.arrayContaining(["agency"]));
  });

  it("1. transizione valida: canUpdate true, nessun conflitto, token emesso", async () => {
    const admin = makeFakeAdmin({ services: [serviceRow({ status: "new" })] });
    const context = makeContext(TENANT_A, admin);
    const result: any = await tool.handler(context, { serviceId: SERVICE_A, targetStatus: "assigned" });

    expect(result.currentStatus).toBe("new");
    expect(result.targetStatus).toBe("assigned");
    expect(result.canUpdate).toBe(true);
    expect(result.conflicts).toEqual([]);
    expect(result.confirmationToken).not.toBeNull();
    expect(result.expiresAt).not.toBeNull();
    expect(result.service).toEqual({ id: SERVICE_A, date: "2026-08-20", time: "10:00", type: "transfer" });
  });

  it("3. transizione vietata (target non impostabile via MCP): canUpdate false, conflitto, nessun token", async () => {
    const admin = makeFakeAdmin({ services: [serviceRow({ status: "new" })] });
    const context = makeContext(TENANT_A, admin);
    const result: any = await tool.handler(context, { serviceId: SERVICE_A, targetStatus: "cancelled" });

    expect(result.canUpdate).toBe(false);
    expect(result.conflicts).toEqual([{ code: "TARGET_STATUS_NOT_SETTABLE", message: expect.any(String) }]);
    expect(result.confirmationToken).toBeNull();
  });

  it("6. stato terminale come origine: canUpdate false, conflitto SERVICE_STATUS_TERMINAL, nessun token", async () => {
    const admin = makeFakeAdmin({ services: [serviceRow({ status: "completato" })] });
    const context = makeContext(TENANT_A, admin);
    const result: any = await tool.handler(context, { serviceId: SERVICE_A, targetStatus: "partito" });

    expect(result.canUpdate).toBe(false);
    expect(result.conflicts).toEqual([{ code: "SERVICE_STATUS_TERMINAL", message: expect.any(String) }]);
    expect(result.confirmationToken).toBeNull();
  });

  it("4. stato uguale (no-op): canUpdate true, warning STATUS_ALREADY_SET, token comunque emesso", async () => {
    const admin = makeFakeAdmin({ services: [serviceRow({ status: "assigned" })] });
    const context = makeContext(TENANT_A, admin);
    const result: any = await tool.handler(context, { serviceId: SERVICE_A, targetStatus: "assigned" });

    expect(result.canUpdate).toBe(true);
    expect(result.warnings).toEqual(expect.arrayContaining([{ code: "STATUS_ALREADY_SET", message: expect.any(String) }]));
    expect(result.confirmationToken).not.toBeNull();
    expect(result.sideEffects).toEqual([]); // no-op: nessun side effect previsto
  });

  it("warning NO_DRIVER_ASSIGNED per transizione a stato operativo senza assegnazione", async () => {
    const admin = makeFakeAdmin({ services: [serviceRow({ status: "assigned" })], assignments: [] });
    const context = makeContext(TENANT_A, admin);
    const result: any = await tool.handler(context, { serviceId: SERVICE_A, targetStatus: "partito" });

    expect(result.canUpdate).toBe(true);
    expect(result.warnings).toEqual(expect.arrayContaining([{ code: "NO_DRIVER_ASSIGNED", message: expect.any(String) }]));
  });

  it("nessun warning NO_DRIVER_ASSIGNED quando l'assegnazione esiste", async () => {
    const admin = makeFakeAdmin({
      services: [serviceRow({ status: "assigned" })],
      assignments: [{ id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_A }],
    });
    const context = makeContext(TENANT_A, admin);
    const result: any = await tool.handler(context, { serviceId: SERVICE_A, targetStatus: "partito" });

    expect(result.warnings.some((w: any) => w.code === "NO_DRIVER_ASSIGNED")).toBe(false);
  });

  it("5. servizio di un altro tenant: MCP_NOT_FOUND", async () => {
    const admin = makeFakeAdmin({ services: [serviceRow({ tenant_id: TENANT_B })] });
    const context = makeContext(TENANT_A, admin);
    await expect(tool.handler(context, { serviceId: SERVICE_A, targetStatus: "assigned" })).rejects.toMatchObject({
      code: "MCP_NOT_FOUND",
    });
  });

  it("2. targetStatus sconosciuto (non un ServiceStatus reale): rifiutato dallo schema di input", () => {
    const parsed = tool.inputSchema.safeParse({ serviceId: SERVICE_A, targetStatus: "foobar" });
    expect(parsed.success).toBe(false);
  });

  it("il payload del confirmation token contiene lo snapshot corretto (currentStatus/targetStatus/tenant/user)", async () => {
    const admin = makeFakeAdmin({ services: [serviceRow({ status: "new" })] });
    const context = makeContext(TENANT_A, admin);
    __resetConfirmationRegistryForTests();
    const result: any = await tool.handler(context, { serviceId: SERVICE_A, targetStatus: "assigned" });

    const verified = verifyUpdateServiceStatusConfirmationToken(result.confirmationToken);
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.payload.purpose).toBe("mcp_update_service_status");
      expect(verified.payload.serviceId).toBe(SERVICE_A);
      expect(verified.payload.currentStatus).toBe("new");
      expect(verified.payload.targetStatus).toBe("assigned");
      expect(verified.payload.userId).toBe(context.userId);
      expect(verified.payload.tenantId).toBe(TENANT_A);
    }
  });

  it("output non contiene PII (nessun customer_name/phone/email/notes)", async () => {
    const admin = makeFakeAdmin({ services: [serviceRow({ status: "new" })] });
    const context = makeContext(TENANT_A, admin);
    const result: any = await tool.handler(context, { serviceId: SERVICE_A, targetStatus: "assigned" });
    const text = JSON.stringify(result).toLowerCase();
    expect(text).not.toMatch(/phone|email|customer_name|notes|tenant_id/);
  });
});
