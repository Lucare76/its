/**
 * POST /api/cron/agency-reminders
 *
 * Invia riepilogo servizi alle agenzie:
 * - 48h prima per tutti i giorni
 * - 24h prima aggiuntivo per la domenica
 *
 * Chiamato dal cron scheduler (es. Vercel Cron o esterno).
 * Header richiesto: Authorization: Bearer <CRON_SECRET>
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { generateReminderEmailHtml } from "@/lib/server/invoice-pdf";

export const runtime = "nodejs";
export const maxDuration = 120;

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function isSunday(iso: string): boolean {
  return new Date(`${iso}T12:00:00Z`).getUTCDay() === 0;
}

async function sendEmail(to: string, subject: string, html: string) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.AGENCY_BOOKING_FROM_EMAIL ?? "noreply@ischiatransfer.it";
  if (!key) return;
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ from: `Ischia Transfer Service <${from}>`, to: [to], subject, html })
  });
}

export async function POST(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRole) return NextResponse.json({ ok: false, error: "Missing env" }, { status: 500 });

  const admin = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false } });

  const today = new Date().toISOString().slice(0, 10);
  const date48h = addDays(today, 2);
  const date24h = addDays(today, 1);
  const isSunday48h = isSunday(date48h);

  // Recupera tutti i tenant
  const { data: tenants } = await admin.from("tenants").select("id").limit(50);
  let sent = 0;
  let errors = 0;

  for (const tenant of tenants ?? []) {
    const tenantId = tenant.id as string;

    // Recupera agenzie con reminder abilitato
    const { data: agencies } = await admin
      .from("agencies")
      .select("id, name, invoice_email, contact_email, booking_email, invoice_enabled")
      .eq("tenant_id", tenantId)
      .eq("active", true);

    // Recupera hotel per nome
    const { data: hotels } = await admin.from("hotels").select("id, name").eq("tenant_id", tenantId).limit(500);
    const hotelsById = new Map((hotels ?? []).map((h: any) => [h.id, h.name]));

    for (const agency of agencies ?? []) {
      const email = agency.invoice_email ?? agency.contact_email ?? agency.booking_email;
      if (!email || !agency.invoice_enabled) continue;

      // Servizi nelle prossime 48h
      const { data: services48h } = await admin
        .from("services")
        .select("customer_name, date, time, direction, hotel_id")
        .eq("tenant_id", tenantId)
        .eq("is_draft", false)
        .ilike("billing_party_name", `%${agency.name}%`)
        .eq("date", date48h)
        .order("time");

      if ((services48h ?? []).length > 0) {
        const serviceList = (services48h ?? []).map((s: any) => ({
          customer_name: s.customer_name,
          date: s.date,
          time: s.time,
          direction: s.direction,
          hotel: hotelsById.get(s.hotel_id) ?? undefined
        }));
        try {
          await sendEmail(
            email,
            `Riepilogo servizi ${date48h.split("-").reverse().join("/")} — ${agency.name}`,
            generateReminderEmailHtml(agency.name, serviceList, 48)
          );
          sent++;
        } catch { errors++; }
      }

      // Extra 24h per domenica
      if (isSunday48h) {
        const { data: services24h } = await admin
          .from("services")
          .select("customer_name, date, time, direction, hotel_id")
          .eq("tenant_id", tenantId)
          .eq("is_draft", false)
          .ilike("billing_party_name", `%${agency.name}%`)
          .eq("date", date24h)
          .order("time");

        if ((services24h ?? []).length > 0) {
          const serviceList = (services24h ?? []).map((s: any) => ({
            customer_name: s.customer_name,
            date: s.date,
            time: s.time,
            direction: s.direction,
            hotel: hotelsById.get(s.hotel_id) ?? undefined
          }));
          try {
            await sendEmail(
              email,
              `Riepilogo domenica ${date24h.split("-").reverse().join("/")} — ${agency.name}`,
              generateReminderEmailHtml(agency.name, serviceList, 24)
            );
            sent++;
          } catch { errors++; }
        }
      }
    }
  }

  return NextResponse.json({ ok: true, sent, errors, date48h, date24h, sunday_extra: isSunday48h });
}
