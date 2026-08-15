// Framework-free TTL cache + in-flight dedupe for a single async resolver.
// Extracted as a pure module (same pattern as tenant-data-lifecycle.ts's
// createDedupedAsync) so the tricky timing/concurrency behavior can be unit
// tested without touching Supabase or the DOM. Used by client-session.ts to
// cache getClientSessionContext() resolutions. Sprint Performance 12.

export type SessionCacheEvent = "hit" | "miss" | "in-flight";

export type SessionCacheDeps<T> = {
  /** Performs the real (expensive) resolution. */
  resolve: () => Promise<T>;
  /** Injectable clock, defaults to Date.now — pass a fake in tests. */
  now?: () => number;
  /** How long a resolved value stays valid. */
  ttlMs: number;
  /** Optional dev-only instrumentation hook (cache hit/miss/in-flight). */
  onEvent?: (event: SessionCacheEvent) => void;
};

export type SessionCacheGetOptions = {
  /** Bypasses the cached value (still dedupes against an in-flight resolve). */
  forceRefresh?: boolean;
};

export interface SessionCache<T> {
  get: (options?: SessionCacheGetOptions) => Promise<T>;
  /** Drops the cached value. The next get() call triggers a real resolution. */
  invalidate: () => void;
}

/**
 * Creates a TTL cache around `resolve`. Concurrent get() calls while a
 * resolution is in flight share the same promise instead of firing parallel
 * duplicate work. A rejected resolution clears the in-flight slot without
 * caching anything, so the next call retries for real.
 */
export function createSessionCache<T>(deps: SessionCacheDeps<T>): SessionCache<T> {
  const { resolve, ttlMs, onEvent } = deps;
  const now = deps.now ?? (() => Date.now());

  let cached: { value: T; expiresAt: number } | null = null;
  let inFlight: Promise<T> | null = null;

  const invalidate = () => {
    cached = null;
  };

  const get = (options?: SessionCacheGetOptions): Promise<T> => {
    const forceRefresh = options?.forceRefresh === true;

    if (!forceRefresh && cached && now() < cached.expiresAt) {
      onEvent?.("hit");
      return Promise.resolve(cached.value);
    }

    if (inFlight) {
      onEvent?.("in-flight");
      return inFlight;
    }

    onEvent?.("miss");
    const run = resolve()
      .then((value) => {
        cached = { value, expiresAt: now() + ttlMs };
        return value;
      })
      .finally(() => {
        inFlight = null;
      });
    inFlight = run;
    return run;
  };

  return { get, invalidate };
}
