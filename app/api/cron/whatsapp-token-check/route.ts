import { NextRequest, NextResponse } from "next/server";
import { createAdminClient, whatsappAccessToken, whatsappGraphVersion } from "@/lib/server/whatsapp";
import { sendEmail } from "@/lib/server/send-email";

export const runtime = "nodejs";

const WARNING_DAYS = 15;

function hasCronAuth(request: NextRequest) {
  const expected = process.env.WHATSAPP_CRON_SECRET ?? process.env.CRON_SECRET;
  if (!expected) return false;
  return request.headers.get("authorization") === `Bearer ${expected}`;
}

async function adminEmails(admin: ReturnType<typeof createAdminClient>, tenantId?: string | null) {
  let query = admin.from("memberships").select("user_id, tenant_id").in("role", ["admin"]);
  if (tenantId) query = query.eq("tenant_id", tenantId);
  const { data } = await query;
  const ids = Array.from(new Set((data ?? []).map((row) => row.user_id as string).filter(Boolean)));
  if (!ids.length) return [];
  const { data: usersData } = await admin.auth.admin.listUsers();
  return (usersData.users ?? [])
    .filter((user) => ids.includes(user.id))
    .map((user) => user.email)
    .filter((email): email is string => Boolean(email));
}

async function logTokenCheck(
  admin: ReturnType<typeof createAdminClient>,
  payload: {
    tenantId: string;
    outcome: string;
    status: number;
    expiresAt?: number | null;
    daysLeft?: number | null;
    error?: string | null;
  }
) {
  await admin.from("ops_audit_events").insert({
    tenant_id: payload.tenantId,
    event: "whatsapp_token_check",
    level: payload.outcome === "expired" ? "error" : payload.outcome === "expiring" ? "warn" : "info",
    outcome: payload.outcome,
    details: {
      status: payload.status,
      expires_at: payload.expiresAt ?? null,
      days_left: payload.daysLeft ?? null,
      error: payload.error ?? null,
      checked_at: new Date().toISOString(),
    },
  });
}

async function runCheck(request: NextRequest) {
  if (!hasCronAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let admin: ReturnType<typeof createAdminClient>;
  let accessToken: string;
  try {
    admin = createAdminClient();
    accessToken = whatsappAccessToken();
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Server env missing" }, { status: 500 });
  }

  const { data: tenants } = await admin.from("tenants").select("id").limit(500);
  const tenantIds = (tenants ?? []).map((tenant) => tenant.id as string);

  const response = await fetch(`https://graph.facebook.com/${whatsappGraphVersion()}/me?fields=id,name`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  const payload = await response.json().catch(() => null) as {
    id?: string;
    name?: string;
    expires_at?: number;
    error?: { message?: string };
  } | null;

  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiresAt = typeof payload?.expires_at === "number" ? payload.expires_at : null;
  const daysLeft = expiresAt ? Math.floor((expiresAt - nowSeconds) / 86_400) : null;
  const outcome =
    response.status === 401 || response.status === 403
      ? "expired"
      : daysLeft !== null && daysLeft < WARNING_DAYS
      ? "expiring"
      : response.ok
      ? "ok"
      : "error";

  await Promise.all(tenantIds.map((tenantId) =>
    logTokenCheck(admin, {
      tenantId,
      outcome,
      status: response.status,
      expiresAt,
      daysLeft,
      error: payload?.error?.message ?? null,
    })
  ));

  if (outcome === "expired" || outcome === "expiring") {
    const emails = await adminEmails(admin);
    if (emails.length) {
      const urgent = outcome === "expired";
      const subject = urgent
        ? "⚠️ Token WhatsApp scaduto — i messaggi ai clienti non vengono inviati. Azione richiesta immediata."
        : "Token WhatsApp in scadenza - azione richiesta";
      const body = urgent
        ? "⚠️ Token WhatsApp scaduto — i messaggi ai clienti non vengono inviati. Azione richiesta immediata."
        : `Token WhatsApp in scadenza tra ${daysLeft ?? "pochi"} giorni. Genera un System User Token permanente e aggiorna WHATSAPP_ACCESS_TOKEN.`;
      await sendEmail({
        to: emails,
        subject,
        html: `<p style="font-size:16px;font-weight:700;color:#991b1b;">${body}</p>`,
        text: body,
      });
    }
  }

  return NextResponse.json({
    ok: response.ok,
    status: response.status,
    outcome,
    expires_at: expiresAt,
    days_left: daysLeft,
    meta_id: payload?.id ?? null,
    meta_name: payload?.name ?? null,
  });
}

export async function GET(request: NextRequest) {
  return runCheck(request);
}

export async function POST(request: NextRequest) {
  return runCheck(request);
}
