import { z } from "zod";
import { registerTool } from "@/lib/mcp/registry";
import { computeItsHealthSnapshot } from "@/lib/mcp/health-snapshot";
import { toSafeMcpError } from "@/lib/mcp/errors";

const inputSchema = z.object({}).strict();

const jobHealthEntrySchema = z.object({
  job_key: z.string(),
  job_name: z.string(),
  health: z.string(),
  reason: z.string(),
  enabled: z.boolean(),
  consecutive_failures: z.number(),
  stale: z.boolean(),
  stuck: z.boolean(),
});

const signalActionSchema = z.object({ label: z.string(), href: z.string() });

const signalSchema = z.object({
  key: z.string(),
  area: z.string(),
  severity: z.string(),
  title: z.string(),
  message: z.string(),
  entity_id: z.string().nullable(),
  action: signalActionSchema.nullable(),
});

const outputSchema = z.object({
  generated_at: z.string(),
  available: z.boolean(),
  overall: z.enum(["healthy", "attention", "critical"]).nullable(),
  job_health: z
    .object({
      summary: z.object({
        healthy: z.number(),
        info: z.number(),
        warning: z.number(),
        critical: z.number(),
        disabled: z.number(),
        unknown: z.number(),
      }),
      jobs: z.array(jobHealthEntrySchema),
    })
    .nullable(),
  operational_health: z
    .object({
      summary: z.object({ info: z.number(), warning: z.number(), critical: z.number() }),
      areas: z.array(z.object({ area: z.string(), available: z.boolean(), error: z.string().nullable() })),
      signals: z.array(signalSchema),
    })
    .nullable(),
});

registerTool({
  name: "its.get_health_status",
  description:
    "Stato di salute generale di ITS: Job Health (i processi automatici funzionano?) + Operational Health (i risultati prodotti sono sani?), stessa source of truth di /settings/system. Usalo per 'ITS sta funzionando bene?', 'ci sono problemi tecnici?', 'ci sono anomalie?'.",
  category: "READ",
  inputSchema,
  outputSchema,
  allowedRoles: ["admin", "operator", "supervisor"],
  async handler(context) {
    try {
      const snapshot = await computeItsHealthSnapshot(context.admin, context.tenantId);

      if (!snapshot.available) {
        return {
          generated_at: new Date().toISOString(),
          available: false,
          overall: null,
          job_health: null,
          operational_health: null,
        };
      }

      return {
        generated_at: snapshot.generatedAt,
        available: true,
        overall: snapshot.overall,
        job_health: {
          summary: snapshot.jobHealth.summary,
          jobs: snapshot.jobHealth.evaluations.map((e) => ({
            job_key: e.jobKey,
            job_name: e.jobName,
            health: e.healthStatus,
            reason: e.reason,
            enabled: e.enabled,
            consecutive_failures: e.consecutiveFailures,
            stale: e.stale,
            stuck: e.stuck,
          })),
        },
        operational_health: {
          summary: snapshot.operationalHealth.summary,
          areas: snapshot.operationalHealth.areas.map((a) => ({
            area: a.area,
            available: a.available,
            error: a.error ?? null,
          })),
          signals: snapshot.operationalHealth.signals.map((s) => ({
            key: s.key,
            area: s.area,
            severity: s.severity,
            title: s.title,
            message: s.message,
            entity_id: s.entityId ?? null,
            action: s.action ?? null,
          })),
        },
      };
    } catch (error) {
      throw toSafeMcpError(error);
    }
  },
  buildAuditSummary: (_input, output) => ({
    available: output.available,
    overall: output.overall,
  }),
});
