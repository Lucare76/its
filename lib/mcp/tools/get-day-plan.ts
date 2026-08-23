import { z } from "zod";
import { registerTool } from "@/lib/mcp/registry";
import { isoDateSchema } from "@/lib/mcp/schemas/common";
import { listDriverRegistry } from "@/lib/server/driver-registry";
import { toSafeMcpError } from "@/lib/mcp/errors";

const inputSchema = z.object({ date: isoDateSchema }).strict();

const planServiceSchema = z.object({
  id: z.string(),
  time: z.string().nullable(),
  status: z.string().nullable(),
  direction: z.string().nullable(),
  pax: z.number().nullable(),
  vessel: z.string().nullable(),
  service_type: z.string().nullable(),
  assigned: z.boolean(),
  driver_name: z.string().nullable(),
  vehicle_label: z.string().nullable(),
});

const outputSchema = z.object({
  date: z.string(),
  services: z.array(planServiceSchema),
  unassigned_count: z.number(),
  drivers_on_duty: z.array(z.object({ full_name: z.string(), active: z.boolean() })),
});

const SERVICE_SELECT = "id, time, status, direction, pax, vessel, service_type";

registerTool({
  name: "its.get_day_plan",
  description:
    "Vista operativa compatta del giorno per il tenant corrente: servizi, assegnazioni driver/veicolo, non assegnati (campo 'assigned' per servizio), autisti in servizio. Nota (Sprint 5): 'assigned=false' qui e' un dato grezzo (include anche servizi che potrebbero non richiedere assegnazione) — per sapere quali servizi mancano DAVVERO di autista, o hanno un alert operativo, usa its.get_unassigned_services / its.get_operational_alerts.",
  category: "READ",
  inputSchema,
  outputSchema,
  allowedRoles: ["admin", "operator", "supervisor"],
  async handler(context, input) {
    try {
      const { data: serviceRows, error: servicesError } = await context.admin
        .from("services")
        .select(SERVICE_SELECT)
        .eq("tenant_id", context.tenantId)
        .eq("date", input.date)
        .order("time", { ascending: true });
      if (servicesError) throw servicesError;

      const services = (serviceRows ?? []) as Array<{
        id: string;
        time: string | null;
        status: string | null;
        direction: string | null;
        pax: number | null;
        vessel: string | null;
        service_type: string | null;
      }>;
      const serviceIds = services.map((service) => service.id);

      const { data: assignmentRows, error: assignmentsError } =
        serviceIds.length === 0
          ? { data: [] as Array<{ service_id: string; driver_user_id: string | null; vehicle_label: string | null }>, error: null }
          : await context.admin
              .from("assignments")
              .select("service_id, driver_user_id, vehicle_label")
              .eq("tenant_id", context.tenantId)
              .in("service_id", serviceIds);
      if (assignmentsError) throw assignmentsError;

      const assignmentByServiceId = new Map(
        ((assignmentRows ?? []) as Array<{ service_id: string; driver_user_id: string | null; vehicle_label: string | null }>).map(
          (row) => [row.service_id, row]
        )
      );

      const driverRegistry = await listDriverRegistry(context.admin, context.tenantId, { activeOnly: true });
      const driverNameByUserId = new Map(driverRegistry.map((driver) => [driver.user_id, driver.full_name]));

      const planServices = services.map((service) => {
        const assignment = assignmentByServiceId.get(service.id);
        return {
          id: service.id,
          time: service.time,
          status: service.status,
          direction: service.direction,
          pax: service.pax,
          vessel: service.vessel,
          service_type: service.service_type,
          assigned: Boolean(assignment),
          driver_name: assignment?.driver_user_id ? (driverNameByUserId.get(assignment.driver_user_id) ?? null) : null,
          vehicle_label: assignment?.vehicle_label ?? null,
        };
      });

      return {
        date: input.date,
        services: planServices,
        unassigned_count: planServices.filter((service) => !service.assigned).length,
        drivers_on_duty: driverRegistry.map((driver) => ({ full_name: driver.full_name, active: driver.active })),
      };
    } catch (error) {
      throw toSafeMcpError(error);
    }
  },
});
