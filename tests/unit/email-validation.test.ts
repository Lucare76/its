import { describe, it, expect } from "vitest";
import { isDisposableEmail } from "@/lib/email-validation";

describe("isDisposableEmail", () => {
  it("detects known disposable domains", () => {
    expect(isDisposableEmail("user@mailinator.com")).toBe(true);
    expect(isDisposableEmail("user@yopmail.com")).toBe(true);
    expect(isDisposableEmail("user@10minutemail.com")).toBe(true);
    expect(isDisposableEmail("user@guerrillamail.com")).toBe(true);
    expect(isDisposableEmail("user@trashmail.com")).toBe(true);
    expect(isDisposableEmail("user@temp-mail.org")).toBe(true);
  });

  it("accepts legitimate domains", () => {
    expect(isDisposableEmail("luca@gmail.com")).toBe(false);
    expect(isDisposableEmail("user@hotmail.com")).toBe(false);
    expect(isDisposableEmail("user@company.it")).toBe(false);
  });

  it("is case-insensitive on the domain part", () => {
    expect(isDisposableEmail("user@Mailinator.COM")).toBe(true);
    expect(isDisposableEmail("user@YOPMAIL.com")).toBe(true);
  });

  it("returns false for malformed addresses (no @)", () => {
    expect(isDisposableEmail("notanemail")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isDisposableEmail("")).toBe(false);
  });
});
