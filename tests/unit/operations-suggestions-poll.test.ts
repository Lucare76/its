import { describe, expect, it, vi } from "vitest";
import { startSuggestionsPolling } from "@/lib/operations-suggestions-poll";

/**
 * Sprint Performance 14F — FASE 10/14. Pure lifecycle tests, no jsdom: all
 * dependencies (visibility, timers, refresh) are injected fakes.
 */

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createHarness(initialVisibility: "visible" | "hidden" = "visible") {
  let visibility = initialVisibility;
  const listeners = new Set<() => void>();
  const intervals: Array<{ fn: () => void; ms: number }> = [];
  const cleared = new Set<unknown>();

  return {
    getVisibilityState: () => visibility,
    setVisibility: (next: "visible" | "hidden") => {
      visibility = next;
    },
    addVisibilityListener: (handler: () => void) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    fireVisibilityChange: () => {
      for (const listener of listeners) listener();
    },
    setIntervalFn: (fn: () => void, ms: number) => {
      const handle = { fn, ms };
      intervals.push(handle);
      return handle;
    },
    clearIntervalFn: (handle: unknown) => {
      cleared.add(handle);
    },
    fireInterval: () => {
      for (const handle of intervals) {
        if (!cleared.has(handle)) handle.fn();
      }
    },
    listenerCount: () => listeners.size
  };
}

describe("startSuggestionsPolling", () => {
  it("1. visible tab: initial call fetches immediately", () => {
    const harness = createHarness("visible");
    const refresh = vi.fn().mockResolvedValue(undefined);
    startSuggestionsPolling({
      refresh,
      getVisibilityState: harness.getVisibilityState,
      addVisibilityListener: harness.addVisibilityListener,
      setIntervalFn: harness.setIntervalFn,
      clearIntervalFn: harness.clearIntervalFn,
      intervalMs: 30_000
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("2. hidden tab: interval tick does not call refresh", () => {
    const harness = createHarness("hidden");
    const refresh = vi.fn().mockResolvedValue(undefined);
    startSuggestionsPolling({
      refresh,
      getVisibilityState: harness.getVisibilityState,
      addVisibilityListener: harness.addVisibilityListener,
      setIntervalFn: harness.setIntervalFn,
      clearIntervalFn: harness.clearIntervalFn,
      intervalMs: 30_000
    });
    expect(refresh).not.toHaveBeenCalled(); // initial tick also skipped while hidden
    harness.fireInterval();
    harness.fireInterval();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("3. in-flight request: a tick while refresh() is still pending is ignored", async () => {
    const harness = createHarness("visible");
    const deferred = createDeferred<void>();
    const refresh = vi.fn().mockReturnValue(deferred.promise);
    startSuggestionsPolling({
      refresh,
      getVisibilityState: harness.getVisibilityState,
      addVisibilityListener: harness.addVisibilityListener,
      setIntervalFn: harness.setIntervalFn,
      clearIntervalFn: harness.clearIntervalFn,
      intervalMs: 30_000
    });
    expect(refresh).toHaveBeenCalledTimes(1); // initial tick, still pending

    harness.fireInterval();
    harness.fireInterval();
    expect(refresh).toHaveBeenCalledTimes(1); // both ticks skipped — still in flight

    deferred.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  it("4. completed request: the next tick is allowed again", async () => {
    const harness = createHarness("visible");
    const refresh = vi.fn().mockResolvedValue(undefined);
    startSuggestionsPolling({
      refresh,
      getVisibilityState: harness.getVisibilityState,
      addVisibilityListener: harness.addVisibilityListener,
      setIntervalFn: harness.setIntervalFn,
      clearIntervalFn: harness.clearIntervalFn,
      intervalMs: 30_000
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await Promise.resolve();

    harness.fireInterval();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("5. hidden -> visible transition triggers an immediate refresh", () => {
    const harness = createHarness("hidden");
    const refresh = vi.fn().mockResolvedValue(undefined);
    startSuggestionsPolling({
      refresh,
      getVisibilityState: harness.getVisibilityState,
      addVisibilityListener: harness.addVisibilityListener,
      setIntervalFn: harness.setIntervalFn,
      clearIntervalFn: harness.clearIntervalFn,
      intervalMs: 30_000
    });
    expect(refresh).not.toHaveBeenCalled();

    harness.setVisibility("visible");
    harness.fireVisibilityChange();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("6. a rejected refresh() still releases the in-flight guard (next tick allowed)", async () => {
    const harness = createHarness("visible");
    const refresh = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(undefined);
    startSuggestionsPolling({
      refresh,
      getVisibilityState: harness.getVisibilityState,
      addVisibilityListener: harness.addVisibilityListener,
      setIntervalFn: harness.setIntervalFn,
      clearIntervalFn: harness.clearIntervalFn,
      intervalMs: 30_000
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await Promise.resolve();

    harness.fireInterval();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("hidden tab for many consecutive ticks (simulated 10 minutes) never polls", () => {
    const harness = createHarness("hidden");
    const refresh = vi.fn().mockResolvedValue(undefined);
    startSuggestionsPolling({
      refresh,
      getVisibilityState: harness.getVisibilityState,
      addVisibilityListener: harness.addVisibilityListener,
      setIntervalFn: harness.setIntervalFn,
      clearIntervalFn: harness.clearIntervalFn,
      intervalMs: 30_000
    });
    // 10 minutes / 30s = 20 ticks
    for (let i = 0; i < 20; i++) harness.fireInterval();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("stop() removes the visibility listener and further interval ticks are inert", () => {
    const harness = createHarness("visible");
    const refresh = vi.fn().mockResolvedValue(undefined);
    const stop = startSuggestionsPolling({
      refresh,
      getVisibilityState: harness.getVisibilityState,
      addVisibilityListener: harness.addVisibilityListener,
      setIntervalFn: harness.setIntervalFn,
      clearIntervalFn: harness.clearIntervalFn,
      intervalMs: 30_000
    });
    expect(harness.listenerCount()).toBe(1);
    stop();
    expect(harness.listenerCount()).toBe(0);
    refresh.mockClear();
    harness.fireInterval();
    expect(refresh).not.toHaveBeenCalled();
  });
});
