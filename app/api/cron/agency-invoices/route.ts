/**
 * POST /api/cron/agency-invoices
 *
 * Genera e invia automaticamente gli estratti conto alle agenzie
 * in base alla cadenza configurata (weekly / biweekly / monthly).
 *
 * Header richiesto: Authorization: Bearer <CRON_SECRET>
 * Va eseguito ogni giorno (es. alle 08:00).
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { generateInvoiceHtml, type InvoiceLineItem } from "@/lib/server/invoice-pdf";

export const runtime = "nodejs";
export const maxDuration = 120;

function subtractDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function shouldSendToday(cadence: string, sendDay: number, today: Date): boolean {
  const dow = today.getDay(); // 0=Dom, 1=Lun...
  if (cadence === "weekly") return dow === sendDay;
  if (cadence === "biweekly") {
    // Invia ogni due settimane nel giorno configurato
    const weekOfYear = Math.floor((today.getTime() - new Date(today.getFullYear(), 0, 1).getTime()) / (7 * 86400000));
    return dow === sendDay && weekOfYear % 2 === 0;
  }
  if (cadence === "monthly") {
    // Primo giorno del mese
    return today.getDate() === 1;
  }
  return false;
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

  const today = new Date();
  const todayIso = today.toISOString().slice(0, 10);

  const { data: tenants } = await admin.from("tenants").select("id").limit(50);
  let sent = 0;
  let skipped = 0;

  for (const tenant of tenants ?? []) {
    const tenantId = tenant.id as string;

    const { data: agencies } = await admin
      .from("agencies")
      .select("id, name, invoice_email, contact_email, booking_email, invoice_enabled, invoice_cadence, invoice_send_day")
      .eq("tenant_id", tenantId)
      .eq("active", true)
      .eq("invoice_enabled", true);

    for (const agency of agencies ?? []) {
      const email = agency.invoice_email ?? agency.contact_email ?? agency.booking_email;
      if (!email) { skipped++; continue; }

      const cadence = agency.invoice_cadence ?? "weekly";
      const sendDay = agency.invoice_send_day ?? 1;

      if (!shouldSendToday(cadence, sendDay, today)) { skipped++; continue; }

      // Calcola periodo
      let periodDays = cadence === "monthly" ? 30 : cadence === "biweekly" ? 14 : 7;
      const periodFrom = subtractDays(todayIso, periodDays);
      const periodTo = subtractDays(todayIso, 1);

      // Recupera servizi
      const { data: services } = await admin
        .from("services")
        .select("id, date, time, customer_name, customer_first_name, customer_last_name, booking_service_kind, service_type, notes, source_total_amount_cents")
        .eq("tenant_id", tenantId)
        .eq("is_draft", false)
        .ilike("billing_party_name", `%${agency.name}%`)
        .gte("date", periodFrom)
        .lte("date", periodTo)
        .order("date");

      if ((services ?? []).length === 0) { skipped++; continue; }

      const items: InvoiceLineItem[] = (services ?? []).map((s: any) => {
        const practiceMatch = (s.notes ?? "").match(/\[practice:([^\]]+)\]/);
        const clienteName = [s.customer_first_name, s.customer_last_name].filter(Boolean).join(" ") || s.customer_name || "—";
        return {
          numero_pratica: practiceMatch?.[1] ?? "—",
          cliente_nome: clienteName,
          data_servizio: s.date ?? periodFrom,
          tipo_servizio: s.booking_service_kind ?? s.service_type ?? "transfer",
          importo_cents: s.source_total_amount_cents ?? 0
        };
      });

      const totalCents = items.reduce((sum, i) => sum + i.importo_cents, 0);
      const createdAt = new Date().toISOString();

      // Salva fattura
      const { data: invoice } = await admin
        .from("agency_invoices")
        .insert({
          tenant_id: tenantId,
          agency_id: agency.id,
          agency_name: agency.name,
          period_from: periodFrom,
          period_to: periodTo,
          status: "sent",
          total_cents: totalCents,
          services_count: items.length,
          invoice_data: items,
          created_at: createdAt,
          sent_at: createdAt
        })
        .select("id")
        .single();

      const invoiceId = (invoice as any)?.id ?? "N/D";

      const html = generateInvoiceHtml({
        agencyName: agency.name,
        agencyEmail: email,
        periodFrom,
        periodTo,
        invoiceId,
        createdAt,
        items,
        totalCents
      });

      const months = ["gen","feb","mar","apr","mag","giu","lug","ago","set","ott","nov","dic"];
      const [fy, fm] = periodFrom.split("-");
      const [, tm] = periodTo.split("-");
      const periodLabel = fm === tm ? `${months[Number(fm)-1]} ${fy}` : `${months[Number(fm)-1]}-${months[Number(tm)-1]} ${fy}`;

      try {
        await sendEmail(
          email,
          `Estratto conto ${periodLabel} — ${agency.name}`,
          html
        );
        sent++;
      } catch { skipped++; }
    }
  }

  return NextResponse.json({ ok: true, sent, skipped, date: todayIso });
}
