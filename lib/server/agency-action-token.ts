/**
 * Token HMAC per azioni agenzia da email (annulla servizio, ecc.)
 * Nessun DB necessario — il token è self-contained e verificato lato server.
 */

import { createHmac, timingSafeEqual } from "crypto";

export type AgencyActionType = "cancel";

export interface AgencyActionPayload {
  sid: string;  // service_id
  aid: string;  // agency_id
  tid: string;  // tenant_id
  act: AgencyActionType;
  exp: number;  // unix timestamp seconds
}

function getSecret(): string {
  return process.env.AGENCY_ACTION_SECRET ?? process.env.CRON_SECRET ?? "fallback-dev-secret";
}

function base64url(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf) : buf;
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function fromBase64url(s: string): string {
  return s.replace(/-/g, "+").replace(/_/g, "/");
}

export function generateAgencyActionToken(payload: Omit<AgencyActionPayload, "exp">, ttlDays = 7): string {
  const exp = Math.floor(Date.now() / 1000) + ttlDays * 86400;
  const full: AgencyActionPayload = { ...payload, exp };
  const encodedPayload = base64url(JSON.stringify(full));
  const sig = base64url(createHmac("sha256", getSecret()).update(encodedPayload).digest());
  return `${encodedPayload}.${sig}`;
}

export function verifyAgencyActionToken(token: string): AgencyActionPayload | null {
  try {
    const dot = token.lastIndexOf(".");
    if (dot < 0) return null;
    const encodedPayload = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expectedSig = base64url(createHmac("sha256", getSecret()).update(encodedPayload).digest());
    // timing-safe compare
    const a = Buffer.from(fromBase64url(sig), "base64");
    const b = Buffer.from(fromBase64url(expectedSig), "base64");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(Buffer.from(fromBase64url(encodedPayload), "base64").toString()) as AgencyActionPayload;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}
