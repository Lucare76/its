import type { UserRole } from "@/lib/types";
import type { McpContext } from "@/lib/mcp/context";
import type { McpToolDefinition } from "@/lib/mcp/registry";
import { McpError } from "@/lib/mcp/errors";

export type McpToolCategory = "READ" | "WRITE" | "DESTRUCTIVE" | "EXTERNAL_ACTION";

/**
 * Sprint 1 implementa SOLO tool READ. Le altre categorie sono modellate qui
 * per Sprint futuri (write con conferma, azioni distruttive con doppia
 * conferma, azioni esterne come invio email/WhatsApp) ma nessun tool di
 * queste categorie e' registrato in questo sprint.
 */
export const ENABLED_TOOL_CATEGORIES: readonly McpToolCategory[] = ["READ"];

/**
 * Policy centralizzata: il singolo tool NON decide da solo se un ruolo puo'
 * eseguirlo. Verifica categoria abilitata + ruolo consentito dal tool stesso.
 */
export function canExecuteTool(context: McpContext, tool: McpToolDefinition): true {
  if (!ENABLED_TOOL_CATEGORIES.includes(tool.category)) {
    throw new McpError("MCP_FORBIDDEN", `Categoria tool '${tool.category}' non abilitata in questo sprint.`);
  }
  const allowedRoles: readonly UserRole[] = tool.allowedRoles;
  if (!allowedRoles.includes(context.role)) {
    throw new McpError("MCP_FORBIDDEN", `Ruolo '${context.role}' non autorizzato per il tool '${tool.name}'.`);
  }
  return true;
}
