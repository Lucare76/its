import { randomUUID } from "crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { resolvePreferredMembership } from "@/lib/tenant-preference";
import { parseRole } from "@/lib/rbac";
import type { UserRole } from "@/lib/types";
import { McpError } from "@/lib/mcp/errors";

export type McpContext = {
  requestId: string;
  userId: string;
  userEmail: string | null;
  tenantId: string;
  role: UserRole;
  admin: SupabaseClient;
};

type MembershipRow = {
  tenant_id: string;
  role: string;
  suspended?: boolean | null;
};

/**
 * Risolve l'identita' e il tenant SEMPRE lato server, a partire da un Supabase
 * user access token. Il tenantId non arriva mai come parametro affidabile dal
 * client/modello: viene derivato dalla membership dell'utente autenticato,
 * riusando lo stesso pattern di lib/server/pricing-auth.ts.
 */
export async function resolveMcpContext(params: {
  accessToken: string | null | undefined;
  preferredTenantId?: string | null;
}): Promise<McpContext> {
  const { accessToken, preferredTenantId } = params;
  if (!accessToken) {
    throw new McpError("MCP_UNAUTHORIZED", "Token di accesso mancante.");
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/^["']|["']$/g, "");
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim().replace(/^["']|["']$/g, "");
  if (!supabaseUrl || !serviceRoleKey) {
    throw new McpError("MCP_INTERNAL_ERROR", "Configurazione server mancante.");
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const {
    data: { user },
    error: userError,
  } = await admin.auth.getUser(accessToken);
  if (userError || !user) {
    throw new McpError("MCP_UNAUTHORIZED", "Sessione non valida.");
  }

  const { data: memberships, error: membershipError } = await admin
    .from("memberships")
    .select("tenant_id, role, suspended")
    .eq("user_id", user.id);
  if (membershipError) {
    throw new McpError("MCP_INTERNAL_ERROR", "Impossibile risolvere la membership.");
  }

  const membershipRows = (memberships ?? []) as MembershipRow[];
  const membership = resolvePreferredMembership(membershipRows, preferredTenantId ?? null);
  if (!membership?.tenant_id) {
    throw new McpError("MCP_FORBIDDEN", "Nessuna membership trovata per questo utente.");
  }
  if (membership.suspended === true) {
    throw new McpError("MCP_FORBIDDEN", "Accesso sospeso per questo tenant.");
  }

  const role = parseRole(membership.role);
  if (!role) {
    throw new McpError("MCP_FORBIDDEN", "Ruolo non riconosciuto.");
  }

  return {
    requestId: randomUUID(),
    userId: user.id,
    userEmail: user.email ?? null,
    tenantId: membership.tenant_id,
    role,
    admin,
  };
}
