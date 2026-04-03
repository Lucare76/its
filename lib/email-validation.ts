import { resolve4, resolve6, resolveMx } from "dns/promises";

const disposableEmailDomains = new Set([
  "mailinator.com",
  "10minutemail.com",
  "yopmail.com",
  "guerrillamail.com",
  "getnada.com",
  "trashmail.com",
  "temp-mail.org",
  "maildrop.cc",
  "tempmail.io",
  "tempmail.net",
  "dispostable.com",
  "mailnesia.com",
  "fakeinbox.com",
  "www.mailinator.com",
  "sharklasers.com",
  "spamgourmet.com",
  "mail-temporaire.fr",
  "mohmal.com",
  "tempinbox.com",
  "10minutemail.net",
  "temp-mail.io",
  "trashmail.com",
  "mailforspam.com",
  "mailcatch.com",
  "spam4.me",
  "spambox.us",
  "throwawaymail.com",
  "getairmail.com"
]);

export function isDisposableEmail(email: string): boolean {
  const parts = email.split("@");
  if (parts.length !== 2) return false;
  const domain = parts[1].trim().toLowerCase();
  return disposableEmailDomains.has(domain);
}

export async function hasDeliverableEmailDomain(email: string): Promise<boolean> {
  const parts = email.split("@");
  if (parts.length !== 2) return false;
  const domain = parts[1].trim().toLowerCase();
  if (!domain) return false;

  try {
    const mx = await resolveMx(domain);
    if (mx && mx.length > 0) return true;
  } catch {
    // ignore and continue
  }

  try {
    const records = await resolve4(domain);
    if (records && records.length > 0) return true;
  } catch {
    // ignore and continue
  }

  try {
    const records6 = await resolve6(domain);
    if (records6 && records6.length > 0) return true;
  } catch {
    // ignore and continue
  }

  return false;
}
