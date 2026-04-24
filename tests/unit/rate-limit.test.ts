import { describe, it, expect, beforeEach } from "vitest";
import { checkRateLimit, resetRateLimit, incrementRateLimit } from "@/lib/server/rate-limit";

const CONFIG = { maxAttempts: 3, windowMs: 60_000 };
const TYPE = "test";

beforeEach(() => {
  resetRateLimit(TYPE, "ip-A");
  resetRateLimit(TYPE, "ip-B");
});

describe("checkRateLimit", () => {
  it("allows requests up to the limit", () => {
    expect(checkRateLimit(TYPE, "ip-A", CONFIG).allowed).toBe(true);
    expect(checkRateLimit(TYPE, "ip-A", CONFIG).allowed).toBe(true);
    expect(checkRateLimit(TYPE, "ip-A", CONFIG).allowed).toBe(true);
  });

  it("blocks the (maxAttempts + 1)-th request", () => {
    checkRateLimit(TYPE, "ip-A", CONFIG);
    checkRateLimit(TYPE, "ip-A", CONFIG);
    checkRateLimit(TYPE, "ip-A", CONFIG);
    expect(checkRateLimit(TYPE, "ip-A", CONFIG).allowed).toBe(false);
  });

  it("counts remaining correctly", () => {
    const r1 = checkRateLimit(TYPE, "ip-A", CONFIG);
    expect(r1.remaining).toBe(2); // 3 max, 1 used → 2 left
    const r2 = checkRateLimit(TYPE, "ip-A", CONFIG);
    expect(r2.remaining).toBe(1);
    const r3 = checkRateLimit(TYPE, "ip-A", CONFIG);
    expect(r3.remaining).toBe(0);
  });

  it("isolates different identifiers", () => {
    checkRateLimit(TYPE, "ip-A", CONFIG);
    checkRateLimit(TYPE, "ip-A", CONFIG);
    checkRateLimit(TYPE, "ip-A", CONFIG);
    // ip-B is untouched
    expect(checkRateLimit(TYPE, "ip-B", CONFIG).allowed).toBe(true);
  });

  it("returns a resetAt Date in the future", () => {
    const { resetAt } = checkRateLimit(TYPE, "ip-A", CONFIG);
    expect(resetAt).toBeInstanceOf(Date);
    expect(resetAt.getTime()).toBeGreaterThan(Date.now());
  });
});

describe("resetRateLimit", () => {
  it("re-allows requests after reset", () => {
    checkRateLimit(TYPE, "ip-A", CONFIG);
    checkRateLimit(TYPE, "ip-A", CONFIG);
    checkRateLimit(TYPE, "ip-A", CONFIG);
    expect(checkRateLimit(TYPE, "ip-A", CONFIG).allowed).toBe(false);

    resetRateLimit(TYPE, "ip-A");

    expect(checkRateLimit(TYPE, "ip-A", CONFIG).allowed).toBe(true);
  });
});

describe("incrementRateLimit", () => {
  it("counts without blocking (used for failed-login tracking)", () => {
    incrementRateLimit(TYPE, "ip-A", CONFIG);
    incrementRateLimit(TYPE, "ip-A", CONFIG);
    incrementRateLimit(TYPE, "ip-A", CONFIG);
    // After 3 increments the next checkRateLimit should be blocked
    expect(checkRateLimit(TYPE, "ip-A", CONFIG).allowed).toBe(false);
  });
});
