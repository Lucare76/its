/**
 * Generatore estratto conto HTML per agenzie.
 * Produce HTML con print CSS — l'operatore può stampare come PDF dal browser,
 * oppure viene inviato come email HTML via Resend.
 */

import { buildServiceListEmailHtml, buildServiceListPlainText } from "@/lib/server/service-list-email";

export type InvoiceLineItem = {
  numero_pratica: string;
  cliente_nome: string;
  data_servizio: string;
  tipo_servizio: string;
  importo_cents: number;
};

export type InvoiceData = {
  agencyName: string;
  agencyEmail?: string | null;
  periodFrom: string;  // YYYY-MM-DD
  periodTo: string;    // YYYY-MM-DD
  invoiceId: string;
  createdAt: string;
  items: InvoiceLineItem[];
  totalCents: number;
};

function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function formatCents(cents: number): string {
  return (cents / 100).toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
}

export function generateInvoiceHtml(data: InvoiceData): string {
  // Usa emailHtml() come tutti gli altri template — layout table-based inline,
  // compatibile con Gmail desktop e mobile senza dipendere da <style> in <head>.
  const { emailHtml } = require("@/lib/server/email-layout") as typeof import("@/lib/server/email-layout");

  const rows = data.items.map((item, i) => {
    const bg = i % 2 === 0 ? "#ffffff" : "#f8fafc";
    return `<tr>
      <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;font-size:12px;color:#64748b;background:${bg};white-space:nowrap;">${item.numero_pratica || "—"}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;font-weight:600;color:#1e293b;background:${bg};">${item.cliente_nome}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;color:#475569;background:${bg};white-space:nowrap;">${formatDate(item.data_servizio)}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;color:#475569;background:${bg};">${item.tipo_servizio}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;font-weight:700;text-align:right;color:#0f2744;background:${bg};white-space:nowrap;">${formatCents(item.importo_cents)}</td>
    </tr>`;
  }).join("");

  const body = `
    <p style="font-size:17px;margin-bottom:4px;">Ciao <strong>${data.agencyName}</strong>,</p>
    <p style="color:#475569;margin-bottom:24px;">di seguito il riepilogo dei servizi per il periodo <strong>${formatDate(data.periodFrom)} — ${formatDate(data.periodTo)}</strong>.</p>

    <!-- KPI: 3 box in riga -->
    <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin-bottom:24px;">
      <tr>
        <td style="width:33%;padding-right:8px;vertical-align:top;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation">
            <tr><td style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:14px 16px;">
              <div style="font-size:10px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#94a3b8;margin-bottom:4px;">Periodo</div>
              <div style="font-size:13px;font-weight:700;color:#0f2744;line-height:1.3;">${formatDate(data.periodFrom)}<br/>${formatDate(data.periodTo)}</div>
            </td></tr>
          </table>
        </td>
        <td style="width:33%;padding:0 4px;vertical-align:top;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation">
            <tr><td style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:14px 16px;text-align:center;">
              <div style="font-size:10px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#94a3b8;margin-bottom:4px;">Pratiche</div>
              <div style="font-size:28px;font-weight:900;color:#0e7490;">${data.items.length}</div>
            </td></tr>
          </table>
        </td>
        <td style="width:33%;padding-left:8px;vertical-align:top;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation">
            <tr><td style="background:linear-gradient(135deg,#0f2744,#1e3a5f);border-radius:12px;padding:14px 16px;text-align:right;">
              <div style="font-size:10px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:rgba(255,255,255,0.5);margin-bottom:4px;">Totale</div>
              <div style="font-size:22px;font-weight:900;color:#ffffff;">${formatCents(data.totalCents)}</div>
            </td></tr>
          </table>
        </td>
      </tr>
    </table>

    <!-- Tabella servizi -->
    <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="border-collapse:collapse;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;margin-bottom:20px;">
      <thead>
        <tr style="background:linear-gradient(135deg,#0f2744,#1e3a5f);">
          <th style="padding:11px 12px;text-align:left;font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:rgba(255,255,255,0.65);">N. Pratica</th>
          <th style="padding:11px 12px;text-align:left;font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:rgba(255,255,255,0.65);">Cliente</th>
          <th style="padding:11px 12px;text-align:left;font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:rgba(255,255,255,0.65);">Data</th>
          <th style="padding:11px 12px;text-align:left;font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:rgba(255,255,255,0.65);">Servizio</th>
          <th style="padding:11px 12px;text-align:right;font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:rgba(255,255,255,0.65);">Importo</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
        <tr>
          <td colspan="4" style="padding:12px;border-top:2px solid #1e3a5f;font-size:13px;font-weight:800;color:#0f2744;background:#f0f6ff;">Totale complessivo</td>
          <td style="padding:12px;border-top:2px solid #1e3a5f;font-size:15px;font-weight:900;text-align:right;color:#0f2744;background:#f0f6ff;white-space:nowrap;">${formatCents(data.totalCents)}</td>
        </tr>
      </tbody>
    </table>

    <p style="font-size:12px;color:#94a3b8;text-align:center;">Rif. <strong style="color:#475569;">${data.invoiceId.slice(0, 8).toUpperCase()}</strong> &nbsp;·&nbsp; Emesso il ${formatDate(data.createdAt.slice(0, 10))}</p>
  `;

  return emailHtml(body, {
    title: `Estratto conto — ${data.agencyName}`,
    preheader: `Estratto conto ${formatDate(data.periodFrom)}–${formatDate(data.periodTo)} · ${data.items.length} pratiche · ${formatCents(data.totalCents)}`,
  });
}

/**
 * Genera il testo email di accompagnamento (plain text + HTML summary).
 */
export function generateReminderEmailHtml(
  agencyName: string,
  services: Array<{ customer_name: string; date: string; time: string | null; direction: string; hotel?: string }>,
  hoursAhead: number
): string {
  const today = new Date().toISOString().slice(0, 10);
  return buildServiceListEmailHtml({
    agencyName,
    type: hoursAhead <= 24 ? "reminder_24h" : "reminder_48h",
    targetDate: today,
    lines: services.map((s) => ({
      date: s.date,
      time: s.time ?? "—",
      customer_name: s.customer_name,
      pax: 1,
      hotel_or_destination: s.hotel ?? null,
      direction: s.direction === "arrival" ? "arrival" : "departure",
    })),
  });
}

export function generateReminderPlainText(
  agencyName: string,
  services: Array<{ customer_name: string; date: string; time: string | null; direction: string; hotel?: string }>,
  hoursAhead: number
): string {
  const today = new Date().toISOString().slice(0, 10);
  return buildServiceListPlainText({
    agencyName,
    type: hoursAhead <= 24 ? "reminder_24h" : "reminder_48h",
    targetDate: today,
    lines: services.map((s) => ({
      date: s.date,
      time: s.time ?? "—",
      customer_name: s.customer_name,
      pax: 1,
      hotel_or_destination: s.hotel ?? null,
      direction: s.direction === "arrival" ? "arrival" : "departure",
    })),
  });
}
