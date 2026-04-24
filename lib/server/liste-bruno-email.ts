import { getVerifiedFromEmail, resendFetch } from "@/lib/server/send-email";

// Email "Liste Bruno" — inviata da Karmen Peach a Bruno
// Contiene la lista arrivi (stazione/aeroporto) e partenze (per traghetto)
// del giorno selezionato.

export type BrunoArrival = {
  id: string;
  customer_name: string;
  pax: number;
  time: string;
  vessel: string;
  arrival_at_ischia: string | null;  // orario arrivo traghetto a Ischia (per autisti sull'isola)
  place_type: "station" | "airport";
  meeting_point: string | null;
  phone: string;
  hotel_name: string | null;
  notes: string;
  flight_number: string | null;     // numero volo arrivo (train_arrival_number)
  dispatch_source?: "rule" | "manual";
};

export type BrunoDeparture = {
  id: string;
  customer_name: string;
  pax: number;
  time: string;              // orario prelievo hotel (sull'isola, non rilevante per Bruno)
  vessel: string;                  // nome traghetto, es. "MEDMAR 08:10"
  boat_t: string | null;           // orario traghetto da ischia
  arrival_at_porto: string | null; // orario arrivo traghetto al porto continentale (Bruno si fa trovare qui)
  connection_time: string | null;  // orario volo/treno/bus del cliente
  place_type: "station" | "airport";
  meeting_point: string | null;
  phone: string;
  porto_bruno: string | null;   // porto dove Bruno ritira il cliente (Pozzuoli / Napoli Beverello)
  hotel_name: string | null;    // hotel sull'isola (utile per identificare il cliente)
  notes: string;
  flight_number: string | null; // numero volo partenza (train_departure_number)
  dispatch_source?: "rule" | "manual";
};

type BrunoEmailInput = {
  date: string;          // YYYY-MM-DD
  arrivals: BrunoArrival[];
  departures: BrunoDeparture[];
  brunoEmail: string;
  senderNote?: string;
};

function fmtDate(iso: string) {
  return new Date(iso + "T12:00:00").toLocaleDateString("it-IT", {
    weekday: "long", day: "numeric", month: "long", year: "numeric"
  });
}

function placeLabel(place_type: "station" | "airport", meeting_point: string | null) {
  const name = meeting_point?.trim() || (place_type === "station" ? "Stazione" : "Aeroporto");
  return place_type === "station" ? `🚂 ${name}` : `✈️ ${name}`;
}

function buildArrivalsHtml(arrivals: BrunoArrival[]): string {
  if (arrivals.length === 0) return "<p><em>Nessun arrivo da stazione/aeroporto.</em></p>";

  const rows = arrivals
    .sort((a, b) => a.time.localeCompare(b.time))
    .map((a) => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-weight:600">${a.time.slice(0, 5)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0">${a.customer_name}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:center">${a.pax}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0">${placeLabel(a.place_type, a.meeting_point)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0">${a.vessel}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0">${a.flight_number ? `<strong>✈️ ${a.flight_number}</strong>` : "—"}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0">${a.hotel_name ?? "—"}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;color:#64748b;font-size:12px">${a.phone}${a.notes ? ` · ${a.notes}` : ""}</td>
      </tr>`)
    .join("");

  return `
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px">
      <thead>
        <tr style="background:#f1f5f9">
          <th style="padding:8px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#64748b">Ora</th>
          <th style="padding:8px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#64748b">Cliente</th>
          <th style="padding:8px 12px;text-align:center;font-size:11px;text-transform:uppercase;color:#64748b">Pax</th>
          <th style="padding:8px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#64748b">Da</th>
          <th style="padding:8px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#64748b">Traghetto</th>
          <th style="padding:8px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#64748b">Volo</th>
          <th style="padding:8px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#64748b">Hotel</th>
          <th style="padding:8px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#64748b">Telefono / Note</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// Deriva il porto di sbarco dal nome del traghetto (fallback se porto_bruno non è salvato)
function portoDaVessel(vessel: string): string {
  const v = vessel.toLowerCase();
  if (v.includes("snav")) return "Pozzuoli";
  if (v.includes("alilauro")) return "Napoli Beverello";
  if (v.includes("medmar napoli")) return "Napoli Beverello";
  if (v.includes("medmar pozzuoli") || v.includes("medmar")) return "Pozzuoli";
  return vessel;
}

function buildDeparturesHtml(departures: BrunoDeparture[]): string {
  if (departures.length === 0) return "<p><em>Nessuna partenza verso stazione/aeroporto.</em></p>";

  // Raggruppa per traghetto (vessel)
  const byVessel = departures.reduce<Record<string, BrunoDeparture[]>>((acc, d) => {
    const key = `${d.vessel}|${d.time}`;
    (acc[key] ??= []).push(d);
    return acc;
  }, {});

  const sections = Object.entries(byVessel)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, group]) => {
      const [vessel] = key.split("|");
      const firstTime = group[0].time.slice(0, 5);
      const totalPax = group.reduce((s, d) => s + d.pax, 0);

      const rows = group
        .sort((a, b) => a.customer_name.localeCompare(b.customer_name))
        .map((d) => {
          const portoBrunoLabel = d.porto_bruno ?? portoDaVessel(d.vessel);
          const connLabel = d.connection_time
            ? `<strong style="color:#c2410c">${d.place_type === "airport" ? "✈️" : "🚂"} ${d.connection_time.slice(0, 5)}</strong>`
            : "—";
          return `
          <tr>
            <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-weight:600">${d.customer_name}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:center">${d.pax}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0">⚓ ${portoBrunoLabel}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0">${connLabel}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0">${d.flight_number ? `<strong>✈️ ${d.flight_number}</strong>` : "—"}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0">${placeLabel(d.place_type, d.meeting_point)}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;color:#64748b;font-size:12px">${d.phone}${d.notes ? ` · ${d.notes}` : ""}</td>
          </tr>`;
        })
        .join("");

      const groupPorto = group[0] ? (group[0].porto_bruno ?? portoDaVessel(group[0].vessel)) : "—";
      const groupConnTime = group.find(d => d.connection_time)?.connection_time ?? null;
      const groupConnIcon = group[0]?.place_type === "airport" ? "✈️" : "🚂";
      const groupArrival = group.find(d => d.arrival_at_porto)?.arrival_at_porto ?? null;

      return `
        <div style="margin-bottom:24px">
          <div style="background:#1e293b;color:white;padding:10px 14px;border-radius:8px 8px 0 0;font-weight:700;font-size:15px">
            ⛴ ${vessel} &mdash; Porto: ${groupPorto} &mdash; parte ${firstTime}${groupConnTime ? ` &mdash; <span style="color:#fdba74">${groupConnIcon} ${groupConnTime.slice(0, 5)}</span>` : ""}
            <span style="font-size:12px;font-weight:400;opacity:0.75">&nbsp;${totalPax} pax totali</span>
            ${groupArrival ? `<div style="margin-top:8px;background:rgba(16,185,129,0.25);border-radius:6px;padding:6px 12px;font-size:14px;color:#6ee7b7">🕐 Bruno si fa trovare alle <strong>${groupArrival}</strong> a ${groupPorto}</div>` : ""}
          </div>
          <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px;border:1px solid #e2e8f0;border-top:none">
            <thead>
              <tr style="background:#f8fafc">
                <th style="padding:7px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#64748b">Cliente</th>
                <th style="padding:7px 12px;text-align:center;font-size:11px;text-transform:uppercase;color:#64748b">Pax</th>
                <th style="padding:7px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#64748b">Porto ritiro Bruno</th>
                <th style="padding:7px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#64748b">Orario connessione</th>
                <th style="padding:7px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#64748b">N° Volo</th>
                <th style="padding:7px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#64748b">Verso</th>
                <th style="padding:7px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#64748b">Telefono / Note</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
    })
    .join("");

  return sections;
}

export async function sendListeBrunoEmail(input: BrunoEmailInput): Promise<{ ok: boolean; error?: string }> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = getVerifiedFromEmail();
  if (!apiKey) return { ok: false, error: "RESEND_API_KEY non configurata" };

  const dateLabel = fmtDate(input.date);
  const subject = `Liste Bruno — ${dateLabel}`;

  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/$/, "") ?? "https://ischia-transfer.vercel.app";
  const logoUrl = `${appUrl}/brand/logo-ischia-transfer-email.png`;

  const html = `
<!DOCTYPE html>
<html lang="it">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:760px;margin:32px auto;background:white;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.07)">

    <!-- Header -->
    <div style="background:#0f172a;padding:24px 28px">
      <div style="display:flex;align-items:center;gap:16px;margin-bottom:12px">
        <img src="${logoUrl}" alt="Ischia Transfer Service" style="height:64px;width:auto;display:block" />
      </div>
      <h1 style="margin:0;color:white;font-size:22px;font-weight:700">Liste Bruno</h1>
      <p style="margin:6px 0 0;color:#cbd5e1;font-size:14px">${dateLabel}</p>
    </div>

    <div style="padding:28px">

      <!-- Note Karmen -->
      ${input.senderNote ? `<div style="background:#fef9c3;border:1px solid #fde68a;border-radius:8px;padding:12px 16px;margin-bottom:24px;font-size:14px;color:#92400e"><strong>Nota di Karmen:</strong> ${input.senderNote}</div>` : ""}

      <!-- ARRIVI -->
      <h2 style="margin:0 0 12px;font-size:17px;color:#0f172a;border-bottom:2px solid #e2e8f0;padding-bottom:8px">
        📥 Arrivi da stazione / aeroporto
        <span style="font-size:13px;font-weight:400;color:#64748b;margin-left:8px">${input.arrivals.length} servizi</span>
      </h2>
      ${buildArrivalsHtml(input.arrivals)}

      <div style="margin:32px 0"></div>

      <!-- PARTENZE -->
      <h2 style="margin:0 0 12px;font-size:17px;color:#0f172a;border-bottom:2px solid #e2e8f0;padding-bottom:8px">
        📤 Partenze verso stazione / aeroporto
        <span style="font-size:13px;font-weight:400;color:#64748b;margin-left:8px">${input.departures.length} servizi</span>
      </h2>
      ${buildDeparturesHtml(input.departures)}

    </div>

    <!-- Footer -->
    <div style="background:#f1f5f9;padding:16px 28px;font-size:11px;color:#94a3b8;text-align:center">
      Generato da Ischia Transfer Service PMS &mdash; Lista preparata da Karmen Peach
    </div>
  </div>
</body>
</html>`;

  const text = [
    `LISTE BRUNO — ${dateLabel}`,
    ``,
    `── ARRIVI DA STAZIONE/AEROPORTO (${input.arrivals.length}) ──`,
    ...input.arrivals
      .sort((a, b) => a.time.localeCompare(b.time))
      .map((a) => `${a.time.slice(0, 5)} | ${a.customer_name} | ${a.pax} pax | ${a.meeting_point ?? a.place_type} | ${a.vessel} | Hotel: ${a.hotel_name ?? "—"} | ${a.phone}`),
    ``,
    `── PARTENZE VERSO STAZIONE/AEROPORTO (${input.departures.length}) ──`,
    ...input.departures
      .sort((a, b) => a.vessel.localeCompare(b.vessel))
      .map((d) => `${d.vessel} | ${d.customer_name} | ${d.pax} pax | Porto ritiro: ${d.porto_bruno ?? portoDaVessel(d.vessel)}${d.connection_time ? ` | ${d.place_type === "airport" ? "Volo" : "Treno"}: ${d.connection_time.slice(0, 5)}` : ""} | ${d.meeting_point ?? d.place_type} | ${d.phone}`),
  ].join("\n");

  try {
    const res = await resendFetch(apiKey, { from, to: [input.brunoEmail], subject, html, text });
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      return { ok: false, error: `Resend error: ${err}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Errore invio email" };
  }
}
