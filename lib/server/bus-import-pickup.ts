export type BusImportPickupTimes = {
  italia?: string | null;
  centro?: string | null;
  adriatica?: string | null;
};

export type BusImportLineFamily = {
  family_code?: string | null;
};

function normalizeLookupKey(value?: string | null) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

export function cleanBusImportPickupTime(value?: string | null) {
  const match = String(value ?? "").trim().match(/^([01]\d|2[0-3]):([0-5]\d)/);
  if (!match) return null;
  const time = `${match[1]}:${match[2]}`;
  return time === "00:00" ? null : time;
}

export function buildBusImportPickupTimesMap(
  rows: Array<{
    hotel_name?: string | null;
    pickup_time_linea_italia?: string | null;
    pickup_time_linea_centro?: string | null;
    pickup_time_linea_adriatica?: string | null;
  }>
) {
  const map = new Map<string, BusImportPickupTimes>();
  for (const row of rows) {
    const key = normalizeLookupKey(row.hotel_name);
    if (!key) continue;
    map.set(key, {
      italia: row.pickup_time_linea_italia ?? null,
      centro: row.pickup_time_linea_centro ?? null,
      adriatica: row.pickup_time_linea_adriatica ?? null,
    });
  }
  return map;
}

export function resolveBusImportDeparturePickupTime(
  hotelName: string | null | undefined,
  lineId: string,
  pickupTimesMap: Map<string, BusImportPickupTimes>,
  linesById: Map<string, BusImportLineFamily>
) {
  const hotelKey = normalizeLookupKey(hotelName);
  if (!hotelKey) return null;
  const entry = pickupTimesMap.get(hotelKey);
  if (!entry) return null;
  const family = String(linesById.get(lineId)?.family_code ?? "").trim().toLowerCase();
  if (family === "italia") return cleanBusImportPickupTime(entry.italia);
  if (family === "centro") return cleanBusImportPickupTime(entry.centro);
  if (family === "adriatica") return cleanBusImportPickupTime(entry.adriatica);
  return null;
}
