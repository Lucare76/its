// Email "Liste Bruno" — inviata da Karmen Peach a Bruno
// Contiene la lista arrivi (stazione/aeroporto) e partenze (per traghetto)
// del giorno selezionato.

export type BrunoArrival = {
  id: string;
  customer_name: string;
  pax: number;
  time: string;
  vessel: string;
  place_type: "station" | "airport";
  meeting_point: string | null;
  phone: string;
  hotel_name: string | null;
  notes: string;
};

export type BrunoDeparture = {
  id: string;
  customer_name: string;
  pax: number;
  time: string;
  vessel: string;
  place_type: "station" | "airport";
  meeting_point: string | null;
  phone: string;
  hotel_name: string | null;
  notes: string;
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
          <th style="padding:8px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#64748b">Hotel</th>
          <th style="padding:8px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#64748b">Telefono / Note</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
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
        .map((d) => `
          <tr>
            <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-weight:600">${d.customer_name}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:center">${d.pax}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0">${d.hotel_name ?? "—"}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0">${placeLabel(d.place_type, d.meeting_point)}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;color:#64748b;font-size:12px">${d.phone}${d.notes ? ` · ${d.notes}` : ""}</td>
          </tr>`)
        .join("");

      return `
        <div style="margin-bottom:24px">
          <div style="background:#1e293b;color:white;padding:10px 14px;border-radius:8px 8px 0 0;font-weight:700;font-size:15px">
            ⛴ ${vessel} &mdash; pickup ${firstTime} &nbsp;
            <span style="font-size:12px;font-weight:400;opacity:0.75">${totalPax} pax totali</span>
          </div>
          <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px;border:1px solid #e2e8f0;border-top:none">
            <thead>
              <tr style="background:#f8fafc">
                <th style="padding:7px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#64748b">Cliente</th>
                <th style="padding:7px 12px;text-align:center;font-size:11px;text-transform:uppercase;color:#64748b">Pax</th>
                <th style="padding:7px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#64748b">Hotel</th>
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
  const from = process.env.AGENCY_BOOKING_FROM_EMAIL?.trim() || "noreply@ischiatransferservice.it";
  if (!apiKey) return { ok: false, error: "RESEND_API_KEY non configurata" };

  const dateLabel = fmtDate(input.date);
  const subject = `Liste Bruno — ${dateLabel}`;

  const html = `
<!DOCTYPE html>
<html lang="it">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:760px;margin:32px auto;background:white;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.07)">

    <!-- Header -->
    <div style="background:#0f172a;padding:24px 28px">
      <p style="margin:0;color:#94a3b8;font-size:11px;text-transform:uppercase;letter-spacing:0.15em">Ischia Transfer Service</p>
      <h1 style="margin:4px 0 0;color:white;font-size:22px;font-weight:700">Liste Bruno</h1>
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
      .map((d) => `${d.vessel} | ${d.customer_name} | ${d.pax} pax | ${d.meeting_point ?? d.place_type} | Hotel: ${d.hotel_name ?? "—"} | ${d.phone}`),
  ].join("\n");

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [input.brunoEmail], subject, html, text }),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      return { ok: false, error: `Resend error: ${err}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Errore invio email" };
  }
}
