import { parseRole } from "@/lib/rbac";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";
import { createSessionCache, type SessionCacheGetOptions } from "@/lib/supabase/client-session-cache";
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
  for (const storage of [window.sessionStorage, window.localStorage]) {
    const key = Object.keys(storage).find((item) => /^sb-.*-auth-token$/i.test(item));
    if (!key) continue;
    try {
      const parsed = JSON.parse(storage.getItem(key) ?? "null") as StoredSupabaseSession;
      if (parsed?.access_token && parsed.refresh_token) {
        return { access_token: parsed.access_token, refresh_token: parsed.refresh_token };
      }
    } catch {
      // Ignore malformed storage and continue with the other persistence scope.
    }
  }
  return null;
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

// Sprint Performance 12: getClientSessionContext() is called on every
// authenticated page mount (directly or via useTenantOperationalData), each
// time re-running getUser() + getSession() + a fetch to
// /api/onboarding/tenant. Navigating Dashboard -> Arrivals -> Departures ->
// Planning used to repeat that full chain 4x even though the user, tenant
// and role never changed. A 45s TTL cache (comfortably inside a normal
// browsing burst, short enough that a role/tenant change server-side is
// picked up quickly) plus in-flight dedupe collapses concurrent/rapid calls
// into a single real resolution. This is a CLIENT-ONLY optimization: every
// protected API route still runs its own authorizePricingRequest /
// authorizeServiceRoleRequest server-side check regardless of what this
// cache returns.
const SESSION_CACHE_TTL_MS = 45_000;

const sessionCache = createSessionCache<ClientSessionContext>({
  resolve: resolveClientSessionContext,
  ttlMs: SESSION_CACHE_TTL_MS,
  onEvent:
    process.env.NODE_ENV !== "production"
      ? (event) => console.debug(`[client-session] cache ${event}`)
      : undefined
});

// Conservative invalidation: any event that can change who the user is (or
// whether they're signed in at all) drops the cache so the next call
// re-resolves for real instead of serving a stale identity. TOKEN_REFRESHED
// is included because the cached accessToken would otherwise outlive the
// Supabase-managed token it was read from.
if (typeof window !== "undefined" && hasSupabaseEnv && supabase) {
  supabase.auth.onAuthStateChange((event) => {
    if (
      event === "SIGNED_OUT" ||
      event === "SIGNED_IN" ||
      event === "USER_UPDATED" ||
      event === "TOKEN_REFRESHED"
    ) {
      sessionCache.invalidate();
    }
  });
}

export function invalidateClientSessionCache(): void {
  sessionCache.invalidate();
}

export function getClientSessionContext(options?: SessionCacheGetOptions): Promise<ClientSessionContext> {
  const e2eOverride = getE2ETestSessionOverride();
  if (e2eOverride) return Promise.resolve(e2eOverride);
  return sessionCache.get(options);
}

async function resolveClientSessionContext(): Promise<ClientSessionContext> {
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
