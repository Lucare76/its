/**
 * Helper server-side per Web Push (VAPID).
 *
 * Env vars richieste:
 *   VAPID_PUBLIC_KEY   — chiave pubblica VAPID (base64url)
 *   VAPID_PRIVATE_KEY  — chiave privata VAPID (base64url)
 *   VAPID_SUBJECT      — mailto: o URL del sito (default: mailto:info@ischiatransferservice.it)
 *
 * Genera le chiavi una volta con:
 *   node -e "const wp=require('web-push'); const k=wp.generateVAPIDKeys(); console.log(JSON.stringify(k,null,2));"
 */

import webpush from "web-push";
import { createClient } from "@supabase/supabase-js";

function adminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/^["']|["']$/g, "")!,
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim().replace(/^["']|["']$/g, "")!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

function getVapidConfig() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT ?? "mailto:info@ischiatransferservice.it";
  return publicKey && privateKey ? { publicKey, privateKey, subject } : null;
}

export function isWebPushConfigured(): boolean {
  return Boolean(getVapidConfig());
}

export type PushPayload = {
  title: string;
  body: string;
  url?: string;
  tag?: string;
};

type SubRow = { id: string; endpoint: string; p256dh: string; auth_key: string };

async function deliverToSubs(subs: SubRow[], payload: PushPayload): Promise<{ sent: number; failed: number }> {
  const cfg = getVapidConfig();
  if (!cfg || subs.length === 0) return { sent: 0, failed: 0 };

  webpush.setVapidDetails(cfg.subject, cfg.publicKey, cfg.privateKey);

  let sent = 0;
  let failed = 0;
  const toRemove: string[] = [];

  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth_key } },
        JSON.stringify(payload),
        { TTL: 60 * 60 * 24 } // 24h TTL
      );
      sent++;
    } catch (err) {
      failed++;
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 410 || status === 404) {
        // Subscription scaduta/rimossa dal browser
        toRemove.push(sub.id);
      }
    }
  }

  if (toRemove.length > 0) {
    const admin = adminClient();
    await admin.from("push_subscriptions").delete().in("id", toRemove);
  }

  return { sent, failed };
}

/**
 * Invia una notifica push a tutti i device registrati di un utente specifico.
 */
export async function sendPushToUser(
  tenantId: string,
  userId: string,
  payload: PushPayload
): Promise<{ sent: number; failed: number }> {
  if (!isWebPushConfigured()) return { sent: 0, failed: 0 };
  const admin = adminClient();
  const { data: subs } = await admin
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth_key")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId);

  return deliverToSubs((subs as SubRow[]) ?? [], payload);
}

/**
 * Invia una notifica push a tutti gli utenti con uno dei ruoli indicati nel tenant.
 */
export async function sendPushToTenantRoles(
  tenantId: string,
  roles: string[],
  payload: PushPayload
): Promise<void> {
  if (!isWebPushConfigured()) return;
  const admin = adminClient();

  const { data: memberships } = await admin
    .from("memberships")
    .select("user_id")
    .eq("tenant_id", tenantId)
    .in("role", roles);

  if (!memberships?.length) return;

  const userIds = memberships.map((m: { user_id: string }) => m.user_id);

  const { data: subs } = await admin
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth_key")
    .eq("tenant_id", tenantId)
    .in("user_id", userIds);

  await deliverToSubs((subs as SubRow[]) ?? [], payload);
}
