/**
 * POST /api/cron/agency-bus-monday
 *
 * Ogni lunedì invia alle agenzie il riepilogo dei servizi di linea bus
 * programmati per la domenica successiva.
 *
 * Header richiesto: Authorization: Bearer <CRON_SECRET>
 * Va eseguito ogni lunedì (es. alle 08:00).
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { buildServiceListEmailHtml } from "@/lib/server/service-list-email";
import type { ServiceLine } from "@/lib/server/service-list-email";
import { sendEmail } from "@/lib/server/send-email";

export const runtime = "nodejs";
export const maxDuration = 120;

function nextSunday(fromIso: string): string {
  const d = new Date(`${fromIso}T12:00:00Z`);
  // dow: 0=Dom, 1=Lun ... 6=Sab
  const dow = d.getUTCDay();
  // Se siamo lunedì (1), domenica prossima è tra 6 giorni
  const daysUntilSunday = dow === 0 ? 7 : 7 - dow;
  d.setUTCDate(d.getUTCDate() + daysUntilSunday);
  return d.toISOString().slice(0, 10);
}

function isMonday(iso: string): boolean {
  return new Date(`${iso}T12:00:00Z`).getUTCDay() === 1;
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

  const todayIso = new Date().toISOString().slice(0, 10);

  // Esegui solo il lunedì (protezione extra oltre al cron scheduler)
  if (!isMonday(todayIso)) {
    return NextResponse.json({ ok: true, skipped: true, reason: "not_monday", date: todayIso });
  }

  const sundayIso = nextSunday(todayIso);
  const sundayFormatted = sundayIso.split("-").reverse().join("/");

  const { data: tenants } = await admin.from("tenants").select("id");
  let sent = 0;
  let errors = 0;

  for (const tenant of tenants ?? []) {
    const tenantId = tenant.id as string;

    const { data: agencies } = await admin
      .from("agencies")
      .select("id, name, invoice_email, contact_email, booking_email, invoice_enabled")
      .eq("tenant_id", tenantId)
      .eq("active", true);

    const { data: hotels } = await admin
      .from("hotels")
      .select("id, name")
      .eq("tenant_id", tenantId)
      .limit(500);
    const hotelsById = new Map((hotels ?? []).map((h: { id: string; name: string }) => [h.id, h.name]));

    for (const agency of agencies ?? []) {
      const email = agency.invoice_email ?? agency.contact_email ?? agency.booking_email;
      if (!email || !agency.invoice_enabled) continue;

      // Servizi bus (booking_service_kind = bus_city_hotel oppure service_type_code = bus_line)
      // per la domenica prossima, filtrati per agenzia
      const { data: busServices } = await admin
        .from("services")
        .select("id, date, time, customer_name, customer_first_name, customer_last_name, pax, hotel_id, direction, booking_service_kind, service_type_code, bus_city_origin, transport_code, meeting_point")
        .eq("tenant_id", tenantId)
        .eq("is_draft", false)
        .ilike("billing_party_name", `%${agency.name}%`)
        .eq("date", sundayIso)
        .or("booking_service_kind.eq.bus_city_hotel,service_type_code.eq.bus_line")
        .order("time");

      if (!busServices || busServices.length === 0) continue;

      const lines: ServiceLine[] = busServices.map((s: Record<string, unknown>) => {
        const firstName = (s.customer_first_name as string | null)?.trim() ?? "";
        const lastName = (s.customer_last_name as string | null)?.trim() ?? "";
        const customerName = [firstName, lastName].filter(Boolean).join(" ") || (s.customer_name as string) || "—";
        return {
          date: s.date as string,
          time: (s.time as string | null) ?? "—",
          customer_name: customerName,
          pax: (s.pax as number) ?? 1,
          hotel_or_destination: hotelsById.get(s.hotel_id as string) ?? (s.meeting_point as string | null) ?? null,
          direction: s.direction === "departure" ? "departure" : "arrival",
          transport_type: (s.bus_city_origin as string | null) ?? null
        };
      });

      const html = buildServiceListEmailHtml({
        agencyName: agency.name as string,
        type: "bus_monday",
        targetDate: sundayFormatted,
        lines
      });

      try {
        await sendEmail({
          to: email as string,
          subject: `Linea bus domenica ${sundayFormatted} — ${agency.name}`,
          html,
        });
        sent++;
      } catch {
        errors++;
      }
    }
  }

  return NextResponse.json({ ok: true, sent, errors, today: todayIso, sunday: sundayIso });
}
