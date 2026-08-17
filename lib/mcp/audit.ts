import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { McpToolCategory } from "@/lib/mcp/policy";
import type { McpErrorCode } from "@/lib/mcp/errors";

export type McpAuditEntry = {
  requestId: string;
  tenantId: string;
  userId: string;
  role: string;
  toolName: string;
  category: McpToolCategory;
  success: boolean;
  durationMs: number;
  errorCode?: McpErrorCode;
  /** Riassunto sanitizzato dell'input (mai il payload completo, mai PII). */
  inputSummary?: Record<string, unknown>;
};

let auditAdminClient: SupabaseClient | null = null;

function getAuditAdminClient(): SupabaseClient | null {
  if (auditAdminClient) return auditAdminClient;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/^["']|["']$/g, "");
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim().replace(/^["']|["']$/g, "");
  if (!supabaseUrl || !serviceRoleKey) return null;
  auditAdminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return auditAdminClient;
}

async function persistAuditEntry(entry: McpAuditEntry, timestamp: string) {
  const admin = getAuditAdminClient();
  if (!admin) return;
  try {
    await admin.from("mcp_audit_logs").insert({
      request_id: entry.requestId,
      created_at: timestamp,
      tenant_id: entry.tenantId,
      user_id: entry.userId,
      role: entry.role,
      tool_name: entry.toolName,
      category: entry.category,
      success: entry.success,
      duration_ms: entry.durationMs,
      error_code: entry.errorCode ?? null,
      input_summary: entry.inputSummary ?? null,
    });
  } catch {
    // Audit fire-and-forget: non deve mai interrompere l'esecuzione del tool.
  }
}

export function mcpAuditLog(entry: McpAuditEntry) {
  const timestamp = new Date().toISOString();
  const line = {
    ts: timestamp,
    scope: "mcp",
    request_id: entry.requestId,
    tenant_id: entry.tenantId,
    user_id: entry.userId,
    role: entry.role,
    tool_name: entry.toolName,
    category: entry.category,
    success: entry.success,
    duration_ms: entry.durationMs,
    error_code: entry.errorCode ?? null,
    input_summary: entry.inputSummary ?? null,
  };

  void persistAuditEntry(entry, timestamp);

  if (!entry.success) {
    console.error(JSON.stringify(line));
    return;
  }
  console.info(JSON.stringify(line));
}
