/**
 * GET /api/admin/email-preview?template=otp|booking|reset|approval|report|invoice
 * Restituisce l'HTML del template richiesto con dati di esempio.
 * Solo per admin/supervisor in sviluppo/staging.
 */

import { NextRequest, NextResponse } from "next/server";
import { emailHtml } from "@/lib/server/email-layout";
import { generateInvoiceHtml } from "@/lib/server/invoice-pdf";

export const runtime = "nodejs";

const SAMPLES: Record<string, () => string> = {
  otp: () => emailHtml([
    `<p>Ciao <strong>Mario Rossi</strong>,</p>`,
    "<p>Hai ricevuto una richiesta di accesso al tuo account Ischia Transfer Service.</p>",
    "<p><strong>Codice di verifica (valido 10 minuti):</strong></p>",
    `<p style="word-break:break-word;font-family:monospace;background:#f0f4ff;border:2px solid #c7d7f0;padding:16px 20px;border-radius:10px;font-size:22px;letter-spacing:4px;text-align:center;color:#1e3a5f;">847291</p>`,
    "<p>Se non hai richiesto questo codice, ignora questo messaggio.</p>",
  ].join("")),

  booking: () => emailHtml([
    `<p>Ciao <strong>Famiglia Esposito</strong>,</p>`,
    "<p>abbiamo ricevuto la tua prenotazione Ischia Transfer.</p>",
    `<table style="width:100%;border-collapse:collapse;margin:16px 0;">`,
    `<tr><td style="padding:8px 12px;border:1px solid #e2e8f0;background:#f8fafc;font-weight:600;width:140px;">Servizio</td><td style="padding:8px 12px;border:1px solid #e2e8f0;">Transfer Porto → Hotel</td></tr>`,
    `<tr><td style="padding:8px 12px;border:1px solid #e2e8f0;background:#f8fafc;font-weight:600;">Hotel/Struttura</td><td style="padding:8px 12px;border:1px solid #e2e8f0;">Grand Hotel Excelsior</td></tr>`,
    `<tr><td style="padding:8px 12px;border:1px solid #e2e8f0;background:#f8fafc;font-weight:600;">Pax</td><td style="padding:8px 12px;border:1px solid #e2e8f0;">4</td></tr>`,
    `<tr><td style="padding:8px 12px;border:1px solid #e2e8f0;background:#f8fafc;font-weight:600;">Arrivo</td><td style="padding:8px 12px;border:1px solid #e2e8f0;">15/06/2026 14:30</td></tr>`,
    `<tr><td style="padding:8px 12px;border:1px solid #e2e8f0;background:#f8fafc;font-weight:600;">Partenza</td><td style="padding:8px 12px;border:1px solid #e2e8f0;">22/06/2026 10:00</td></tr>`,
    `<tr><td style="padding:8px 12px;border:1px solid #e2e8f0;background:#f8fafc;font-weight:600;">Note</td><td style="padding:8px 12px;border:1px solid #e2e8f0;">Bagaglio extra, bambino in passeggino</td></tr>`,
    `</table>`,
    "<p>Ti contatteremo per eventuali dettagli operativi.</p>",
  ].join("")),

  reset: () => emailHtml([
    `<p>Ciao <strong>Luca Renna</strong>,</p>`,
    "<p>abbiamo ricevuto una richiesta di reset password per il tuo accesso Ischia Transfer.</p>",
    `<p style="margin:24px 0;"><a href="#" style="display:inline-block;padding:14px 24px;border-radius:10px;background:#1e3a5f;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;">Imposta nuova password</a></p>`,
    `<p style="font-size:13px;color:#64748b;">Se il bottone non funziona, copia e incolla questo link nel browser:<br /><a href="#" style="color:#1e3a5f;">https://ischiatransferservice.it/reset-password?token=abc123...</a></p>`,
    "<p>Se non hai richiesto tu il reset, puoi ignorare questa email.</p>",
  ].join("")),

  approval: () => emailHtml([
    `<p>Ciao <strong>Giovanna Ferrari</strong>,</p>`,
    "<p>la tua richiesta di accesso è stata approvata.</p>",
    `<table style="width:100%;border-collapse:collapse;margin:16px 0;">`,
    `<tr><td style="padding:8px 12px;border:1px solid #e2e8f0;background:#f8fafc;font-weight:600;width:140px;">Ruolo assegnato</td><td style="padding:8px 12px;border:1px solid #e2e8f0;">Agenzia</td></tr>`,
    `<tr><td style="padding:8px 12px;border:1px solid #e2e8f0;background:#f8fafc;font-weight:600;">Agenzia</td><td style="padding:8px 12px;border:1px solid #e2e8f0;">Aleste Viaggi</td></tr>`,
    `</table>`,
    "<p>Ora puoi accedere alla tua area dedicata e inserire le prenotazioni agenzia.</p>",
    "<p>Se hai bisogno di supporto, contatta Ischia Transfer Service.</p>",
  ].join("")),

  report: () => {
    const rows = [
      ["15/06/2026", "09:00", "Arrivo", "Famiglia Bianchi", "Hotel Moresco", "3"],
      ["15/06/2026", "11:30", "Arrivo", "Coppia Verdi", "Hotel Regina Isabella", "2"],
      ["15/06/2026", "14:00", "Partenza", "Rossi Group", "Porto Ischia", "6"],
      ["16/06/2026", "08:45", "Arrivo", "Tour Esposito", "Hotel San Montano", "4"],
    ].map(([d,t,dir,c,h,p]) =>
      `<tr><td style="padding:8px 10px;border:1px solid #dbe3ea;">${d}</td><td style="padding:8px 10px;border:1px solid #dbe3ea;">${t}</td><td style="padding:8px 10px;border:1px solid #dbe3ea;">${dir}</td><td style="padding:8px 10px;border:1px solid #dbe3ea;">${c}</td><td style="padding:8px 10px;border:1px solid #dbe3ea;">${h}</td><td style="padding:8px 10px;border:1px solid #dbe3ea;text-align:right;">${p}</td></tr>`
    ).join("");
    const { emailHtml: wrap } = require("@/lib/server/email-layout");
    return wrap([
      `<p>Ciao <strong>Aleste Viaggi</strong>,</p>`,
      `<p>Ti inviamo il riepilogo arrivi +48h con target <strong>15/06/2026</strong>.</p>`,
      `<p><strong>Servizi nel lotto:</strong> 4 &nbsp;·&nbsp; <strong>Pax totali:</strong> 15</p>`,
      `<table style="border-collapse:collapse;width:100%;font-size:13px;margin-top:16px;">`,
      `<thead><tr style="background:#f1f5f9;"><th style="padding:8px 10px;border:1px solid #dbe3ea;text-align:left;">Data</th><th style="padding:8px 10px;border:1px solid #dbe3ea;text-align:left;">Ora</th><th style="padding:8px 10px;border:1px solid #dbe3ea;text-align:left;">Direzione</th><th style="padding:8px 10px;border:1px solid #dbe3ea;text-align:left;">Cliente</th><th style="padding:8px 10px;border:1px solid #dbe3ea;text-align:left;">Hotel</th><th style="padding:8px 10px;border:1px solid #dbe3ea;text-align:right;">Pax</th></tr></thead>`,
      `<tbody>${rows}</tbody></table>`,
    ].join(""));
  },

  invoice: () => generateInvoiceHtml({
    agencyName: "Aleste Viaggi S.r.l.",
    agencyEmail: "info@alesteviaggi.it",
    periodFrom: "2026-06-01",
    periodTo: "2026-06-30",
    invoiceId: "inv-2026-06-001",
    createdAt: "2026-07-01T08:00:00Z",
    totalCents: 184500,
    items: [
      { numero_pratica: "AV-2024-001", cliente_nome: "Famiglia Bianchi", data_servizio: "2026-06-05", tipo_servizio: "Transfer Porto→Hotel", importo_cents: 45000 },
      { numero_pratica: "AV-2024-002", cliente_nome: "Coppia Verdi", data_servizio: "2026-06-08", tipo_servizio: "Transfer Hotel→Porto", importo_cents: 38000 },
      { numero_pratica: "AV-2024-003", cliente_nome: "Rossi Group", data_servizio: "2026-06-12", tipo_servizio: "Bus Line", importo_cents: 52000 },
      { numero_pratica: "AV-2024-004", cliente_nome: "Tour Esposito", data_servizio: "2026-06-18", tipo_servizio: "Transfer Porto→Hotel", importo_cents: 49500 },
    ],
  }),
};

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const template = searchParams.get("template") ?? "booking";

  const generator = SAMPLES[template];
  if (!generator) {
    const list = Object.keys(SAMPLES).join(", ");
    return new NextResponse(`Template non trovato. Disponibili: ${list}`, { status: 404 });
  }

  const html = generator();
  return new NextResponse(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
