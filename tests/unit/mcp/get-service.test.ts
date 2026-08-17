import { describe, it, expect, beforeAll } from "vitest";
import { getTool } from "@/lib/mcp/registry";
import { McpError } from "@/lib/mcp/errors";
import type { McpContext } from "@/lib/mcp/context";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SERVICE_A = "11111111-1111-4111-8111-111111111111";
const SERVICE_B = "22222222-2222-4222-8222-222222222222";

type Row = Record<string, unknown>;

function makeFakeAdmin(rows: Row[]) {
  return {
    from(_table: string) {
      let filtered = rows;
      let columns: string[] | null = null;
      const builder = {
        select(select: string) {
          columns = select.split(",").map((column) => column.trim());
          return builder;
        },
        eq(field: string, value: unknown) {
          filtered = filtered.filter((row) => row[field] === value);
          return builder;
        },
        async maybeSingle() {
          const row = filtered[0] ?? null;
          if (!row || !columns) return { data: row, error: null };
          const projected: Row = {};
          for (const column of columns) {
            if (column in row) projected[column] = row[column];
          }
          return { data: projected, error: null };
        },
      };
      return builder;
    },
  };
}

function makeContext(tenantId: string, admin: unknown): McpContext {
  return {
    requestId: "req-1",
    userId: "user-1",
    userEmail: "test@example.com",
    tenantId,
    role: "operator",
    admin: admin as McpContext["admin"],
  };
}

describe("its.get_service", () => {
  let tool: NonNullable<ReturnType<typeof getTool>>;

  beforeAll(async () => {
    await import("@/lib/mcp/tools/get-service");
    const found = getTool("its.get_service");
    if (!found) throw new Error("its.get_service non registrato");
    tool = found;
  });

  const rows: Row[] = [
    {
      id: SERVICE_A,
      tenant_id: TENANT_A,
      date: "2026-08-20",
      time: "10:00",
      status: "assigned",
      direction: "arrival",
      pax: 2,
      vessel: "Snav",
      hotel_id: null,
      service_type: "transfer",
      customer_name: "Mario Rossi",
      meeting_point: "Porto",
      pickup_hotel: null,
      // Campi PII/sensibili presenti nella riga DB ma che NON devono uscire
      // dall'output del tool.
      phone: "+39123456789",
      customer_email: "mario@example.com",
      notes: "nota privata cliente",
      raw_email: "raw mime content",
      share_token: "secret-share-token",
    },
    { id: SERVICE_B, tenant_id: TENANT_B, date: "2026-08-20", time: "11:00", status: "new" },
  ];

  it("un utente del tenant A legge il servizio del tenant A", async () => {
    const context = makeContext(TENANT_A, makeFakeAdmin(rows));
    const result = await tool.handler(context, { serviceId: SERVICE_A });
    expect((result as Row).id).toBe(SERVICE_A);
  });

  it("un utente del tenant A NON legge un servizio del tenant B (isolamento tenant)", async () => {
    const context = makeContext(TENANT_A, makeFakeAdmin(rows));
    await expect(tool.handler(context, { serviceId: SERVICE_B })).rejects.toMatchObject({
      code: "MCP_NOT_FOUND",
    });
  });

  it("servizio inesistente -> MCP_NOT_FOUND", async () => {
    const context = makeContext(TENANT_A, makeFakeAdmin(rows));
    await expect(
      tool.handler(context, { serviceId: "99999999-9999-4999-8999-999999999999" })
    ).rejects.toBeInstanceOf(McpError);
  });

  it("input non valido (uuid malformato) viene rifiutato dallo schema", () => {
    const parsed = tool.inputSchema.safeParse({ serviceId: "not-a-uuid" });
    expect(parsed.success).toBe(false);
  });

  it("l'output non contiene mai PII o campi sensibili", async () => {
    const context = makeContext(TENANT_A, makeFakeAdmin(rows));
    const result = (await tool.handler(context, { serviceId: SERVICE_A })) as Row;
    for (const forbiddenField of ["phone", "customer_email", "notes", "raw_email", "share_token", "tenant_id"]) {
      expect(result).not.toHaveProperty(forbiddenField);
    }
  });
});
