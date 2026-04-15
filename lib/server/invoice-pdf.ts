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
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/$/, "") ?? "https://ischia-transfer.vercel.app";
  const logoUrl = `${appUrl}/brand/logo-ischia-transfer-email.png`;

  const rows = data.items.map((item, i) => `
    <tr>
      <td class="td-pratica" style="padding:11px 14px;border-bottom:1px solid #e2e8f0;font-size:12px;color:#64748b;background:${i % 2 === 0 ? "#ffffff" : "#f8fafc"};">${item.numero_pratica || "—"}</td>
      <td style="padding:11px 14px;border-bottom:1px solid #e2e8f0;font-size:13px;font-weight:600;color:#1e293b;background:${i % 2 === 0 ? "#ffffff" : "#f8fafc"};">${item.cliente_nome}</td>
      <td class="td-data" style="padding:11px 14px;border-bottom:1px solid #e2e8f0;font-size:13px;color:#475569;background:${i % 2 === 0 ? "#ffffff" : "#f8fafc"};">${formatDate(item.data_servizio)}</td>
      <td class="td-servizio" style="padding:11px 14px;border-bottom:1px solid #e2e8f0;font-size:13px;color:#475569;background:${i % 2 === 0 ? "#ffffff" : "#f8fafc"};">${item.tipo_servizio}</td>
      <td style="padding:11px 14px;border-bottom:1px solid #e2e8f0;font-size:13px;font-weight:700;text-align:right;color:#0f2744;background:${i % 2 === 0 ? "#ffffff" : "#f8fafc"};">${formatCents(item.importo_cents)}</td>
    </tr>
  `).join("");

  return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Estratto conto — ${data.agencyName}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif; font-size: 13px; color: #1a1a1a; background: #f1f5f9; }

  .page { max-width: 860px; margin: 32px auto; background: #fff; border-radius: 20px; overflow: hidden; box-shadow: 0 4px 40px rgba(0,0,0,0.10); }
  .header { background: linear-gradient(135deg,#0f2744 0%,#1e3a5f 60%,#1a4a7a 100%); padding: 36px 40px; }
  .header-logo { vertical-align: middle; width: 50%; }
  .header-info { vertical-align: top; text-align: right; width: 50%; }
  .kpi-section { padding: 28px 40px 0; }
  .kpi-table { width: 100%; }
  .table-section { padding: 28px 40px; }
  .table-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  .footer-section { margin: 0 40px 32px; padding: 18px 24px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; text-align: center; }

  @media print {
    body { background: #fff; }
    .no-print { display: none !important; }
    .page { box-shadow: none !important; margin: 0 !important; border-radius: 0 !important; }
  }

  @media only screen and (max-width: 620px) {
    .page { margin: 0; border-radius: 0; box-shadow: none; }
    .header { padding: 24px 20px; }
    .header-logo { display: block; width: 100%; text-align: center; padding-bottom: 16px; }
    .header-info { display: block; width: 100%; text-align: center; }
    .header-table { width: 100%; }
    .header-table tr { display: block; }
    .header-table td { display: block !important; width: 100% !important; text-align: center !important; }
    .kpi-section { padding: 20px 16px 0; }
    .kpi-table tr { display: block; }
    .kpi-table td { display: block !important; width: 100% !important; padding: 0 0 10px 0 !important; }
    .table-section { padding: 20px 16px; }
    .footer-section { margin: 0 16px 24px; }
    .td-pratica { display: none !important; }
    .td-servizio { display: none !important; }
    th.th-pratica { display: none !important; }
    th.th-servizio { display: none !important; }
    img.invoice-logo { width: 160px !important; max-width: 160px !important; }
  }
</style>
</head>
<body>
  <div class="page">

    <!-- HEADER GRADIENT -->
    <div class="header">
      <table class="header-table" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td class="header-logo">
            <img class="invoice-logo" src="${logoUrl}" alt="Ischia Transfer Service" width="220" style="width:220px;max-width:220px;height:auto;display:block;" />
          </td>
          <td class="header-info">
            <div style="font-size:11px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:rgba(255,255,255,0.5);margin-bottom:6px;">Estratto conto</div>
            <div style="font-size:24px;font-weight:900;color:#ffffff;line-height:1.1;">${data.agencyName}</div>
            ${data.agencyEmail ? `<div style="font-size:13px;color:rgba(255,255,255,0.6);margin-top:6px;">${data.agencyEmail}</div>` : ""}
            <div style="margin-top:12px;display:inline-block;background:rgba(255,255,255,0.12);border:1px solid rgba(255,255,255,0.2);border-radius:8px;padding:6px 14px;font-size:12px;color:rgba(255,255,255,0.8);">
              Rif. <strong style="color:#ffffff;">${data.invoiceId.slice(0, 8).toUpperCase()}</strong> &nbsp;·&nbsp; Emesso il ${formatDate(data.createdAt.slice(0, 10))}
            </div>
          </td>
        </tr>
      </table>
    </div>

    <!-- KPI BOXES -->
    <div class="kpi-section">
      <table class="kpi-table" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td style="width:33%;padding-right:10px;">
            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:14px;padding:18px 20px;">
              <div style="font-size:10px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#94a3b8;margin-bottom:6px;">Periodo</div>
              <div style="font-size:14px;font-weight:700;color:#0f2744;">${formatDate(data.periodFrom)} — ${formatDate(data.periodTo)}</div>
            </div>
          </td>
          <td style="width:33%;padding:0 5px;">
            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:14px;padding:18px 20px;text-align:center;">
              <div style="font-size:10px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#94a3b8;margin-bottom:6px;">Pratiche</div>
              <div style="font-size:32px;font-weight:900;color:#0e7490;">${data.items.length}</div>
            </div>
          </td>
          <td style="width:33%;padding-left:10px;">
            <div style="background:linear-gradient(135deg,#0f2744,#1e3a5f);border-radius:14px;padding:18px 20px;text-align:right;">
              <div style="font-size:10px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:rgba(255,255,255,0.5);margin-bottom:6px;">Totale</div>
              <div style="font-size:24px;font-weight:900;color:#ffffff;">${formatCents(data.totalCents)}</div>
            </div>
          </td>
        </tr>
      </table>
    </div>

    <!-- TABLE -->
    <div class="table-section">
      <div class="table-scroll">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;min-width:400px;">
          <thead>
            <tr style="background:linear-gradient(135deg,#0f2744,#1e3a5f);">
              <th class="th-pratica" style="padding:12px 14px;text-align:left;font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:rgba(255,255,255,0.65);width:110px;">N. Pratica</th>
              <th style="padding:12px 14px;text-align:left;font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:rgba(255,255,255,0.65);">Cliente</th>
              <th style="padding:12px 14px;text-align:left;font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:rgba(255,255,255,0.65);width:90px;">Data</th>
              <th class="th-servizio" style="padding:12px 14px;text-align:left;font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:rgba(255,255,255,0.65);width:150px;">Servizio</th>
              <th style="padding:12px 14px;text-align:right;font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:rgba(255,255,255,0.65);width:100px;">Importo</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
            <tr>
              <td colspan="5" style="padding:14px 14px;border-top:2px solid #1e3a5f;font-size:13px;font-weight:800;color:#0f2744;text-align:right;background:#f0f6ff;">
                Totale &nbsp;<span style="font-size:16px;font-weight:900;">${formatCents(data.totalCents)}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- FOOTER -->
    <div class="footer-section">
      <div style="font-size:11px;color:#94a3b8;line-height:1.8;">
        <strong style="color:#475569;">Ischia Transfer Service S.r.l.</strong><br/>
        Via Cilento 14/C, 80077 Ischia (NA) &nbsp;·&nbsp; P.IVA IT 05931311210<br/>
        <span style="color:#cbd5e1;">Documento generato automaticamente il ${formatDate(data.createdAt.slice(0, 10))}</span>
      </div>
    </div>

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
