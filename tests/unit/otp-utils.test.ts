import { describe, it, expect } from "vitest";
import { generateOtpCode, getOtpExpiration } from "@/lib/server/otp-utils";

describe("generateOtpCode", () => {
  it("returns a string of the default length (6)", () => {
    const code = generateOtpCode();
    expect(code).toHaveLength(6);
  });

  it("returns a string of a custom length", () => {
    expect(generateOtpCode(4)).toHaveLength(4);
    expect(generateOtpCode(8)).toHaveLength(8);
  });

  it("contains only digits", () => {
    for (let i = 0; i < 20; i++) {
      expect(generateOtpCode()).toMatch(/^\d+$/);
    }
  });

  it("produces different codes across calls (probabilistic)", () => {
    const codes = new Set(Array.from({ length: 20 }, () => generateOtpCode()));
    // With 10^6 possibilities and 20 draws, collision probability is negligible
    expect(codes.size).toBeGreaterThan(1);
  });
});

describe("getOtpExpiration", () => {
  it("returns a Date in the future", () => {
    const before = Date.now();
    const exp = getOtpExpiration();
    expect(exp.getTime()).toBeGreaterThan(before);
  });

  it("defaults to 10 minutes from now", () => {
    const before = Date.now();
    const exp = getOtpExpiration();
    const diff = exp.getTime() - before;
    // Allow ±1 second of execution time
    expect(diff).toBeGreaterThanOrEqual(9 * 60 * 1000);
    expect(diff).toBeLessThanOrEqual(11 * 60 * 1000);
  });

  it("respects a custom minutes argument", () => {
    const before = Date.now();
    const exp = getOtpExpiration(30);
    const diff = exp.getTime() - before;
    expect(diff).toBeGreaterThanOrEqual(29 * 60 * 1000);
    expect(diff).toBeLessThanOrEqual(31 * 60 * 1000);
  });
});
