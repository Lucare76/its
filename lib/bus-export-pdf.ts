type Direction = "arrival" | "departure";

export type BusPdfAllocation = {
  stop_name: string;
  stop_city?: string | null;
  stop_pickup_note?: string | null;
  stop_pickup_time?: string | null;
  hotel_pickup_time?: string | null;
  pax_assigned: number;
  customer_name: string;
  customer_phone?: string | null;
  booking_group_contact_name?: string | null;
  booking_group_contact_phone?: string | null;
  booking_group_outbound_ferry_company?: string | null;
  booking_group_outbound_departure_port?: string | null;
  booking_group_outbound_ferry_time?: string | null;
  booking_group_outbound_arrival_port?: string | null;
  booking_group_return_ferry_company?: string | null;
  booking_group_return_departure_port?: string | null;
  booking_group_return_ferry_time?: string | null;
  booking_group_return_arrival_port?: string | null;
  is_booking_group?: boolean;
  hotel_name?: string | null;
  agency_name?: string | null;
  notes?: string | null;
  // Obiettivo B/C: note gruppo/fermata/servizio gia' composte a monte
  // (page.tsx, composeGroupNotesBlock) — mai lette prima d'ora dal PDF.
  group_notes_block?: string | null;
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

function normalizeLabel(value: string | null | undefined) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function visiblePickupNote(stopName: string, pickupNote: string | null | undefined) {
  const note = (pickupNote ?? "").trim();
  if (!note) return "";
  const normalizedStop = normalizeLabel(stopName);
  const normalizedNote = normalizeLabel(note);
  return normalizedNote && normalizedStop.includes(normalizedNote) ? "" : note;
}

function displayStopName(alloc: BusPdfAllocation) {
  return (alloc.stop_name ?? "").trim();
}

function displayStopCity(alloc: BusPdfAllocation) {
  const city = (alloc.stop_city ?? "").trim();
  if (city) return city;
  const [firstPart] = (alloc.stop_name ?? "").split(/\s+-\s+/).map((part) => part.trim()).filter(Boolean);
  return firstPart ?? alloc.stop_name;
}

function displayPickupPoint(alloc: BusPdfAllocation, fallbackPickup: string | null | undefined) {
  const pickup = (fallbackPickup ?? "").trim();
  if (pickup) return pickup;
  const city = displayStopCity(alloc);
  const stop = displayStopName(alloc);
  if (normalizeLabel(stop) === normalizeLabel(city)) return "";
  if (normalizeLabel(stop).startsWith(`${normalizeLabel(city)} `)) {
    return stop.slice(city.length).replace(/^\s*-\s*/, "").trim();
  }
  return stop;
}

function displayHotel(alloc: BusPdfAllocation, hotelFromNotes: string) {
  // Obiettivo A: prima azzerava sempre l'hotel per le righe di gruppo
  // (perdendo booking_group.hotel_id anche quando valorizzato). Ora
  // alloc.hotel_name arriva gia' risolto da page.tsx con la priorita'
  // corretta (service > gruppo > note legacy > vuoto), quindi si usa
  // sempre — nessun comportamento speciale per is_booking_group.
  return alloc.hotel_name || hotelFromNotes;
}

function firstBookingGroupContact(allocations: BusPdfAllocation[]) {
  const match = allocations.find((alloc) => alloc.booking_group_contact_name || alloc.booking_group_contact_phone);
  if (!match) return null;
  return {
    name: match.booking_group_contact_name?.trim() ?? "",
    phone: match.booking_group_contact_phone?.trim() ?? "",
  };
}

function firstBookingGroupFerry(allocations: BusPdfAllocation[], direction: Direction) {
  const match = allocations.find((alloc) => (
    direction === "arrival"
      ? alloc.booking_group_outbound_ferry_company || alloc.booking_group_outbound_departure_port || alloc.booking_group_outbound_ferry_time || alloc.booking_group_outbound_arrival_port
      : alloc.booking_group_return_ferry_company || alloc.booking_group_return_departure_port || alloc.booking_group_return_ferry_time || alloc.booking_group_return_arrival_port
  ));
  if (!match) return null;
  return direction === "arrival"
    ? {
        company: match.booking_group_outbound_ferry_company?.trim() ?? "",
        departurePort: match.booking_group_outbound_departure_port?.trim() ?? "",
        time: time5(match.booking_group_outbound_ferry_time),
        arrivalPort: match.booking_group_outbound_arrival_port?.trim() ?? "",
      }
    : {
        company: match.booking_group_return_ferry_company?.trim() ?? "",
        departurePort: match.booking_group_return_departure_port?.trim() ?? "",
        time: time5(match.booking_group_return_ferry_time),
        arrivalPort: match.booking_group_return_arrival_port?.trim() ?? "",
      };
}

function sortedAllocations(allocations: BusPdfAllocation[], stops: BusPdfStop[] = [], direction: Direction = "arrival") {
  const orders = stopOrderMap(stops);
  if (direction === "departure") {
    return [...allocations].sort((a, b) => {
      const timeA = time5(a.hotel_pickup_time || a.stop_pickup_time);
      const timeB = time5(b.hotel_pickup_time || b.stop_pickup_time);
      if (timeA !== timeB) return timeB.localeCompare(timeA);
      const orderA = orders.get(a.stop_name.toUpperCase()) ?? 9999;
      const orderB = orders.get(b.stop_name.toUpperCase()) ?? 9999;
      if (orderA !== orderB) return orderB - orderA;
      const stopA = displayStopName(a).toUpperCase();
      const stopB = displayStopName(b).toUpperCase();
      if (stopA !== stopB) return stopA.localeCompare(stopB, "it");
      const hotelA = (a.hotel_name ?? "").toUpperCase();
      const hotelB = (b.hotel_name ?? "").toUpperCase();
      if (hotelA !== hotelB) return hotelA.localeCompare(hotelB);
      return a.customer_name.localeCompare(b.customer_name, "it");
    });
  }
  return [...allocations].sort((a, b) => {
    const timeA = time5(a.stop_pickup_time || a.hotel_pickup_time);
    const timeB = time5(b.stop_pickup_time || b.hotel_pickup_time);
    if (timeA !== timeB) return timeA.localeCompare(timeB);
    const orderA = orders.get(a.stop_name.toUpperCase()) ?? 9999;
    const orderB = orders.get(b.stop_name.toUpperCase()) ?? 9999;
    if (orderA !== orderB) return orderA - orderB;
    return a.customer_name.localeCompare(b.customer_name, "it");
  });
}

function groupKey(alloc: BusPdfAllocation, direction: Direction) {
  if (direction === "departure") return displayStopName(alloc).toUpperCase();
  return `${time5(alloc.stop_pickup_time || alloc.hotel_pickup_time)}|${displayStopName(alloc).toUpperCase()}`;
}

function buildRows(input: BusPdfInput) {
  const sorted = sortedAllocations(input.allocations, input.stops, input.direction);
  let previousKey = "";
  let total = 0;

  return {
    totalPax: sorted.reduce((sum, alloc) => sum + alloc.pax_assigned, 0),
    rows: sorted.map((alloc, index) => {
      const key = groupKey(alloc, input.direction);
      const shouldRenderStop = key !== previousKey;
      previousKey = key;
      total += alloc.pax_assigned;
      const { hotelFromNotes, agencyFromNotes, cleanNote } = extractFromNotes(alloc.notes);
      const stopTime = time5(alloc.stop_pickup_time || alloc.hotel_pickup_time);
      const stopName = displayStopName(alloc);
      const rawStopNote = alloc.stop_pickup_note ?? input.stops?.find((s) => s.stop_name.toUpperCase() === alloc.stop_name.toUpperCase())?.pickup_note ?? "";
      const stopCity = displayStopCity(alloc);
      const stopNote = displayPickupPoint(alloc, rawStopNote);
      const hotel = displayHotel(alloc, hotelFromNotes);
      const agency = alloc.agency_name || agencyFromNotes;
      // Obiettivo B/C: la nota "pulita" dell'allocazione (comportamento
      // invariato) resta la base; le note gruppo/fermata/servizio si
      // aggiungono senza sovrascriverla.
      const noteCell = [cleanNote, alloc.group_notes_block].filter(Boolean).join(" · ");
      return { alloc, index, shouldRenderStop, stopTime, stopNote, stopCity, hotel, agency, cleanNote: noteCell, runningTotal: total };
    }),
  };
}

function buildDepartureUnloadRows(input: BusPdfInput) {
  if (input.direction !== "departure") return "";
  const paxByStop = new Map<string, number>();
  for (const alloc of input.allocations) {
    const key = alloc.stop_name.toUpperCase();
    paxByStop.set(key, (paxByStop.get(key) ?? 0) + alloc.pax_assigned);
  }
  const usedStopNames = new Set(input.allocations.map((alloc) => alloc.stop_name.toUpperCase()));
  const stops = (input.stops ?? [])
    .filter((stop) => usedStopNames.has(stop.stop_name.toUpperCase()))
    .sort((a, b) => a.stop_order - b.stop_order);

  if (stops.length === 0) return "";

  const rows = stops.map((stop) => {
    const pickupNote = visiblePickupNote(stop.stop_name, stop.pickup_note);
    const label = pickupNote ? `${stop.stop_name} - ${pickupNote}` : stop.stop_name;
    const pax = paxByStop.get(stop.stop_name.toUpperCase()) ?? 0;
    return `<tr class="unload-row"><td colspan="8"><div class="unload-line"><span>${escapeHtml(label)}</span><strong>${pax} pax</strong></div></td></tr>`;
  }).join("");

  return `<tr class="spacer-row"><td colspan="8"></td></tr><tr class="unload-title"><td colspan="8">SCARICO</td></tr>${rows}`;
}

export function buildBusLinePdfHtml(input: BusPdfInput) {
  const directionTitle = input.title ?? (input.direction === "arrival" ? "ARRIVI" : "PARTENZE");
  const { rows, totalPax } = buildRows(input);
  const departureUnloadRows = buildDepartureUnloadRows(input);
  const groupContact = firstBookingGroupContact(input.allocations);
  const groupFerry = firstBookingGroupFerry(input.allocations, input.direction);
  const driver = `${input.driverName || "N/D"}${input.driverPhone ? ` - ${input.driverPhone}` : ""}`;
  const isExclusiveGroupLine = normalizeLabel(input.lineName) === "bus esclusivi gruppi";
  const subtitle = isExclusiveGroupLine && input.busLabel
    ? `${input.busLabel} - ${fmtDate(input.dateIso)}`
    : `${input.lineName}${input.busLabel ? ` - Bus ${input.busLabel}` : ""} - ${fmtDate(input.dateIso)}`;
  const headerColumns = input.direction === "arrival"
    ? ["orario", "punto di carico", "n° pax", "nominativo", "cell", "HOTEL", "note", "agenzia"]
    : ["pickup", "hotel partenza", "n° pax", "nominativo", "cell", "destinazione", "agenzia", "note"];

  const bodyRows = rows.map(({ alloc, index, shouldRenderStop, stopTime, stopNote, stopCity, hotel, agency, cleanNote }) => {
    const shouldShowStopBand = shouldRenderStop;
    const stopBand = shouldShowStopBand
      ? `<tr class="stop-row"><td colspan="8"><span class="bus-icon">&bull;</span><strong>${escapeHtml(stopCity)}</strong><span>${escapeHtml(stopNote)}</span></td></tr>`
      : "";
    const cells = input.direction === "arrival"
      ? [
          stopTime,
          "",
          alloc.pax_assigned,
          alloc.is_booking_group ? "" : alloc.customer_name,
          alloc.is_booking_group ? "" : alloc.customer_phone,
          hotel,
          cleanNote,
          agency,
        ]
      : [
          time5(alloc.hotel_pickup_time || alloc.stop_pickup_time),
          hotel,
          alloc.pax_assigned,
          alloc.is_booking_group ? "" : alloc.customer_name,
          alloc.is_booking_group ? "" : alloc.customer_phone,
          stopNote ? `${displayStopName(alloc)} - ${stopNote}` : displayStopName(alloc),
          agency,
          cleanNote,
        ];
    return `${stopBand}<tr class="${index % 2 === 1 ? "alt" : ""}">${cells.map((cell, cellIndex) => {
      const className = cellIndex === 2 ? "center" : "";
      return `<td class="${className}">${escapeHtml(cell)}</td>`;
    }).join("")}</tr>`;
  }).join("");

  const logoMarkup = input.logoBase64
    ? `<img class="logo" src="${input.logoBase64}" alt="Ischia Transfer Service" />`
    : `<div class="logo-fallback"><strong>ISCHIA</strong><span>TRANSFER SERVICE</span></div>`;
  const groupContactMarkup = groupContact
    ? `<section class="group-contact"><strong>Capogruppo</strong><span>${escapeHtml(groupContact.name || "N/D")}</span>${groupContact.phone ? `<span>${escapeHtml(groupContact.phone)}</span>` : ""}</section>`
    : "";
  const groupFerryLabel = groupFerry
    ? [
        groupFerry.company,
        groupFerry.departurePort && groupFerry.arrivalPort ? `${groupFerry.departurePort} → ${groupFerry.arrivalPort}` : groupFerry.departurePort || groupFerry.arrivalPort,
        groupFerry.time,
      ].filter(Boolean).join(" - ")
    : "";
  const groupFerryMarkup = groupFerryLabel
    ? `<section class="group-contact"><strong>Traghetto previsto</strong><span>${escapeHtml(groupFerryLabel)}</span></section>`
    : "";

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
    .group-contact {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-top: 4mm;
      border: 1px solid ${BRAND_BLUE};
      border-radius: 6px;
      background: #f8fbff;
      color: ${BRAND_NAVY};
      padding: 7px 10px;
      font-size: 12px;
      font-weight: 700;
    }
    .group-contact strong {
      text-transform: uppercase;
      color: ${BRAND_BLUE};
      letter-spacing: 0.08em;
      font-size: 10px;
    }
    .group-contact span {
      font-size: 13px;
    }
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
      text-align: center;
      overflow-wrap: break-word;
    }
    tbody tr.alt td { background: #f8fbff; }
    .stop-row td {
      background: #eaf4ff;
      color: ${BRAND_NAVY};
      font-size: 11px;
      font-weight: 700;
      padding: 5px 7px;
      text-align: left;
    }
    .stop-row span:last-child { margin-left: 12px; color: #31577e; font-size: 9.5px; font-weight: 600; }
    .bus-icon { color: ${BRAND_ORANGE}; margin-right: 8px; }
    .center { text-align: center; font-weight: 700; }
    .pickup-cell {
      text-align: center;
      font-weight: 700;
      line-height: 1.22;
    }
    .pickup-cell strong {
      display: block;
      color: ${BRAND_NAVY};
      font-size: 10.2px;
      text-transform: uppercase;
    }
    .pickup-cell span {
      display: block;
      margin-top: 2px;
      color: #31577e;
      font-size: 9.2px;
      font-weight: 600;
      text-transform: uppercase;
    }
    .total td {
      background: #fff2c8;
      color: ${BRAND_NAVY};
      font-weight: 800;
      font-size: 12px;
      text-align: center;
    }
    .total .value { color: #079669; font-size: 17px; }
    .spacer-row td {
      height: 6px;
      padding: 0;
      border-left: 0;
      border-right: 0;
      background: white;
    }
    .unload-title td {
      background: #d4edda;
      color: ${BRAND_NAVY};
      font-size: 12px;
      font-weight: 900;
      text-align: left;
    }
    .unload-row td {
      color: ${BRAND_NAVY};
      font-size: 10.5px;
      font-weight: 700;
      text-align: left;
      background: #f8fff9;
    }
    .unload-line {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      width: 100%;
    }
    .unload-line span {
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .unload-line strong {
      min-width: 48px;
      border-radius: 999px;
      background: #dcfce7;
      color: #047857;
      padding: 3px 8px;
      text-align: center;
      font-size: 10px;
      white-space: nowrap;
    }
    .footer {
      display: flex;
      justify-content: flex-end;
      margin-top: 5mm;
      color: ${BRAND_NAVY};
      font-size: 12px;
      font-weight: 700;
    }
    .signature { width: 95mm; text-align: center; }
    .signature::after {
      content: "";
      display: block;
      width: 85mm;
      margin: 9px auto 0;
      border-bottom: 1.5px solid #6b7b8f;
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
      ${groupContactMarkup}
      ${groupFerryMarkup}
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
          ${departureUnloadRows}
        </tbody>
      </table>
      <footer class="footer">
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
