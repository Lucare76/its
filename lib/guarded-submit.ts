/**
 * Guards an async submit handler against re-entrant invocation.
 *
 * The bug this exists to prevent: a submit handler that only flips its
 * "submitting" flag deep inside itself (e.g. after an awaited network call)
 * leaves the trigger (button click, keypress) live during that window, so a
 * second invocation races the first and both complete, producing duplicate
 * writes. `runGuardedSubmit` closes that window by checking and setting the
 * flag synchronously before anything else runs, and always releases it via
 * `finally` — including on validation early-returns and thrown errors.
 */
export async function runGuardedSubmit(
  submitting: boolean,
  setSubmitting: (value: boolean) => void,
  fn: () => Promise<void>
): Promise<void> {
  if (submitting) return;
  setSubmitting(true);
  try {
    await fn();
  } finally {
    setSubmitting(false);
  }
}
