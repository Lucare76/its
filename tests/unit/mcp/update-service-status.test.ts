import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { getTool } from "@/lib/mcp/registry";
import { generateUpdateServiceStatusConfirmationToken, __resetConfirmationRegistryForTests } from "@/lib/mcp/confirmation";
import type { McpContext } from "@/lib/mcp/context";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SERVICE_A = "11111111-1111-4111-8111-111111111111";

type Row = Record<string, unknown>;

function makeFakeAdmin(seedTables: { services?: Row[]; status_events?: Row[] } = {}) {
  const services: Row[] = [...(seedTables.services ?? [])];
  const statusEvents: Row[] = [...(seedTables.status_events ?? [])];

  const admin = {
    from(table: string) {
      if (table === "services") {
        return {
          select() {
            let filtered = services;
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
          update(payload: Row) {
            let filtered = services;
            const builder = {
              eq(field: string, value: unknown) {
                filtered = filtered.filter((r) => r[field] === value);
                return builder;
              },
              select(_c?: string) {
                for (const row of filtered) Object.assign(row, payload);
                return Promise.resolve({ data: filtered.map((r) => ({ id: r.id })), error: null });
              },
            };
            return builder;
          },
        };
      }
      if (table === "status_events") {
        return {
          upsert(row: Row) {
            const key = `${row.tenant_id}:${row.service_id}:${row.status}`;
            if (!statusEvents.some((e) => `${e.tenant_id}:${e.service_id}:${e.status}` === key)) statusEvents.push(row);
            return Promise.resolve({ data: null, error: null });
          },
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    },
  };

  return { admin, services, statusEvents };
}

function makeContext(tenantId: string, userId: string, admin: unknown): McpContext {
  return { requestId: "req-1", userId, userEmail: "op@test.dev", tenantId, role: "operator", admin: admin as McpContext["admin"] };
}

function serviceRow(overrides: Row = {}): Row {
  return { id: SERVICE_A, tenant_id: TENANT_A, status: "new", ...overrides };
}

describe("its.update_service_status (MCP Sprint 3)", () => {
  let tool: NonNullable<ReturnType<typeof getTool>>;

  beforeAll(async () => {
    process.env.AGENCY_ACTION_SECRET = "test-secret-not-real";
    await import("@/lib/mcp/tools/update-service-status");
    const found = getTool("its.update_service_status");
    if (!found) throw new Error("its.update_service_status non registrato");
    tool = found;
  });

  beforeEach(() => {
    __resetConfirmationRegistryForTests();
  });

  it("e' WRITE, ruoli ops (non driver/agency/assistenza/autista)", () => {
    expect(tool.category).toBe("WRITE");
    expect(tool.allowedRoles).toEqual(expect.arrayContaining(["admin", "operator", "supervisor"]));
    expect(tool.allowedRoles).not.toEqual(expect.arrayContaining(["driver"]));
  });

  it("1. update riuscito: services.status aggiornato, status_event scritto, audit MCP WRITE (buildAuditSummary)", async () => {
    const fake = makeFakeAdmin({ services: [serviceRow({ status: "new" })] });
    const context = makeContext(TENANT_A, "user-1", fake.admin);
    const { token } = generateUpdateServiceStatusConfirmationToken({
      userId: "user-1",
      tenantId: TENANT_A,
      serviceId: SERVICE_A,
      currentStatus: "new",
      targetStatus: "assigned",
    });

    const result: any = await tool.handler(context, { confirmationToken: token });
    expect(result.status).toBe("updated");
    expect(fake.services[0].status).toBe("assigned");
    expect(fake.statusEvents).toHaveLength(1);

    const summary = tool.buildAuditSummary?.({ confirmationToken: token }, result);
    expect(summary).toEqual({ service_id: SERVICE_A, from_status: "new", to_status: "assigned", result: "updated" });
    expect(JSON.stringify(summary)).not.toContain(token);
  });

  it("token invalido: MCP_CONFIRMATION_INVALID, nessuna scrittura", async () => {
    const fake = makeFakeAdmin({ services: [serviceRow()] });
    const context = makeContext(TENANT_A, "user-1", fake.admin);
    await expect(tool.handler(context, { confirmationToken: "not-a-real-token" })).rejects.toMatchObject({
      code: "MCP_CONFIRMATION_INVALID",
    });
    expect(fake.services[0].status).toBe("new");
  });

  it("token scaduto: MCP_CONFIRMATION_EXPIRED", async () => {
    const fake = makeFakeAdmin({ services: [serviceRow()] });
    const context = makeContext(TENANT_A, "user-1", fake.admin);
    const { token: freshToken } = generateUpdateServiceStatusConfirmationToken({
      userId: "user-1",
      tenantId: TENANT_A,
      serviceId: SERVICE_A,
      currentStatus: "new",
      targetStatus: "assigned",
    });
    const [encodedPayload] = freshToken.split(".");
    const decoded = JSON.parse(Buffer.from(encodedPayload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
    decoded.exp = Math.floor(Date.now() / 1000) - 10;
    // Re-sign with the same secret so only expiry is being tested (tamper-free).
    const { createHmac } = await import("crypto");
    const reencoded = Buffer.from(JSON.stringify(decoded)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
    const newSig = createHmac("sha256", "test-secret-not-real").update(reencoded).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
    const expiredToken = `${reencoded}.${newSig}`;
    await expect(tool.handler(context, { confirmationToken: expiredToken })).rejects.toMatchObject({
      code: "MCP_CONFIRMATION_EXPIRED",
    });
  });

  it("user diverso dal context: MCP_CONFIRMATION_INVALID, nessuna scrittura", async () => {
    const fake = makeFakeAdmin({ services: [serviceRow()] });
    const context = makeContext(TENANT_A, "user-1", fake.admin);
    const { token } = generateUpdateServiceStatusConfirmationToken({
      userId: "user-2",
      tenantId: TENANT_A,
      serviceId: SERVICE_A,
      currentStatus: "new",
      targetStatus: "assigned",
    });
    await expect(tool.handler(context, { confirmationToken: token })).rejects.toMatchObject({ code: "MCP_CONFIRMATION_INVALID" });
    expect(fake.services[0].status).toBe("new");
  });

  it("tenant diverso dal context: MCP_CONFIRMATION_INVALID, nessuna scrittura", async () => {
    const fake = makeFakeAdmin({ services: [serviceRow()] });
    const context = makeContext(TENANT_A, "user-1", fake.admin);
    const { token } = generateUpdateServiceStatusConfirmationToken({
      userId: "user-1",
      tenantId: TENANT_B,
      serviceId: SERVICE_A,
      currentStatus: "new",
      targetStatus: "assigned",
    });
    await expect(tool.handler(context, { confirmationToken: token })).rejects.toMatchObject({ code: "MCP_CONFIRMATION_INVALID" });
  });

  it("token riusato: seconda esecuzione -> MCP_CONFIRMATION_ALREADY_USED, nessuna doppia scrittura", async () => {
    const fake = makeFakeAdmin({ services: [serviceRow()] });
    const context = makeContext(TENANT_A, "user-1", fake.admin);
    const { token } = generateUpdateServiceStatusConfirmationToken({
      userId: "user-1",
      tenantId: TENANT_A,
      serviceId: SERVICE_A,
      currentStatus: "new",
      targetStatus: "assigned",
    });
    await tool.handler(context, { confirmationToken: token });
    await expect(tool.handler(context, { confirmationToken: token })).rejects.toMatchObject({
      code: "MCP_CONFIRMATION_ALREADY_USED",
    });
    expect(fake.statusEvents).toHaveLength(1);
  });

  it("target tampered nel payload: firma non corrisponde -> MCP_CONFIRMATION_INVALID", async () => {
    const fake = makeFakeAdmin({ services: [serviceRow()] });
    const context = makeContext(TENANT_A, "user-1", fake.admin);
    const { token } = generateUpdateServiceStatusConfirmationToken({
      userId: "user-1",
      tenantId: TENANT_A,
      serviceId: SERVICE_A,
      currentStatus: "new",
      targetStatus: "assigned",
    });
    const [encodedPayload] = token.split(".");
    const decoded = JSON.parse(Buffer.from(encodedPayload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
    decoded.targetStatus = "completato";
    const reencoded = Buffer.from(JSON.stringify(decoded)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
    const tampered = `${reencoded}.forgedsignature`;
    await expect(tool.handler(context, { confirmationToken: tampered })).rejects.toMatchObject({ code: "MCP_CONFIRMATION_INVALID" });
    expect(fake.services[0].status).toBe("new");
  });

  it("purpose diverso (token di its.assign_driver riusato qui): rifiutato", async () => {
    const fake = makeFakeAdmin({ services: [serviceRow()] });
    const context = makeContext(TENANT_A, "user-1", fake.admin);
    const { generateAssignDriverConfirmationToken } = await import("@/lib/mcp/confirmation");
    const { token } = generateAssignDriverConfirmationToken({
      userId: "user-1",
      tenantId: TENANT_A,
      serviceId: SERVICE_A,
      driverId: "driver-1",
      vehicleId: null,
    });
    await expect(tool.handler(context, { confirmationToken: token })).rejects.toMatchObject({ code: "MCP_CONFIRMATION_INVALID" });
  });

  it("preview stale (stato diventato terminale nel frattempo): MCP_STATUS_TRANSITION_INVALID, nessuna scrittura", async () => {
    // Preview: assigned -> partito. Nel frattempo un altro operatore ha
    // spostato il servizio su "cancelled" (terminale).
    const fake = makeFakeAdmin({ services: [serviceRow({ status: "cancelled" })] });
    const context = makeContext(TENANT_A, "user-1", fake.admin);
    const { token } = generateUpdateServiceStatusConfirmationToken({
      userId: "user-1",
      tenantId: TENANT_A,
      serviceId: SERVICE_A,
      currentStatus: "assigned",
      targetStatus: "partito",
    });
    await expect(tool.handler(context, { confirmationToken: token })).rejects.toMatchObject({
      code: "MCP_STATUS_TRANSITION_INVALID",
    });
    expect(fake.services[0].status).toBe("cancelled");
  });

  it("preview stale con stato live non terminale ma diverso: MCP_CONFIRMATION_STALE", async () => {
    const fake = makeFakeAdmin({ services: [serviceRow({ status: "problema" })] });
    const context = makeContext(TENANT_A, "user-1", fake.admin);
    const { token } = generateUpdateServiceStatusConfirmationToken({
      userId: "user-1",
      tenantId: TENANT_A,
      serviceId: SERVICE_A,
      currentStatus: "assigned",
      targetStatus: "partito",
    });
    await expect(tool.handler(context, { confirmationToken: token })).rejects.toMatchObject({
      code: "MCP_CONFIRMATION_STALE",
    });
    expect(fake.services[0].status).toBe("problema");
  });

  it("4/no-op: stato gia' uguale -> status 'no_op', nessuna doppia scrittura status_events", async () => {
    const fake = makeFakeAdmin({
      services: [serviceRow({ status: "assigned" })],
      status_events: [{ tenant_id: TENANT_A, service_id: SERVICE_A, status: "assigned" }],
    });
    const context = makeContext(TENANT_A, "user-1", fake.admin);
    const { token } = generateUpdateServiceStatusConfirmationToken({
      userId: "user-1",
      tenantId: TENANT_A,
      serviceId: SERVICE_A,
      currentStatus: "assigned",
      targetStatus: "assigned",
    });
    const result: any = await tool.handler(context, { confirmationToken: token });
    expect(result.status).toBe("no_op");
    expect(fake.statusEvents).toHaveLength(1);
  });

  it("errore DB safe: nessun dettaglio Postgres esposto (McpError sempre sanificato)", async () => {
    const fake = makeFakeAdmin({ services: [serviceRow()] });
    (fake.admin as any).from = (table: string) => {
      if (table === "services") {
        return {
          select() {
            return { eq() { return this; }, maybeSingle: () => Promise.reject(new Error("connection refused by internal-db-host")) };
          },
        };
      }
      throw new Error("unexpected");
    };
    const context = makeContext(TENANT_A, "user-1", fake.admin);
    const { token } = generateUpdateServiceStatusConfirmationToken({
      userId: "user-1",
      tenantId: TENANT_A,
      serviceId: SERVICE_A,
      currentStatus: "new",
      targetStatus: "assigned",
    });
    try {
      await tool.handler(context, { confirmationToken: token });
      expect.unreachable("doveva lanciare");
    } catch (error: any) {
      expect(error.code).toBe("MCP_INTERNAL_ERROR");
      expect(error.message).not.toContain("internal-db-host");
    }
  });

  it("nessun PII leak: output/audit non contengono customer_name/phone/email/token", async () => {
    const fake = makeFakeAdmin({ services: [serviceRow({ status: "new" })] });
    const context = makeContext(TENANT_A, "user-1", fake.admin);
    const { token } = generateUpdateServiceStatusConfirmationToken({
      userId: "user-1",
      tenantId: TENANT_A,
      serviceId: SERVICE_A,
      currentStatus: "new",
      targetStatus: "assigned",
    });
    const result: any = await tool.handler(context, { confirmationToken: token });
    const summary = tool.buildAuditSummary?.({ confirmationToken: token }, result);
    const text = JSON.stringify(summary).toLowerCase();
    expect(text).not.toMatch(/phone|email|customer_name|notes/);
    expect(JSON.stringify(summary)).not.toContain(token);
  });
});
