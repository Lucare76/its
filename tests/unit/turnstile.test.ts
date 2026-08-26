import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { verifyTurnstileToken } from "@/lib/server/turnstile";

const originalSecret = process.env.TURNSTILE_SECRET_KEY;
const originalFetch = global.fetch;

describe("verifyTurnstileToken (mocked Siteverify — no real network calls)", () => {
  beforeEach(() => {
    process.env.TURNSTILE_SECRET_KEY = "test-secret-key";
  });

  afterEach(() => {
    process.env.TURNSTILE_SECRET_KEY = originalSecret;
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns missing_token without calling fetch when no token is provided", async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    const result = await verifyTurnstileToken({ token: null });

    expect(result).toEqual({ success: false, errorCode: "missing_token" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails closed with missing_secret when TURNSTILE_SECRET_KEY is not configured, without calling fetch", async () => {
    delete process.env.TURNSTILE_SECRET_KEY;
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    const result = await verifyTurnstileToken({ token: "some-token" });

    expect(result).toEqual({ success: false, errorCode: "missing_secret" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns success:true and passes secret/response/remoteip to Siteverify", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true })
    });
    global.fetch = fetchSpy as unknown as typeof fetch;

    const result = await verifyTurnstileToken({ token: "good-token", remoteIp: "1.2.3.4" });

    expect(result).toEqual({ success: true, errorCode: null });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      expect.objectContaining({ method: "POST" })
    );
    const sentBody = fetchSpy.mock.calls[0][1].body as URLSearchParams;
    expect(sentBody.get("secret")).toBe("test-secret-key");
    expect(sentBody.get("response")).toBe("good-token");
    expect(sentBody.get("remoteip")).toBe("1.2.3.4");
  });

  it("omits remoteip when not provided", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true })
    });
    global.fetch = fetchSpy as unknown as typeof fetch;

    await verifyTurnstileToken({ token: "good-token" });

    const sentBody = fetchSpy.mock.calls[0][1].body as URLSearchParams;
    expect(sentBody.has("remoteip")).toBe(false);
  });

  it("returns verification_failed when Siteverify responds success:false", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: false, "error-codes": ["invalid-input-response"] })
    });
    global.fetch = fetchSpy as unknown as typeof fetch;

    const result = await verifyTurnstileToken({ token: "bad-token" });

    expect(result).toEqual({
      success: false,
      errorCode: "verification_failed",
      cloudflareErrorCodes: ["invalid-input-response"]
    });
  });

  it("fails closed with network_error when Siteverify is unreachable", async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error("network down"));
    global.fetch = fetchSpy as unknown as typeof fetch;

    const result = await verifyTurnstileToken({ token: "some-token" });

    expect(result).toEqual({ success: false, errorCode: "network_error" });
  });

  it("fails closed with network_error when Siteverify returns a non-ok HTTP status", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    global.fetch = fetchSpy as unknown as typeof fetch;

    const result = await verifyTurnstileToken({ token: "some-token" });

    expect(result).toEqual({ success: false, errorCode: "network_error" });
  });
});
