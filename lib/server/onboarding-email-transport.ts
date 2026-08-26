import { getVerifiedFromEmail, resendFetch } from "@/lib/server/send-email";

/**
 * Shared send/result-normalization wiring for the three onboarding
 * transactional emails (access-request-received, access-approval,
 * access-rejection). Each of those files still owns its own subject and
 * HTML/text builders — only the identical "check destinatario, check
 * provider configurato, call Resend, normalize ok/failed/skipped" plumbing
 * that was copy-pasted three times lives here.
 */

export type OnboardingEmailStatus = "sent" | "failed" | "skipped";

export interface OnboardingEmailResult {
  status: OnboardingEmailStatus;
  error: string | null;
}

export async function sendOnboardingTransactionalEmail(params: {
  to: string | null;
  subject: string;
  html: string;
  text: string;
  /** Prefix used in the failure error message, e.g. "Invio email rifiuto fallito". */
  failureLabel: string;
}): Promise<OnboardingEmailResult> {
  if (!params.to) {
    return { status: "skipped", error: "Destinatario email non disponibile." };
  }

  const apiKey = process.env.RESEND_API_KEY;
  const from = getVerifiedFromEmail();
  if (!apiKey || !from) {
    return { status: "skipped", error: "Provider email non configurato (RESEND_API_KEY / AGENCY_BOOKING_FROM_EMAIL)." };
  }

  const response = await resendFetch(apiKey, {
    from,
    to: [params.to],
    subject: params.subject,
    html: params.html,
    text: params.text
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    return {
      status: "failed",
      error: `${params.failureLabel} (${response.status}). ${bodyText.slice(0, 240)}`
    };
  }

  return { status: "sent", error: null };
}
