import { z } from "zod";
import { registerTool } from "@/lib/mcp/registry";
import { uuidSchema } from "@/lib/mcp/schemas/common";
import { McpError, toSafeMcpError } from "@/lib/mcp/errors";

const inputSchema = z.object({ serviceId: uuidSchema }).strict();

const outputSchema = z.object({
  service_id: z.string(),
  status: z.enum(["auto_safe", "review", "unresolved", "locked", "manual"]),
  proposed_driver_name: z.string().nullable(),
  proposed_vehicle_label: z.string().nullable(),
  score: z.number().nullable(),
  confidence: z.number().nullable(),
  reason_summary: z.array(z.string()),
  warnings: z.array(z.string()),
  alternatives: z.array(z.object({ driver_name: z.string(), vehicle_label: z.string().nullable(), score: z.number(), reason: z.array(z.string()) })),
});

registerTool({
  name: "its.explain_assignment",
  description:
    "Spiega perche' il piano di assegnazione intelligente ha proposto un dato autista/mezzo per un servizio: motivazioni, score, alternative considerate. Usalo per 'perche' hai scelto Antonio per il servizio X?'. Richiede che its.get_assignment_plan sia gia' stato generato per la data del servizio.",
  category: "READ",
  inputSchema,
  outputSchema,
  allowedRoles: ["admin", "operator", "supervisor"],
  async handler(context, input) {
    try {
      const { data: item, error } = await context.admin
        .from("assignment_plan_items")
        .select("service_id, status, proposed_driver_name, proposed_vehicle_label, score, confidence, reason, warnings, alternatives")
        .eq("tenant_id", context.tenantId)
        .eq("service_id", input.serviceId)
        .maybeSingle();
      if (error) throw error;
      if (!item) throw new McpError("MCP_NOT_FOUND", "Nessun item di piano trovato per questo servizio. Genera prima il piano con its.recalculate_assignment_plan.");

      const reason = (item.reason as { summary?: string[] } | null) ?? {};
      return {
        service_id: item.service_id as string,
        status: item.status as "auto_safe" | "review" | "unresolved" | "locked" | "manual",
        proposed_driver_name: (item.proposed_driver_name as string | null) ?? null,
        proposed_vehicle_label: (item.proposed_vehicle_label as string | null) ?? null,
        score: (item.score as number | null) ?? null,
        confidence: (item.confidence as number | null) ?? null,
        reason_summary: reason.summary ?? [],
        warnings: (item.warnings as string[] | null) ?? [],
        alternatives: ((item.alternatives as Array<{ driver_name: string; vehicle_label: string | null; score: number; reason: string[] }> | null) ?? []).map((alt) => ({
          driver_name: alt.driver_name,
          vehicle_label: alt.vehicle_label ?? null,
          score: alt.score,
          reason: alt.reason,
        })),
      };
    } catch (error) {
      throw toSafeMcpError(error);
    }
  },
  buildAuditSummary: (input, output) => ({ service_id: output.service_id, status: output.status }),
});
