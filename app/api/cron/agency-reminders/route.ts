/**
 * GET / POST /api/cron/agency-reminders
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
import { buildServiceListEmailHtml } from "@/lib/server/service-list-email";
import { generateAgencyActionToken } from "@/lib/server/agency-action-token";
import { sendEmail } from "@/lib/server/send-email";

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


export async function POST(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/^["']|["']$/g, "");
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim().replace(/^["']|["']$/g, "");
  if (!supabaseUrl || !serviceRole) return NextResponse.json({ ok: false, error: "Missing env" }, { status: 500 });

  const admin = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false } });

  const today = new Date().toISOString().slice(0, 10);
  const date48h = addDays(today, 2);
  const date24h = addDays(today, 1);
  const sundayExtra = isSunday(date24h);

  // Recupera tutti i tenant
  const { data: tenants, error: tenantsError } = await admin.from("tenants").select("id");
  if (tenantsError) return NextResponse.json({ ok: false, error: "Impossibile leggere i tenant." }, { status: 500 });
  let sent = 0;
  let errors = 0;

  for (const tenant of tenants ?? []) {
    const tenantId = tenant.id as string;

    // Recupera agenzie con reminder abilitato
    const { data: agencies, error: agenciesError } = await admin
      .from("agencies")
      .select("id, name, invoice_email, contact_email, booking_email, invoice_enabled")
      .eq("tenant_id", tenantId)
      .eq("active", true);
    if (agenciesError) { errors++; continue; }

    // Recupera hotel per nome
    const { data: hotels, error: hotelsError } = await admin.from("hotels").select("id, name").eq("tenant_id", tenantId).limit(500);
    if (hotelsError) { errors++; continue; }
    const hotelsById = new Map((hotels ?? []).map((h: { id: string; name: string }) => [h.id, h.name]));

    for (const agency of agencies ?? []) {
      const email = agency.invoice_email ?? agency.contact_email ?? agency.booking_email;
      if (!email || !agency.invoice_enabled) continue;

      const appBaseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://ischiatransferservice.it";

      // Servizi nelle prossime 48h
      const { data: services48h, error: services48hError } = await admin
        .from("services")
        .select("id, customer_name, date, time, direction, hotel_id, pax")
        .eq("tenant_id", tenantId)
        .eq("is_draft", false)
        .ilike("billing_party_name", `%${agency.name}%`)
        .eq("date", date48h)
        .order("time");
      if (services48hError) { errors++; continue; }

      if ((services48h ?? []).length > 0) {
        const cancelTokens48: Record<string, string> = {};
        const serviceList = (services48h ?? []).map((s: { id: string; customer_name: string | null; date: string | null; time: string | null; direction: string | null; hotel_id: string | null; pax: number | null }) => {
          const token = generateAgencyActionToken({ sid: s.id, aid: agency.id, tid: tenantId, act: "cancel" });
          cancelTokens48[s.id] = token;
          return {
            service_id: s.id,
            customer_name: s.customer_name ?? "",
            date: s.date ?? "",
            time: s.time ?? "",
            direction: s.direction as "arrival" | "departure",
            hotel_or_destination: hotelsById.get(s.hotel_id ?? "") ?? null,
            pax: s.pax ?? 1,
          };
        });
        try {
          const result = await sendEmail({
            to: email,
            subject: `Riepilogo servizi ${date48h.split("-").reverse().join("/")} — ${agency.name}`,
            html: buildServiceListEmailHtml({
              agencyName: agency.name,
              type: "reminder_48h",
              targetDate: date48h.split("-").reverse().join("/"),
              lines: serviceList,
              cancelTokens: cancelTokens48,
              appBaseUrl,
            }),
          });
          if (result.ok && !result.skipped) sent++;
          else errors++;
        } catch { errors++; }
      }

      // Extra 24h per domenica
      if (sundayExtra) {
        const { data: services24h, error: services24hError } = await admin
          .from("services")
          .select("id, customer_name, date, time, direction, hotel_id, pax")
          .eq("tenant_id", tenantId)
          .eq("is_draft", false)
          .ilike("billing_party_name", `%${agency.name}%`)
          .eq("date", date24h)
          .order("time");
        if (services24hError) { errors++; continue; }

        if ((services24h ?? []).length > 0) {
          const cancelTokens24: Record<string, string> = {};
          const serviceList = (services24h ?? []).map((s: { id: string; customer_name: string | null; date: string | null; time: string | null; direction: string | null; hotel_id: string | null; pax: number | null }) => {
            const token = generateAgencyActionToken({ sid: s.id, aid: agency.id, tid: tenantId, act: "cancel" });
            cancelTokens24[s.id] = token;
            return {
              service_id: s.id,
              customer_name: s.customer_name ?? "",
              date: s.date ?? "",
              time: s.time ?? "",
              direction: s.direction as "arrival" | "departure",
              hotel_or_destination: hotelsById.get(s.hotel_id ?? "") ?? null,
              pax: s.pax ?? 1,
            };
          });
          try {
            const result = await sendEmail({
              to: email,
              subject: `Riepilogo domenica ${date24h.split("-").reverse().join("/")} — ${agency.name}`,
              html: buildServiceListEmailHtml({
                agencyName: agency.name,
                type: "reminder_24h",
                targetDate: date24h.split("-").reverse().join("/"),
                lines: serviceList,
                cancelTokens: cancelTokens24,
                appBaseUrl,
              }),
            });
            if (result.ok && !result.skipped) sent++;
            else errors++;
          } catch { errors++; }
        }
      }
    }
  }

  return NextResponse.json({ ok: errors === 0, sent, errors, date48h, date24h, sunday_extra: sundayExtra }, { status: errors > 0 ? 500 : 200 });
}

export async function GET(request: NextRequest) {
  return POST(request);
}
