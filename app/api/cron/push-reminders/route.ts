/**
 * GET /api/cron/push-reminders
 * Invia notifiche push 2 ore prima di ogni servizio assegnato a un driver.
 * Vercel Cron: ogni 15 minuti (via cron-job.org su Hobby plan)
 *
 * Chiamato da Vercel con header  Authorization: Bearer CRON_SECRET
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { sendPushToUser } from "@/lib/server/web-push";

export const runtime = "nodejs";
export const maxDuration = 60;

function adminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/^["']|["']$/g, "")!,
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim().replace(/^["']|["']$/g, "")!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

function padTime(n: number) { return String(n).padStart(2, "0"); }

export async function GET(request: NextRequest) {
  // Autorizzazione cron
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
  const todayIso = now.toISOString().slice(0, 10);

  // Finestra: servizi che iniziano tra 1h45m e 2h15m da adesso
  const winStart = new Date(now.getTime() + 105 * 60_000);
  const winEnd   = new Date(now.getTime() + 135 * 60_000);
  const timeStart = `${padTime(winStart.getHours())}:${padTime(winStart.getMinutes())}`;
  const timeEnd   = `${padTime(winEnd.getHours())}:${padTime(winEnd.getMinutes())}`;

  // Prendo tutte le assegnazioni con il servizio corrispondente nella finestra
  const { data: assignments, error } = await admin
    .from("assignments")
    .select("id, service_id, driver_user_id, tenant_id, services!inner(id, date, time, status, customer_name, pax, direction, tenant_id)")
    .eq("services.date", todayIso)
    .gte("services.time", timeStart)
    .lte("services.time", timeEnd)
    .not("driver_user_id", "is", null);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  if (!assignments?.length) {
    return NextResponse.json({ ok: true, sent: 0, window: `${timeStart}–${timeEnd}` });
  }

  let sent = 0;

  for (const asgn of assignments) {
    const svc = asgn.services as unknown as Record<string, unknown>;
    const status = svc.status as string;

    // Salta servizi già completati/cancellati
    if (status === "completato" || status === "cancelled") continue;

    const tenantId  = svc.tenant_id as string;
    const serviceId = asgn.service_id as string;
    const driverUid = asgn.driver_user_id as string;

    // Controlla duplicato nel log
    const { data: existing } = await admin
      .from("push_notification_log")
      .select("id")
      .eq("service_id", serviceId)
      .eq("user_id", driverUid)
      .eq("kind", "reminder_2h")
      .maybeSingle();

    if (existing) continue;

    const direction = svc.direction === "arrival" ? "Arrivo" : "Partenza";
    const time = svc.time as string;
    const name = svc.customer_name as string;
    const pax  = svc.pax as number;

    await sendPushToUser(tenantId, driverUid, {
      title: `⏰ Tra 2 ore — ${direction} ${time}`,
      body: `${name} · ${pax} pax`,
      url: `/driver/${serviceId}`,
      tag: `reminder-${serviceId}`,
    });

    // Log per evitare duplicati (ignora conflitto se già esiste)
    await admin.from("push_notification_log").upsert(
      { tenant_id: tenantId, user_id: driverUid, service_id: serviceId, kind: "reminder_2h" },
      { onConflict: "service_id,user_id,kind", ignoreDuplicates: true }
    );

    sent++;
  }

  return NextResponse.json({ ok: true, sent, window: `${timeStart}–${timeEnd}` });
}
