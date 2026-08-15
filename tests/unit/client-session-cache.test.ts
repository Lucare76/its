import { describe, expect, it, vi } from "vitest";
import { createSessionCache } from "@/lib/supabase/client-session-cache";

function makeClock(startMs = 0) {
  let now = startMs;
  return {
    now: () => now,
    advance: (ms: number) => { now += ms; }
  };
}

describe("createSessionCache", () => {
  it("resolves for real on the first call", async () => {
    const resolve = vi.fn(async () => "value-1");
    const cache = createSessionCache({ resolve, ttlMs: 1000 });

    const result = await cache.get();

    expect(result).toBe("value-1");
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("serves the cached value on a second call within the TTL", async () => {
    const resolve = vi.fn(async () => "value-1");
    const clock = makeClock();
    const cache = createSessionCache({ resolve, ttlMs: 1000, now: clock.now });

    await cache.get();
    clock.advance(500);
    const second = await cache.get();

    expect(second).toBe("value-1");
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("shares a single in-flight resolution across concurrent callers", async () => {
    let resolveFn!: (value: string) => void;
    const resolve = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveFn = resolve;
        })
    );
    const cache = createSessionCache({ resolve, ttlMs: 1000 });

    const first = cache.get();
    const second = cache.get();
    const third = cache.get();
    resolveFn("value-1");

    const results = await Promise.all([first, second, third]);

    expect(results).toEqual(["value-1", "value-1", "value-1"]);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("resolves again once the TTL has expired", async () => {
    const resolve = vi.fn(async () => "value-1");
    const clock = makeClock();
    const cache = createSessionCache({ resolve, ttlMs: 1000, now: clock.now });

    await cache.get();
    clock.advance(1001);
    await cache.get();

    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("forceRefresh bypasses a still-valid cached value", async () => {
    const resolve = vi.fn(async () => "value-1");
    const clock = makeClock();
    const cache = createSessionCache({ resolve, ttlMs: 1000, now: clock.now });

    await cache.get();
    await cache.get({ forceRefresh: true });

    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("invalidate() on SIGNED_OUT-style events forces the next call to re-resolve", async () => {
    const resolve = vi.fn(async () => "value-1");
    const cache = createSessionCache({ resolve, ttlMs: 1000 });

    await cache.get();
    cache.invalidate();
    await cache.get();

    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("invalidate() covers SIGNED_IN-style identity changes the same way", async () => {
    const resolve = vi.fn(async () => "value-1");
    const cache = createSessionCache({ resolve, ttlMs: 1000 });

    await cache.get();
    cache.invalidate(); // stand-in for a SIGNED_IN auth event
    await cache.get();

    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("invalidate() covers USER_UPDATED-style identity changes the same way", async () => {
    const resolve = vi.fn(async () => "value-1");
    const cache = createSessionCache({ resolve, ttlMs: 1000 });

    await cache.get();
    cache.invalidate(); // stand-in for a USER_UPDATED auth event
    await cache.get();

    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("clears the in-flight slot on error without caching anything", async () => {
    const resolve = vi.fn(async () => {
      throw new Error("boom");
    });
    const cache = createSessionCache({ resolve, ttlMs: 1000 });

    await expect(cache.get()).rejects.toThrow("boom");
  });

  it("allows a fresh retry after a prior error", async () => {
    const resolve = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce("value-1");
    const cache = createSessionCache({ resolve, ttlMs: 1000 });

    await expect(cache.get()).rejects.toThrow("boom");
    const result = await cache.get();

    expect(result).toBe("value-1");
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("emits hit/miss/in-flight events for dev-only instrumentation", async () => {
    let resolveFn!: (value: string) => void;
    const resolve = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveFn = resolve;
        })
    );
    const events: string[] = [];
    const clock = makeClock();
    const cache = createSessionCache({
      resolve,
      ttlMs: 1000,
      now: clock.now,
      onEvent: (event) => events.push(event)
    });

    const pending = cache.get();
    const concurrent = cache.get();
    resolveFn("value-1");
    await Promise.all([pending, concurrent]);
    await cache.get();

    expect(events).toEqual(["miss", "in-flight", "hit"]);
  });
});
