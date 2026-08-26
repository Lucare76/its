import { z } from "zod";
import { registerTool } from "@/lib/mcp/registry";
import { isoDateSchema } from "@/lib/mcp/schemas/common";
import { toSafeMcpError } from "@/lib/mcp/errors";

const inputSchema = z.object({ date: isoDateSchema }).strict();

const planItemSchema = z.object({
  service_id: z.string(),
  status: z.enum(["auto_safe", "review", "unresolved", "locked", "manual"]),
  proposed_driver_name: z.string().nullable(),
  proposed_vehicle_label: z.string().nullable(),
  score: z.number().nullable(),
  confidence: z.number().nullable(),
});

const outputSchema = z.object({
  date: z.string(),
  plan: z
    .object({
      id: z.string(),
      generated_at: z.string(),
      duration_ms: z.number().nullable(),
      services_count: z.number(),
      auto_safe_count: z.number(),
      review_count: z.number(),
      unresolved_count: z.number(),
      locked_count: z.number(),
      manual_count: z.number(),
      drivers_count: z.number(),
      vehicles_count: z.number(),
    })
    .nullable(),
  items: z.array(planItemSchema),
});

registerTool({
  name: "its.get_assignment_plan",
  description:
    "Piano di assegnazione intelligente gia' generato per una data: contatori (auto_safe/review/unresolved/locked/manual) e stato per servizio. Se non esiste ancora un piano per la data, plan=null e items=[] — usa its.recalculate_assignment_plan per generarlo. Usalo per 'preparami le assegnazioni di [data]' / 'com'e' il piano di oggi'.",
  category: "READ",
  inputSchema,
  outputSchema,
  allowedRoles: ["admin", "operator", "supervisor"],
  async handler(context, input) {
    try {
      const { data: plan, error: planError } = await context.admin
        .from("assignment_plans")
        .select("id, generated_at, duration_ms, services_count, auto_safe_count, review_count, unresolved_count, locked_count, manual_count, drivers_count, vehicles_count")
        .eq("tenant_id", context.tenantId)
        .eq("plan_date", input.date)
        .maybeSingle();
      if (planError) throw planError;
      if (!plan) return { date: input.date, plan: null, items: [] };

      const { data: items, error: itemsError } = await context.admin
        .from("assignment_plan_items")
        .select("service_id, status, proposed_driver_name, proposed_vehicle_label, score, confidence")
        .eq("tenant_id", context.tenantId)
        .eq("plan_id", plan.id);
      if (itemsError) throw itemsError;

      return {
        date: input.date,
        plan: {
          id: plan.id as string,
          generated_at: plan.generated_at as string,
          duration_ms: (plan.duration_ms as number | null) ?? null,
          services_count: plan.services_count as number,
          auto_safe_count: plan.auto_safe_count as number,
          review_count: plan.review_count as number,
          unresolved_count: plan.unresolved_count as number,
          locked_count: plan.locked_count as number,
          manual_count: plan.manual_count as number,
          drivers_count: plan.drivers_count as number,
          vehicles_count: plan.vehicles_count as number,
        },
        items: (items ?? []).map((row) => ({
          service_id: row.service_id as string,
          status: row.status as "auto_safe" | "review" | "unresolved" | "locked" | "manual",
          proposed_driver_name: (row.proposed_driver_name as string | null) ?? null,
          proposed_vehicle_label: (row.proposed_vehicle_label as string | null) ?? null,
          score: (row.score as number | null) ?? null,
          confidence: (row.confidence as number | null) ?? null,
        })),
      };
    } catch (error) {
      throw toSafeMcpError(error);
    }
  },
  buildAuditSummary: (input, output) => ({ date: output.date, services_count: output.plan?.services_count ?? 0 }),
});
