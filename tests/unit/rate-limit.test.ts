import { describe, it, expect, beforeEach } from "vitest";
import { checkRateLimit, resetRateLimit, incrementRateLimit } from "@/lib/server/rate-limit";

const CONFIG = { maxAttempts: 3, windowMs: 60_000 };
const TYPE = "test";

beforeEach(() => {
  resetRateLimit(TYPE, "ip-A");
  resetRateLimit(TYPE, "ip-B");
});

describe("checkRateLimit", () => {
  it("allows requests up to the limit", async () => {
    expect((await checkRateLimit(TYPE, "ip-A", CONFIG)).allowed).toBe(true);
    expect((await checkRateLimit(TYPE, "ip-A", CONFIG)).allowed).toBe(true);
    expect((await checkRateLimit(TYPE, "ip-A", CONFIG)).allowed).toBe(true);
  });

  it("blocks the (maxAttempts + 1)-th request", async () => {
    await checkRateLimit(TYPE, "ip-A", CONFIG);
    await checkRateLimit(TYPE, "ip-A", CONFIG);
    await checkRateLimit(TYPE, "ip-A", CONFIG);
    expect((await checkRateLimit(TYPE, "ip-A", CONFIG)).allowed).toBe(false);
  });

  it("counts remaining correctly", async () => {
    const r1 = await checkRateLimit(TYPE, "ip-A", CONFIG);
    expect(r1.remaining).toBe(2); // 3 max, 1 used → 2 left
    const r2 = await checkRateLimit(TYPE, "ip-A", CONFIG);
    expect(r2.remaining).toBe(1);
    const r3 = await checkRateLimit(TYPE, "ip-A", CONFIG);
    expect(r3.remaining).toBe(0);
  });

  it("isolates different identifiers", async () => {
    await checkRateLimit(TYPE, "ip-A", CONFIG);
    await checkRateLimit(TYPE, "ip-A", CONFIG);
    await checkRateLimit(TYPE, "ip-A", CONFIG);
    // ip-B is untouched
    expect((await checkRateLimit(TYPE, "ip-B", CONFIG)).allowed).toBe(true);
  });

  it("returns a resetAt Date in the future", async () => {
    const { resetAt } = await checkRateLimit(TYPE, "ip-A", CONFIG);
    expect(resetAt).toBeInstanceOf(Date);
    expect(resetAt.getTime()).toBeGreaterThan(Date.now());
  });
});

describe("resetRateLimit", () => {
  it("re-allows requests after reset", async () => {
    await checkRateLimit(TYPE, "ip-A", CONFIG);
    await checkRateLimit(TYPE, "ip-A", CONFIG);
    await checkRateLimit(TYPE, "ip-A", CONFIG);
    expect((await checkRateLimit(TYPE, "ip-A", CONFIG)).allowed).toBe(false);

    resetRateLimit(TYPE, "ip-A");

    expect((await checkRateLimit(TYPE, "ip-A", CONFIG)).allowed).toBe(true);
  });
});

describe("incrementRateLimit", () => {
  it("counts without blocking (used for failed-login tracking)", async () => {
    incrementRateLimit(TYPE, "ip-A", CONFIG);
    incrementRateLimit(TYPE, "ip-A", CONFIG);
    incrementRateLimit(TYPE, "ip-A", CONFIG);
    // After 3 increments the next checkRateLimit should be blocked
    expect((await checkRateLimit(TYPE, "ip-A", CONFIG)).allowed).toBe(false);
  });
});
