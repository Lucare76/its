import { z } from "zod";
import { registerTool } from "@/lib/mcp/registry";
import { isoDateSchema } from "@/lib/mcp/schemas/common";
import { listDriverRegistry } from "@/lib/server/driver-registry";
import { toSafeMcpError } from "@/lib/mcp/errors";

const inputSchema = z.object({ date: isoDateSchema }).strict();

const outputSchema = z.object({
  date: z.string(),
  drivers: z.array(
    z.object({
      user_id: z.string().nullable(),
      full_name: z.string(),
      active: z.boolean(),
      has_access: z.boolean(),
      assigned_services_count: z.number(),
    })
  ),
});

registerTool({
  name: "its.get_driver_availability",
  description:
    "Disponibilita' operativa degli autisti attivi del tenant per una data: numero di servizi gia' assegnati. Nessuna PII (no telefono).",
  category: "READ",
  inputSchema,
  outputSchema,
  allowedRoles: ["admin", "operator", "supervisor"],
  async handler(context, input) {
    try {
      const drivers = await listDriverRegistry(context.admin, context.tenantId, { activeOnly: true });

      const { data: serviceRows, error: servicesError } = await context.admin
        .from("services")
        .select("id")
        .eq("tenant_id", context.tenantId)
        .eq("date", input.date);
      if (servicesError) throw servicesError;
      const serviceIds = ((serviceRows ?? []) as Array<{ id: string }>).map((row) => row.id);

      const { data: assignmentRows, error: assignmentsError } =
        serviceIds.length === 0
          ? { data: [] as Array<{ driver_user_id: string | null }>, error: null }
          : await context.admin
              .from("assignments")
              .select("driver_user_id")
              .eq("tenant_id", context.tenantId)
              .in("service_id", serviceIds);
      if (assignmentsError) throw assignmentsError;

      const countByDriverUserId = new Map<string, number>();
      for (const row of (assignmentRows ?? []) as Array<{ driver_user_id: string | null }>) {
        if (!row.driver_user_id) continue;
        countByDriverUserId.set(row.driver_user_id, (countByDriverUserId.get(row.driver_user_id) ?? 0) + 1);
      }

      return {
        date: input.date,
        drivers: drivers.map((driver) => ({
          user_id: driver.user_id,
          full_name: driver.full_name,
          active: driver.active,
          has_access: driver.has_access,
          assigned_services_count: driver.user_id ? (countByDriverUserId.get(driver.user_id) ?? 0) : 0,
        })),
      };
    } catch (error) {
      throw toSafeMcpError(error);
    }
  },
});
