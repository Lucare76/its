import { describe, it, expect, vi } from "vitest";
import { runGuardedSubmit } from "@/lib/guarded-submit";

function makeState(initial = false) {
  let submitting = initial;
  const setSubmitting = vi.fn((value: boolean) => { submitting = value; });
  return { get submitting() { return submitting; }, setSubmitting };
}

describe("runGuardedSubmit", () => {
  it("un singolo submit esegue fn esattamente una volta", async () => {
    const state = makeState();
    const fn = vi.fn().mockResolvedValue(undefined);
    await runGuardedSubmit(state.submitting, state.setSubmitting, fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("doppio click rapido: la seconda chiamata è ignorata mentre la prima è in corso (una sola creazione)", async () => {
    const state = makeState();
    let resolveFirst!: () => void;
    const firstCallStarted = vi.fn(() => new Promise<void>((resolve) => { resolveFirst = resolve; }));
    const callCount = { n: 0 };
    const fn = vi.fn(async () => {
      callCount.n += 1;
      await firstCallStarted();
    });

    const first = runGuardedSubmit(state.submitting, state.setSubmitting, fn);
    // submitting is now true (set synchronously before any await inside fn resolves)
    expect(state.submitting).toBe(true);

    // Second "click" while the first is still in flight — must be a no-op.
    const second = runGuardedSubmit(state.submitting, state.setSubmitting, fn);
    await second;

    expect(fn).toHaveBeenCalledTimes(1);
    expect(callCount.n).toBe(1);

    resolveFirst();
    await first;
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("rilascia il guard dopo un submit riuscito (submitting torna false)", async () => {
    const state = makeState();
    await runGuardedSubmit(state.submitting, state.setSubmitting, async () => {});
    expect(state.setSubmitting).toHaveBeenLastCalledWith(false);
  });

  it("rilascia il guard anche se fn lancia un errore (retry successivo permesso)", async () => {
    const state = makeState();
    const fn = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(runGuardedSubmit(state.submitting, state.setSubmitting, fn)).rejects.toThrow("boom");
    expect(state.setSubmitting).toHaveBeenLastCalledWith(false);

    // Dopo il rilascio, un nuovo submit deve poter procedere (retry).
    const okFn = vi.fn().mockResolvedValue(undefined);
    await runGuardedSubmit(false, state.setSubmitting, okFn);
    expect(okFn).toHaveBeenCalledTimes(1);
  });

  it("rilascia il guard su early-return sincrono dentro fn (es. validazione fallita)", async () => {
    const state = makeState();
    const fn = vi.fn(async () => { return; });
    await runGuardedSubmit(state.submitting, state.setSubmitting, fn);
    expect(state.setSubmitting).toHaveBeenLastCalledWith(false);
  });

  it("SENSITIVITY: se submitting è già true, fn non viene mai invocata", async () => {
    const setSubmitting = vi.fn();
    const fn = vi.fn().mockResolvedValue(undefined);
    await runGuardedSubmit(true, setSubmitting, fn);
    expect(fn).not.toHaveBeenCalled();
    expect(setSubmitting).not.toHaveBeenCalled();
  });
});
