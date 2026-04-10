/**
 * GET  /api/agency/action?token=xxx  → restituisce dettagli servizio (per pagina conferma)
 * POST /api/agency/action            → esegue l'azione (cancel) + notifica operatore
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verifyAgencyActionToken } from "@/lib/server/agency-action-token";

export const runtime = "nodejs";

function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase non configurato.");
  return createClient(url, key, { auth: { persistSession: false } });
}

async function sendEmail(to: string, subject: string, html: string) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.AGENCY_BOOKING_FROM_EMAIL ?? "noreply@ischiatransferservice.it";
  if (!key) return;
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ from: `Ischia Transfer Service <${from}>`, to: [to], subject, html })
  });
}

export async function GET(request: NextRequest) {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const payload = verifyAgencyActionToken(token);
  if (!payload) {
    return NextResponse.json({ error: "Token non valido o scaduto." }, { status: 400 });
  }

  try {
    const admin = adminClient();
    const { data: service } = await admin
      .from("services")
      .select("id, date, time, customer_name, pax, status, direction, hotel_id, hotels(name)")
      .eq("id", payload.sid)
      .eq("tenant_id", payload.tid)
      .maybeSingle();

    if (!service) {
      return NextResponse.json({ error: "Servizio non trovato." }, { status: 404 });
    }

    const hotelName = Array.isArray(service.hotels) ? service.hotels[0]?.name : (service.hotels as { name?: string } | null)?.name ?? "N/D";

    return NextResponse.json({
      ok: true,
      service: {
        id: service.id,
        date: service.date,
        time: service.time,
        customer_name: service.customer_name,
        pax: service.pax,
        status: service.status,
        direction: service.direction,
        hotel_name: hotelName
      },
      action: payload.act
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Errore." }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null) as { token?: string; reason?: string } | null;
    const token = body?.token ?? "";
    const reason = (body?.reason ?? "").trim();

    const payload = verifyAgencyActionToken(token);
    if (!payload || payload.act !== "cancel") {
      return NextResponse.json({ error: "Token non valido o scaduto." }, { status: 400 });
    }

    const admin = adminClient();

    // Verifica il servizio
    const { data: service } = await admin
      .from("services")
      .select("id, date, time, customer_name, pax, status, direction, hotel_id, hotels(name), agency_id, agencies(name)")
      .eq("id", payload.sid)
      .eq("tenant_id", payload.tid)
      .maybeSingle();

    if (!service) {
      return NextResponse.json({ error: "Servizio non trovato." }, { status: 404 });
    }
    if (service.status === "cancelled") {
      return NextResponse.json({ ok: true, already_cancelled: true });
    }

    // Annulla il servizio
    await admin
      .from("services")
      .update({ status: "cancelled" })
      .eq("id", payload.sid)
      .eq("tenant_id", payload.tid);

    // Crea status_event
    await admin.from("status_events").insert({
      tenant_id: payload.tid,
      service_id: payload.sid,
      status: "cancelled",
      by_user_id: payload.aid // usa agency_id come proxy dell'utente
    });

    // Notifica operatore via email
    const operatorEmail = process.env.OPERATOR_NOTIFICATION_EMAIL
      ?? process.env.AGENCY_BOOKING_FROM_EMAIL
      ?? null;

    if (operatorEmail) {
      const hotelName = Array.isArray(service.hotels) ? service.hotels[0]?.name : (service.hotels as { name?: string } | null)?.name ?? "N/D";
      const agencyName = Array.isArray(service.agencies) ? service.agencies[0]?.name : (service.agencies as { name?: string } | null)?.name ?? "Agenzia";
      const dirLabel = service.direction === "arrival" ? "Arrivo" : "Partenza";
      const dateFormatted = (service.date as string)?.split("-").reverse().join("/") ?? service.date;

      await sendEmail(
        operatorEmail,
        `⚠️ Annullamento richiesto — ${agencyName} — ${dateFormatted}`,
        `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px;">
          <h2 style="color:#991b1b;margin-bottom:8px;">Annullamento servizio</h2>
          <p style="color:#475569;">L'agenzia <strong>${agencyName}</strong> ha richiesto l'annullamento del seguente servizio:</p>
          <table style="width:100%;border-collapse:collapse;margin:20px 0;">
            <tr><td style="padding:8px 12px;background:#f8fafc;font-weight:600;width:40%;">Cliente</td><td style="padding:8px 12px;">${service.customer_name}</td></tr>
            <tr><td style="padding:8px 12px;background:#f1f5f9;font-weight:600;">Data / Ora</td><td style="padding:8px 12px;">${dateFormatted} alle ${service.time}</td></tr>
            <tr><td style="padding:8px 12px;background:#f8fafc;font-weight:600;">Tipo</td><td style="padding:8px 12px;">${dirLabel}</td></tr>
            <tr><td style="padding:8px 12px;background:#f1f5f9;font-weight:600;">Hotel</td><td style="padding:8px 12px;">${hotelName}</td></tr>
            <tr><td style="padding:8px 12px;background:#f8fafc;font-weight:600;">Pax</td><td style="padding:8px 12px;">${service.pax}</td></tr>
            ${reason ? `<tr><td style="padding:8px 12px;background:#fef9c3;font-weight:600;color:#854d0e;">Motivo</td><td style="padding:8px 12px;color:#854d0e;">${reason}</td></tr>` : ""}
          </table>
          <p style="color:#64748b;font-size:13px;">Il servizio è stato marcato come <strong>Annullato</strong> nel sistema. Verifica in dashboard.</p>
        </div>`
      );
    }

    return NextResponse.json({ ok: true, cancelled: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Errore." }, { status: 500 });
  }
}
