import ExcelJS from "exceljs";

type ExportAlloc = {
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
  service_time?: string | null;
};

type ExportStop = {
  stop_name: string;
  pickup_note?: string | null;
  pickup_time?: string | null;
  stop_order: number;
  lat?: number | null;
};

function shortenHotelName(name: string): string {
  return name
    .replace(/\b(hotel|albergo|terme|resort|spa|club|grand|park|relax|boutique)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase() || name.toUpperCase();
}

function extractFromNotes(rawNotes: string) {
  const hotelFromNotes = rawNotes.match(/Hotel:\s*([^·\n]+)/)?.[1]?.trim() ?? "";
  const agencyFromNotes = rawNotes.match(/Agenzia:\s*([^·\n]+)/)?.[1]?.trim() ?? "";
  const cleanNote = rawNotes
    .replace(/Hotel:\s*[^·\n]+·?\s*/gi, "")
    .replace(/Agenzia:\s*[^·\n]+·?\s*/gi, "")
    .trim();
  return { hotelFromNotes, agencyFromNotes, cleanNote };
}

const HEADER_COLOR = "1E3A5F";
const HEADER_BG = "E8EDF3";
const TOTAL_BG = "FFF3CD";
const SCARICO_BG = "D4EDDA";

function styleHeaderRow(row: ExcelJS.Row, colCount: number) {
  row.font = { bold: true, size: 10, color: { argb: `FF${HEADER_COLOR}` } };
  row.alignment = { horizontal: "center", vertical: "middle" };
  for (let c = 1; c <= colCount; c++) {
    const cell = row.getCell(c);
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${HEADER_BG}` } };
    cell.border = {
      bottom: { style: "thin", color: { argb: "FF999999" } },
    };
  }
}

export async function fetchLogoBase64(): Promise<string | null> {
  try {
    const res = await fetch("/brand/logo-ischia-transfer.png");
    if (!res.ok) return null;
    const blob = await res.blob();
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

export function addLogo(wb: ExcelJS.Workbook, ws: ExcelJS.Worksheet, logoBase64: string) {
  const base64Data = logoBase64.split(",")[1] ?? logoBase64;
  const imageId = wb.addImage({ base64: base64Data, extension: "png" });
  ws.addImage(imageId, {
    tl: { col: 0, row: 0 },
    ext: { width: 120, height: 80 },
  });
}

export async function buildArrivalWorkbook(
  allocs: ExportAlloc[],
  stops: ExportStop[],
  driverName?: string | null,
  driverPhone?: string | null,
  preloadedLogo?: string | null
): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Andata");
  ws.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 };

  const logoBase64 = preloadedLogo ?? await fetchLogoBase64();

  const stopOrderMap = new Map<string, number>();
  for (const s of stops) stopOrderMap.set(s.stop_name.toUpperCase(), s.stop_order);

  const sorted = [...allocs].sort((a, b) => {
    const oa = stopOrderMap.get(a.stop_name.toUpperCase()) ?? 9999;
    const ob = stopOrderMap.get(b.stop_name.toUpperCase()) ?? 9999;
    if (oa !== ob) return oa - ob;
    return (a.service_time ?? "").localeCompare(b.service_time ?? "");
  });

  ws.columns = [
    { width: 30 }, // orario + città
    { width: 28 }, // punto di carico
    { width: 8 },  // n° pax
    { width: 32 }, // nominativo
    { width: 18 }, // cell
    { width: 26 }, // HOTEL
    { width: 14 }, // note
    { width: 20 }, // agenzia
  ];

  // Logo + titolo
  let startRow = 1;
  if (logoBase64) {
    addLogo(wb, ws, logoBase64);
    ws.getRow(1).height = 60;
    startRow = 2;
  }
  const titleCell = ws.getCell(startRow, 1);
  titleCell.value = "ARRIVI";
  titleCell.font = { bold: true, size: 14, color: { argb: `FF${HEADER_COLOR}` } };
  ws.getRow(startRow).height = 24;

  // Header
  const headerRow = ws.addRow(["orario", "punto di carico", "n° pax", "nominativo", "cell", "HOTEL", "note", "agenzia"]);
  styleHeaderRow(headerRow, 8);

  // Data rows
  let totalPax = 0;
  for (const alloc of sorted) {
    const { hotelFromNotes, agencyFromNotes, cleanNote } = extractFromNotes(alloc.notes ?? "");
    const stopTime = alloc.stop_pickup_time ?? "";
    const orario = stopTime ? `${stopTime.slice(0, 5)} ${alloc.stop_name}` : alloc.stop_name;
    const row = ws.addRow([
      orario,
      alloc.stop_pickup_note ?? "",
      alloc.pax_assigned,
      alloc.customer_name,
      alloc.customer_phone ?? "",
      shortenHotelName(alloc.hotel_name || hotelFromNotes || ""),
      cleanNote,
      alloc.agency_name || agencyFromNotes || "",
    ]);
    row.font = { size: 10 };
    row.getCell(1).font = { size: 10, bold: true };
    totalPax += alloc.pax_assigned;
  }

  // Totale
  ws.addRow([]);
  const totRow = ws.addRow(["", "TOTALE", totalPax, "", "", "", "", ""]);
  totRow.font = { bold: true, size: 11 };
  totRow.getCell(2).fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${TOTAL_BG}` } };
  totRow.getCell(3).fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${TOTAL_BG}` } };

  // Autista
  ws.addRow([]);
  const driverRow = ws.addRow([`AUTISTA : ${driverName || "N/D"}  ${driverPhone || ""}`]);
  driverRow.font = { bold: true, size: 11, color: { argb: `FF${HEADER_COLOR}` } };

  return wb;
}

export async function buildDepartureWorkbook(
  allocs: ExportAlloc[],
  stops: ExportStop[],
  driverName?: string | null,
  driverPhone?: string | null,
  preloadedLogo?: string | null
): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Ritorno");
  ws.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 };

  const logoBase64 = preloadedLogo ?? await fetchLogoBase64();

  const sorted = [...allocs].sort((a, b) => {
    const ta = a.hotel_pickup_time ?? "";
    const tb = b.hotel_pickup_time ?? "";
    if (ta !== tb) return ta.localeCompare(tb);
    const ha = (a.hotel_name ?? "").toUpperCase();
    const hb = (b.hotel_name ?? "").toUpperCase();
    if (ha !== hb) return ha.localeCompare(hb);
    return (a.customer_name ?? "").localeCompare(b.customer_name ?? "");
  });

  ws.columns = [
    { width: 10 }, // orario pickup
    { width: 24 }, // hotel partenza
    { width: 8 },  // n° pax
    { width: 32 }, // nominativo
    { width: 18 }, // cell
    { width: 42 }, // destinazione
    { width: 20 }, // agenzia
    { width: 22 }, // note
  ];

  // Logo + titolo
  let startRow = 1;
  if (logoBase64) {
    addLogo(wb, ws, logoBase64);
    ws.getRow(1).height = 60;
    startRow = 2;
  }
  const titleCell = ws.getCell(startRow, 1);
  titleCell.value = "PARTENZE";
  titleCell.font = { bold: true, size: 14, color: { argb: `FF${HEADER_COLOR}` } };
  ws.getRow(startRow).height = 24;

  // Header
  const headerRow = ws.addRow(["pickup", "hotel partenza", "n° pax", "nominativo", "cell", "destinazione", "agenzia", "note"]);
  styleHeaderRow(headerRow, 8);

  // Data rows
  let totalPax = 0;
  for (const alloc of sorted) {
    const { hotelFromNotes, agencyFromNotes, cleanNote } = extractFromNotes(alloc.notes ?? "");
    const hotelPartenza = shortenHotelName(alloc.hotel_name || hotelFromNotes || "");
    const stopNote = alloc.stop_pickup_note ?? "";
    const destinazione = stopNote ? `${alloc.stop_name} - ${stopNote}` : alloc.stop_name;
    const pickupTime = (alloc.hotel_pickup_time ?? "").slice(0, 5);
    const row = ws.addRow([
      pickupTime,
      hotelPartenza,
      alloc.pax_assigned,
      alloc.customer_name,
      alloc.customer_phone ?? "",
      destinazione,
      alloc.agency_name || agencyFromNotes || "",
      cleanNote,
    ]);
    row.font = { size: 10 };
    if (pickupTime) row.getCell(1).font = { size: 10, bold: true };
    totalPax += alloc.pax_assigned;
  }

  // Totale
  ws.addRow([]);
  const totRow = ws.addRow(["", "TOTALE", totalPax, "", "", "", "", ""]);
  totRow.font = { bold: true, size: 11 };
  totRow.getCell(2).fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${TOTAL_BG}` } };
  totRow.getCell(3).fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${TOTAL_BG}` } };

  // Scarico
  const usedStopNames = new Set(sorted.map((a) => a.stop_name.toUpperCase()));
  const usedStops = stops
    .filter((s) => usedStopNames.has(s.stop_name.toUpperCase()))
    .sort((a, b) => {
      if (a.lat != null && b.lat != null) return a.lat - b.lat;
      if (a.lat != null) return -1;
      if (b.lat != null) return 1;
      return a.stop_order - b.stop_order;
    });
  if (usedStops.length > 0) {
    ws.addRow([]);
    const scaricoHeader = ws.addRow(["SCARICO"]);
    scaricoHeader.font = { bold: true, size: 11, color: { argb: `FF${HEADER_COLOR}` } };
    scaricoHeader.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${SCARICO_BG}` } };
    for (const stop of usedStops) {
      const label = stop.pickup_note ? `${stop.stop_name} - ${stop.pickup_note}` : stop.stop_name;
      ws.addRow([label]);
    }
  }

  // Autista
  ws.addRow([]);
  const driverRow = ws.addRow([`AUTISTA : ${driverName || "N/D"}  ${driverPhone || ""}`]);
  driverRow.font = { bold: true, size: 11, color: { argb: `FF${HEADER_COLOR}` } };

  return wb;
}

export async function downloadWorkbook(wb: ExcelJS.Workbook, filename: string) {
  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
