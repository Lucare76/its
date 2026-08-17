import { z } from "zod";
import { registerTool } from "@/lib/mcp/registry";
import { uuidSchema } from "@/lib/mcp/schemas/common";
import { McpError, toSafeMcpError } from "@/lib/mcp/errors";

const inputSchema = z.object({ serviceId: uuidSchema }).strict();

const outputSchema = z.object({
  id: z.string(),
  date: z.string().nullable(),
  time: z.string().nullable(),
  status: z.string().nullable(),
  direction: z.string().nullable(),
  pax: z.number().nullable(),
  vessel: z.string().nullable(),
  hotel_id: z.string().nullable(),
  service_type: z.string().nullable(),
  customer_name: z.string().nullable(),
  meeting_point: z.string().nullable(),
  pickup_hotel: z.string().nullable(),
});

const SAFE_SELECT =
  "id, date, time, status, direction, pax, vessel, hotel_id, service_type, customer_name, meeting_point, pickup_hotel, tenant_id";

registerTool({
  name: "its.get_service",
  description:
    "Recupera un singolo servizio per id, solo se appartiene al tenant corrente. Restituisce solo campi operativi, mai PII (no email/telefono/note).",
  category: "READ",
  inputSchema,
  outputSchema,
  allowedRoles: ["admin", "operator", "supervisor"],
  async handler(context, input) {
    try {
      const { data, error } = await context.admin
        .from("services")
        .select(SAFE_SELECT)
        .eq("id", input.serviceId)
        .eq("tenant_id", context.tenantId)
        .maybeSingle();
      if (error) throw error;
      if (!data) {
        throw new McpError("MCP_NOT_FOUND", "Servizio non trovato.");
      }
      const { tenant_id: _tenantId, ...safe } = data as Record<string, unknown> & { tenant_id: string };
      return safe as z.infer<typeof outputSchema>;
    } catch (error) {
      throw toSafeMcpError(error);
    }
  },
});
