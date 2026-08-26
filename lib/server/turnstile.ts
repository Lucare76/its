/**
 * Cloudflare Turnstile server-side verification. Domain-agnostic: takes a
 * token (+ optional remote IP), calls Siteverify, returns a typed result.
 * Callers own their own policy (what to do on failure, what to log) — this
 * helper never logs the token and never knows about onboarding/register.
 */

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export type TurnstileErrorCode =
  | "missing_token"
  | "missing_secret"
  | "network_error"
  | "verification_failed";

export interface TurnstileVerifyResult {
  success: boolean;
  errorCode: TurnstileErrorCode | null;
  /** Cloudflare's own error-codes array, if any — safe to log, contains no secrets/tokens. */
  cloudflareErrorCodes?: string[];
}

export interface TurnstileVerifyInput {
  token: string | null | undefined;
  remoteIp?: string | null;
}

/**
 * Verifies a Turnstile token against Cloudflare Siteverify.
 *
 * Fails closed: a missing secret, a missing token, or an unreachable
 * Cloudflare endpoint are all treated as verification failure — callers
 * must never silently bypass the check when this returns success:false.
 */
export async function verifyTurnstileToken(input: TurnstileVerifyInput): Promise<TurnstileVerifyResult> {
  if (!input.token) {
    return { success: false, errorCode: "missing_token" };
  }

  const secret = process.env.TURNSTILE_SECRET_KEY?.trim();
  if (!secret) {
    return { success: false, errorCode: "missing_secret" };
  }

  const body = new URLSearchParams();
  body.set("secret", secret);
  body.set("response", input.token);
  if (input.remoteIp) {
    body.set("remoteip", input.remoteIp);
  }

  let response: Response;
  try {
    response = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
  } catch {
    return { success: false, errorCode: "network_error" };
  }

  if (!response.ok) {
    return { success: false, errorCode: "network_error" };
  }

  let data: { success?: boolean; "error-codes"?: string[] };
  try {
    data = await response.json();
  } catch {
    return { success: false, errorCode: "network_error" };
  }

  if (!data.success) {
    return { success: false, errorCode: "verification_failed", cloudflareErrorCodes: data["error-codes"] };
  }

  return { success: true, errorCode: null };
}
