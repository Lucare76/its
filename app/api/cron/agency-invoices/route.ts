import { buildInvoiceServiceDescription, type InvoiceServiceContext } from "@/lib/invoice-service-label";
/**
 * GET / POST /api/cron/agency-invoices
 *
 * Genera e invia automaticamente gli estratti conto alle agenzie
 * in base alla cadenza configurata (weekly / biweekly / monthly).
 *
 * Header richiesto: Authorization: Bearer <CRON_SECRET>
 * Va eseguito ogni giorno (es. alle 08:00).
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { generateInvoiceHtml, buildInvoiceXlsx, type InvoiceLineItem } from "@/lib/server/invoice-pdf";
import { sendEmail } from "@/lib/server/send-email";
import { getConfiguredAppUrl } from "@/lib/app-url";
import { generateAgencyActionToken } from "@/lib/server/agency-action-token";
import { previousAgencyInvoicePeriod, scheduledAgencyInvoiceId } from "@/lib/server/agency-email-schedule";

export const runtime = "nodejs";
export const maxDuration = 120;

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

  const today = new Date();
  const todayIso = today.toISOString().slice(0, 10);

  const { data: tenants, error: tenantsError } = await admin.from("tenants").select("id");
  if (tenantsError) return NextResponse.json({ ok: false, error: "Impossibile leggere i tenant." }, { status: 500 });
  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const tenant of tenants ?? []) {
    const tenantId = tenant.id as string;

    const { data: agencies, error: agenciesError } = await admin
      .from("agencies")
      .select("id, name, invoice_email, contact_email, booking_email, invoice_enabled, invoice_cadence, invoice_send_day")
      .eq("tenant_id", tenantId)
      .eq("active", true)
      .eq("invoice_enabled", true);
    if (agenciesError) { failed++; continue; }

    for (const agency of agencies ?? []) {
      const email = agency.invoice_email ?? agency.contact_email ?? agency.booking_email;
      if (!email) { skipped++; continue; }

      const cadence = agency.invoice_cadence ?? "weekly";
      const sendDay = agency.invoice_send_day ?? 1;

      if (!shouldSendToday(cadence, sendDay, today)) { skipped++; continue; }

      // Calcola periodo
      const { periodFrom, periodTo } = previousAgencyInvoicePeriod(cadence, todayIso);

      // Un documento già presente (anche una bozza manuale) va verificato o
      // reinviato dall'operatore, senza generare un secondo estratto automatico.
      const { data: existing, error: existingError } = await admin
        .from("agency_invoices")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("agency_id", agency.id)
        .eq("period_from", periodFrom)
        .eq("period_to", periodTo)
        .limit(1)
        .maybeSingle();
      if (existingError) { failed++; continue; }
      if (existing) { skipped++; continue; }

      // Recupera servizi
      const { data: services, error: servicesError } = await admin
        .from("services")
        .select("id, date, time, customer_name, customer_first_name, customer_last_name, booking_service_kind, service_type, vessel, transport_code, include_ferry_tickets, ferry_details, bus_city_origin, notes, source_total_amount_cents, agency_quoted_price_cents, practice_number, pax")
        .eq("tenant_id", tenantId)
        .eq("is_draft", false)
        .ilike("billing_party_name", `%${agency.name}%`)
        .gte("date", periodFrom)
        .lte("date", periodTo)
        .order("date");
      if (servicesError) { failed++; continue; }

      if ((services ?? []).length === 0) { skipped++; continue; }

      type SvcRow = InvoiceServiceContext & { id: string; date: string | null; time: string | null; customer_name: string | null; customer_first_name: string | null; customer_last_name: string | null; booking_service_kind: string | null; service_type: string | null; notes: string | null; source_total_amount_cents: number | null; agency_quoted_price_cents: number | null; practice_number: string | null; pax: number | null; };
      const items: InvoiceLineItem[] = (services ?? []).map((s: SvcRow) => {
        // Stessa priorita' di app/api/invoices/route.ts: numero pratica
        // dell'agenzia (dal loro PDF) se presente, altrimenti il numero
        // ITS-YYYY-N se la pratica e' stata inserita a mano.
        const practiceMatch = (s.notes ?? "").match(/\[practice:([^\]]+)\]/);
        const clienteName = [s.customer_first_name, s.customer_last_name].filter(Boolean).join(" ") || s.customer_name || "—";
        return {
          service_id: s.id,
          numero_pratica: practiceMatch?.[1] ?? s.practice_number ?? "—",
          cliente_nome: clienteName,
          data_servizio: s.date ?? periodFrom,
          tipo_servizio: s.booking_service_kind ?? s.service_type ?? "transfer",
          descrizione_servizio: buildInvoiceServiceDescription(s),
          pax: s.pax ?? null,
          // Stessa priorita' di app/api/invoices/route.ts: prezzo concordato
          // con l'agenzia prima del costo interno.
          importo_cents: s.agency_quoted_price_cents ?? s.source_total_amount_cents ?? 0
        };
      });

      const totalCents = items.reduce((sum, i) => sum + i.importo_cents, 0);
      const createdAt = new Date().toISOString();

      // Salva fattura
      const { data: invoice, error: insertError } = await admin
        .from("agency_invoices")
        .insert({
          id: scheduledAgencyInvoiceId(tenantId, agency.id, periodFrom, periodTo),
          tenant_id: tenantId,
          agency_id: agency.id,
          agency_name: agency.name,
          period_from: periodFrom,
          period_to: periodTo,
          status: "draft",
          total_cents: totalCents,
          services_count: items.length,
          invoice_data: items,
          created_at: createdAt
        })
        .select("id")
        .single();

      // Due esecuzioni possono superare insieme la lettura precedente:
      // soltanto una vince l'inserimento sulla stessa PK deterministica.
      if (insertError?.code === "23505") { skipped++; continue; }
      if (insertError || !invoice?.id) { failed++; continue; }
      const invoiceId = invoice.id;

      // Link con token (funziona senza login, valido anche per agenzie
      // senza account nell'area agenzia) quando l'insert e' andato a buon
      // fine, altrimenti fallback alla pagina che richiede login. Se la
      // generazione del token fallisce, non deve mai bloccare l'invio.
      const cronAppUrl = getConfiguredAppUrl() ?? "https://ischia-transfer.vercel.app";
      let reviewUrl = `${cronAppUrl}/agency/statement`;
      if (invoice?.id) {
        try {
          const token = generateAgencyActionToken({ sid: "", aid: agency.id, tid: tenantId, act: "invoice_review", iid: invoice.id }, 60);
          reviewUrl = `${cronAppUrl}/agency-estratto-conto?token=${encodeURIComponent(token)}`;
        } catch { /* fallback gia' impostato sopra */ }
      }
      const invoiceData = {
        agencyName: agency.name,
        agencyEmail: email,
        periodFrom,
        periodTo,
        invoiceId,
        createdAt,
        items,
        totalCents,
        reviewUrl
      };
      const html = generateInvoiceHtml(invoiceData);
      const xlsxBuffer = buildInvoiceXlsx(invoiceData);
      const xlsxFilename = `estratto_conto_${String(agency.name).replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").toLowerCase()}_${periodFrom}_${periodTo}.xlsx`;

      const months = ["gen","feb","mar","apr","mag","giu","lug","ago","set","ott","nov","dic"];
      const [fy, fm] = periodFrom.split("-");
      const [, tm] = periodTo.split("-");
      const periodLabel = fm === tm ? `${months[Number(fm)-1]} ${fy}` : `${months[Number(fm)-1]}-${months[Number(tm)-1]} ${fy}`;

      try {
        const result = await sendEmail({
          to: email,
          subject: `Estratto conto ${periodLabel} — ${agency.name}`,
          html,
          attachments: [{ filename: xlsxFilename, content: xlsxBuffer.toString("base64") }],
        });
        if (!result.ok || result.skipped) { failed++; continue; }
        const { error: updateError } = await admin
          .from("agency_invoices")
          .update({ status: "sent", sent_at: new Date().toISOString() })
          .eq("id", invoiceId)
          .eq("tenant_id", tenantId);
        if (updateError) { failed++; continue; }
        sent++;
      } catch { failed++; }
    }
  }

  return NextResponse.json({ ok: failed === 0, sent, skipped, failed, date: todayIso }, { status: failed > 0 ? 500 : 200 });
}

// Vercel Cron richiama le route con GET. La stessa autenticazione resta obbligatoria.
export async function GET(request: NextRequest) {
  return POST(request);
}
