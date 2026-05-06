import { parseRole } from "@/lib/rbac";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";
import { resolvePreferredMembership } from "@/lib/tenant-preference";
import type { UserRole } from "@/lib/types";

export type ClientSessionMode = "supabase" | "demo";

export interface ClientSessionContext {
  mode: ClientSessionMode;
  userId: string | null;
  tenantId: string | null;
  role: UserRole | null;
  accessToken: string | null;
}

const E2E_SESSION_STORAGE_KEY = "__it_e2e_session";
type StoredSupabaseSession = {
  access_token?: string;
  refresh_token?: string;
} | null;

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
      role,
      accessToken: null
    };
  } catch {
    return null;
  }
}

export function isClientDemoMode(): boolean {
  return false;
}

export function readStoredSupabaseSession(): { access_token: string; refresh_token: string } | null {
  if (typeof window === "undefined") return null;
  const key = Object.keys(window.localStorage).find((item) => /^sb-.*-auth-token$/i.test(item));
  if (!key) return null;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) ?? "null") as StoredSupabaseSession;
    if (!parsed?.access_token || !parsed?.refresh_token) return null;
    return { access_token: parsed.access_token, refresh_token: parsed.refresh_token };
  } catch {
    return null;
  }
}

export async function ensureSupabaseClientReady(maxAttempts = 20) {
  if (!hasSupabaseEnv || !supabase) return false;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const { data: sessionData } = await supabase.auth.getSession();
    if (sessionData.session?.access_token) return true;
    const storedSession = readStoredSupabaseSession();
    if (storedSession) {
      const restored = await supabase.auth.setSession(storedSession);
      if (!restored.error && restored.data.session?.access_token) return true;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 200));
  }
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
      role: null,
      accessToken: null
    };
  }

  await ensureSupabaseClientReady();

  const { data: userData, error: userError } = await supabase!.auth.getUser();
  if (userError || !userData.user) {
    return {
      mode: "supabase",
      userId: null,
      tenantId: null,
      role: null,
      accessToken: null
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
          role: resolvedRole,
          accessToken
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
  const valid = resolvePreferredMembership(membershipRows);

  return {
    mode: "supabase",
    userId: userData.user.id,
    tenantId: valid?.tenant_id ?? null,
    role: valid ? parseRole(valid.role) : null,
    accessToken
  };
}
