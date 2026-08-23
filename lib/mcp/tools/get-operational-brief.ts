import { z } from "zod";
import { registerTool } from "@/lib/mcp/registry";
import { isoDateSchema } from "@/lib/mcp/schemas/common";
import {
  romeDateKey,
  SERVICE_COLUMNS,
  EXCLUDED_STATUSES,
  listUnassignedServicesForDay,
  type OperationsHealthServiceRow,
  type OperationsHealthAssignmentRow,
  type OperationsHealthHotelRow,
} from "@/lib/server/operational-health/operations-health";
import { romeDateTimeToUtc } from "@/lib/server/medmar-booking/departure-datetime";
import { computeItsHealthSnapshot } from "@/lib/mcp/health-snapshot";
import { toSafeMcpError } from "@/lib/mcp/errors";

const inputSchema = z.object({ date: isoDateSchema.optional() }).strict();

const ACTIVE_STATUSES = new Set(["partito", "arrivato"]);

const signalActionSchema = z.object({ label: z.string(), href: z.string() });

const briefItemSchema = z.object({
  key: z.string(),
  area: z.string(),
  title: z.string(),
  message: z.string(),
  entity_id: z.string().nullable(),
  action: signalActionSchema.nullable(),
});

const outputSchema = z.object({
  date: z.string(),
  summary: z.object({
    total_services: z.number(),
    upcoming_services: z.number(),
    unassigned_services: z.number(),
    active_services: z.number(),
  }),
  critical_items: z.array(briefItemSchema),
  warnings: z.array(briefItemSchema),
  health: z.object({
    available: z.boolean(),
    overall: z.enum(["healthy", "attention", "critical"]).nullable(),
  }),
});

registerTool({
  name: "its.get_operational_brief",
  description:
    "Quadro operativo sintetico della giornata ITS: servizi, assegnazioni mancanti e salute generale, senza duplicare il Piano del Giorno. Usalo per 'come siamo messi oggi?', 'ci sono problemi per oggi?', 'fammi il punto della giornata'. Default: oggi.",
  category: "READ",
  inputSchema,
  outputSchema,
  allowedRoles: ["admin", "operator", "supervisor"],
  async handler(context, input) {
    try {
      const now = new Date();
      const date = input.date ?? romeDateKey(now);

      const [servicesResult, hotelsResult] = await Promise.all([
        context.admin.from("services").select(SERVICE_COLUMNS).eq("tenant_id", context.tenantId).eq("date", date).limit(500),
        context.admin.from("hotels").select("id, name, zone").eq("tenant_id", context.tenantId),
      ]);
      if (servicesResult.error) throw servicesResult.error;
      if (hotelsResult.error) throw hotelsResult.error;

      const services = (servicesResult.data ?? []) as unknown as OperationsHealthServiceRow[];
      const hotelsById = new Map(
        ((hotelsResult.data ?? []) as OperationsHealthHotelRow[]).map((h) => [h.id, h] as const)
      );
      const serviceIds = services.map((s) => s.id);

      const { data: assignmentRows, error: assignmentError } = serviceIds.length
        ? await context.admin
            .from("assignments")
            .select("service_id, driver_user_id")
            .eq("tenant_id", context.tenantId)
            .in("service_id", serviceIds)
            .not("driver_user_id", "is", null)
        : { data: [] as OperationsHealthAssignmentRow[], error: null };
      if (assignmentError) throw assignmentError;

      const nonDraftServices = services.filter((s) => !s.is_draft);
      const unassigned = listUnassignedServicesForDay(
        services,
        (assignmentRows ?? []) as OperationsHealthAssignmentRow[],
        hotelsById,
        { now }
      );
      const upcomingCount = nonDraftServices.filter((s) => {
        if (EXCLUDED_STATUSES.has(s.status) || ACTIVE_STATUSES.has(s.status)) return false;
        const at = romeDateTimeToUtc(s.date, s.time);
        return at ? at.getTime() >= now.getTime() : false;
      }).length;
      const activeCount = nonDraftServices.filter((s) => ACTIVE_STATUSES.has(s.status)).length;

      // Failure isolation (spec Sprint 5): la snapshot Health e' composta a
      // parte e non fa mai fallire il resto del brief — se non disponibile,
      // summary/servizi restano validi, solo health.available diventa false
      // e critical_items/warnings restano vuoti (nessuna fonte da cui derivarli).
      const snapshot = await computeItsHealthSnapshot(context.admin, context.tenantId, now);

      const criticalItems = snapshot.available
        ? snapshot.operationalHealth.signals
            .filter((s) => s.severity === "critical")
            .map((s) => ({
              key: s.key,
              area: s.area,
              title: s.title,
              message: s.message,
              entity_id: s.entityId ?? null,
              action: s.action ?? null,
            }))
        : [];
      const warningItems = snapshot.available
        ? snapshot.operationalHealth.signals
            .filter((s) => s.severity === "warning")
            .map((s) => ({
              key: s.key,
              area: s.area,
              title: s.title,
              message: s.message,
              entity_id: s.entityId ?? null,
              action: s.action ?? null,
            }))
        : [];

      return {
        date,
        summary: {
          total_services: nonDraftServices.length,
          upcoming_services: upcomingCount,
          unassigned_services: unassigned.length,
          active_services: activeCount,
        },
        critical_items: criticalItems,
        warnings: warningItems,
        health: {
          available: snapshot.available,
          overall: snapshot.available ? snapshot.overall : null,
        },
      };
    } catch (error) {
      throw toSafeMcpError(error);
    }
  },
  buildAuditSummary: (_input, output) => ({
    date: output.date,
    total_services: output.summary.total_services,
    unassigned_services: output.summary.unassigned_services,
    critical_count: output.critical_items.length,
    warning_count: output.warnings.length,
    health_available: output.health.available,
  }),
});
