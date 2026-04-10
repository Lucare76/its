export function normalizeAppUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/$/, "");
}

export function getConfiguredAppUrl(): string | null {
  const fromEnv = normalizeAppUrl(process.env.NEXT_PUBLIC_APP_URL);
  if (fromEnv) return fromEnv;

  const vercelUrl = normalizeAppUrl(process.env.VERCEL_URL);
  if (vercelUrl) {
    return /^https?:\/\//i.test(vercelUrl) ? vercelUrl : `https://${vercelUrl}`;
  }

  return null;
}

export function getBrowserAppUrl(): string {
  if (typeof window !== "undefined" && window.location.origin) {
    return normalizeAppUrl(window.location.origin) ?? window.location.origin;
  }

  return getConfiguredAppUrl() ?? "http://127.0.0.1:3010";
}

export function getRequestAppUrl(headers: Headers): string {
  const configured = getConfiguredAppUrl();
  if (configured) return configured;

  const host = headers.get("x-forwarded-host") ?? headers.get("host") ?? "";
  const proto = headers.get("x-forwarded-proto") ?? (host.includes("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");

  if (host) {
    return `${proto}://${host}`.replace(/\/$/, "");
  }

  return "http://127.0.0.1:3010";
}
