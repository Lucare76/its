// Parser Sun&Sea / MTS Globe ("booking-item-list" export).
//
// Colonne reali verificate sul file "Liste Mts Globe fino al 30.09.2026
// originale.xlsx": Voucher No, Grouping Id, Start Date, Service Base Code,
// Flight, Dep Airport, Dep Time, Arr Airport, Arr Time, Pick-Up, Drop-Off,
// Resort, Provider Name, Lead Pax, Adults, Children, Infants, Service Unit,
// Cost SCY. Nessuna escursione presente nel file reale: solo transfer
// aeroportuali (Arrivi/Partenza) e trasferimenti hotel->hotel (Intermedio).
//
// Grain della prenotazione: "Voucher No" e' la chiave di pratica stabile.
// "Grouping Id" NON identifica la stessa prenotazione: raggruppa piu'
// prenotazioni indipendenti (nominativi/hotel diversi) che condividono lo
// stesso transfer navetta — e' un dato operativo, non di identita' booking.
//
// Il parser produce SOLO cio' che e' deducibile dal dato grezzo. Non associa
// hotel a un ID (nessun accesso DB qui), non decide orari operativi diversi
// da quelli presenti in riga: quella e' responsabilita' del service generator.

export const MTS_GLOBE_EXPECTED_HEADER = [
  "Voucher No",
  "Grouping Id",
  "Start Date",
  "Service Base Code",
  "Flight",
  "Dep Airport",
  "Dep Time",
  "Arr Airport",
  "Arr Time",
  "Pick-Up",
  "Drop-Off",
  "Resort",
  "Provider Name",
  "Lead Pax",
  "Adults",
  "Children",
  "Infants",
  "Service Unit",
  "Cost SCY"
] as const;

export type MtsGlobeLegType = "arrival" | "departure" | "hotel_change";

export type MtsGlobeParsedLeg = {
  rowIndex: number;
  voucherNo: string;
  groupingId: string | null;
  legType: MtsGlobeLegType;
  date: string; // YYYY-MM-DD
  flightCode: string | null;
  depAirport: string | null;
  depTime: string | null;
  arrAirport: string | null;
  arrTime: string | null;
  pickupRaw: string;
  dropoffRaw: string;
  hotelNameRaw: string | null; // hotel coinvolto (drop-off per arrivo, pick-up per partenza)
  hotelFromRaw: string | null; // solo per hotel_change
  hotelToRaw: string | null; // solo per hotel_change
  resort: string | null;
  leadPax: string | null;
  pax: number;
  serviceUnit: string | null;
  costScy: number | null;
  providerNameRaw: string | null;
};

export type MtsGlobeRowError = {
  rowIndex: number;
  voucherNo: string | null;
  message: string;
};

export type MtsGlobeBookingDraft = {
  voucherNo: string;
  sourceBookingKey: string;
  customerName: string;
  legs: MtsGlobeParsedLeg[];
  duplicateLegsSkipped: number;
  serviceScope: "round_trip" | "outbound_only" | "return_only";
  pax: number;
  hotelNameRaw: string | null;
  agencyName: string;
  rawRowIndexes: number[];
};

export type MtsGlobeParseResult = {
  bookings: MtsGlobeBookingDraft[];
  errors: MtsGlobeRowError[];
  totalRows: number;
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function extractHotelName(cell: string): string | null {
  const value = clean(cell);
  if (!value) return null;
  const match = value.match(/^\S+\s*-\s*(.+)$/);
  const name = match ? match[1].trim() : value;
  return name.length > 0 ? name : null;
}

// Converte un serial date Excel (giorni dal 1899-12-30, sistema 1900) in ISO
// YYYY-MM-DD. Offset di 25569 giorni tra l'epoca Excel e l'epoca Unix
// (1970-01-01) — formula standard, assorbe gia' il bug storico del 29
// febbraio 1900 (inesistente ma contato da Excel) senza gestirlo a parte.
function excelSerialToIsoDate(serial: number): string | null {
  if (!Number.isFinite(serial) || serial <= 0) return null;
  const utcMs = Math.round((serial - 25569) * 86400 * 1000);
  const date = new Date(utcMs);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function parseDate(raw: unknown): string | null {
  // Il lettore XLSX lato browser (raw:true, default in page.tsx) restituisce
  // le celle data Excel formattate come data nativa come NUMERO seriale, non
  // come testo "DD.MM.YYYY" — verificato sul file MTS Globe reale (colonna
  // "Start Date" sempre numerica). Gestito qui per restare robusti a
  // entrambi i formati (numero da Excel, stringa da payload JSON/test/CSV)
  // senza duplicare la logica di parsing altrove.
  if (typeof raw === "number") {
    return excelSerialToIsoDate(raw);
  }
  const match = clean(raw).match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const asDate = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(asDate.getTime()) || asDate.getUTCDate() !== day || asDate.getUTCMonth() + 1 !== month) return null;
  return iso;
}

function parseTime(raw: string): string | null {
  const match = clean(raw).match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function parseIntSafe(raw: unknown): number {
  const n = Number.parseInt(clean(raw), 10);
  return Number.isFinite(n) ? n : 0;
}

function cleanLeadPaxName(raw: string | null): string {
  const value = clean(raw);
  if (!value) return "Cliente da verificare";
  const withoutTitle = value.replace(/^(mr|mrs|ms|frau|herr|sig|sig\.ra|dr)\.{1,2}\s*/i, "").trim();
  return withoutTitle.length > 0 ? withoutTitle : value;
}

function legDedupeSignature(leg: Omit<MtsGlobeParsedLeg, "rowIndex" | "groupingId">): string {
  return [
    leg.legType,
    leg.date,
    leg.flightCode,
    leg.depAirport,
    leg.depTime,
    leg.arrAirport,
    leg.arrTime,
    leg.pickupRaw,
    leg.dropoffRaw,
    leg.pax
  ].join("|");
}

function determineServiceScope(legs: MtsGlobeParsedLeg[]): MtsGlobeBookingDraft["serviceScope"] {
  const hasArrival = legs.some((leg) => leg.legType === "arrival");
  const hasDeparture = legs.some((leg) => leg.legType === "departure");
  if (hasArrival && hasDeparture) return "round_trip";
  if (hasArrival) return "outbound_only";
  if (hasDeparture) return "return_only";
  return "round_trip";
}

/**
 * Analizza le righe grezze (array di oggetti chiave=header) del file
 * MTS Globe. Ritorna prenotazioni raggruppate per Voucher No + errori riga.
 * Non tocca il DB: nessun match hotel, nessuna decisione operativa.
 */
export function parseMtsGlobeRows(rawRows: Array<Record<string, unknown>>): MtsGlobeParseResult {
  const errors: MtsGlobeRowError[] = [];
  const legsByVoucher = new Map<string, MtsGlobeParsedLeg[]>();

  rawRows.forEach((raw, index) => {
    const rowIndex = index + 2; // riga 1 = header
    const voucherNo = clean(raw["Voucher No"]);
    const serviceBaseCode = clean(raw["Service Base Code"]);
    // Valore grezzo (non "clean()"-ato): parseDate deve vedere se e' un
    // number (cella data Excel nativa) o una string, per scegliere il ramo
    // di parsing corretto — clean() lo trasformerebbe sempre in stringa,
    // rendendo indistinguibile un serial Excel da un testo numerico.
    const dateRaw = raw["Start Date"];

    if (!voucherNo) {
      errors.push({ rowIndex, voucherNo: null, message: "Voucher No mancante: riga non importabile." });
      return;
    }

    const date = parseDate(dateRaw);
    if (!date) {
      errors.push({ rowIndex, voucherNo, message: `Data non valida: "${dateRaw}".` });
      return;
    }

    const pax = parseIntSafe(raw["Adults"]) + parseIntSafe(raw["Children"]) + parseIntSafe(raw["Infants"]);
    if (pax <= 0) {
      errors.push({ rowIndex, voucherNo, message: "Pax non valido (0 o mancante)." });
      return;
    }

    const pickupRaw = clean(raw["Pick-Up"]);
    const dropoffRaw = clean(raw["Drop-Off"]);

    let legType: MtsGlobeLegType;
    let hotelNameRaw: string | null = null;
    let hotelFromRaw: string | null = null;
    let hotelToRaw: string | null = null;

    if (serviceBaseCode === "Arrivi") {
      legType = "arrival";
      hotelNameRaw = extractHotelName(dropoffRaw);
      if (!hotelNameRaw) {
        errors.push({ rowIndex, voucherNo, message: "Riga Arrivi incompleta: hotel (Drop-Off) mancante." });
        return;
      }
    } else if (serviceBaseCode === "Partenza") {
      legType = "departure";
      hotelNameRaw = extractHotelName(pickupRaw);
      if (!hotelNameRaw) {
        errors.push({ rowIndex, voucherNo, message: "Riga Partenza incompleta: hotel (Pick-Up) mancante." });
        return;
      }
    } else if (serviceBaseCode === "Intermedio") {
      legType = "hotel_change";
      hotelFromRaw = extractHotelName(pickupRaw);
      hotelToRaw = extractHotelName(dropoffRaw);
      if (!hotelFromRaw || !hotelToRaw) {
        errors.push({ rowIndex, voucherNo, message: "Riga Intermedio incompleta: hotel origine/destinazione mancante." });
        return;
      }
    } else {
      errors.push({ rowIndex, voucherNo, message: `Tipo operazione non riconosciuto: "${serviceBaseCode || "vuoto"}".` });
      return;
    }

    const leg: MtsGlobeParsedLeg = {
      rowIndex,
      voucherNo,
      groupingId: clean(raw["Grouping Id"]) || null,
      legType,
      date,
      flightCode: clean(raw["Flight"]) || null,
      depAirport: clean(raw["Dep Airport"]) || null,
      depTime: parseTime(clean(raw["Dep Time"])),
      arrAirport: clean(raw["Arr Airport"]) || null,
      arrTime: parseTime(clean(raw["Arr Time"])),
      pickupRaw,
      dropoffRaw,
      hotelNameRaw,
      hotelFromRaw,
      hotelToRaw,
      resort: clean(raw["Resort"]) || null,
      leadPax: clean(raw["Lead Pax"]) || null,
      pax,
      serviceUnit: clean(raw["Service Unit"]) || null,
      costScy: Number.isFinite(Number(raw["Cost SCY"])) ? Number(raw["Cost SCY"]) : null,
      providerNameRaw: clean(raw["Provider Name"]) || null
    };

    const bucket = legsByVoucher.get(voucherNo) ?? [];
    bucket.push(leg);
    legsByVoucher.set(voucherNo, bucket);
  });

  const bookings: MtsGlobeBookingDraft[] = [];

  for (const [voucherNo, legs] of legsByVoucher) {
    const seenSignatures = new Set<string>();
    const dedupedLegs: MtsGlobeParsedLeg[] = [];
    let duplicateLegsSkipped = 0;
    for (const leg of legs) {
      const signature = legDedupeSignature(leg);
      if (seenSignatures.has(signature)) {
        duplicateLegsSkipped += 1;
        continue;
      }
      seenSignatures.add(signature);
      dedupedLegs.push(leg);
    }

    dedupedLegs.sort((a, b) => (a.date === b.date ? a.rowIndex - b.rowIndex : a.date.localeCompare(b.date)));

    const firstLeg = dedupedLegs[0];
    const customerName = cleanLeadPaxName(firstLeg.leadPax);
    const hotelNameRaw = firstLeg.hotelNameRaw ?? firstLeg.hotelFromRaw ?? firstLeg.hotelToRaw ?? null;

    bookings.push({
      voucherNo,
      sourceBookingKey: `mts_globe:${voucherNo}`,
      customerName,
      legs: dedupedLegs,
      duplicateLegsSkipped,
      serviceScope: determineServiceScope(dedupedLegs),
      pax: Math.max(...dedupedLegs.map((leg) => leg.pax)),
      hotelNameRaw,
      // Nome agenzia reale dal dato di riga ("Provider Name"), mai un
      // hardcode: "Sun&Sea" resta solo come etichetta di fallback se la
      // colonna e' vuota, non come dato di identita' assunto.
      agencyName: firstLeg.providerNameRaw ?? "Sun&Sea",
      rawRowIndexes: dedupedLegs.map((leg) => leg.rowIndex)
    });
  }

  bookings.sort((a, b) => a.voucherNo.localeCompare(b.voucherNo));

  return { bookings, errors, totalRows: rawRows.length };
}
