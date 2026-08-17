import { z } from "zod";
import { registerTool } from "@/lib/mcp/registry";
import { isoDateSchema } from "@/lib/mcp/schemas/common";
import { loadOperationalVehicles } from "@/lib/server/vehicle-catalog";
import { isVehicleManuallyBlockedOnDate } from "@/lib/server/vehicle-availability";
import { toSafeMcpError } from "@/lib/mcp/errors";

const inputSchema = z.object({ date: isoDateSchema.optional() }).strict();

const outputSchema = z.object({
  date: z.string().nullable(),
  vehicles: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      capacity: z.number().nullable(),
      vehicle_size: z.string().nullable(),
      active: z.boolean(),
      blocked_on_date: z.boolean(),
    })
  ),
});

registerTool({
  name: "its.get_fleet_status",
  description:
    "Stato flotta del tenant corrente: mezzi attivi/inattivi ed eventuale blocco manuale sulla data indicata.",
  category: "READ",
  inputSchema,
  outputSchema,
  allowedRoles: ["admin", "operator", "supervisor"],
  async handler(context, input) {
    try {
      const vehicles = await loadOperationalVehicles(context.admin, context.tenantId, { activeOnly: false });

      let blockRows: Array<{ id: string; blocked_from: string | null; blocked_until: string | null; is_blocked_manual: boolean | null }> = [];
      if (input.date) {
        const { data, error } = await context.admin
          .from("vehicles")
          .select("id, blocked_from, blocked_until, is_blocked_manual")
          .eq("tenant_id", context.tenantId);
        if (error) throw error;
        blockRows = (data ?? []) as typeof blockRows;
      }
      const blockById = new Map(blockRows.map((row) => [row.id, row]));

      return {
        date: input.date ?? null,
        vehicles: vehicles.map((vehicle) => {
          const block = blockById.get(vehicle.id);
          return {
            id: vehicle.id,
            label: vehicle.label,
            capacity: vehicle.capacity,
            vehicle_size: vehicle.vehicle_size,
            active: vehicle.active,
            blocked_on_date: input.date && block ? isVehicleManuallyBlockedOnDate(block, input.date) : false,
          };
        }),
      };
    } catch (error) {
      throw toSafeMcpError(error);
    }
  },
});
