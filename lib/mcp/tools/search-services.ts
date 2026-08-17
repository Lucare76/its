import { z } from "zod";
import { registerTool } from "@/lib/mcp/registry";
import { limitSchema, isoDateSchema } from "@/lib/mcp/schemas/common";
import { buildServicesQuery, serviceQueryFiltersSchema } from "@/lib/server/services-filter-builder";
import { McpError, toSafeMcpError } from "@/lib/mcp/errors";

const inputSchema = z
  .object({
    query: z.string().max(200).optional(),
    dateFrom: isoDateSchema.optional(),
    dateTo: isoDateSchema.optional(),
    status: z
      .array(z.enum(["needs_review", "new", "assigned", "partito", "arrivato", "completato", "problema", "cancelled"]))
      .optional(),
    limit: limitSchema.optional(),
  })
  .strict();

const outputItemSchema = z.object({
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
});

const outputSchema = z.object({
  services: z.array(outputItemSchema),
  count: z.number(),
});

const SAFE_SELECT = "id, date, time, status, direction, pax, vessel, hotel_id, service_type, customer_name";

registerTool({
  name: "its.search_services",
  description:
    "Cerca servizi (transfer/bus) del tenant corrente per intervallo date, stato e testo libero. Restituisce solo campi operativi, mai PII (no email/telefono/note).",
  category: "READ",
  inputSchema,
  outputSchema,
  allowedRoles: ["admin", "operator", "supervisor"],
  async handler(context, input) {
    const limit = input.limit ?? 50;
    let filters;
    try {
      filters = serviceQueryFiltersSchema.parse({
        dateFrom: input.dateFrom,
        dateTo: input.dateTo,
        status: input.status ?? [],
        search: input.query ?? "",
        tenant_id: context.tenantId,
      });
    } catch {
      throw new McpError("MCP_INVALID_INPUT", "Filtri di ricerca non validi.");
    }

    try {
      const { query } = await buildServicesQuery({ admin: context.admin, filters, select: SAFE_SELECT });
      const { data, error } = await query.order("date", { ascending: false }).order("time", { ascending: true }).limit(limit);
      if (error) throw error;
      const services = (data ?? []) as z.infer<typeof outputItemSchema>[];
      return { services, count: services.length };
    } catch (error) {
      throw toSafeMcpError(error);
    }
  },
});
