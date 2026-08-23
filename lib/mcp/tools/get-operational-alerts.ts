import { z } from "zod";
import { registerTool } from "@/lib/mcp/registry";
import { readOperationalHealth } from "@/lib/server/operational-health";
import { toSafeMcpError } from "@/lib/mcp/errors";

const inputSchema = z
  .object({
    severity: z.enum(["warning", "critical", "all"]).optional(),
  })
  .strict();

const signalActionSchema = z.object({ label: z.string(), href: z.string() });

const alertSchema = z.object({
  key: z.string(),
  area: z.string(),
  severity: z.enum(["info", "warning", "critical"]),
  title: z.string(),
  message: z.string(),
  entity_id: z.string().nullable(),
  action: signalActionSchema.nullable(),
  detected_at: z.string(),
});

const outputSchema = z.object({
  generated_at: z.string(),
  severity_filter: z.enum(["warning", "critical", "all"]),
  alerts: z.array(alertSchema),
});

registerTool({
  name: "its.get_operational_alerts",
  description:
    "Elenco di cio' che richiede attenzione in ITS (Operational Health): critical/warning per area, con eventuale collegamento gia' determinato verso il punto giusto del gestionale. Usalo per 'cosa richiede attenzione?', 'quali problemi abbiamo?', 'ci sono servizi a rischio?'. Filtro opzionale per severita' (default: all).",
  category: "READ",
  inputSchema,
  outputSchema,
  allowedRoles: ["admin", "operator", "supervisor"],
  async handler(context, input) {
    try {
      const severityFilter = input.severity ?? "all";
      const now = new Date();
      const report = await readOperationalHealth(context.admin, context.tenantId, now);

      const signals =
        severityFilter === "all" ? report.signals : report.signals.filter((s) => s.severity === severityFilter);

      return {
        generated_at: report.generated_at,
        severity_filter: severityFilter,
        alerts: signals.map((s) => ({
          key: s.key,
          area: s.area,
          severity: s.severity,
          title: s.title,
          message: s.message,
          entity_id: s.entityId ?? null,
          action: s.action ?? null,
          detected_at: s.detectedAt,
        })),
      };
    } catch (error) {
      throw toSafeMcpError(error);
    }
  },
  buildAuditSummary: (input, output) => ({
    severity_filter: output.severity_filter,
    alert_count: output.alerts.length,
    requested_severity: input.severity ?? "all",
  }),
});
