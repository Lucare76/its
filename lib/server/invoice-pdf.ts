/**
 * Generatore estratto conto HTML per agenzie.
 * Produce HTML con print CSS — l'operatore può stampare come PDF dal browser,
 * oppure viene inviato come email HTML via Resend.
 */

import * as XLSX from "xlsx";
import { buildServiceListEmailHtml, buildServiceListPlainText } from "@/lib/server/service-list-email";

export type InvoiceLineItem = {
  service_id: string;
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
  reviewUrl?: string | null;
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
  const { emailHtml, emailButton } = require("@/lib/server/email-layout") as typeof import("@/lib/server/email-layout");

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

    <p style="font-size:12px;color:#94a3b8;text-align:center;margin-top:16px;">Se un importo ti sembra sbagliato, accedi alla tua area agenzia per segnalarlo: verrà rivisto dal nostro team.</p>

    ${data.reviewUrl ? emailButton("Vedi estratto conto", data.reviewUrl, "#1e3a5f") : ""}
  `;

  return emailHtml(body, {
    title: `Estratto conto — ${data.agencyName}`,
    preheader: `Estratto conto ${formatDate(data.periodFrom)}–${formatDate(data.periodTo)} · ${data.items.length} pratiche · ${formatCents(data.totalCents)}`,
  });
}

/**
 * Genera HTML print-friendly per stampa/PDF dal browser (A4 portrait).
 * Diverso da generateInvoiceHtml che è ottimizzato per email.
 */
export function generateInvoicePrintHtml(data: InvoiceData): string {
  const rows = data.items.map((item, i) => {
    const bg = i % 2 === 0 ? "#fff" : "#f8fafc";
    return `<tr style="background:${bg}">
      <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:12px;color:#64748b">${item.numero_pratica || "—"}</td>
      <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:13px;font-weight:600;color:#1e293b;text-transform:uppercase">${item.cliente_nome}</td>
      <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:13px;color:#475569;white-space:nowrap">${formatDate(item.data_servizio)}</td>
      <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:13px;color:#475569">${item.tipo_servizio}</td>
      <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:13px;font-weight:700;text-align:right;color:#0f2744;white-space:nowrap">${formatCents(item.importo_cents)}</td>
    </tr>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Estratto conto — ${data.agencyName}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif; font-size: 13px; color: #1a1a1a; padding: 32px; background: #fff; }
  @media print {
    body { padding: 0; }
    .no-print { display: none !important; }
    @page { margin: 1.5cm; size: A4 portrait; }
  }
</style>
</head>
<body>
  <!-- Intestazione -->
  <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:28px;padding-bottom:16px;border-bottom:3px solid #0f172a">
    <div>
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.15em;color:#64748b;margin-bottom:6px">Ischia Transfer Service</div>
      <h1 style="font-size:24px;font-weight:800;color:#0f172a">Estratto conto</h1>
      <div style="font-size:16px;font-weight:600;color:#475569;margin-top:4px">${data.agencyName}</div>
      ${data.agencyEmail ? `<div style="font-size:12px;color:#94a3b8;margin-top:2px">${data.agencyEmail}</div>` : ""}
    </div>
    <div style="text-align:right">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.1em;color:#94a3b8;margin-bottom:4px">Periodo</div>
      <div style="font-size:14px;font-weight:700;color:#0f172a">${formatDate(data.periodFrom)} — ${formatDate(data.periodTo)}</div>
      <div style="margin-top:8px;font-size:11px;color:#94a3b8">Rif. ${data.invoiceId.slice(0, 8).toUpperCase()}</div>
      <div style="font-size:11px;color:#94a3b8">Emesso il ${formatDate(data.createdAt.slice(0, 10))}</div>
    </div>
  </div>

  <!-- KPI -->
  <div style="display:flex;gap:16px;margin-bottom:24px">
    <div style="flex:1;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px 18px">
      <div style="font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#94a3b8;margin-bottom:4px">Pratiche</div>
      <div style="font-size:28px;font-weight:900;color:#0e7490">${data.items.length}</div>
    </div>
    <div style="flex:2;background:#0f172a;border-radius:10px;padding:14px 18px;text-align:right">
      <div style="font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:rgba(255,255,255,0.5);margin-bottom:4px">Totale da pagare</div>
      <div style="font-size:28px;font-weight:900;color:#fff">${formatCents(data.totalCents)}</div>
    </div>
  </div>

  <!-- Tabella servizi -->
  <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:20px">
    <thead>
      <tr style="background:#0f172a">
        <th style="padding:10px 12px;text-align:left;font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:rgba(255,255,255,0.65);border:1px solid #1e293b">N. Pratica</th>
        <th style="padding:10px 12px;text-align:left;font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:rgba(255,255,255,0.65);border:1px solid #1e293b">Cliente</th>
        <th style="padding:10px 12px;text-align:left;font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:rgba(255,255,255,0.65);border:1px solid #1e293b">Data</th>
        <th style="padding:10px 12px;text-align:left;font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:rgba(255,255,255,0.65);border:1px solid #1e293b">Servizio</th>
        <th style="padding:10px 12px;text-align:right;font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:rgba(255,255,255,0.65);border:1px solid #1e293b">Importo</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
      <tr style="background:#f0f6ff">
        <td colspan="4" style="padding:12px;border:1px solid #e2e8f0;font-size:13px;font-weight:800;color:#0f2744;text-transform:uppercase;letter-spacing:0.06em">Totale complessivo</td>
        <td style="padding:12px;border:1px solid #e2e8f0;font-size:16px;font-weight:900;text-align:right;color:#0f2744;white-space:nowrap">${formatCents(data.totalCents)}</td>
      </tr>
    </tbody>
  </table>

  <!-- Footer -->
  <div style="margin-top:24px;padding-top:14px;border-top:1px solid #e2e8f0;font-size:11px;color:#94a3b8;text-align:center;line-height:1.8">
    <strong style="color:#475569">Ischia Transfer Service S.r.l.</strong><br/>
    Via Cilento 14/C, 80077 Ischia (NA) &nbsp;·&nbsp; P.IVA IT 05931311210<br/>
    Documento generato automaticamente il ${formatDate(data.createdAt.slice(0, 10))}
  </div>

  <div class="no-print" style="margin-top:28px;text-align:center">
    <button onclick="window.print()" style="background:#0f172a;color:white;border:none;padding:10px 28px;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer">🖨️ Stampa / Salva PDF</button>
  </div>
</body>
</html>`;
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

/**
 * Allegato Excel dell'estratto conto — stesse righe/colonne dell'HTML,
 * stesso pattern di lib/server/services-export.ts (XLSX.utils.aoa_to_sheet +
 * XLSX.write bookType 'xlsx'), pensato per essere passato a strumenti esterni
 * (alcune agenzie lo inoltrano a tool di analisi/AI).
 */
export function buildInvoiceXlsx(data: InvoiceData): Buffer {
  const header = ["Numero pratica", "Cliente", "Data servizio", "Tipo servizio", "Importo EUR"];
  const rows = data.items.map((item) => [
    item.numero_pratica,
    item.cliente_nome,
    formatDate(item.data_servizio),
    item.tipo_servizio,
    Number((item.importo_cents / 100).toFixed(2)),
  ]);
  const totalRow = ["", "", "", "Totale", Number((data.totalCents / 100).toFixed(2))];

  const sheet = XLSX.utils.aoa_to_sheet([header, ...rows, totalRow]);
  sheet["!cols"] = [{ wch: 22 }, { wch: 28 }, { wch: 14 }, { wch: 24 }, { wch: 14 }];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Estratto conto");

  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
