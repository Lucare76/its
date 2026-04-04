/**
 * Generatore estratto conto HTML per agenzie.
 * Produce HTML con print CSS — l'operatore può stampare come PDF dal browser,
 * oppure viene inviato come email HTML via Resend.
 */

import { getLogoDataUri } from "@/lib/server/logo";
import { emailHtml } from "@/lib/server/email-layout";

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
  const logoUri = getLogoDataUri();
  const logoHtml = logoUri
    ? `<img src="${logoUri}" alt="Ischia Transfer Service" style="height:160px;width:auto;display:block;" />`
    : `<div style="font-size:22px;font-weight:900;color:#ffffff;letter-spacing:-0.5px;">Ischia Transfer Service</div>`;

  const rows = data.items.map((item, i) => `
    <tr>
      <td style="padding:11px 14px;border-bottom:1px solid #e2e8f0;font-size:12px;color:#64748b;background:${i % 2 === 0 ? "#ffffff" : "#f8fafc"};">${item.numero_pratica || "—"}</td>
      <td style="padding:11px 14px;border-bottom:1px solid #e2e8f0;font-size:13px;font-weight:600;color:#1e293b;background:${i % 2 === 0 ? "#ffffff" : "#f8fafc"};">${item.cliente_nome}</td>
      <td style="padding:11px 14px;border-bottom:1px solid #e2e8f0;font-size:13px;color:#475569;background:${i % 2 === 0 ? "#ffffff" : "#f8fafc"};">${formatDate(item.data_servizio)}</td>
      <td style="padding:11px 14px;border-bottom:1px solid #e2e8f0;font-size:13px;color:#475569;background:${i % 2 === 0 ? "#ffffff" : "#f8fafc"};">${item.tipo_servizio}</td>
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
  @media print {
    body { background: #fff; }
    .no-print { display: none !important; }
    .page { box-shadow: none !important; margin: 0 !important; border-radius: 0 !important; }
  }
</style>
</head>
<body>
  <div class="page" style="max-width:860px;margin:32px auto;background:#fff;border-radius:20px;overflow:hidden;box-shadow:0 4px 40px rgba(0,0,0,0.10);">

    <!-- HEADER GRADIENT -->
    <div style="background:linear-gradient(135deg,#0f2744 0%,#1e3a5f 60%,#1a4a7a 100%);padding:36px 40px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td style="vertical-align:middle;">
            ${logoHtml}
          </td>
          <td style="vertical-align:top;text-align:right;">
            <div style="font-size:11px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:rgba(255,255,255,0.5);margin-bottom:6px;">Estratto conto</div>
            <div style="font-size:28px;font-weight:900;color:#ffffff;line-height:1.1;">${data.agencyName}</div>
            ${data.agencyEmail ? `<div style="font-size:13px;color:rgba(255,255,255,0.6);margin-top:6px;">${data.agencyEmail}</div>` : ""}
            <div style="margin-top:12px;display:inline-block;background:rgba(255,255,255,0.12);border:1px solid rgba(255,255,255,0.2);border-radius:8px;padding:6px 14px;font-size:12px;color:rgba(255,255,255,0.8);">
              Rif. <strong style="color:#ffffff;">${data.invoiceId.slice(0, 8).toUpperCase()}</strong> &nbsp;·&nbsp; Emesso il ${formatDate(data.createdAt.slice(0, 10))}
            </div>
          </td>
        </tr>
      </table>
    </div>

    <!-- KPI BOXES -->
    <div style="padding:28px 40px 0;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td style="width:33%;padding-right:10px;">
            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:14px;padding:18px 20px;">
              <div style="font-size:10px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#94a3b8;margin-bottom:6px;">Periodo</div>
              <div style="font-size:15px;font-weight:700;color:#0f2744;">${formatDate(data.periodFrom)} — ${formatDate(data.periodTo)}</div>
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
              <div style="font-size:26px;font-weight:900;color:#ffffff;">${formatCents(data.totalCents)}</div>
            </div>
          </td>
        </tr>
      </table>
    </div>

    <!-- TABLE -->
    <div style="padding:28px 40px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;">
        <thead>
          <tr style="background:linear-gradient(135deg,#0f2744,#1e3a5f);">
            <th style="padding:12px 14px;text-align:left;font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:rgba(255,255,255,0.65);width:120px;">N. Pratica</th>
            <th style="padding:12px 14px;text-align:left;font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:rgba(255,255,255,0.65);">Cliente</th>
            <th style="padding:12px 14px;text-align:left;font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:rgba(255,255,255,0.65);width:90px;">Data</th>
            <th style="padding:12px 14px;text-align:left;font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:rgba(255,255,255,0.65);width:150px;">Servizio</th>
            <th style="padding:12px 14px;text-align:right;font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:rgba(255,255,255,0.65);width:100px;">Importo</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
          <tr>
            <td colspan="4" style="padding:14px 14px;border-top:2px solid #1e3a5f;font-size:13px;font-weight:800;color:#0f2744;text-transform:uppercase;letter-spacing:0.06em;background:#f0f6ff;">Totale complessivo</td>
            <td style="padding:14px 14px;border-top:2px solid #1e3a5f;font-size:16px;font-weight:900;text-align:right;color:#0f2744;background:#f0f6ff;">${formatCents(data.totalCents)}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- FOOTER -->
    <div style="margin:0 40px 32px;padding:18px 24px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;text-align:center;">
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
  const label = hoursAhead <= 24 ? "nelle prossime 24 ore" : "nelle prossime 48 ore";
  const arrivals = services.filter((s) => s.direction === "arrival").length;
  const departures = services.filter((s) => s.direction === "departure").length;

  const rows = services.map((s, i) => {
    const isArrival = s.direction === "arrival";
    const bg = i % 2 === 0 ? "#ffffff" : "#f8fafc";
    return `<tr style="background:${bg};">
      <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;font-weight:600;color:#1e293b;">${s.customer_name}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;color:#475569;">${s.date.split("-").reverse().join("/")}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;font-weight:600;color:#1e293b;">${s.time ?? "—"}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;">
        <span style="display:inline-block;padding:3px 8px;border-radius:20px;font-size:11px;font-weight:700;${isArrival ? "background:#dcfce7;color:#166534;" : "background:#fef9c3;color:#854d0e;"}">${isArrival ? "▼ Arrivo" : "▲ Partenza"}</span>
      </td>
      <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;color:#475569;">${s.hotel ?? "—"}</td>
    </tr>`;
  }).join("");

  return emailHtml(`
    <p style="font-size:17px;margin-bottom:6px;">Ciao <strong>${agencyName}</strong>,</p>
    <p style="color:#475569;margin-bottom:28px;">Di seguito i servizi programmati <strong>${label}</strong>.</p>

    <div style="display:flex;gap:12px;margin-bottom:28px;">
      ${[
        { label: "Servizi totali", value: services.length, color: "#1e3a5f" },
        { label: "Arrivi",         value: arrivals,         color: "#166534" },
        { label: "Partenze",       value: departures,       color: "#854d0e" },
      ].map(s => `
        <div style="flex:1;background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:14px;text-align:center;">
          <div style="font-size:28px;font-weight:800;color:${s.color};">${s.value}</div>
          <div style="font-size:11px;color:#94a3b8;margin-top:4px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;">${s.label}</div>
        </div>`).join("")}
    </div>

    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;">
      <thead>
        <tr style="background:linear-gradient(135deg,#0f2744,#1e3a5f);">
          <th style="padding:12px;text-align:left;font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:rgba(255,255,255,0.7);">Cliente</th>
          <th style="padding:12px;text-align:left;font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:rgba(255,255,255,0.7);">Data</th>
          <th style="padding:12px;text-align:left;font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:rgba(255,255,255,0.7);">Orario</th>
          <th style="padding:12px;text-align:left;font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:rgba(255,255,255,0.7);">Dir.</th>
          <th style="padding:12px;text-align:left;font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:rgba(255,255,255,0.7);">Hotel</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `, { title: `Riepilogo servizi — ${agencyName}`, preheader: `${services.length} servizi programmati ${label}` });
}
