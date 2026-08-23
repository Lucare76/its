import { z } from "zod";
import { registerTool } from "@/lib/mcp/registry";
import { isoDateSchema } from "@/lib/mcp/schemas/common";
import {
  romeDateKey,
  SERVICE_COLUMNS,
  listUnassignedServicesForDay,
  type OperationsHealthServiceRow,
  type OperationsHealthAssignmentRow,
  type OperationsHealthHotelRow,
} from "@/lib/server/operational-health/operations-health";
import { toSafeMcpError } from "@/lib/mcp/errors";

const inputSchema = z
  .object({
    date: isoDateSchema.optional(),
    withinMinutes: z.coerce.number().int().min(1).max(1440).optional(),
  })
  .strict();

const outputSchema = z.object({
  date: z.string(),
  services: z.array(
    z.object({
      id: z.string(),
      time: z.string(),
      direction: z.string().nullable(),
      practice_number: z.string().nullable(),
      minutes_until: z.number().nullable(),
    })
  ),
  count: z.number(),
  /**
   * false se la lettura servizi/hotel/assegnazioni e' fallita (es. schema DB
   * disallineato in un ambiente specifico) — stessa failure isolation gia'
   * usata da readOperationsOperationalHealth per lo stesso identico rischio
   * documentato (colonna "operational_v2" opzionale non ancora presente in
   * un ambiente). In quel caso services/count sono vuoti per costruzione,
   * MAI un "zero servizi" travestito da dato reale.
   */
  available: z.boolean(),
});

registerTool({
  name: "its.get_unassigned_services",
  description:
    "Servizi di una giornata che richiedono ancora un autista (stessa logica di assegnabilita' del Piano del Giorno/Operational Health — mai un falso positivo per servizi che non richiedono assegnazione). Default: oggi. Opzionale withinMinutes per limitare a un orizzonte temporale. Usalo per 'mostrami i servizi senza autista'.",
  category: "READ",
  inputSchema,
  outputSchema,
  allowedRoles: ["admin", "operator", "supervisor"],
  async handler(context, input) {
    const now = new Date();
    const date = input.date ?? romeDateKey(now);

    // Lettura dati isolata dal resto (stesso pattern di settleArea in
    // lib/server/operational-health.ts): se services/hotels/assignments
    // falliscono (es. colonna mancante in un ambiente specifico — rischio
    // gia' documentato per SERVICE_COLUMNS), il tool risponde available:false
    // invece di un errore MCP generico che nasconde la causa reale al
    // chiamante. La causa reale resta comunque loggata qui sotto.
    let services: OperationsHealthServiceRow[] = [];
    let hotelsById = new Map<string, OperationsHealthHotelRow>();
    let assignmentRows: OperationsHealthAssignmentRow[] = [];
    let available = true;

    try {
      const [servicesResult, hotelsResult] = await Promise.all([
        context.admin.from("services").select(SERVICE_COLUMNS).eq("tenant_id", context.tenantId).eq("date", date).limit(500),
        context.admin.from("hotels").select("id, name, zone").eq("tenant_id", context.tenantId),
      ]);
      if (servicesResult.error) throw servicesResult.error;
      if (hotelsResult.error) throw hotelsResult.error;

      services = (servicesResult.data ?? []) as unknown as OperationsHealthServiceRow[];
      hotelsById = new Map(((hotelsResult.data ?? []) as OperationsHealthHotelRow[]).map((h) => [h.id, h] as const));
      const serviceIds = services.map((s) => s.id);

      const { data, error: assignmentError } = serviceIds.length
        ? await context.admin
            .from("assignments")
            .select("service_id, driver_user_id")
            .eq("tenant_id", context.tenantId)
            .in("service_id", serviceIds)
            .not("driver_user_id", "is", null)
        : { data: [] as OperationsHealthAssignmentRow[], error: null };
      if (assignmentError) throw assignmentError;
      assignmentRows = (data ?? []) as OperationsHealthAssignmentRow[];
    } catch (error) {
      console.error("its.get_unassigned_services: lettura dati non disponibile", error instanceof Error ? error.message : error);
      available = false;
    }

    if (!available) {
      return { date, services: [], count: 0, available: false };
    }

    try {
      const unassigned = listUnassignedServicesForDay(services, assignmentRows, hotelsById, {
        now,
        withinMinutes: input.withinMinutes,
      });

      return {
        date,
        services: unassigned.map((s) => ({
          id: s.id,
          time: s.time,
          direction: s.direction,
          practice_number: s.practiceNumber,
          minutes_until: s.minutesUntil,
        })),
        count: unassigned.length,
        available: true,
      };
    } catch (error) {
      throw toSafeMcpError(error);
    }
  },
  buildAuditSummary: (input, output) => ({
    date: output.date,
    within_minutes: input.withinMinutes ?? null,
    count: output.count,
  }),
});
