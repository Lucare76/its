/**
 * Bootstrap locale del server MCP ITS. Uso:
 *
 *   ITS_MCP_ACCESS_TOKEN=<supabase-access-token> pnpm exec tsx scripts/mcp-server.ts
 *
 * Il token e' un access token Supabase di un utente reale (login gia' avvenuto
 * nell'app). Identita', tenant e ruolo sono risolti server-side da questo token
 * PRIMA di avviare il transport: nessun client MCP puo' iniettare un tenantId.
 *
 * Transport: stdio. Pensato per client MCP locali/controllati (es. Claude
 * Desktop, Claude Code) collegati al processo, NON per esposizione pubblica.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveMcpContext } from "@/lib/mcp/context";
import { createMcpServer } from "@/lib/mcp/server";

async function main() {
  const accessToken = process.env.ITS_MCP_ACCESS_TOKEN;
  const preferredTenantId = process.env.ITS_MCP_TENANT_ID ?? null;

  if (!accessToken) {
    console.error("ITS_MCP_ACCESS_TOKEN mancante. Imposta un access token Supabase valido.");
    process.exit(1);
  }

  const context = await resolveMcpContext({ accessToken, preferredTenantId });
  console.error(
    `[mcp-its] contesto risolto: tenant=${context.tenantId} role=${context.role} user=${context.userEmail ?? context.userId}`
  );

  const server = createMcpServer(context);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mcp-its] server pronto su stdio.");
}

main().catch((error) => {
  console.error("[mcp-its] avvio fallito:", error instanceof Error ? error.message : error);
  process.exit(1);
});
