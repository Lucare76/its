import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import "@/lib/mcp/tools/index";
import { listTools, getTool, type McpToolDefinition } from "@/lib/mcp/registry";
import { canExecuteTool } from "@/lib/mcp/policy";
import { mcpAuditLog } from "@/lib/mcp/audit";
import { toSafeMcpError, McpError } from "@/lib/mcp/errors";
import type { McpContext } from "@/lib/mcp/context";
import { checkRateLimit } from "@/lib/server/rate-limit";

const RATE_LIMIT = { maxAttempts: 60, windowMs: 60 * 1000 };

async function runTool(context: McpContext, tool: McpToolDefinition, rawInput: unknown) {
  const startedAt = Date.now();
  try {
    canExecuteTool(context, tool);

    const rateLimitResult = await checkRateLimit(`mcp:${tool.name}`, context.tenantId, RATE_LIMIT);
    if (!rateLimitResult.allowed) {
      throw new McpError("MCP_RATE_LIMITED", "Troppe richieste, riprova tra poco.");
    }

    const parsedInput = tool.inputSchema.safeParse(rawInput ?? {});
    if (!parsedInput.success) {
      throw new McpError("MCP_INVALID_INPUT", "Parametri non validi per il tool.");
    }

    const output = await tool.handler(context, parsedInput.data);
    tool.outputSchema.parse(output);

    mcpAuditLog({
      requestId: context.requestId,
      tenantId: context.tenantId,
      userId: context.userId,
      role: context.role,
      toolName: tool.name,
      category: tool.category,
      success: true,
      durationMs: Date.now() - startedAt,
      inputSummary: tool.buildAuditSummary?.(parsedInput.data, output),
    });

    return { content: [{ type: "text" as const, text: JSON.stringify(output) }] };
  } catch (error) {
    const safeError = toSafeMcpError(error);
    mcpAuditLog({
      requestId: context.requestId,
      tenantId: context.tenantId,
      userId: context.userId,
      role: context.role,
      toolName: tool.name,
      category: tool.category,
      success: false,
      durationMs: Date.now() - startedAt,
      errorCode: safeError.code,
    });
    return {
      isError: true,
      content: [{ type: "text" as const, text: JSON.stringify({ code: safeError.code, message: safeError.message }) }],
    };
  }
}

/**
 * Costruisce un McpServer SDK legato a un unico McpContext gia' risolto
 * (identita' + tenant risolti server-side prima della connessione). Ogni tool
 * registrato passa per policy centralizzata, rate limit e audit prima/dopo
 * l'esecuzione dell'handler di dominio.
 */
export function createMcpServer(context: McpContext): McpServer {
  const server = new McpServer({ name: "its-mcp", version: "1.0.0" });

  for (const tool of listTools()) {
    // inputSchema viene comunque dichiarato qui SOLO per farlo comparire in
    // list_tools (discoverability per i client MCP): questo handler non
    // verra' mai invocato a runtime, perche' sotto sovrascriviamo del tutto
    // il dispatch di tools/call con la nostra pipeline (vedi commento sotto).
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputSchema as any }, async () => {
      throw new Error("unreachable: tools/call e' gestito da runTool via l'handler custom sotto");
    });
  }

  // L'SDK, quando registri un tool CON inputSchema, valida gli argomenti PRIMA
  // di invocare la callback: se la validazione fallisce lancia un errore
  // JSON-RPC -32602 generico (non il nostro McpError/MCP_INVALID_INPUT) e
  // salta completamente l'audit log. Bug reale dimostrato dal live smoke
  // test Sprint 1. Fix: sovrascriviamo il dispatch di tools/call con la
  // nostra pipeline unica (policy -> rate limit -> validazione -> handler ->
  // audit), che gestisce sia l'input valido sia quello invalido in modo
  // uniforme e verificabile.
  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = getTool(request.params.name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: JSON.stringify({ code: "MCP_NOT_FOUND", message: "Tool non trovato." }) }],
      };
    }
    return runTool(context, tool, request.params.arguments);
  });

  return server;
}
