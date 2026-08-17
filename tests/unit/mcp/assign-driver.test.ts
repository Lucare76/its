import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { getTool } from "@/lib/mcp/registry";
import { generateAssignDriverConfirmationToken, __resetConfirmationRegistryForTests } from "@/lib/mcp/confirmation";
import type { McpContext } from "@/lib/mcp/context";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SERVICE_A = "11111111-1111-4111-8111-111111111111";
const DRIVER_PROFILE_A = "22222222-2222-4222-8222-222222222222";
const DRIVER_USER_A = "33333333-3333-4333-8333-333333333333";
const TEST_DATE = "2026-08-20";

type Row = Record<string, unknown>;

function makeFakeAdmin(seedTables: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = {
    driver_assignment_history: [],
    ...seedTables,
  };

  function augmentAssignmentRow(row: Row): Row {
    return { ...row, services: (tables.services ?? []).find((s) => s.id === row.service_id) ?? null };
  }

  function selectChain(table: string) {
    let rows = tables[table] ?? [];
    const augment = table === "assignments" ? augmentAssignmentRow : undefined;
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
        const row = rows[0] ?? null;
        return Promise.resolve({ data: row ? (augment ? augment(row) : row) : null, error: null });
      },
      then(resolve: (v: { data: Row[]; error: null }) => unknown, reject?: (e: unknown) => unknown) {
        const data = augment ? rows.map(augment) : rows;
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      },
    };
    return builder;
  }

  function mutationChain(table: string, op: "delete" | "update", payload?: Row) {
    const rows = tables[table] ?? (tables[table] = []);
    let filtered = rows;
    const builder: any = {
      eq(field: string, value: unknown) {
        filtered = filtered.filter((r) => r[field] === value);
        return builder;
      },
      then(resolve: (v: { data: null; error: null }) => unknown, reject?: (e: unknown) => unknown) {
        if (op === "delete") {
          const toRemove = new Set(filtered);
          for (let i = rows.length - 1; i >= 0; i--) if (toRemove.has(rows[i])) rows.splice(i, 1);
        } else {
          for (const row of filtered) Object.assign(row, payload);
        }
        return Promise.resolve({ data: null, error: null }).then(resolve, reject);
      },
    };
    return builder;
  }

  return {
    from(table: string) {
      return {
        select: () => selectChain(table),
        delete: () => mutationChain(table, "delete"),
        update: (payload: Row) => mutationChain(table, "update", payload),
        insert(row: Row) {
          const rows = tables[table] ?? (tables[table] = []);
          if (table === "trip_groups") {
            const inserted = { id: `grp-${rows.length + 1}`, status: "active", ...row };
            rows.push(inserted);
            return { select: () => ({ single: () => Promise.resolve({ data: inserted, error: null }) }) };
          }
          if (table === "assignments") {
            const inserted = { id: `asg-${rows.length + 1}`, ...row };
            rows.push(inserted);
            return Promise.resolve({ data: inserted, error: null });
          }
          rows.push(row);
          return Promise.resolve({ data: row, error: null });
        },
        upsert(row: Row) {
          const rows = tables[table] ?? (tables[table] = []);
          rows.push(row);
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
    tables,
  };
}

function makeContext(tenantId: string, userId: string, admin: unknown): McpContext {
  return { requestId: "req-1", userId, userEmail: "op@test.dev", tenantId, role: "operator", admin: admin as McpContext["admin"] };
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
        booking_service_kind: null,
        service_type_code: null,
        service_type: "transfer",
        vessel: null,
        ferry_details: null,
        pax: 2,
      },
    ],
    driver_profiles: [{ id: DRIVER_PROFILE_A, tenant_id: TENANT_A, user_id: DRIVER_USER_A, full_name: "Mario Autista", phone: "+391234", active: true }],
    memberships: [{ user_id: DRIVER_USER_A, tenant_id: TENANT_A, role: "driver", full_name: "Mario Autista", suspended: false, max_vehicle_capacity: null }],
    vehicles: [],
    assignments: [],
    trip_groups: [],
    daily_availability_confirmations: [{ tenant_id: TENANT_A, date: TEST_DATE, confirmed: true }],
    status_events: [],
  };
}

describe("its.assign_driver (Fase 26/27)", () => {
  let tool: NonNullable<ReturnType<typeof getTool>>;

  beforeAll(async () => {
    process.env.AGENCY_ACTION_SECRET = "test-secret-not-real";
    await import("@/lib/mcp/tools/assign-driver");
    const found = getTool("its.assign_driver");
    if (!found) throw new Error("its.assign_driver non registrato");
    tool = found;
  });

  beforeEach(() => {
    __resetConfirmationRegistryForTests();
  });

  it("e' WRITE, ruoli ops (non driver/agency/assistenza/autista)", () => {
    expect(tool.category).toBe("WRITE");
    expect(tool.allowedRoles).toEqual(expect.arrayContaining(["admin", "operator", "supervisor"]));
    expect(tool.allowedRoles).not.toEqual(expect.arrayContaining(["driver"]));
    expect(tool.allowedRoles).not.toEqual(expect.arrayContaining(["agency"]));
  });

  it("1/2/3. assegnazione riuscita: scrive assignment, produce history e group_id", async () => {
    const fake = makeFakeAdmin(baseTables());
    const context = makeContext(TENANT_A, "user-1", fake);
    const { token } = generateAssignDriverConfirmationToken({
      userId: "user-1",
      tenantId: TENANT_A,
      serviceId: SERVICE_A,
      driverId: DRIVER_PROFILE_A,
      vehicleId: null,
    });

    const result: any = await tool.handler(context, { confirmationToken: token });
    expect(result.status).toBe("assigned");
    expect(result.groupId).not.toBeNull();
    expect(fake.tables.assignments).toHaveLength(1);
  });

  it("senza preview valida (token malformato/inesistente): MCP_CONFIRMATION_INVALID", async () => {
    const fake = makeFakeAdmin(baseTables());
    const context = makeContext(TENANT_A, "user-1", fake);
    await expect(tool.handler(context, { confirmationToken: "not-a-real-token" })).rejects.toMatchObject({
      code: "MCP_CONFIRMATION_INVALID",
    });
    expect(fake.tables.assignments).toHaveLength(0);
  });

  it("token gia' usato: seconda esecuzione -> MCP_CONFIRMATION_ALREADY_USED, nessuna doppia scrittura", async () => {
    const fake = makeFakeAdmin(baseTables());
    const context = makeContext(TENANT_A, "user-1", fake);
    const { token } = generateAssignDriverConfirmationToken({
      userId: "user-1",
      tenantId: TENANT_A,
      serviceId: SERVICE_A,
      driverId: DRIVER_PROFILE_A,
      vehicleId: null,
    });

    await tool.handler(context, { confirmationToken: token });
    await expect(tool.handler(context, { confirmationToken: token })).rejects.toMatchObject({
      code: "MCP_CONFIRMATION_ALREADY_USED",
    });
    expect(fake.tables.assignments).toHaveLength(1);
  });

  it("token emesso per un tenant diverso dal context: MCP_CONFIRMATION_INVALID, nessuna scrittura", async () => {
    const fake = makeFakeAdmin(baseTables());
    const context = makeContext(TENANT_A, "user-1", fake);
    const { token } = generateAssignDriverConfirmationToken({
      userId: "user-1",
      tenantId: TENANT_B,
      serviceId: SERVICE_A,
      driverId: DRIVER_PROFILE_A,
      vehicleId: null,
    });
    await expect(tool.handler(context, { confirmationToken: token })).rejects.toMatchObject({
      code: "MCP_CONFIRMATION_INVALID",
    });
    expect(fake.tables.assignments).toHaveLength(0);
  });

  it("token emesso per un utente diverso dal context: MCP_CONFIRMATION_INVALID, nessuna scrittura", async () => {
    const fake = makeFakeAdmin(baseTables());
    const context = makeContext(TENANT_A, "user-1", fake);
    const { token } = generateAssignDriverConfirmationToken({
      userId: "user-2",
      tenantId: TENANT_A,
      serviceId: SERVICE_A,
      driverId: DRIVER_PROFILE_A,
      vehicleId: null,
    });
    await expect(tool.handler(context, { confirmationToken: token })).rejects.toMatchObject({
      code: "MCP_CONFIRMATION_INVALID",
    });
    expect(fake.tables.assignments).toHaveLength(0);
  });

  it("payload tampering (driverId nel token diverso da quello approvato): la firma non corrisponde -> MCP_CONFIRMATION_INVALID", async () => {
    const fake = makeFakeAdmin(baseTables());
    const context = makeContext(TENANT_A, "user-1", fake);
    const { token } = generateAssignDriverConfirmationToken({
      userId: "user-1",
      tenantId: TENANT_A,
      serviceId: SERVICE_A,
      driverId: DRIVER_PROFILE_A,
      vehicleId: null,
    });
    const [encodedPayload] = token.split(".");
    const decoded = JSON.parse(Buffer.from(encodedPayload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
    decoded.driverId = "11111111-1111-4111-8111-999999999999";
    const reencoded = Buffer.from(JSON.stringify(decoded)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
    const tampered = `${reencoded}.forgedsignature`;
    await expect(tool.handler(context, { confirmationToken: tampered })).rejects.toMatchObject({
      code: "MCP_CONFIRMATION_INVALID",
    });
  });

  it("preview stale (assegnato nel frattempo da un altro operatore): MCP_CONFIRMATION_STALE", async () => {
    const tables = baseTables();
    // Un'altra assegnazione, creata DOPO la preview, occupa gia' il servizio
    // con lo stesso vincolo unique che la route userebbe in produzione:
    // simuliamo il conflitto 23505 forzando l'insert ad avere gia' una riga.
    tables.assignments = [{ id: "asg-existing", tenant_id: TENANT_A, service_id: SERVICE_A, group_id: null, driver_profile_id: "other-driver", vehicle_label: "" }];
    const fake = makeFakeAdmin(tables);
    // Sovrascrive insert su assignments per simulare il conflitto reale 23505
    // quando il gruppo non e' riusabile (nessun group_id sull'assegnazione esistente).
    const originalFrom = fake.from.bind(fake);
    (fake as any).from = (table: string) => {
      const base = originalFrom(table);
      if (table === "assignments") {
        return {
          ...base,
          insert: () => Promise.resolve({ data: null, error: { code: "23505", message: "duplicate key" } }),
        };
      }
      return base;
    };

    const context = makeContext(TENANT_A, "user-1", fake);
    const { token } = generateAssignDriverConfirmationToken({
      userId: "user-1",
      tenantId: TENANT_A,
      serviceId: SERVICE_A,
      driverId: DRIVER_PROFILE_A,
      vehicleId: null,
    });
    await expect(tool.handler(context, { confirmationToken: token })).rejects.toMatchObject({
      code: "MCP_CONFIRMATION_STALE",
    });
  });

  it("6. idempotenza: stessa assegnazione gia' presente -> status 'no_op', nessuna nuova assignment history duplicata", async () => {
    const tables = baseTables();
    tables.assignments = [{ id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_A, group_id: "grp-1", driver_profile_id: DRIVER_PROFILE_A, driver_user_id: DRIVER_USER_A, vehicle_label: "" }];
    tables.trip_groups = [{ id: "grp-1", tenant_id: TENANT_A, date: TEST_DATE, status: "active", driver_profile_id: DRIVER_PROFILE_A, driver_user_id: DRIVER_USER_A, vehicle_label: null }];
    const fake = makeFakeAdmin(tables);
    const context = makeContext(TENANT_A, "user-1", fake);
    const { token } = generateAssignDriverConfirmationToken({
      userId: "user-1",
      tenantId: TENANT_A,
      serviceId: SERVICE_A,
      driverId: DRIVER_PROFILE_A,
      vehicleId: null,
    });

    const result: any = await tool.handler(context, { confirmationToken: token });
    expect(result.status).toBe("no_op");
  });

  it("8. output/audit summary non contengono PII ne' il confirmation token", async () => {
    const fake = makeFakeAdmin(baseTables());
    const context = makeContext(TENANT_A, "user-1", fake);
    const { token } = generateAssignDriverConfirmationToken({
      userId: "user-1",
      tenantId: TENANT_A,
      serviceId: SERVICE_A,
      driverId: DRIVER_PROFILE_A,
      vehicleId: null,
    });
    const result: any = await tool.handler(context, { confirmationToken: token });
    const summary = tool.buildAuditSummary?.({ confirmationToken: token }, result);
    expect(summary).toEqual({ service_id: SERVICE_A, driver_id: DRIVER_PROFILE_A, vehicle_id: null, result: "assigned" });
    expect(JSON.stringify(summary)).not.toContain(token);
    expect(JSON.stringify(summary).toLowerCase()).not.toMatch(/phone|email|notes/);
  });
});
