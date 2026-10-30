/** Baseline loads populate badges; only later, unseen pending requests produce live alerts. */
export function newPendingModificationIds(previous: ReadonlySet<string> | null, current: ReadonlySet<string>): string[] {
  return previous === null ? [] : [...current].filter(id => !previous.has(id));
}
