import { z } from "zod";
import { registerTool } from "@/lib/mcp/registry";
import { isoDateSchema, uuidSchema } from "@/lib/mcp/schemas/common";
import { buildAndPersistAssignmentPlan } from "@/lib/server/assignment-engine/build-plan";
import { toSafeMcpError } from "@/lib/mcp/errors";

const inputSchema = z
  .object({
    date: isoDateSchema,
    changedServiceIds: z.array(uuidSchema).max(50).optional(),
  })
  .strict();

const outputSchema = z.object({
  date: z.string(),
  duration_ms: z.number(),
  services_count: z.number(),
  auto_safe_count: z.number(),
  review_count: z.number(),
  unresolved_count: z.number(),
  locked_count: z.number(),
  manual_count: z.number(),
  incremental: z.boolean(),
});

registerTool({
  name: "its.recalculate_assignment_plan",
  description:
    "Genera o ricalcola il piano di assegnazione intelligente per una data (PREPARA PIANO AUTOMATICO / RICALCOLA PIANO). Se changedServiceIds e' passato, il ricalcolo scrive solo gli item coinvolti (stessi autisti + servizi collegati), non l'intera giornata. Scrive assignment_plans/assignment_plan_items, non tocca assegnazioni reali gia' presenti (manual/locked restano invariate).",
  category: "WRITE",
  inputSchema,
  outputSchema,
  allowedRoles: ["admin", "operator", "supervisor"],
  async handler(context, input) {
    try {
      const result = await buildAndPersistAssignmentPlan(context.admin, {
        tenantId: context.tenantId,
        date: input.date,
        userId: context.userId,
        scope: input.changedServiceIds?.length ? { changedServiceIds: input.changedServiceIds } : undefined,
      });
      return {
        date: input.date,
        duration_ms: result.plan.duration_ms,
        services_count: result.plan.services_count,
        auto_safe_count: result.plan.auto_safe_count,
        review_count: result.plan.review_count,
        unresolved_count: result.plan.unresolved_count,
        locked_count: result.plan.locked_count,
        manual_count: result.plan.manual_count,
        incremental: Boolean(input.changedServiceIds?.length),
      };
    } catch (error) {
      throw toSafeMcpError(error);
    }
  },
  buildAuditSummary: (input, output) => ({ date: output.date, incremental: output.incremental, services_count: output.services_count }),
});
