import { parseRole } from "@/lib/rbac";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";
import type { UserRole } from "@/lib/types";

export type ClientSessionMode = "supabase" | "demo";

export interface ClientSessionContext {
  mode: ClientSessionMode;
  userId: string | null;
  tenantId: string | null;
  role: UserRole | null;
}

const E2E_SESSION_STORAGE_KEY = "__it_e2e_session";

function isLocalE2ETestMode() {
  if (typeof window === "undefined") return false;
  return ["localhost", "127.0.0.1"].includes(window.location.hostname);
}

export function getE2ETestSessionOverride(): ClientSessionContext | null {
  if (!isLocalE2ETestMode()) return null;
  try {
    const raw = window.localStorage.getItem(E2E_SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { userId?: string | null; tenantId?: string | null; role?: string | null };
    const role = parseRole(parsed.role ?? undefined);
    if (!parsed.userId || !parsed.tenantId || !role) return null;
    return {
      mode: "supabase",
      userId: parsed.userId,
      tenantId: parsed.tenantId,
      role
    };
  } catch {
    return null;
  }
}

export function isClientDemoMode(): boolean {
  return false;
}

export async function getClientSessionContext(): Promise<ClientSessionContext> {
  const e2eOverride = getE2ETestSessionOverride();
  if (e2eOverride) return e2eOverride;

  if (!hasSupabaseEnv || !supabase) {
    return {
      mode: "supabase",
      userId: null,
      tenantId: null,
      role: null
    };
  }

  const { data: userData, error: userError } = await supabase!.auth.getUser();
  if (userError || !userData.user) {
    return {
      mode: "supabase",
      userId: null,
      tenantId: null,
      role: null
    };
  }

  const { data: sessionData } = await supabase!.auth.getSession();
  const accessToken = sessionData.session?.access_token ?? null;

  if (accessToken) {
    try {
      const response = await fetch("/api/onboarding/tenant", {
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      });
      const body = (await response.json().catch(() => null)) as
        | { hasTenant?: boolean; tenant?: { id?: string | null } | null; role?: string | null }
        | null;
      const resolvedRole = parseRole(body?.role ?? undefined);
      const resolvedTenantId = body?.hasTenant ? body?.tenant?.id ?? null : null;
      if (resolvedRole && resolvedTenantId) {
        return {
          mode: "supabase",
          userId: userData.user.id,
          tenantId: resolvedTenantId,
          role: resolvedRole
        };
      }
    } catch {
      // Fall back to the direct membership lookup below if the route is temporarily unavailable.
    }
  }

  const { data: memberships } = await supabase!
    .from("memberships")
    .select("tenant_id, role")
    .eq("user_id", userData.user.id)
    .limit(50);

  const membershipRows = (memberships ?? []) as Array<{ tenant_id: string; role: string }>;
  const valid = membershipRows.find((item) => parseRole(item.role) !== null) ?? null;

  return {
    mode: "supabase",
    userId: userData.user.id,
    tenantId: valid?.tenant_id ?? null,
    role: valid ? parseRole(valid.role) : null
  };
}
