import { describe, expect, it, vi } from "vitest";
import { createDedupedAsync, startTenantDataLifecycle } from "@/lib/supabase/tenant-data-lifecycle";

type FakeChannel = {
  onEvent: () => void;
  onStatus: (status: string) => void;
  unsubscribe: ReturnType<typeof vi.fn>;
};

function makeHarness(refreshImpl?: () => Promise<boolean>) {
  let visibilityState = "visible";
  const visibilityListeners = new Set<() => void>();
  const timeouts = new Map<number, () => void>();
  const intervals = new Map<number, () => void>();
  let nextHandle = 1;

  const refresh = vi.fn(refreshImpl ?? (async () => true));

  let channel: FakeChannel | null = null;
  const subscribeRealtime = vi.fn((onEvent: () => void, onStatus: (status: string) => void) => {
    channel = { onEvent, onStatus, unsubscribe: vi.fn() };
    return () => channel?.unsubscribe();
  });

  const onLiveConnectedChange = vi.fn();

  const stop = startTenantDataLifecycle({
    refresh,
    subscribeRealtime,
    getVisibilityState: () => visibilityState,
    addVisibilityListener: (handler) => {
      visibilityListeners.add(handler);
      return () => visibilityListeners.delete(handler);
    },
    setTimeoutFn: (fn, _ms) => {
      const handle = nextHandle++;
      timeouts.set(handle, fn);
      return handle;
    },
    clearTimeoutFn: (handle) => {
      timeouts.delete(handle as number);
    },
    setIntervalFn: (fn, _ms) => {
      const handle = nextHandle++;
      intervals.set(handle, fn);
      return handle;
    },
    clearIntervalFn: (handle) => {
      intervals.delete(handle as number);
    },
    onLiveConnectedChange
  });

  return {
    stop,
    refresh,
    subscribeRealtime,
    onLiveConnectedChange,
    setVisibility: (state: string) => {
      visibilityState = state;
    },
    fireVisibilityChange: () => {
      for (const listener of visibilityListeners) listener();
    },
    fireStatus: (status: string) => channel?.onStatus(status),
    fireDbEvent: () => channel?.onEvent(),
    fireAllTimeouts: () => {
      for (const fn of Array.from(timeouts.values())) fn();
    },
    fireAllIntervals: () => {
      for (const fn of Array.from(intervals.values())) fn();
    },
    intervalCount: () => intervals.size,
    timeoutCount: () => timeouts.size,
    getChannel: () => channel
  };
}

describe("startTenantDataLifecycle — mount / FASE 7", () => {
  it("does not call refresh on setup — subscribing to realtime adds zero extra fetches", () => {
    const h = makeHarness();
    expect(h.refresh).not.toHaveBeenCalled();
    expect(h.subscribeRealtime).toHaveBeenCalledTimes(1);
    h.stop();
  });
});

describe("startTenantDataLifecycle — realtime status / FASE 8", () => {
  it("SUBSCRIBED: no fallback polling starts, and realtime events still trigger a debounced refresh", () => {
    const h = makeHarness();
    h.fireStatus("SUBSCRIBED");
    expect(h.onLiveConnectedChange).toHaveBeenCalledWith(true);
    expect(h.intervalCount()).toBe(0);

    h.fireDbEvent();
    expect(h.refresh).not.toHaveBeenCalled();
    h.fireAllTimeouts();
    expect(h.refresh).toHaveBeenCalledTimes(1);
    h.stop();
  });

  it("CHANNEL_ERROR: fallback polling starts", () => {
    const h = makeHarness();
    h.fireStatus("CHANNEL_ERROR");
    expect(h.onLiveConnectedChange).toHaveBeenCalledWith(false);
    expect(h.intervalCount()).toBe(1);
    h.stop();
  });

  it("TIMED_OUT and CLOSED also start fallback polling", () => {
    for (const status of ["TIMED_OUT", "CLOSED"]) {
      const h = makeHarness();
      h.fireStatus(status);
      expect(h.intervalCount()).toBe(1);
      h.stop();
    }
  });

  it("returning to SUBSCRIBED stops the fallback immediately", () => {
    const h = makeHarness();
    h.fireStatus("CHANNEL_ERROR");
    expect(h.intervalCount()).toBe(1);
    h.fireStatus("SUBSCRIBED");
    expect(h.intervalCount()).toBe(0);
    h.stop();
  });
});

describe("startTenantDataLifecycle — tab visibility / FASE 9", () => {
  it("fallback tick is skipped while the tab is hidden", () => {
    const h = makeHarness();
    h.fireStatus("CHANNEL_ERROR");
    h.setVisibility("hidden");
    h.fireAllIntervals();
    expect(h.refresh).not.toHaveBeenCalled();
    h.stop();
  });

  it("fallback tick runs when the tab is visible", () => {
    const h = makeHarness();
    h.fireStatus("CHANNEL_ERROR");
    h.setVisibility("visible");
    h.fireAllIntervals();
    expect(h.refresh).toHaveBeenCalledTimes(1);
    h.stop();
  });

  it("tab regains visibility while realtime is disconnected: immediate refresh", () => {
    const h = makeHarness();
    h.fireStatus("CHANNEL_ERROR");
    h.setVisibility("visible");
    h.fireVisibilityChange();
    expect(h.refresh).toHaveBeenCalledTimes(1);
    h.stop();
  });

  it("tab regains visibility while realtime is SUBSCRIBED: no extra refresh", () => {
    const h = makeHarness();
    h.fireStatus("SUBSCRIBED");
    h.setVisibility("visible");
    h.fireVisibilityChange();
    expect(h.refresh).not.toHaveBeenCalled();
    h.stop();
  });

  it("visibilitychange while still hidden does nothing", () => {
    const h = makeHarness();
    h.fireStatus("CHANNEL_ERROR");
    h.setVisibility("hidden");
    h.fireVisibilityChange();
    expect(h.refresh).not.toHaveBeenCalled();
    h.stop();
  });
});

describe("startTenantDataLifecycle — teardown", () => {
  it("stop() unsubscribes realtime, removes the visibility listener, and clears timers", () => {
    const h = makeHarness();
    h.fireStatus("CHANNEL_ERROR");
    const channel = h.getChannel();
    h.stop();
    expect(channel?.unsubscribe).toHaveBeenCalledTimes(1);
    expect(h.intervalCount()).toBe(0);

    h.setVisibility("visible");
    h.fireVisibilityChange();
    expect(h.refresh).not.toHaveBeenCalled();
  });
});

describe("createDedupedAsync — concurrency guard / FASE 4 & 10", () => {
  it("collapses concurrent calls into a single in-flight execution", async () => {
    let resolveFn: (() => void) | null = null;
    const underlying = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveFn = () => resolve(true);
        })
    );
    const deduped = createDedupedAsync(underlying);

    const p1 = deduped();
    const p2 = deduped();
    const p3 = deduped();
    expect(underlying).toHaveBeenCalledTimes(1);

    resolveFn?.();
    await Promise.all([p1, p2, p3]);
    expect(underlying).toHaveBeenCalledTimes(1);
  });

  it("allows a fresh execution after the previous one resolves", async () => {
    const underlying = vi.fn(async () => true);
    const deduped = createDedupedAsync(underlying);

    await deduped();
    await deduped();
    expect(underlying).toHaveBeenCalledTimes(2);
  });

  it("releases the guard in finally even if the call rejects", async () => {
    const underlying = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(true);
    const deduped = createDedupedAsync(underlying);

    await expect(deduped()).rejects.toThrow("boom");
    await expect(deduped()).resolves.toBe(true);
    expect(underlying).toHaveBeenCalledTimes(2);
  });

  it("simulates realtime event + fallback tick + manual refresh firing near-simultaneously: only one real fetch in-flight", async () => {
    let resolveFn: (() => void) | null = null;
    const underlying = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveFn = () => resolve(true);
        })
    );
    const dedupedRefresh = createDedupedAsync(underlying);
    const h = makeHarness(dedupedRefresh);

    h.fireStatus("CHANNEL_ERROR");
    h.setVisibility("visible");

    // realtime event schedules a debounced refresh
    h.fireDbEvent();
    h.fireAllTimeouts(); // debounce elapses, calls dedupedRefresh() — starts the in-flight fetch
    // fallback tick fires "at the same time" while the fetch above is still pending
    h.fireAllIntervals();
    // a consumer also triggers a manual refresh concurrently
    const manual = h.refresh();

    expect(underlying).toHaveBeenCalledTimes(1); // all three collapsed into one real fetch

    resolveFn?.();
    await manual;
    expect(underlying).toHaveBeenCalledTimes(1);
    h.stop();
  });
});
