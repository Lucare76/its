import { z } from "zod";
import { registerTool } from "@/lib/mcp/registry";
import { uuidSchema } from "@/lib/mcp/schemas/common";
import { auditLog } from "@/lib/server/ops-audit";
import { McpError, toSafeMcpError } from "@/lib/mcp/errors";

const inputSchema = z.object({ serviceId: uuidSchema, locked: z.boolean() }).strict();

const outputSchema = z.object({ serviceId: z.string(), locked: z.boolean(), status: z.string() });

registerTool({
  name: "its.lock_assignment",
  description:
    "Blocca (o sblocca) l'item del piano di assegnazione intelligente per un servizio: un item locked non viene mai sovrascritto da un ricalcolo automatico, fino a sblocco esplicito.",
  category: "WRITE",
  inputSchema,
  outputSchema,
  allowedRoles: ["admin", "operator", "supervisor"],
  async handler(context, input) {
    try {
      const { data: item, error: itemError } = await context.admin
        .from("assignment_plan_items")
        .select("id, status")
        .eq("tenant_id", context.tenantId)
        .eq("service_id", input.serviceId)
        .maybeSingle();
      if (itemError) throw itemError;
      if (!item) throw new McpError("MCP_NOT_FOUND", "Nessun item di piano trovato per questo servizio.");

      const nextStatus = input.locked ? "locked" : item.status === "locked" ? "review" : (item.status as string);
      const { error: updateError } = await context.admin
        .from("assignment_plan_items")
        .update({ locked: input.locked, status: nextStatus, updated_at: new Date().toISOString() })
        .eq("id", item.id)
        .eq("tenant_id", context.tenantId);
      if (updateError) throw updateError;

      auditLog({
        event: "assignment_locked",
        level: "info",
        tenantId: context.tenantId,
        userId: context.userId,
        serviceId: input.serviceId,
        details: { item_id: item.id, locked: input.locked, source: "mcp" },
      });

      return { serviceId: input.serviceId, locked: input.locked, status: nextStatus };
    } catch (error) {
      throw toSafeMcpError(error);
    }
  },
  buildAuditSummary: (_input, output) => ({ service_id: output.serviceId, locked: output.locked }),
});
