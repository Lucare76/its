import { escapeHtml } from "@/lib/server/escape-html";
import { emailHtml } from "@/lib/server/email-layout";

export const DISPO_PREFIX = "__dispo__:";

export interface DispoData {
  vehicleType: string;
  vehicleCount: number;
  dateFrom: string;
  dateTo: string;
  totalDays: number;
  timeFrom?: string;
  timeTo?: string;
  rateDay: number;
  rateNight: number;
  pricePerVehicle: number;
  includeAccommodation: boolean;
  customNotes?: string;
}

export function parseDispoData(notes: string): DispoData | null {
  if (!notes.startsWith(DISPO_PREFIX)) return null;
  try {
    return JSON.parse(notes.slice(DISPO_PREFIX.length)) as DispoData;
  } catch {
    return null;
  }
}

function fmtEur(amount: number): string {
  return amount.toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function row(label: string, value: string, isLast = false, highlight = false): string {
  const border = isLast ? "0" : "1px solid #e2e8f0";
  const pad = highlight ? "12px 16px" : "10px 16px";
  const bg = highlight ? "#f0fdf4" : "#f8fafc";
  const labelColor = highlight ? "#166534" : "#64748b";
  const labelWeight = highlight ? "700" : "600";
  const labelSize = highlight ? "14px" : "13px";
  const valueColor = highlight ? "#166534" : "#1e293b";
  const valueWeight = highlight ? "800" : "400";
  const valueFontSize = highlight ? "18px" : "14px";
  return `
    <tr>
      <td style="padding:${pad};background:${bg};border-bottom:${border};font-size:${labelSize};font-weight:${labelWeight};color:${labelColor};width:58%;vertical-align:middle;">${label}</td>
      <td style="padding:${pad};background:${highlight ? "#f0fdf4" : "transparent"};border-bottom:${border};font-size:${valueFontSize};font-weight:${valueWeight};color:${valueColor};vertical-align:middle;">${value}</td>
    </tr>`;
}

function section(title: string): string {
  return `<h3 style="font-size:11px;font-weight:700;color:#1e3a5f;margin:28px 0 10px;padding-bottom:8px;border-bottom:2px solid #1e3a5f;letter-spacing:0.1em;text-transform:uppercase;">${escapeHtml(title)}</h3>`;
}

function dataTable(rows: string): string {
  return `<table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="border-collapse:collapse;margin:0 0 4px;border-radius:10px;overflow:hidden;border:1px solid #e2e8f0;">${rows}</table>`;
}

export function buildDisposizioniEmail(
  recipientName: string,
  totalPriceEur: number,
  d: DispoData
): string {
  const noteItems = [
    "Il servizio è garantito in modalità disposizione continuativa H24",
    "Sono esclusi eventuali costi extra quali pedaggi, parcheggi, ZTL e traghetti, se applicabili",
    "Il presente preventivo non include vitto e alloggio per gli autisti",
    ...(d.customNotes?.trim() ? [escapeHtml(d.customNotes.trim())] : []),
  ].map((n) => `<li style="margin-bottom:6px;">${n}</li>`).join("");

  const body = `
    <p style="font-size:15px;color:#0f172a;margin:0 0 6px;font-weight:600;">
      Gentile ${escapeHtml(recipientName)},
    </p>
    <p style="font-size:15px;color:#475569;margin:0 0 28px;line-height:1.75;">
      con la presente siamo lieti di sottoporLe il nostro preventivo per il servizio di
      <strong style="color:#0f172a;">noleggio con conducente in disposizione continuativa H24</strong>,
      previsto per il periodo dal
      <strong style="color:#0f172a;">${escapeHtml(d.dateFrom)}</strong> al
      <strong style="color:#0f172a;">${escapeHtml(d.dateTo)}</strong>
      (${escapeHtml(String(d.totalDays))} giorni complessivi).
    </p>

    ${section("Dettaglio del servizio")}
    ${dataTable(`
      ${row("Disponibilità", d.timeFrom && d.timeTo ? `dalle ${escapeHtml(d.timeFrom)} alle ${escapeHtml(d.timeTo)}` : "H24 (24 ore su 24)")}
      ${row("Mezzi impiegati", `n.&nbsp;${escapeHtml(String(d.vehicleCount))} ${escapeHtml(d.vehicleType)}`)}
      ${row("Periodo", `dal ${escapeHtml(d.dateFrom)} al ${escapeHtml(d.dateTo)}`)}
      ${row("Sistemazione autisti", d.includeAccommodation ? "inclusa" : "esclusa", true)}
    `)}

    ${section("Tariffe applicate")}
    ${dataTable(`
      ${row("Fascia diurna (07:00–22:00)", `€${escapeHtml(String(d.rateDay))},00/ora`)}
      ${row("Fascia notturna (22:00–07:00)", `€${escapeHtml(String(d.rateNight))},00/ora`, true)}
    `)}
    <p style="font-size:12px;color:#94a3b8;margin:5px 0 0;font-style:italic;">
      Le tariffe si applicano anche alle eventuali frazioni orarie.
    </p>

    ${section("Riepilogo economico")}
    ${dataTable(`
      ${row(`Totale per 1 ${escapeHtml(d.vehicleType)} (${escapeHtml(String(d.totalDays))} giorni)`, `€${escapeHtml(fmtEur(d.pricePerVehicle))}`)}
      ${row(`Totale per ${escapeHtml(String(d.vehicleCount))} ${escapeHtml(d.vehicleType)} (${escapeHtml(String(d.totalDays))} giorni)`, `€${escapeHtml(fmtEur(totalPriceEur))}`)}
      ${row("Totale complessivo del servizio", `€${escapeHtml(fmtEur(totalPriceEur))}`, true, true)}
    `)}

    ${section("Note")}
    <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:14px 18px;margin-bottom:32px;">
      <ul style="margin:0;padding-left:18px;font-size:13px;color:#92400e;line-height:1.9;">
        ${noteItems}
      </ul>
    </div>

    <p style="font-size:15px;color:#475569;margin:0 0 10px;line-height:1.75;">
      Restiamo a Sua completa disposizione per qualsiasi chiarimento o eventuale
      personalizzazione del servizio.
    </p>
    <p style="font-size:15px;color:#475569;margin:0 0 4px;">Cordiali saluti,</p>
    <p style="font-size:15px;font-weight:700;color:#0f172a;margin:0;">Ischia Transfer Service</p>
  `;

  return emailHtml(body, {
    title: `Preventivo Disposizione H24 — ${d.dateFrom} / ${d.dateTo}`,
    preheader: `Disposizione H24 · ${d.vehicleCount} ${d.vehicleType} · ${d.totalDays} giorni · €${fmtEur(totalPriceEur)}`,
  });
}
