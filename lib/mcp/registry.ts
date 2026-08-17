import type { ZodType } from "zod";
import type { UserRole } from "@/lib/types";
import type { McpContext } from "@/lib/mcp/context";
import type { McpToolCategory } from "@/lib/mcp/policy";

export type McpToolDefinition<TInput = unknown, TOutput = unknown> = {
  /** Namespaced e stabile, es. "its.search_services". */
  name: string;
  description: string;
  category: McpToolCategory;
  inputSchema: ZodType<TInput>;
  outputSchema: ZodType<TOutput>;
  allowedRoles: readonly UserRole[];
  handler: (context: McpContext, input: TInput) => Promise<TOutput>;
  /**
   * Opzionale: costruisce l'input_summary sanitizzato da scrivere in
   * mcp_audit_logs per una chiamata riuscita (mai PII, mai il token di
   * conferma). Se assente, l'audit non include un input_summary.
   */
  buildAuditSummary?: (input: TInput, output: TOutput) => Record<string, unknown>;
};

const registry = new Map<string, McpToolDefinition<any, any>>();

export function registerTool<TInput, TOutput>(tool: McpToolDefinition<TInput, TOutput>) {
  if (registry.has(tool.name)) {
    throw new Error(`MCP tool '${tool.name}' e' gia' registrato.`);
  }
  if (!tool.name.startsWith("its.")) {
    throw new Error(`MCP tool '${tool.name}' deve essere namespaced con 'its.'.`);
  }
  registry.set(tool.name, tool);
}

export function getTool(name: string): McpToolDefinition<any, any> | undefined {
  return registry.get(name);
}

export function listTools(): McpToolDefinition<any, any>[] {
  return Array.from(registry.values());
}

/** Solo per i test: azzera il registry tra un test suite e l'altro. */
export function __resetRegistryForTests() {
  registry.clear();
}
