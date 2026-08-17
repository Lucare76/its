type Direction = "arrival" | "departure";

export type BusPdfAllocation = {
  stop_name: string;
  stop_pickup_note?: string | null;
  stop_pickup_time?: string | null;
  hotel_pickup_time?: string | null;
  pax_assigned: number;
  customer_name: string;
  customer_phone?: string | null;
  hotel_name?: string | null;
  agency_name?: string | null;
  notes?: string | null;
};

export type BusPdfStop = {
  stop_name: string;
  pickup_note?: string | null;
  pickup_time?: string | null;
  stop_order: number;
};

type BusPdfInput = {
  direction: Direction;
  title?: string;
  lineName: string;
  busLabel?: string | null;
  dateIso: string;
  driverName?: string | null;
  driverPhone?: string | null;
  allocations: BusPdfAllocation[];
  stops?: BusPdfStop[];
  logoBase64?: string | null;
};

const BRAND_NAVY = "#082452";
const BRAND_BLUE = "#0b56a4";
const BRAND_ORANGE = "#f59e0b";
const GRID = "#b9c4d0";

function escapeHtml(value: string | number | null | undefined) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function fmtDate(iso: string) {
  return new Date(`${iso}T12:00:00`).toLocaleDateString("it-IT", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function time5(value: string | null | undefined) {
  return value ? value.slice(0, 5) : "";
}

function extractFromNotes(rawNotes: string | null | undefined) {
  const raw = rawNotes ?? "";
  const hotelMatch = raw.match(/Hotel:\s*([^|]+?)(?:\s*\||$)/i);
  const agencyMatch = raw.match(/Agenzia:\s*([^|]+?)(?:\s*\||$)/i);
  const cleanNote = raw
    .replace(/Hotel:\s*([^|]+?)(?:\s*\||$)/gi, "")
    .replace(/Agenzia:\s*([^|]+?)(?:\s*\||$)/gi, "")
    .replace(/\s*\|\s*/g, " ")
    .trim();
  return {
    hotelFromNotes: hotelMatch?.[1]?.trim() ?? "",
    agencyFromNotes: agencyMatch?.[1]?.trim() ?? "",
    cleanNote,
  };
}

function stopOrderMap(stops: BusPdfStop[] = []) {
  return new Map(stops.map((stop) => [stop.stop_name.toUpperCase(), stop.stop_order]));
}

function sortedAllocations(allocations: BusPdfAllocation[], stops: BusPdfStop[] = []) {
  const orders = stopOrderMap(stops);
  return [...allocations].sort((a, b) => {
    const orderA = orders.get(a.stop_name.toUpperCase()) ?? 9999;
    const orderB = orders.get(b.stop_name.toUpperCase()) ?? 9999;
    if (orderA !== orderB) return orderA - orderB;
    const timeA = time5(a.stop_pickup_time || a.hotel_pickup_time);
    const timeB = time5(b.stop_pickup_time || b.hotel_pickup_time);
    if (timeA !== timeB) return timeA.localeCompare(timeB);
    return a.customer_name.localeCompare(b.customer_name, "it");
  });
}

function groupKey(alloc: BusPdfAllocation) {
  return `${time5(alloc.stop_pickup_time || alloc.hotel_pickup_time)}|${alloc.stop_name.toUpperCase()}`;
}

function buildRows(input: BusPdfInput) {
  const sorted = sortedAllocations(input.allocations, input.stops);
  let previousKey = "";
  let total = 0;

  return {
    totalPax: sorted.reduce((sum, alloc) => sum + alloc.pax_assigned, 0),
    rows: sorted.map((alloc, index) => {
      const key = groupKey(alloc);
      const shouldRenderStop = key !== previousKey;
      previousKey = key;
      total += alloc.pax_assigned;
      const { hotelFromNotes, agencyFromNotes, cleanNote } = extractFromNotes(alloc.notes);
      const stopTime = time5(alloc.stop_pickup_time || alloc.hotel_pickup_time);
      const stopNote = alloc.stop_pickup_note ?? input.stops?.find((s) => s.stop_name.toUpperCase() === alloc.stop_name.toUpperCase())?.pickup_note ?? "";
      const hotel = alloc.hotel_name || hotelFromNotes;
      const agency = alloc.agency_name || agencyFromNotes;
      return { alloc, index, shouldRenderStop, stopTime, stopNote, hotel, agency, cleanNote, runningTotal: total };
    }),
  };
}

export function buildBusLinePdfHtml(input: BusPdfInput) {
  const directionTitle = input.title ?? (input.direction === "arrival" ? "ARRIVI" : "PARTENZE");
  const { rows, totalPax } = buildRows(input);
  const driver = `${input.driverName || "N/D"}${input.driverPhone ? ` · ${input.driverPhone}` : ""}`;
  const subtitle = `${input.lineName}${input.busLabel ? ` — Bus ${input.busLabel}` : ""} · ${fmtDate(input.dateIso)}`;
  const headerColumns = input.direction === "arrival"
    ? ["orario", "punto di carico", "n° pax", "nominativo", "cell", "HOTEL", "note", "agenzia"]
    : ["pickup", "hotel partenza", "n° pax", "nominativo", "cell", "destinazione", "agenzia", "note"];

  const bodyRows = rows.map(({ alloc, index, shouldRenderStop, stopTime, stopNote, hotel, agency, cleanNote }) => {
    const stopBand = shouldRenderStop
      ? `<tr class="stop-row"><td colspan="8"><span class="bus-icon">▣</span><strong>${escapeHtml(stopTime || "—")} ${escapeHtml(alloc.stop_name)}</strong><span>${escapeHtml(stopNote)}</span></td></tr>`
      : "";
    const cells = input.direction === "arrival"
      ? [
          stopTime,
          stopNote,
          alloc.pax_assigned,
          alloc.customer_name,
          alloc.customer_phone,
          hotel,
          cleanNote,
          agency,
        ]
      : [
          time5(alloc.hotel_pickup_time || alloc.stop_pickup_time),
          hotel,
          alloc.pax_assigned,
          alloc.customer_name,
          alloc.customer_phone,
          alloc.stop_name,
          agency,
          cleanNote,
        ];
    return `${stopBand}<tr class="${index % 2 === 1 ? "alt" : ""}">${cells.map((cell, cellIndex) => `<td class="${cellIndex === 2 ? "center" : ""}">${escapeHtml(cell)}</td>`).join("")}</tr>`;
  }).join("");

  const logoMarkup = input.logoBase64
    ? `<img class="logo" src="${input.logoBase64}" alt="Ischia Transfer Service" />`
    : `<div class="logo-fallback"><strong>ISCHIA</strong><span>TRANSFER SERVICE</span></div>`;

  return `<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(directionTitle)} - ${escapeHtml(input.lineName)}</title>
  <style>
    @page { size: A4 landscape; margin: 6mm; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #eef3f8; color: #071733; font-family: Arial, Helvetica, sans-serif; }
    .print-shell { padding: 18px; }
    .page {
      width: 285mm;
      min-height: 198mm;
      margin: 0 auto;
      background: white;
      border: 1px solid #d9e2ec;
      box-shadow: 0 16px 42px rgba(8, 36, 82, 0.16);
      padding: 5mm 7mm 5mm;
    }
    .top {
      display: grid;
      grid-template-columns: 48mm 1fr 52mm;
      align-items: center;
      gap: 6mm;
      min-height: 22mm;
      border-bottom: 2px solid ${BRAND_NAVY};
      padding-bottom: 3mm;
    }
    .logo { width: 34mm; height: auto; display: block; }
    .logo-fallback { color: ${BRAND_NAVY}; font-size: 20px; line-height: 1; }
    .logo-fallback span { display: block; font-size: 12px; letter-spacing: 0.18em; }
    h1 { margin: 0; text-align: center; color: ${BRAND_NAVY}; font-size: 34px; line-height: 0.92; letter-spacing: 0.18em; }
    .subtitle { margin-top: 4px; text-align: center; color: ${BRAND_BLUE}; font-size: 12.5px; font-weight: 800; }
    .chips { display: grid; gap: 4px; }
    .chip {
      border: 1.5px solid ${BRAND_BLUE};
      border-radius: 6px;
      padding: 5px 7px;
      color: ${BRAND_NAVY};
      font-size: 12.5px;
      font-weight: 700;
      text-align: center;
      background: linear-gradient(180deg, #ffffff, #f8fbff);
    }
    .chip strong { color: #079669; font-size: 18px; }
    table { width: 100%; margin-top: 4mm; border-collapse: collapse; table-layout: fixed; }
    th {
      background: linear-gradient(180deg, #0b4a91, ${BRAND_NAVY});
      color: white;
      border: 1px solid #8bb1d8;
      padding: 5px 4px;
      font-size: 10.5px;
      text-transform: lowercase;
      text-align: center;
    }
    td {
      border: 1px solid ${GRID};
      padding: 4px 5px;
      font-size: 9.8px;
      line-height: 1.16;
      vertical-align: middle;
      overflow-wrap: break-word;
    }
    tbody tr.alt td { background: #f8fbff; }
    .stop-row td {
      background: #eaf4ff;
      color: ${BRAND_NAVY};
      font-size: 11px;
      font-weight: 700;
      padding: 5px 7px;
    }
    .stop-row span:last-child { margin-left: 12px; color: #31577e; font-size: 9.5px; font-weight: 600; }
    .bus-icon { color: ${BRAND_ORANGE}; margin-right: 8px; }
    .center { text-align: center; font-weight: 700; }
    .total td {
      background: #fff2c8;
      color: ${BRAND_NAVY};
      font-weight: 800;
      font-size: 12px;
      text-align: center;
    }
    .total .value { color: #079669; font-size: 17px; }
    .footer {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 14mm;
      margin-top: 5mm;
      color: ${BRAND_NAVY};
      font-size: 12px;
      font-weight: 700;
    }
    .signature { text-align: center; }
    .signature::after {
      content: "";
      display: block;
      width: 85mm;
      margin: 9px auto 0;
      border-bottom: 1.5px solid #6b7b8f;
    }
    .driver-box {
      border: 1px solid #d7e2ef;
      border-radius: 8px;
      padding: 7px 10px;
      background: #f8fbff;
    }
    .screen-actions { position: sticky; top: 0; display: flex; justify-content: center; gap: 12px; padding: 12px; }
    .screen-actions button {
      border: 0;
      border-radius: 10px;
      padding: 10px 18px;
      color: white;
      background: linear-gradient(135deg, #2563eb, #5b2eea);
      font-weight: 800;
      cursor: pointer;
      box-shadow: 0 10px 24px rgba(37, 99, 235, 0.22);
    }
    @media print {
      body { background: white; }
      .print-shell { padding: 0; }
      .page { width: auto; min-height: auto; border: 0; box-shadow: none; padding: 0; }
      .screen-actions { display: none; }
    }
  </style>
</head>
<body>
  <div class="screen-actions"><button onclick="window.print()">Stampa / Salva PDF</button></div>
  <main class="print-shell">
    <section class="page">
      <header class="top">
        <div>${logoMarkup}</div>
        <div>
          <h1>${escapeHtml(directionTitle)}</h1>
          <div class="subtitle">${escapeHtml(subtitle)}</div>
        </div>
        <div class="chips">
          <div class="chip">Totale passeggeri: <strong>${totalPax}</strong></div>
          <div class="chip">Autista: ${escapeHtml(driver)}</div>
        </div>
      </header>
      <table>
        <colgroup>
          <col style="width: 10%" />
          <col style="width: 19%" />
          <col style="width: 7%" />
          <col style="width: 23%" />
          <col style="width: 12%" />
          <col style="width: 14%" />
          <col style="width: 8%" />
          <col style="width: 12%" />
        </colgroup>
        <thead><tr>${headerColumns.map((column) => `<th>${escapeHtml(column)}</th>`).join("")}</tr></thead>
        <tbody>
          ${bodyRows || `<tr><td colspan="8" class="center">Nessun passeggero assegnato</td></tr>`}
          <tr class="total"><td colspan="2">TOTALE</td><td class="value">${totalPax}</td><td colspan="5"></td></tr>
        </tbody>
      </table>
      <footer class="footer">
        <div class="driver-box">Autista: ${escapeHtml(driver)}</div>
        <div class="signature">Firma autista</div>
      </footer>
    </section>
  </main>
</body>
</html>`;
}

export function openBusLinePdf(input: BusPdfInput) {
  const html = buildBusLinePdfHtml(input);
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const win = window.open(url, "_blank", "width=1280,height=900");
  if (!win) {
    URL.revokeObjectURL(url);
    throw new Error("Popup bloccato: abilita i popup per aprire il PDF.");
  }
  win.focus();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
