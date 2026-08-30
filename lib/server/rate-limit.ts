import { Ratelimit } from "@upstash/ratelimit";
import { getSharedRedis } from "@/lib/server/redis";

export interface RateLimitConfig {
  maxAttempts: number;
  windowMs: number;
}

export const RATE_LIMIT_DEFAULTS = {
  authEndpoints: { maxAttempts: 5, windowMs: 15 * 60 * 1000 },
  resetPassword: { maxAttempts: 3, windowMs: 60 * 60 * 1000 },
  register: { maxAttempts: 10, windowMs: 60 * 60 * 1000 },
  // Looser than per-email: a single IP can legitimately host several users
  // behind NAT/shared networks. This only needs to catch an attacker cycling
  // through many emails from one IP, not throttle normal shared-IP traffic.
  registerByIp: { maxAttempts: 30, windowMs: 60 * 60 * 1000 },
};

// ── In-memory fallback (dev / Upstash non configurato) ───────────────────────

interface MemEntry { count: number; resetAt: number; }
const memStore = new Map<string, MemEntry>();

function memKey(type: string, id: string) { return `${type}:${id}`; }

function memCheck(key: string, config: RateLimitConfig) {
  const now = Date.now();
  let e = memStore.get(key);
  if (!e || now >= e.resetAt) {
    e = { count: 0, resetAt: now + config.windowMs };
    memStore.set(key, e);
  }
  const remaining = Math.max(0, config.maxAttempts - e.count - 1);
  const allowed = e.count < config.maxAttempts;
  if (allowed) e.count++;
  return { allowed, remaining, resetAt: new Date(e.resetAt) };
}

// ── Upstash Redis ─────────────────────────────────────────────────────────────
// Client condiviso in lib/server/redis.ts (stesse env, stesso parsing) — nessun
// secondo client dedicato al rate limiter.

function msToWindow(ms: number): `${number} ${"ms" | "s" | "m" | "h" | "d"}` {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} m`;
  return `${Math.round(minutes / 60)} h`;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function checkRateLimit(
  type: string,
  identifier: string,
  config: RateLimitConfig,
): Promise<{ allowed: boolean; remaining: number; resetAt: Date }> {
  const redis = getSharedRedis();
  if (!redis) return memCheck(memKey(type, identifier), config);

  const limiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(config.maxAttempts, msToWindow(config.windowMs)),
    prefix: `its:rl:${type}`,
  });

  const { success, remaining, reset } = await limiter.limit(identifier);
  return { allowed: success, remaining, resetAt: new Date(reset) };
}

/** Usato nei test e per sbloccare un utente manualmente. Con Upstash il TTL scade naturalmente. */
export function resetRateLimit(type: string, identifier: string): void {
  memStore.delete(memKey(type, identifier));
}

/** Incrementa il contatore senza verificare (in-memory). Utile nei test. */
export function incrementRateLimit(type: string, identifier: string, config: RateLimitConfig): void {
  const key = memKey(type, identifier);
  const now = Date.now();
  let e = memStore.get(key);
  if (!e || now >= e.resetAt) {
    e = { count: 1, resetAt: now + config.windowMs };
  } else {
    e.count++;
  }
  memStore.set(key, e);
}

// Pulizia entries scadute ogni 5 minuti (solo in-memory)
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of memStore) {
    if (now >= entry.resetAt) memStore.delete(key);
  }
}, 5 * 60 * 1000);
