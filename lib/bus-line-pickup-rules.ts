/**
 * Orari di prelevamento per le linee bus di partenza.
 * Fonte: PDF "PICK UP LINEE - Foglio1.pdf"
 *
 * Tre linee:
 *  - LINEA ITALIA    → Porto Casamicciola, nave 06:20
 *  - LINEA CENTRO    → Porto Ischia,       nave 11:10
 *  - LINEA ADRIATICA → Porto Ischia,       nave 11:10
 *
 * Il lookup avviene per nome hotel (normalizzato, match parziale).
 */

export type BusLine = "italia" | "centro" | "adriatica";

export type BusLineRule = {
  hotel: string;       // nome normalizzato (lowercase, senza accenti)
  comune: string;      // zona (forio | barano | ischia | lacco | casamicciola)
  italia: string;      // orario pickup Linea Italia   (HH:MM)
  centro: string;      // orario pickup Linea Centro   (HH:MM)
  adriatica: string;   // orario pickup Linea Adriatica (HH:MM)
};

export const BUS_LINE_DEPARTURE: Record<BusLine, { porto: string; nave_time: string }> = {
  italia:    { porto: "CASAMICCIOLA", nave_time: "06:20" },
  centro:    { porto: "ISCHIA",       nave_time: "11:10" },
  adriatica: { porto: "ISCHIA",       nave_time: "11:10" },
};

// ---------------------------------------------------------------------------
// Tabella hotel — pickup per linea
// ---------------------------------------------------------------------------
export const BUS_LINE_RULES: BusLineRule[] = [
  // FORIO — 05:00 / 09:50 / 09:50
  { hotel: "colella",              comune: "forio",        italia: "05:00", centro: "09:50", adriatica: "09:50" },
  { hotel: "la villa",             comune: "forio",        italia: "05:00", centro: "09:50", adriatica: "09:50" },
  { hotel: "royal palm",           comune: "forio",        italia: "05:00", centro: "09:50", adriatica: "09:50" },
  { hotel: "park la villa",        comune: "forio",        italia: "05:00", centro: "09:50", adriatica: "09:50" },
  { hotel: "punta del sole",       comune: "forio",        italia: "05:00", centro: "09:50", adriatica: "09:50" },
  { hotel: "carlo magno",          comune: "forio",        italia: "05:00", centro: "09:50", adriatica: "09:50" },
  { hotel: "zi carmela",           comune: "forio",        italia: "05:00", centro: "09:50", adriatica: "09:50" },
  { hotel: "tritone",              comune: "forio",        italia: "05:00", centro: "09:50", adriatica: "09:50" },
  { hotel: "lord byron",           comune: "forio",        italia: "05:00", centro: "09:50", adriatica: "09:50" },
  { hotel: "eden park",            comune: "forio",        italia: "05:00", centro: "09:50", adriatica: "09:50" },
  { hotel: "villa teresa",         comune: "forio",        italia: "05:00", centro: "09:50", adriatica: "09:50" },
  { hotel: "riva del sole",        comune: "forio",        italia: "05:00", centro: "09:50", adriatica: "09:50" },
  { hotel: "mediterraneo",         comune: "forio",        italia: "05:00", centro: "09:50", adriatica: "09:50" },
  { hotel: "junior village",       comune: "forio",        italia: "05:00", centro: "09:50", adriatica: "09:50" },
  { hotel: "villa miralisa",       comune: "forio",        italia: "05:00", centro: "09:50", adriatica: "09:50" },
  { hotel: "hotel al bosco",       comune: "forio",        italia: "05:00", centro: "09:50", adriatica: "09:50" },
  { hotel: "la ginestra",          comune: "forio",        italia: "05:00", centro: "09:50", adriatica: "09:50" },
  { hotel: "tramonto d oro",       comune: "forio",        italia: "05:00", centro: "09:50", adriatica: "09:50" },
  { hotel: "galidon",              comune: "forio",        italia: "05:00", centro: "09:50", adriatica: "09:50" },
  { hotel: "hotel zaro",           comune: "forio",        italia: "05:00", centro: "09:50", adriatica: "09:50" },
  { hotel: "b b san nicola",       comune: "forio",        italia: "05:00", centro: "09:50", adriatica: "09:50" },
  { hotel: "baia delle sirene",    comune: "forio",        italia: "05:00", centro: "09:50", adriatica: "09:50" },
  { hotel: "hotel la rosa",        comune: "forio",        italia: "05:00", centro: "09:50", adriatica: "09:50" },
  { hotel: "park imperial",        comune: "forio",        italia: "05:00", centro: "09:50", adriatica: "09:50" },
  { hotel: "sorriso",              comune: "forio",        italia: "05:00", centro: "09:50", adriatica: "09:50" },
  { hotel: "castiglione village",  comune: "forio",        italia: "05:00", centro: "09:50", adriatica: "09:50" },
  // BARANO
  { hotel: "saint raphael",        comune: "barano",       italia: "05:00", centro: "09:45", adriatica: "09:45" },
  // ISCHIA — 05:15 / 10:10 (alcuni 10:00)
  { hotel: "bristol",              comune: "ischia",       italia: "05:15", centro: "10:10", adriatica: "10:10" },
  { hotel: "felix",                comune: "ischia",       italia: "05:15", centro: "10:10", adriatica: "10:10" },
  { hotel: "president",            comune: "ischia",       italia: "05:15", centro: "10:10", adriatica: "10:10" },
  { hotel: "re ferdinando",        comune: "ischia",       italia: "05:15", centro: "10:10", adriatica: "10:10" },
  { hotel: "tirrenia",             comune: "ischia",       italia: "05:15", centro: "10:10", adriatica: "10:10" },
  { hotel: "central park",         comune: "ischia",       italia: "05:15", centro: "10:10", adriatica: "10:10" },
  { hotel: "san valentino",        comune: "ischia",       italia: "05:15", centro: "10:10", adriatica: "10:10" },
  { hotel: "bellevue",             comune: "ischia",       italia: "05:15", centro: "10:10", adriatica: "10:10" },
  { hotel: "don pepe",             comune: "ischia",       italia: "05:15", centro: "10:00", adriatica: "10:00" },
  { hotel: "augusto",              comune: "ischia",       italia: "05:15", centro: "10:00", adriatica: "10:00" },
  { hotel: "isola verde",          comune: "ischia",       italia: "05:15", centro: "10:10", adriatica: "10:10" },
  { hotel: "continental terme",    comune: "ischia",       italia: "05:15", centro: "10:10", adriatica: "10:10" },
  { hotel: "continental mare",     comune: "ischia",       italia: "05:15", centro: "10:10", adriatica: "10:10" },
  { hotel: "aragona",              comune: "ischia",       italia: "05:15", centro: "10:10", adriatica: "10:10" },
  { hotel: "principe",             comune: "ischia",       italia: "05:15", centro: "10:10", adriatica: "10:10" },
  { hotel: "floridiana",           comune: "ischia",       italia: "05:15", centro: "10:10", adriatica: "10:10" },
  { hotel: "oriente",              comune: "ischia",       italia: "05:15", centro: "10:10", adriatica: "10:10" },
  { hotel: "parco aurora",         comune: "ischia",       italia: "05:15", centro: "10:10", adriatica: "10:10" },
  { hotel: "royal terme",          comune: "ischia",       italia: "05:15", centro: "10:10", adriatica: "10:10" },
  { hotel: "aurum",                comune: "ischia",       italia: "05:15", centro: "10:10", adriatica: "10:10" },
  { hotel: "hotel pineta",         comune: "ischia",       italia: "05:15", centro: "10:10", adriatica: "10:10" },
  // LACCO AMENO — 05:15 / 10:00
  { hotel: "villa svizzera",       comune: "lacco",        italia: "05:15", centro: "10:00", adriatica: "10:00" },
  { hotel: "san lorenzo",          comune: "lacco",        italia: "05:15", centro: "10:00", adriatica: "10:00" },
  // CASAMICCIOLA — 05:30 / 10:00
  { hotel: "cristallo",            comune: "casamicciola", italia: "05:30", centro: "10:00", adriatica: "10:00" },
  { hotel: "gran paradiso",        comune: "casamicciola", italia: "05:30", centro: "10:00", adriatica: "10:00" },
  { hotel: "stella maris",         comune: "casamicciola", italia: "05:30", centro: "10:00", adriatica: "10:00" },
];

// ---------------------------------------------------------------------------
// Normalizzazione nome hotel
// ---------------------------------------------------------------------------
function normalizeHotelName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")  // rimuove accenti
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Lookup per nome hotel (match parziale)
// ---------------------------------------------------------------------------
export function getBusLinePickup(
  hotelName: string,
  line: BusLine
): { pickup: string; porto: string; nave_time: string } | null {
  const normalized = normalizeHotelName(hotelName);
  const rule = BUS_LINE_RULES.find((r) =>
    normalized.includes(r.hotel) || r.hotel.includes(normalized)
  );
  if (!rule) return null;
  const dep = BUS_LINE_DEPARTURE[line];
  return {
    pickup: rule[line],
    porto: dep.porto,
    nave_time: dep.nave_time,
  };
}

// ---------------------------------------------------------------------------
// Lookup per zona (fallback quando non si trova l'hotel esatto)
// Restituisce l'orario tipico per quella zona
// ---------------------------------------------------------------------------
export function getBusLinePickupByZone(
  zona: string,
  line: BusLine
): { pickup: string; porto: string; nave_time: string } | null {
  const z = zona.toLowerCase().trim();
  // Orari di default per zona (dal PDF)
  const zoneDefaults: Record<string, Record<BusLine, string>> = {
    forio:        { italia: "05:00", centro: "09:50", adriatica: "09:50" },
    barano:       { italia: "05:00", centro: "09:45", adriatica: "09:45" },
    ischia:       { italia: "05:15", centro: "10:10", adriatica: "10:10" },
    lacco:        { italia: "05:15", centro: "10:00", adriatica: "10:00" },
    casamicciola: { italia: "05:30", centro: "10:00", adriatica: "10:00" },
  };
  const times = zoneDefaults[z];
  if (!times) return null;
  const dep = BUS_LINE_DEPARTURE[line];
  return {
    pickup: times[line],
    porto: dep.porto,
    nave_time: dep.nave_time,
  };
}
