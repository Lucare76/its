/**
 * GET /api/admin/email-preview?template=otp|booking|reset|approval|report|invoice|reminder
 * Restituisce l'HTML del template richiesto con dati di esempio.
 * Solo per admin/supervisor in sviluppo/staging.
 */

import { NextRequest, NextResponse } from "next/server";
import { emailHtml, emailButton, emailHighlightBox, emailDataTable } from "@/lib/server/email-layout";
import { generateInvoiceHtml, generateReminderEmailHtml } from "@/lib/server/invoice-pdf";

export const runtime = "nodejs";

function buildOtpSample(): string {
  return emailHtml(`
    <p style="font-size:17px;margin-bottom:8px;">Ciao <strong>Mario Rossi</strong>,</p>
    <p style="color:#475569;margin-bottom:24px;">Hai richiesto un codice di accesso per <strong>Ischia Transfer Service</strong>. Usa il codice qui sotto per completare il login.</p>
    ${emailHighlightBox(`
      <div style="font-size:11px;font-weight:700;letter-spacing:0.2em;text-transform:uppercase;color:#64748b;margin-bottom:12px;">Il tuo codice di verifica</div>
      <div style="font-family:'Courier New',monospace;font-size:38px;font-weight:800;letter-spacing:10px;color:#0f2744;">847291</div>
      <div style="font-size:12px;color:#94a3b8;margin-top:12px;">⏱ Valido per 10 minuti</div>
    `)}
    <p style="font-size:13px;color:#94a3b8;border-top:1px solid #f1f5f9;padding-top:20px;margin-top:8px;">
      Se non hai richiesto questo codice, ignora questa email. Il tuo account è al sicuro.
    </p>
  `, { title: "Codice di verifica — Ischia Transfer", preheader: "Il tuo codice è 847291" });
}

function buildBookingSample(): string {
  return emailHtml(`
    <p style="font-size:17px;margin-bottom:6px;">Ciao <strong>Famiglia Esposito</strong>,</p>
    <p style="color:#475569;margin-bottom:24px;">La tua prenotazione è stata ricevuta con successo. Di seguito il riepilogo del servizio.</p>
    <div style="background:linear-gradient(135deg,#0f2744,#1e3a5f);border-radius:14px;padding:20px 24px;margin-bottom:24px;">
      <div style="font-size:11px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:rgba(255,255,255,0.5);margin-bottom:6px;">Servizio prenotato</div>
      <div style="font-size:22px;font-weight:800;color:#ffffff;">Transfer Porto → Hotel</div>
      <div style="font-size:14px;color:rgba(255,255,255,0.7);margin-top:4px;">📍 Grand Hotel Excelsior</div>
    </div>
    ${emailDataTable([
      ["👥 Passeggeri", "4 persone"],
      ["✈️ Arrivo", "15/06/2026 alle 14:30"],
      ["🏠 Partenza", "22/06/2026 alle 10:00"],
      ["📝 Note", "Bagaglio extra, bambino in passeggino"],
    ])}
    <p style="color:#475569;margin-top:20px;">Il nostro team ti contatterà per eventuali dettagli operativi. Grazie per aver scelto Ischia Transfer Service!</p>
  `, { title: "Conferma prenotazione — Ischia Transfer", preheader: "Prenotazione confermata — Grand Hotel Excelsior, 15/06/2026" });
}

function buildResetSample(): string {
  return emailHtml(`
    <p style="font-size:17px;margin-bottom:8px;">Ciao <strong>Luca Renna</strong>,</p>
    <p style="color:#475569;margin-bottom:8px;">Abbiamo ricevuto una richiesta di reset password per il tuo account <strong>Ischia Transfer Service</strong>.</p>
    <p style="color:#475569;margin-bottom:24px;">Clicca il bottone qui sotto per impostare una nuova password. Il link è valido per <strong>60 minuti</strong>.</p>
    ${emailButton("🔑 Imposta nuova password", "#")}
    <div style="background:#fefce8;border:1px solid #fde68a;border-radius:10px;padding:14px 18px;margin:20px 0;font-size:13px;color:#92400e;">
      ⚠️ Se non hai richiesto tu il reset, ignora questa email. La tua password rimane invariata.
    </div>
    <p style="font-size:12px;color:#94a3b8;border-top:1px solid #f1f5f9;padding-top:16px;">
      Il bottone non funziona? Copia e incolla questo link:<br/>
      <a href="#" style="color:#3b82f6;">https://ischiatransferservice.it/reset-password?token=abc123...</a>
    </p>
  `, { title: "Reset password — Ischia Transfer", preheader: "Reimposta la tua password di accesso" });
}

function buildApprovalSample(): string {
  return emailHtml(`
    <div style="text-align:center;margin-bottom:32px;">
      <div style="display:inline-block;background:#dcfce7;border-radius:50%;width:64px;height:64px;line-height:64px;font-size:32px;margin-bottom:16px;">✅</div>
      <h2 style="font-size:22px;font-weight:800;color:#0f2744;margin:0 0 8px;">Accesso approvato!</h2>
      <p style="color:#475569;font-size:15px;margin:0;">Benvenuto/a in <strong>Ischia Transfer Service</strong></p>
    </div>
    <p style="color:#475569;margin-bottom:20px;">Ciao <strong>Giovanna Ferrari</strong>, la tua richiesta di accesso è stata approvata. Di seguito i dettagli del tuo account.</p>
    ${emailDataTable([
      ["🎭 Ruolo", "Agenzia"],
      ["🏢 Agenzia", "Aleste Viaggi"],
    ])}
    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:16px 20px;margin:24px 0;font-size:14px;color:#166534;">
      🏢 Puoi ora accedere alla tua <strong>area agenzia</strong> per inserire e gestire le prenotazioni.
    </div>
    <p style="font-size:13px;color:#94a3b8;">Per assistenza scrivi a <a href="mailto:info@ischiatransferservice.it" style="color:#3b82f6;">info@ischiatransferservice.it</a></p>
  `, { title: "Accesso approvato — Ischia Transfer", preheader: "Il tuo accesso è stato approvato" });
}

function buildReportSample(): string {
  const sampleLines = [
    { date: "2026-06-15", time: "09:00", direction: "arrival" as const, customer_name: "Famiglia Bianchi", hotel_or_destination: "Hotel Moresco", pax: 3 },
    { date: "2026-06-15", time: "11:30", direction: "arrival" as const, customer_name: "Coppia Verdi", hotel_or_destination: "Hotel Regina Isabella", pax: 2 },
    { date: "2026-06-15", time: "14:00", direction: "departure" as const, customer_name: "Rossi Group", hotel_or_destination: "Porto Ischia", pax: 6 },
    { date: "2026-06-16", time: "08:45", direction: "arrival" as const, customer_name: "Tour Esposito", hotel_or_destination: "Hotel San Montano", pax: 4 },
  ];
  const totalPax = sampleLines.reduce((s, l) => s + l.pax, 0);
  const arrivals = sampleLines.filter(l => l.direction === "arrival").length;
  const departures = sampleLines.filter(l => l.direction === "departure").length;

  const rows = sampleLines.map((line, i) => {
    const isArrival = line.direction === "arrival";
    const bg = i % 2 === 0 ? "#ffffff" : "#f8fafc";
    return `<tr style="background:${bg};">
      <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;color:#475569;">${line.date}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;font-weight:600;color:#1e293b;">${line.time}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;">
        <span style="display:inline-block;padding:3px 8px;border-radius:20px;font-size:11px;font-weight:700;${isArrival ? "background:#dcfce7;color:#166534;" : "background:#fef9c3;color:#854d0e;"}">${isArrival ? "▼ Arrivo" : "▲ Partenza"}</span>
      </td>
      <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;font-weight:600;color:#1e293b;">${line.customer_name}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;color:#475569;">${line.hotel_or_destination}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;font-weight:700;text-align:center;color:#1e3a5f;">${line.pax}</td>
    </tr>`;
  }).join("");

  return emailHtml(`
    <p style="font-size:17px;margin-bottom:6px;">Ciao <strong>Aleste Viaggi</strong>,</p>
    <p style="color:#475569;margin-bottom:28px;">Ti inviamo il riepilogo operativo <strong>riepilogo arrivi +48h</strong> per il <strong>15/06/2026</strong>.</p>
    <div style="display:flex;gap:12px;margin-bottom:28px;">
      ${[
        { label: "Servizi totali", value: sampleLines.length, color: "#1e3a5f" },
        { label: "Pax totali",    value: totalPax,            color: "#0e7490" },
        { label: "Arrivi",        value: arrivals,             color: "#166534" },
        { label: "Partenze",      value: departures,           color: "#854d0e" },
      ].map(s => `
        <div style="flex:1;background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:14px;text-align:center;">
          <div style="font-size:24px;font-weight:800;color:${s.color};">${s.value}</div>
          <div style="font-size:11px;color:#94a3b8;margin-top:4px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;">${s.label}</div>
        </div>`).join("")}
    </div>
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;">
      <thead>
        <tr style="background:linear-gradient(135deg,#0f2744,#1e3a5f);">
          <th style="padding:12px;text-align:left;font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:rgba(255,255,255,0.7);">Data</th>
          <th style="padding:12px;text-align:left;font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:rgba(255,255,255,0.7);">Ora</th>
          <th style="padding:12px;text-align:left;font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:rgba(255,255,255,0.7);">Dir.</th>
          <th style="padding:12px;text-align:left;font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:rgba(255,255,255,0.7);">Cliente</th>
          <th style="padding:12px;text-align:left;font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:rgba(255,255,255,0.7);">Hotel / Dest.</th>
          <th style="padding:12px;text-align:center;font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:rgba(255,255,255,0.7);">Pax</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `, { title: "Riepilogo arrivi +48h — 15/06/2026", preheader: `${sampleLines.length} servizi · ${totalPax} pax · 15/06/2026` });
}

const SAMPLES: Record<string, () => string> = {
  otp:      buildOtpSample,
  booking:  buildBookingSample,
  reset:    buildResetSample,
  approval: buildApprovalSample,
  report:   buildReportSample,
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
  reminder: () => generateReminderEmailHtml(
    "Aleste Viaggi",
    [
      { customer_name: "Famiglia Bianchi", date: "2026-06-15", time: "09:00", direction: "arrival", hotel: "Hotel Moresco" },
      { customer_name: "Coppia Verdi", date: "2026-06-15", time: "11:30", direction: "arrival", hotel: "Hotel Regina Isabella" },
      { customer_name: "Rossi Group", date: "2026-06-15", time: "14:00", direction: "departure", hotel: "Porto Ischia" },
      { customer_name: "Tour Esposito", date: "2026-06-16", time: "08:45", direction: "arrival", hotel: "Hotel San Montano" },
    ],
    48
  ),
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
