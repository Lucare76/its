import { z } from "zod";
import { registerTool } from "@/lib/mcp/registry";
import { isoDateSchema } from "@/lib/mcp/schemas/common";
import { toSafeMcpError } from "@/lib/mcp/errors";

const inputSchema = z.object({ date: isoDateSchema }).strict();

const exceptionSchema = z.object({
  service_id: z.string(),
  status: z.enum(["review", "unresolved"]),
  reason_summary: z.array(z.string()),
  alternatives: z.array(z.object({ driver_name: z.string(), score: z.number() })),
  has_suggested_fix: z.boolean(),
});

const outputSchema = z.object({
  date: z.string(),
  review_count: z.number(),
  unresolved_count: z.number(),
  exceptions: z.array(exceptionSchema),
});

registerTool({
  name: "its.get_assignment_exceptions",
  description:
    "Solo le eccezioni del piano di assegnazione intelligente (status review/unresolved): quello su cui Mario deve intervenire, esclusi gli auto_safe. Usalo per 'fammi vedere solo i servizi non risolti' / 'quali eccezioni ci sono oggi'.",
  category: "READ",
  inputSchema,
  outputSchema,
  allowedRoles: ["admin", "operator", "supervisor"],
  async handler(context, input) {
    try {
      const { data: plan, error: planError } = await context.admin
        .from("assignment_plans")
        .select("id")
        .eq("tenant_id", context.tenantId)
        .eq("plan_date", input.date)
        .maybeSingle();
      if (planError) throw planError;
      if (!plan) return { date: input.date, review_count: 0, unresolved_count: 0, exceptions: [] };

      const { data: items, error: itemsError } = await context.admin
        .from("assignment_plan_items")
        .select("service_id, status, reason, alternatives, suggested_fix")
        .eq("tenant_id", context.tenantId)
        .eq("plan_id", plan.id)
        .in("status", ["review", "unresolved"]);
      if (itemsError) throw itemsError;

      const rows = items ?? [];
      return {
        date: input.date,
        review_count: rows.filter((row) => row.status === "review").length,
        unresolved_count: rows.filter((row) => row.status === "unresolved").length,
        exceptions: rows.map((row) => ({
          service_id: row.service_id as string,
          status: row.status as "review" | "unresolved",
          reason_summary: ((row.reason as { summary?: string[] } | null)?.summary as string[]) ?? [],
          alternatives: ((row.alternatives as Array<{ driver_name: string; score: number }> | null) ?? []).map((alt) => ({
            driver_name: alt.driver_name,
            score: alt.score,
          })),
          has_suggested_fix: Boolean(row.suggested_fix),
        })),
      };
    } catch (error) {
      throw toSafeMcpError(error);
    }
  },
  buildAuditSummary: (input, output) => ({ date: output.date, review_count: output.review_count, unresolved_count: output.unresolved_count }),
});
