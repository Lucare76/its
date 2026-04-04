/**
 * Generatore estratto conto HTML per agenzie.
 * Produce HTML con print CSS — l'operatore può stampare come PDF dal browser,
 * oppure viene inviato come email HTML via Resend.
 */

import { getLogoDataUri } from "@/lib/server/logo";

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
    ? `<img src="${logoUri}" alt="Ischia Transfer Service" style="height:48px;width:auto;display:block;margin-bottom:8px;" />`
    : "";
  const rows = data.items.map((item, i) => `
    <tr class="${i % 2 === 0 ? "row-even" : "row-odd"}">
      <td class="col-pratica">${item.numero_pratica || "—"}</td>
      <td class="col-nome">${item.cliente_nome}</td>
      <td class="col-data">${formatDate(item.data_servizio)}</td>
      <td class="col-tipo">${item.tipo_servizio}</td>
      <td class="col-importo">${formatCents(item.importo_cents)}</td>
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
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif; font-size: 13px; color: #1a1a1a; background: #fff; padding: 32px; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 32px; border-bottom: 2px solid #1e3a5f; padding-bottom: 20px; }
  .header-left h1 { font-size: 22px; font-weight: 700; color: #1e3a5f; }
  .header-left p { font-size: 13px; color: #555; margin-top: 4px; }
  .header-right { text-align: right; font-size: 12px; color: #555; }
  .header-right strong { font-size: 14px; color: #1a1a1a; }
  .meta { display: flex; gap: 32px; margin-bottom: 24px; }
  .meta-box { background: #f4f6fa; border-radius: 8px; padding: 12px 16px; flex: 1; }
  .meta-box label { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: #888; display: block; margin-bottom: 4px; }
  .meta-box span { font-size: 14px; font-weight: 600; color: #1a1a1a; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  thead tr { background: #1e3a5f; color: #fff; }
  thead th { padding: 10px 12px; text-align: left; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; }
  .col-pratica { width: 130px; }
  .col-data { width: 90px; }
  .col-tipo { width: 160px; }
  .col-importo { width: 100px; text-align: right; }
  td { padding: 9px 12px; border-bottom: 1px solid #eee; }
  .col-importo { text-align: right; font-weight: 500; }
  .row-even { background: #fff; }
  .row-odd { background: #f9fafc; }
  .total-row { background: #f0f4ff !important; font-weight: 700; }
  .total-row td { border-top: 2px solid #1e3a5f; padding: 12px; font-size: 14px; }
  .footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid #eee; font-size: 11px; color: #888; text-align: center; }
  @media print {
    body { padding: 16px; }
    .no-print { display: none; }
  }
</style>
</head>
<body>
  <div class="header">
    <div class="header-left">
      ${logoHtml}
      <h1>Ischia Transfer Service</h1>
      <p>Estratto conto servizi</p>
    </div>
    <div class="header-right">
      <strong>${data.agencyName}</strong><br/>
      ${data.agencyEmail ? data.agencyEmail + "<br/>" : ""}
      Rif. ${data.invoiceId.slice(0, 8).toUpperCase()}<br/>
      Emesso il ${formatDate(data.createdAt.slice(0, 10))}
    </div>
  </div>

  <div class="meta">
    <div class="meta-box">
      <label>Periodo</label>
      <span>${formatDate(data.periodFrom)} — ${formatDate(data.periodTo)}</span>
    </div>
    <div class="meta-box">
      <label>Pratiche</label>
      <span>${data.items.length}</span>
    </div>
    <div class="meta-box">
      <label>Totale</label>
      <span>${formatCents(data.totalCents)}</span>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th class="col-pratica">N. Pratica</th>
        <th class="col-nome">Cliente</th>
        <th class="col-data">Data</th>
        <th class="col-tipo">Servizio</th>
        <th class="col-importo">Importo</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
      <tr class="total-row">
        <td colspan="4">TOTALE</td>
        <td class="col-importo">${formatCents(data.totalCents)}</td>
      </tr>
    </tbody>
  </table>

  <div class="footer">
    Ischia Transfer Service S.r.l. — Via Cilento 14/C, 80077 Ischia (NA) — P.IVA IT 05931311210
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
  const rows = services.map((s) => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;">${s.customer_name.toUpperCase()}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;">${s.date.split("-").reverse().join("/")}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;">${s.time ?? "—"}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;">${s.direction === "arrival" ? "Arrivo" : "Partenza"}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;">${s.hotel ?? "—"}</td>
    </tr>
  `).join("");

  return `<!DOCTYPE html>
<html lang="it">
<head><meta charset="UTF-8"/></head>
<body style="font-family:-apple-system,Arial,sans-serif;font-size:14px;color:#1a1a1a;padding:32px;max-width:640px;">
  <h2 style="color:#1e3a5f;margin-bottom:8px;">Riepilogo servizi — ${agencyName}</h2>
  <p style="color:#555;margin-bottom:24px;">Di seguito i servizi programmati <strong>${label}</strong>.</p>
  <table style="width:100%;border-collapse:collapse;font-size:13px;">
    <thead>
      <tr style="background:#1e3a5f;color:#fff;">
        <th style="padding:10px 12px;text-align:left;">Cliente</th>
        <th style="padding:10px 12px;text-align:left;">Data</th>
        <th style="padding:10px 12px;text-align:left;">Orario</th>
        <th style="padding:10px 12px;text-align:left;">Tipo</th>
        <th style="padding:10px 12px;text-align:left;">Hotel</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  <p style="margin-top:24px;font-size:12px;color:#888;">
    Ischia Transfer Service S.r.l. — Via Cilento 14/C, 80077 Ischia (NA)
  </p>
</body>
</html>`;
}
