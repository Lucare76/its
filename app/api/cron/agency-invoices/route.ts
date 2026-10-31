import { createStatement, statementData } from "@/lib/server/agency-statements";
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
import {
  generateInvoiceHtml,
  buildInvoiceXlsx,
} from "@/lib/server/invoice-pdf";
import { sendEmail } from "@/lib/server/send-email";
import { getConfiguredAppUrl } from "@/lib/app-url";
import { generateAgencyActionToken } from "@/lib/server/agency-action-token";
import { previousAgencyInvoicePeriod } from "@/lib/server/agency-email-schedule";

export const runtime = "nodejs";
export const maxDuration = 120;

function shouldSendToday(
  cadence: string,
  sendDay: number,
  today: Date,
): boolean {
  const dow = today.getDay(); // 0=Dom, 1=Lun...
  if (cadence === "weekly") return dow === sendDay;
  if (cadence === "biweekly") {
    // Invia ogni due settimane nel giorno configurato
    const weekOfYear = Math.floor(
      (today.getTime() - new Date(today.getFullYear(), 0, 1).getTime()) /
        (7 * 86400000),
    );
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
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(
    /^["']|["']$/g,
    "",
  );
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim().replace(
    /^["']|["']$/g,
    "",
  );
  if (!supabaseUrl || !serviceRole)
    return NextResponse.json(
      { ok: false, error: "Missing env" },
      { status: 500 },
    );

  const admin = createClient(supabaseUrl, serviceRole, {
    auth: { persistSession: false },
  });

  const today = new Date();
  const todayIso = today.toISOString().slice(0, 10);

  const { data: tenants, error: tenantsError } = await admin
    .from("tenants")
    .select("id");
  if (tenantsError)
    return NextResponse.json(
      { ok: false, error: "Impossibile leggere i tenant." },
      { status: 500 },
    );
  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const tenant of tenants ?? []) {
    const tenantId = tenant.id as string;

    const { data: agencies, error: agenciesError } = await admin
      .from("agencies")
      .select(
        "id, name, invoice_email, contact_email, booking_email, invoice_enabled, invoice_cadence, invoice_send_day",
      )
      .eq("tenant_id", tenantId)
      .eq("active", true)
      .eq("invoice_enabled", true);
    if (agenciesError) {
      failed++;
      continue;
    }

    for (const agency of agencies ?? []) {
      const email =
        agency.invoice_email ?? agency.contact_email ?? agency.booking_email;
      if (!email) {
        skipped++;
        continue;
      }

      const cadence = agency.invoice_cadence ?? "weekly";
      const sendDay = agency.invoice_send_day ?? 1;

      if (!shouldSendToday(cadence, sendDay, today)) {
        skipped++;
        continue;
      }

      // Calcola periodo
      const { periodFrom, periodTo } = previousAgencyInvoicePeriod(
        cadence,
        todayIso,
      );

      let invoice;
      try {
        const result = await createStatement(
          admin,
          tenantId,
          agency.id,
          periodFrom,
          periodTo,
          "arrival",
        );
        if (result.reused) {
          skipped++;
          continue;
        }
        invoice = result.invoice;
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("STATEMENT_NO_SERVICES")
        )
          skipped++;
        else failed++;
        continue;
      }
      const invoiceId = invoice.id;
      // Link con token (funziona senza login, valido anche per agenzie
      // senza account nell'area agenzia) quando l'insert e' andato a buon
      // fine, altrimenti fallback alla pagina che richiede login. Se la
      // generazione del token fallisce, non deve mai bloccare l'invio.
      const cronAppUrl =
        getConfiguredAppUrl() ?? "https://ischia-transfer.vercel.app";
      let reviewUrl = `${cronAppUrl}/agency/statement`;
      if (invoice?.id) {
        try {
          const token = generateAgencyActionToken(
            {
              sid: "",
              aid: agency.id,
              tid: tenantId,
              act: "invoice_review",
              iid: invoice.id,
            },
            60,
          );
          reviewUrl = `${cronAppUrl}/agency-estratto-conto?token=${encodeURIComponent(token)}`;
        } catch {
          /* fallback gia' impostato sopra */
        }
      }
      const invoiceData = statementData(invoice, email, reviewUrl);
      const html = generateInvoiceHtml(invoiceData);
      const xlsxBuffer = buildInvoiceXlsx(invoiceData);
      const xlsxFilename = `estratto_conto_${String(agency.name)
        .replace(/[^a-z0-9]+/gi, "_")
        .replace(/^_+|_+$/g, "")
        .toLowerCase()}_${periodFrom}_${periodTo}.xlsx`;

      const months = [
        "gen",
        "feb",
        "mar",
        "apr",
        "mag",
        "giu",
        "lug",
        "ago",
        "set",
        "ott",
        "nov",
        "dic",
      ];
      const [fy, fm] = periodFrom.split("-");
      const [, tm] = periodTo.split("-");
      const periodLabel =
        fm === tm
          ? `${months[Number(fm) - 1]} ${fy}`
          : `${months[Number(fm) - 1]}-${months[Number(tm) - 1]} ${fy}`;

      try {
        const result = await sendEmail({
          to: email,
          subject: `Estratto conto ${invoice.invoice_number} (${periodLabel}) — ${agency.name}`,
          html,
          attachments: [
            { filename: xlsxFilename, content: xlsxBuffer.toString("base64") },
          ],
        });
        if (!result.ok || result.skipped) {
          failed++;
          continue;
        }
        const { error: updateError } = await admin
          .from("agency_invoices")
          .update({
            status:
              invoice.paid_cents + invoice.waived_cents >= invoice.total_cents
                ? "paid"
                : "sent",
            sent_at: new Date().toISOString(),
          })
          .eq("id", invoiceId)
          .eq("tenant_id", tenantId);
        if (updateError) {
          failed++;
          continue;
        }
        sent++;
      } catch {
        failed++;
      }
    }
  }

  return NextResponse.json(
    { ok: failed === 0, sent, skipped, failed, date: todayIso },
    { status: failed > 0 ? 500 : 200 },
  );
}

// Vercel Cron richiama le route con GET. La stessa autenticazione resta obbligatoria.
export async function GET(request: NextRequest) {
  return POST(request);
}
