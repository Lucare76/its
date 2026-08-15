// Framework-free orchestration for useTenantOperationalData's realtime + fallback
// lifecycle. Kept separate from the React hook so the tricky timing/concurrency
// decisions (fallback start/stop, visibility gating, in-flight dedupe) can be unit
// tested without a DOM or a React renderer.

export type RealtimeStatus = string;

export type TenantDataLifecycleDeps = {
  /** Deduped refresh function (see createDedupedAsync). */
  refresh: () => Promise<boolean>;
  /**
   * Wires up the realtime channel. Must call `onEvent` for every relevant DB
   * change and `onStatus` whenever the channel status changes. Returns an
   * unsubscribe function.
   */
  subscribeRealtime: (onEvent: () => void, onStatus: (status: RealtimeStatus) => void) => () => void;
  getVisibilityState: () => string;
  /** Registers a visibilitychange-style listener. Returns a remove function. */
  addVisibilityListener: (handler: () => void) => () => void;
  setTimeoutFn: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn: (handle: unknown) => void;
  setIntervalFn: (fn: () => void, ms: number) => unknown;
  clearIntervalFn: (handle: unknown) => void;
  onLiveConnectedChange: (connected: boolean) => void;
  /** Debounce applied to realtime DB events before triggering a refresh. Default 400ms. */
  debounceMs?: number;
  /** Fallback poll interval, only active while realtime is not SUBSCRIBED. Default 20000ms. */
  fallbackIntervalMs?: number;
};

/**
 * Starts the realtime subscription + fallback-polling lifecycle. Does NOT
 * perform an initial refresh itself — the caller is expected to have already
 * bootstrapped data separately (mount fetch stays a single call that way).
 * Returns a stop function that tears down the channel, timers and listeners.
 */
export function startTenantDataLifecycle(deps: TenantDataLifecycleDeps): () => void {
  const {
    refresh,
    subscribeRealtime,
    getVisibilityState,
    addVisibilityListener,
    setTimeoutFn,
    clearTimeoutFn,
    setIntervalFn,
    clearIntervalFn,
    onLiveConnectedChange,
    debounceMs = 400,
    fallbackIntervalMs = 20000
  } = deps;

  let stopped = false;
  let liveConnected = false;
  let debounceHandle: unknown = null;
  let fallbackHandle: unknown = null;

  const stopFallback = () => {
    if (fallbackHandle !== null) {
      clearIntervalFn(fallbackHandle);
      fallbackHandle = null;
    }
  };

  const startFallback = () => {
    if (stopped || fallbackHandle !== null) return;
    fallbackHandle = setIntervalFn(() => {
      if (getVisibilityState() !== "visible") return;
      void refresh();
    }, fallbackIntervalMs);
  };

  const handleStatus = (status: RealtimeStatus) => {
    if (stopped) return;
    liveConnected = status === "SUBSCRIBED";
    onLiveConnectedChange(liveConnected);
    if (liveConnected) {
      stopFallback();
    } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
      startFallback();
    }
  };

  const handleEvent = () => {
    if (stopped) return;
    if (debounceHandle !== null) clearTimeoutFn(debounceHandle);
    debounceHandle = setTimeoutFn(() => {
      debounceHandle = null;
      void refresh();
    }, debounceMs);
  };

  const handleVisibilityChange = () => {
    if (stopped) return;
    if (getVisibilityState() !== "visible") return;
    if (liveConnected) return;
    void refresh();
  };

  const removeVisibilityListener = addVisibilityListener(handleVisibilityChange);
  const unsubscribeRealtime = subscribeRealtime(handleEvent, handleStatus);

  return () => {
    if (stopped) return;
    stopped = true;
    onLiveConnectedChange(false);
    removeVisibilityListener();
    unsubscribeRealtime();
    if (debounceHandle !== null) clearTimeoutFn(debounceHandle);
    stopFallback();
  };
}

/**
 * Wraps an async function so concurrent callers share a single in-flight
 * execution instead of triggering parallel duplicate work. Once the call
 * resolves (or rejects), the next call starts a fresh execution.
 */
export function createDedupedAsync<T>(fn: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return () => {
    if (inFlight) return inFlight;
    const run = fn().finally(() => {
      inFlight = null;
    });
    inFlight = run;
    return run;
  };
}
