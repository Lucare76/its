import type { UserRole } from "@/lib/types";
import type { McpContext } from "@/lib/mcp/context";
import type { McpToolDefinition } from "@/lib/mcp/registry";
import { McpError } from "@/lib/mcp/errors";

export type McpToolCategory = "READ" | "WRITE" | "DESTRUCTIVE" | "EXTERNAL_ACTION";

/**
 * READ e' sempre abilitata per categoria (Sprint 1). WRITE/DESTRUCTIVE/
 * EXTERNAL_ACTION NON sono mai abilitate per categoria: ogni tool WRITE deve
 * comparire esplicitamente in ENABLED_WRITE_TOOLS qui sotto, dopo revisione
 * dedicata (preview/conferma/audit propri). Registrare un tool con
 * category:"WRITE" nel registry NON basta a renderlo eseguibile — questo
 * impedisce che un futuro tool WRITE aggiunto per errore (o non ancora
 * revisionato) diventi eseguibile solo perche' la categoria WRITE esiste.
 */
export const ENABLED_TOOL_CATEGORIES: readonly McpToolCategory[] = ["READ"];

/**
 * Allowlist esplicita, per nome, dei tool WRITE abilitati (Sprint 2:
 * its.assign_driver, con flusso preview -> confirmation token -> execute).
 * Aggiungere un tool WRITE qui e' una decisione deliberata, non un effetto
 * collaterale della registrazione.
 */
export const ENABLED_WRITE_TOOLS: readonly string[] = ["its.assign_driver"];

/**
 * Policy centralizzata: il singolo tool NON decide da solo se un ruolo puo'
 * eseguirlo. Verifica categoria/allowlist abilitata + ruolo consentito dal
 * tool stesso.
 */
export function canExecuteTool(context: McpContext, tool: McpToolDefinition): true {
  const categoryEnabled = ENABLED_TOOL_CATEGORIES.includes(tool.category);
  const writeExplicitlyEnabled = tool.category === "WRITE" && ENABLED_WRITE_TOOLS.includes(tool.name);
  if (!categoryEnabled && !writeExplicitlyEnabled) {
    throw new McpError("MCP_FORBIDDEN", `Tool '${tool.name}' (categoria '${tool.category}') non abilitato.`);
  }
  const allowedRoles: readonly UserRole[] = tool.allowedRoles;
  if (!allowedRoles.includes(context.role)) {
    throw new McpError("MCP_FORBIDDEN", `Ruolo '${context.role}' non autorizzato per il tool '${tool.name}'.`);
  }
  return true;
}
