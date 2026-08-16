// Sprint Performance 14F. Framework-free polling lifecycle for
// OperationsSuggestions, mirroring lib/supabase/tenant-data-lifecycle.ts's
// dependency-injection shape so the hidden-tab / in-flight / visibility-
// restore decision logic can be unit tested without a DOM (no jsdom).

export type SuggestionsPollDeps = {
  /** Performs one fetch+state-update cycle. This module's own in-flight guard
   *  prevents two POLL-triggered calls from overlapping, but does not
   *  coordinate with calls made outside the polling lifecycle (manual
   *  "Aggiorna" button, post-action refreshes) — those keep their existing,
   *  unconditional-refresh behavior by design (see
   *  components/operations-suggestions.tsx). */
  refresh: () => Promise<void>;
  getVisibilityState: () => string;
  addVisibilityListener: (handler: () => void) => () => void;
  setIntervalFn: (fn: () => void, ms: number) => unknown;
  clearIntervalFn: (handle: unknown) => void;
  intervalMs: number;
};

/**
 * Starts the poll lifecycle: an immediate tick, then one tick per
 * `intervalMs`, plus an extra tick whenever the tab becomes visible again.
 * A tick is a no-op whenever the tab isn't visible or a previous
 * poll-triggered refresh() is still in flight. Returns a stop function.
 */
export function startSuggestionsPolling(deps: SuggestionsPollDeps): () => void {
  const { refresh, getVisibilityState, addVisibilityListener, setIntervalFn, clearIntervalFn, intervalMs } = deps;

  let stopped = false;
  let inFlight = false;

  const tick = () => {
    if (stopped) return;
    if (getVisibilityState() !== "visible") return;
    if (inFlight) return;
    inFlight = true;
    // A rejected refresh() must still release the guard (FASE 8) and must
    // never surface as an unhandled rejection — same contract as
    // app/(app)/layout.tsx's refreshWhatsAppSummary, which catches
    // internally. `refresh` here is a caller-supplied dependency we don't
    // control, so this module catches defensively on its behalf.
    void refresh()
      .catch(() => undefined)
      .finally(() => {
        inFlight = false;
      });
  };

  const handleVisibilityChange = () => {
    if (stopped) return;
    if (getVisibilityState() !== "visible") return;
    tick();
  };

  tick();
  const interval = setIntervalFn(tick, intervalMs);
  const removeVisibilityListener = addVisibilityListener(handleVisibilityChange);

  return () => {
    stopped = true;
    clearIntervalFn(interval);
    removeVisibilityListener();
  };
}
