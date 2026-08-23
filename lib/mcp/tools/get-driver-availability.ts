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
      /** true se l'accesso e' sospeso — motivo deterministico di indisponibilita' gia' noto (Sprint 5 MCP), mai una deduzione. */
      access_suspended: z.boolean(),
      assigned_services_count: z.number(),
      /** Slot orari gia' occupati per la data (Sprint 5 MCP) — nessuno scoring: il chiamante deduce da qui la finestra libera, mai un giudizio "disponibile dalle X alle Y" calcolato qui. */
      assigned_services: z.array(
        z.object({ id: z.string(), time: z.string().nullable(), direction: z.string().nullable(), vehicle_label: z.string().nullable() })
      ),
    })
  ),
});

registerTool({
  name: "its.get_driver_availability",
  description:
    "Disponibilita' operativa degli autisti attivi del tenant per una data: servizi gia' assegnati (orario/direzione/mezzo) cosi' si vedono gli slot occupati, non solo il conteggio. Nessuno scoring/scelta automatica dell'autista 'migliore' — solo dati deterministici. Usalo per 'chi e' disponibile dalle 15 alle 20?', 'chi posso usare per questo servizio?'. Nessuna PII (no telefono).",
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

      type AssignmentRow = { service_id: string; driver_user_id: string | null; vehicle_label: string | null };
      const { data: assignmentRows, error: assignmentsError } =
        serviceIds.length === 0
          ? { data: [] as AssignmentRow[], error: null }
          : await context.admin
              .from("assignments")
              .select("service_id, driver_user_id, vehicle_label")
              .eq("tenant_id", context.tenantId)
              .in("service_id", serviceIds);
      if (assignmentsError) throw assignmentsError;

      type ServiceTimeRow = { id: string; time: string | null; direction: string | null };
      const { data: serviceTimeRows, error: serviceTimesError } =
        serviceIds.length === 0
          ? { data: [] as ServiceTimeRow[], error: null }
          : await context.admin.from("services").select("id, time, direction").in("id", serviceIds);
      if (serviceTimesError) throw serviceTimesError;
      const serviceById = new Map(((serviceTimeRows ?? []) as ServiceTimeRow[]).map((row) => [row.id, row]));

      const assignmentsByDriverUserId = new Map<string, AssignmentRow[]>();
      for (const row of (assignmentRows ?? []) as AssignmentRow[]) {
        if (!row.driver_user_id) continue;
        const list = assignmentsByDriverUserId.get(row.driver_user_id) ?? [];
        list.push(row);
        assignmentsByDriverUserId.set(row.driver_user_id, list);
      }

      return {
        date: input.date,
        drivers: drivers.map((driver) => {
          const driverAssignments = driver.user_id ? (assignmentsByDriverUserId.get(driver.user_id) ?? []) : [];
          return {
            user_id: driver.user_id,
            full_name: driver.full_name,
            active: driver.active,
            has_access: driver.has_access,
            access_suspended: driver.access_suspended,
            assigned_services_count: driverAssignments.length,
            assigned_services: driverAssignments.map((a) => {
              const service = serviceById.get(a.service_id);
              return {
                id: a.service_id,
                time: service?.time ?? null,
                direction: service?.direction ?? null,
                vehicle_label: a.vehicle_label ?? null,
              };
            }),
          };
        }),
      };
    } catch (error) {
      throw toSafeMcpError(error);
    }
  },
});
