/**
 * Utility centralizzata per l'invio email tramite Resend.
 *
 * Supporta BCC automatico per test: imposta NOTIFY_BCC_EMAIL nel .env
 * per ricevere copia di ogni email inviata dal sistema.
 *
 * Uso:
 *   import { sendEmail } from "@/lib/server/send-email";
 *   await sendEmail({ to: "agenzia@example.com", subject: "...", html: "..." });
 */

export interface SendEmailOptions {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  /** Sovrascrive il mittente (default: AGENCY_BOOKING_FROM_EMAIL o noreply@ischiatransferservice.it) */
  from?: string;
  /** CC esplicita (aggiuntiva rispetto al BCC automatico da env) */
  cc?: string | string[];
  /** BCC esplicita (si somma al NOTIFY_BCC_EMAIL automatico) */
  bcc?: string | string[];
}

export interface SendEmailResult {
  ok: boolean;
  skipped?: boolean;   // true se RESEND_API_KEY mancante
  error?: string;
}

function normalize(v: string | string[] | undefined): string[] {
  if (!v) return [];
  return Array.isArray(v) ? v.filter(Boolean) : [v];
}

const FREE_EMAIL_DOMAINS = ["gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "libero.it", "virgilio.it", "icloud.com"];
function isFreeDomain(email: string): boolean {
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  return FREE_EMAIL_DOMAINS.some((d) => domain === d);
}

/**
 * Ritorna l'indirizzo mittente verificato.
 * Se AGENCY_BOOKING_FROM_EMAIL è un dominio libero (gmail ecc.) usa il fallback.
 * Usare questa funzione in tutti i file che chiamano Resend direttamente.
 */
export function getVerifiedFromEmail(): string {
  const fromEnv = process.env.AGENCY_BOOKING_FROM_EMAIL?.trim() ?? "";
  return (fromEnv && !isFreeDomain(fromEnv)) ? fromEnv : "noreply@ischiatransferservice.it";
}

/**
 * Wrapper per la chiamata diretta a Resend che applica il redirect di test.
 * Usare questa funzione al posto di fetch("https://api.resend.com/emails", ...)
 * in tutti i file che non passano per sendEmail.
 */
export async function resendFetch(apiKey: string, payload: Record<string, unknown>): Promise<Response> {
  const testRedirectRaw = process.env.EMAIL_TEST_REDIRECT?.trim();
  const testRedirectList = testRedirectRaw
    ? testRedirectRaw.split(/[,;\s]+/).map(e => e.trim()).filter(Boolean)
    : [];
  let finalPayload = payload;
  if (testRedirectList.length > 0) {
    const originalTo = Array.isArray(payload.to) ? (payload.to as string[]) : [payload.to as string];
    finalPayload = {
      ...payload,
      to: testRedirectList,
      subject: `[TEST → ${originalTo.join(", ")}] ${payload.subject as string}`,
      cc: undefined,
      bcc: undefined,
    };
  }
  return fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(finalPayload),
  });
}

export async function sendEmail(opts: SendEmailOptions): Promise<SendEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { ok: true, skipped: true };

  const fromDefault = getVerifiedFromEmail();
  const from = opts.from ?? `Ischia Transfer Service <${fromDefault}>`;

  // BCC automatico (ignorato in modalità test — resendFetch azzera cc/bcc)
  const autoBcc = process.env.NOTIFY_BCC_EMAIL ? [process.env.NOTIFY_BCC_EMAIL] : [];
  const bcc = [...autoBcc, ...normalize(opts.bcc)];

  const payload: Record<string, unknown> = {
    from,
    to: normalize(opts.to),
    subject: opts.subject,
    html: opts.html,
  };
  if (opts.text) payload.text = opts.text;
  if (opts.cc && normalize(opts.cc).length > 0) payload.cc = normalize(opts.cc);
  if (bcc.length > 0) payload.bcc = bcc;

  try {
    const res = await resendFetch(apiKey, payload);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `Resend HTTP ${res.status}: ${body}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }
}
