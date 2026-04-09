/**
 * Template unificato per email con lista servizi.
 * Usato sia per i riepilogi operativi (inviati dall'operatore/cron)
 * sia per i reminder automatici pre-servizio inviati alle agenzie.
 */

import { emailHtml } from "@/lib/server/email-layout";

export type ServiceLine = {
  date: string;
  time: string;
  customer_name: string;
  phone?: string | null;
  pax: number;
  hotel_or_destination: string | null;
  direction: "arrival" | "departure";
  transport_type?: string | null;   // treno | volo | traghetto | aliscafo
  transport_time?: string | null;   // orario treno/volo/traghetto
};

export type ServiceListEmailType =
  | "arrivals_48h"
  | "departures_48h"
  | "bus_monday"
  | "reminder_24h"
  | "reminder_48h";

const TYPE_LABELS: Record<ServiceListEmailType, string> = {
  arrivals_48h:   "Riepilogo arrivi +48h",
  departures_48h: "Riepilogo partenze +48h",
  bus_monday:     "Riepilogo linea bus domenica",
  reminder_24h:   "Promemoria servizi — prossime 24 ore",
  reminder_48h:   "Promemoria servizi — prossime 48 ore",
};

function isReminder(type: ServiceListEmailType) {
  return type === "reminder_24h" || type === "reminder_48h";
}

function buildIntro(type: ServiceListEmailType, agencyName: string, targetDate: string) {
  if (type === "bus_monday")     return `Ti inviamo il riepilogo <strong>linea bus di domenica ${targetDate}</strong>.`;
  if (type === "arrivals_48h")   return `Ti inviamo il riepilogo operativo <strong>arrivi +48h</strong> per il <strong>${targetDate}</strong>.`;
  if (type === "departures_48h") return `Ti inviamo il riepilogo operativo <strong>partenze +48h</strong> per il <strong>${targetDate}</strong>.`;
  if (type === "reminder_24h")   return `Di seguito i servizi programmati <strong>nelle prossime 24 ore</strong>.`;
  return `Di seguito i servizi programmati <strong>nelle prossime 48 ore</strong>.`;
}

export function buildServiceListEmailHtml(params: {
  agencyName: string;
  type: ServiceListEmailType;
  targetDate: string;
  lines: ServiceLine[];
  /** Token per il link di revisione agenzia (mostra bottoni Approva/Modifica) */
  reviewToken?: string;
}): string {
  const { agencyName, type, targetDate, lines, reviewToken } = params;
  const label = TYPE_LABELS[type];
  const totalPax  = lines.reduce((s, l) => s + l.pax, 0);
  const arrivals  = lines.filter((l) => l.direction === "arrival").length;
  const departures = lines.filter((l) => l.direction === "departure").length;

  const rows = [...lines]
    .sort((a, b) => `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`))
    .map((line, i) => {
      const isArr = line.direction === "arrival";
      const bg = i % 2 === 0 ? "#ffffff" : "#f8fafc";
      return `<tr style="background:${bg};">
        <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;color:#475569;">${line.date}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;font-weight:600;color:#1e293b;">${line.time}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;">
          <span style="display:inline-block;padding:3px 8px;border-radius:20px;font-size:11px;font-weight:700;
            ${isArr ? "background:#dcfce7;color:#166534;" : "background:#fef9c3;color:#854d0e;"}">
            ${isArr ? "▼ Arrivo" : "▲ Partenza"}
          </span>
        </td>
        <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;font-weight:600;color:#1e293b;">${line.customer_name}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;color:#475569;">${line.hotel_or_destination ?? "N/D"}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;font-weight:700;text-align:center;color:#1e3a5f;">${line.pax}</td>
      </tr>`;
    }).join("");

  // Colore header diverso per reminder vs riepilogo
  const headerBg = isReminder(type)
    ? "linear-gradient(135deg,#0e7490,#0369a1)"   // azzurro — reminder urgente
    : "linear-gradient(135deg,#0f2744,#1e3a5f)";   // navy — riepilogo operativo

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://ischiatransferservice.it";
  const reviewUrl = reviewToken ? `${appUrl}/review/${reviewToken}` : null;

  return emailHtml(`
    <p style="font-size:17px;margin-bottom:6px;">Ciao <strong>${agencyName}</strong>,</p>
    <p style="color:#475569;margin-bottom:28px;">${buildIntro(type, agencyName, targetDate)}</p>

    <div style="display:flex;gap:12px;margin-bottom:28px;">
      ${[
        { label: "Servizi",   value: lines.length, color: "#1e3a5f" },
        { label: "Pax",       value: totalPax,     color: "#0e7490" },
        { label: "Arrivi",    value: arrivals,      color: "#166534" },
        { label: "Partenze",  value: departures,    color: "#854d0e" },
      ].map((s) => `
        <div style="flex:1;background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:14px;text-align:center;">
          <div style="font-size:24px;font-weight:800;color:${s.color};">${s.value}</div>
          <div style="font-size:11px;color:#94a3b8;margin-top:4px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;">${s.label}</div>
        </div>`).join("")}
    </div>

    <table width="100%" cellpadding="0" cellspacing="0" border="0"
      style="border-collapse:collapse;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;">
      <thead>
        <tr style="background:${headerBg};">
          ${["Data","Ora","Dir.","Cliente","Hotel / Dest.","Pax"].map((h, idx) =>
            `<th style="padding:12px;text-align:${idx === 5 ? "center" : "left"};font-size:11px;font-weight:700;
              letter-spacing:0.1em;text-transform:uppercase;color:rgba(255,255,255,0.75);">${h}</th>`
          ).join("")}
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>

    ${reviewUrl ? `
    <div style="margin-top:32px;padding-top:24px;border-top:1px solid #e2e8f0;text-align:center;">
      <p style="color:#475569;font-size:14px;margin-bottom:20px;">
        Confermi che i dati siano corretti? Puoi approvare o segnalare modifiche direttamente da qui.
      </p>
      <table cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
        <tr>
          <td style="padding-right:12px;">
            <a href="${reviewUrl}?action=approve"
              style="display:inline-block;background:#166534;color:#fff;text-decoration:none;
                padding:14px 28px;border-radius:12px;font-weight:700;font-size:15px;">
              ✅ Approva tutto
            </a>
          </td>
          <td>
            <a href="${reviewUrl}"
              style="display:inline-block;background:#fff;color:#854d0e;text-decoration:none;
                padding:13px 28px;border-radius:12px;font-weight:700;font-size:15px;
                border:2px solid #d97706;">
              ✏️ Segnala modifiche
            </a>
          </td>
        </tr>
      </table>
      <p style="font-size:12px;color:#94a3b8;margin-top:16px;">
        Il link è valido per 7 giorni · Risposta sicura, nessuna password richiesta
      </p>
    </div>
    ` : ""}
  `, {
    title: `${label} — ${agencyName}`,
    preheader: `${lines.length} servizi · ${totalPax} pax · ${targetDate}`,
  });
}

export function buildServiceListPlainText(params: {
  agencyName: string;
  type: ServiceListEmailType;
  targetDate: string;
  lines: ServiceLine[];
}): string {
  const { agencyName, type, targetDate, lines } = params;
  const totalPax = lines.reduce((s, l) => s + l.pax, 0);
  const rows = [...lines]
    .sort((a, b) => `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`))
    .map((l) => `${l.date} ${l.time} | ${l.direction === "arrival" ? "Arrivo" : "Partenza"} | ${l.customer_name} | ${l.hotel_or_destination ?? "N/D"} | ${l.pax} pax`);

  return [
    `Ciao ${agencyName},`,
    "",
    TYPE_LABELS[type],
    `Data: ${targetDate} | Servizi: ${lines.length} | Pax: ${totalPax}`,
    "",
    ...rows,
    "",
    "Messaggio generato automaticamente da Ischia Transfer Service."
  ].join("\n");
}
