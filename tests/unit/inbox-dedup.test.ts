import { describe, expect, it } from "vitest";
import { dedupeAppend } from "@/lib/collection-utils";

describe("dedupeAppend — FASE 18.11 dedup append client", () => {
  it("appends new rows after the existing ones, preserving order", () => {
    const current = [{ id: "a" }, { id: "b" }];
    const incoming = [{ id: "c" }, { id: "d" }];
    expect(dedupeAppend(current, incoming)).toEqual([{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }]);
  });

  it("drops rows already present by id instead of duplicating them", () => {
    const current = [{ id: "a" }, { id: "b" }];
    const incoming = [{ id: "b" }, { id: "c" }];
    expect(dedupeAppend(current, incoming)).toEqual([{ id: "a" }, { id: "b" }, { id: "c" }]);
  });

  it("does not mutate the current array", () => {
    const current = [{ id: "a" }];
    const result = dedupeAppend(current, [{ id: "b" }]);
    expect(current).toEqual([{ id: "a" }]);
    expect(result).not.toBe(current);
  });

  it("handles an empty incoming page", () => {
    const current = [{ id: "a" }];
    expect(dedupeAppend(current, [])).toEqual([{ id: "a" }]);
  });
});
