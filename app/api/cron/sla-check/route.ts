/**
 * GET /api/cron/sla-check
 * Controlla ogni ora i servizi nelle prossime 12h senza autista assegnato.
 * Invia push notification urgente a tutti gli admin/operator del tenant.
 * Dedup via push_notification_log (kind = "sla_12h").
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { sendPushToTenantRoles } from "@/lib/server/web-push";

export const runtime = "nodejs";
export const maxDuration = 60;

// UUID placeholder per log SLA (alert di sistema, non legati a un utente specifico)
const SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000";

function adminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/^["']|["']$/g, "")!,
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim().replace(/^["']|["']$/g, "")!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

function pad(n: number) { return String(n).padStart(2, "0"); }
function isoDate(d: Date) { return d.toISOString().slice(0, 10); }
function isoTime(d: Date) { return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }

function hoursUntil(serviceDate: string, serviceTime: string, now: Date): number {
  const [h, m] = serviceTime.split(":").map(Number);
  const svc = new Date(`${serviceDate}T${pad(h)}:${pad(m ?? 0)}:00`);
  return (svc.getTime() - now.getTime()) / 3_600_000;
}

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ ok: false, error: "Server configuration error" }, { status: 500 });
  }
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const admin = adminClient();
  const now = new Date();
  const windowEnd = new Date(now.getTime() + 12 * 60 * 60_000);

  const todayIso   = isoDate(now);
  const tomorrowIso = isoDate(windowEnd);
  const nowTime    = isoTime(now);
  const endTime    = isoTime(windowEnd);

  // Servizi nella finestra 12h, esclusi quelli terminati
  let query = admin
    .from("services")
    .select("id, tenant_id, date, time, customer_name, pax, direction, status")
    .not("status", "in", "(completato,cancelled,pending_cancellation)")
    .order("date")
    .order("time");

  if (todayIso === tomorrowIso) {
    query = query.eq("date", todayIso).gte("time", nowTime).lte("time", endTime);
  } else {
    // La finestra supera la mezzanotte
    query = query.or(
      `and(date.eq.${todayIso},time.gte.${nowTime}),and(date.eq.${tomorrowIso},time.lte.${endTime})`
    );
  }

  const { data: services, error: svcErr } = await query;
  if (svcErr) return NextResponse.json({ ok: false, error: svcErr.message }, { status: 500 });
  if (!services?.length) return NextResponse.json({ ok: true, checked: 0, alerts: 0 });

  const serviceIds = services.map((s) => s.id as string);

  // Carica assignments con driver valorizzato
  const { data: assignments } = await admin
    .from("assignments")
    .select("service_id")
    .in("service_id", serviceIds)
    .not("driver_user_id", "is", null);

  const assignedIds = new Set((assignments ?? []).map((a) => a.service_id as string));
  const orphans = services.filter((s) => !assignedIds.has(s.id as string));

  if (!orphans.length) {
    return NextResponse.json({ ok: true, checked: services.length, alerts: 0 });
  }

  let sent = 0;

  for (const svc of orphans) {
    const tenantId  = svc.tenant_id as string;
    const serviceId = svc.id as string;

    // Dedup: già notificato in questa finestra?
    const { data: existing } = await admin
      .from("push_notification_log")
      .select("id")
      .eq("service_id", serviceId)
      .eq("kind", "sla_12h")
      .maybeSingle();

    if (existing) continue;

    const direction = svc.direction === "arrival" ? "Arrivo" : "Partenza";
    const hoursLeft = Math.max(0, Math.round(hoursUntil(svc.date as string, svc.time as string, now)));

    await sendPushToTenantRoles(tenantId, ["admin", "operator"], {
      title: `🚨 Senza autista — ${direction} ${svc.time as string}`,
      body:  `${svc.customer_name as string} · ${svc.pax as number} pax · fra ${hoursLeft}h`,
      url:   "/dispatch",
      tag:   `sla-${serviceId}`,
    });

    // Log dedup — user_id = sistema (ignora errori di conflitto)
    try {
      await admin.from("push_notification_log").insert({
        tenant_id:  tenantId,
        user_id:    SYSTEM_USER_ID,
        service_id: serviceId,
        kind:       "sla_12h",
      });
    } catch { /* conflitto unique constraint: già loggato */ }

    sent++;
  }

  return NextResponse.json({ ok: true, checked: services.length, orphans: orphans.length, sent });
}
