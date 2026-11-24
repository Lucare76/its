export type FuelInvoiceLine = {
  date: string;
  station: string;
  liters: number;
  amount: number;
  reference: string;
};

export type ManualFuelLine = {
  id: string;
  fuel_date: string;
  station: string | null;
  liters: number | null;
  cost: number | null;
  invoice_supplier: string | null;
};

export function normalizeStation(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toUpperCase().replace(/\b(STAZIONE|DISTRIBUTORE|CARBURANTI|SERVICE|SRL|SPA)\b/g, "")
    .replace(/[^A-Z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

export function fuelStationsOverlap(first: string | null, second: string): boolean {
  const a = normalizeStation(first ?? "");
  const b = normalizeStation(second);
  return Boolean(a && b && (a.includes(b) || b.includes(a)));
}

// Parole che non distinguono un distributore da un altro: marchi, punti
// cardinali, articoli e prefissi di toponimi ("San", "Santa", ...).
const STATION_GENERIC_WORDS = new Set([
  "ENI", "AGIP", "Q8", "IP", "ESSO", "TAMOIL", "API", "UTA", "SHELL", "TOTAL", "ERG", "KUWAIT",
  "NORD", "SUD", "EST", "OVEST", "LA", "LE", "IL", "LO", "DI", "DA", "DEL", "DELLA", "DEI", "DELLE",
  "VIA", "VIALE", "PIAZZA", "STRADA", "STATALE", "SS", "SP", "KM", "AREA", "SAN", "SANTA", "SANTO", "SANT", "S",
]);

/**
 * Due descrizioni dello stesso distributore scritte in modo diverso:
 * "SAN NICOLA LA STRADA" e "Eni san nicola est caserta" condividono "NICOLA".
 * Vale se una contiene l'altra, oppure se hanno in comune almeno una parola
 * distintiva di 5 o più lettere (esclusi marchi, punti cardinali e "San").
 */
export function fuelStationsLikelySame(first: string | null, second: string): boolean {
  if (fuelStationsOverlap(first, second)) return true;
  const words = (value: string) => new Set(normalizeStation(value).split(" ")
    .filter((word) => word.length >= 5 && !STATION_GENERIC_WORDS.has(word)));
  const a = words(first ?? "");
  for (const word of words(second)) if (a.has(word)) return true;
  return false;
}

export function fuelCanLink(line: FuelInvoiceLine, row: ManualFuelLine, supplier: string): boolean {
  if (row.invoice_supplier !== supplier || row.fuel_date !== line.date || !row.station || !normalizeStation(row.station) || !normalizeStation(line.station)) return false;
  if (fuelStationsOverlap(row.station, line.station)) return true;
  // Different descriptions of the same pump may use a town instead of a locality.
  // Only exact liters and a difference of at most two cents permit a manual review.
  return row.liters != null && row.cost != null
    && Math.round(row.liters * 100) === Math.round(line.liters * 100)
    && Math.abs(Math.round(row.cost * 100) - Math.round(line.amount * 100)) <= 2;
}

function decimal(value: string): number {
  return Number(value.replace(/\./g, "").replace(",", "."));
}

function isoDate(value: string): string {
  const [day, month, year] = value.split(".");
  return `${year!.length === 2 ? `20${year}` : year}-${month}-${day}`;
}

/** Rows reconstructed from the original PDF coordinates, in reading order. */
export function parseFuelInvoiceRows(rows: string[][], supplier: "ENI" | "UTA"): FuelInvoiceLine[] {
  const out: FuelInvoiceLine[] = [];
  for (const parts of rows) {
    const tokens = parts.map((part) => part.trim()).filter(Boolean);
    const first = tokens[0] ?? "";
    const match = first.match(/^(\d{2}\.\d{2}\.\d{2,4})\b/);
    if (!match) continue;
    if (supplier === "UTA") {
      if (!/\b(Diesel|HVO|Benzina|Gasolio)\b/i.test(first)) continue;
      const litersToken = tokens.find((token) => /^\d[\d.,]*\s+LTR$/i.test(token));
      const eurIndex = tokens.indexOf("EUR");
      const location = first.replace(/^\d{2}\.\d{2}\.\d{4}\s+\S+\s*/, "").trim();
      const reference = tokens.find((token, index) => index > 0 && /^\d{8}$/.test(token));
      if (!litersToken || eurIndex < 0 || !tokens[eurIndex + 2] || !location || !reference) continue;
      const liters = decimal(litersToken.replace(/\s+LTR$/i, ""));
      const amount = decimal(tokens[eurIndex + 2]!);
      if (Number.isFinite(liters) && Number.isFinite(amount)) out.push({
        date: isoDate(match[1]!), station: location, liters, amount, reference,
      });
    } else {
      const productIndex = tokens.findIndex((token) => /\b\d{8}\s+(DIES|BENZ|GPL)\b/i.test(token));
      const selfIndex = tokens.findIndex((token) => /^(SELF|SERVITO)$/i.test(token));
      if (productIndex < 0 || selfIndex < productIndex + 3) continue;
      const station = tokens[productIndex - 1];
      const reference = tokens.find((token) => /^\d{8}$/.test(token));
      const liters = decimal(tokens[selfIndex - 3]!);
      const amount = decimal(tokens[selfIndex - 1]!);
      if (!station || !reference || !Number.isFinite(liters) || !Number.isFinite(amount)) continue;
      out.push({ date: isoDate(match[1]!), station, liters, amount, reference });
    }
  }
  return out;
}

export function proposeFuelMatch(line: FuelInvoiceLine, manual: ManualFuelLine[], supplier: string, alreadyLinked: Set<string> = new Set()) {
  // An absent issuer is deliberately not treated as a match. A UTA purchase
  // at a Q8 pump must not be paired with a Q8 purchase on a different invoice.
  const candidates = manual.filter((row) => !alreadyLinked.has(row.id) && fuelCanLink(line, row, supplier));
  const ranked = candidates.map((row) => ({ row,
    stationMismatch: !fuelStationsOverlap(row.station, line.station),
    amountDifference: row.cost == null ? null : (Math.round((line.amount - row.cost) * 100) / 100 || 0),
    litersDifference: row.liters == null ? null : Math.round((line.liters - row.liters) * 100) / 100,
  }));
  return ranked.length === 1 ? { status: "candidate" as const, ...ranked[0]! }
    : { status: ranked.length ? "ambiguous" as const : "missing" as const, candidates: ranked };
}

export type AutoLinkInvoiceLine = FuelInvoiceLine & { id: string };
export type AutoLinkManualLine = ManualFuelLine & { approval_status?: string | null };

/**
 * Collegamenti automatici sicuri: solo quando una riga fattura e un
 * rifornimento corrispondono esattamente e senza alternative.
 *  - stesso fornitore e stessa data (già richiesti da fuelCanLink)
 *  - distributore coincidente o con una parola distintiva in comune
 *    (es. "SAN NICOLA LA STRADA" ↔ "Eni san nicola est caserta")
 *  - litri identici al centesimo, importo con al massimo 1 centesimo di scarto
 *  - un solo rifornimento candidato per la riga, e quel rifornimento non è
 *    candidato per nessun'altra riga ancora da collegare
 *  - i rifornimenti respinti non vengono mai collegati in automatico
 * Le righe passate devono essere solo quelle ancora collegabili in automatico.
 */
export function selectExactAutoLinks(
  lines: AutoLinkInvoiceLine[],
  manual: AutoLinkManualLine[],
  supplier: string,
  alreadyLinked: Set<string> = new Set(),
): Array<{ line_id: string; fuel_id: string }> {
  const eligible = manual.filter((row) => row.approval_status !== "rejected");
  const candidatesByLine = new Map(lines.map((line) => [
    line.id,
    eligible.filter((row) => !alreadyLinked.has(row.id) && fuelCanLink(line, row, supplier)),
  ]));
  const linesPerFuel = new Map<string, number>();
  for (const candidates of candidatesByLine.values()) {
    for (const row of candidates) linesPerFuel.set(row.id, (linesPerFuel.get(row.id) ?? 0) + 1);
  }
  const links: Array<{ line_id: string; fuel_id: string }> = [];
  for (const line of lines) {
    const candidates = candidatesByLine.get(line.id) ?? [];
    if (candidates.length !== 1) continue;
    const row = candidates[0]!;
    if (linesPerFuel.get(row.id) !== 1) continue;
    if (!fuelStationsLikelySame(row.station, line.station)) continue;
    if (row.liters == null || row.cost == null) continue;
    if (Math.round(Number(row.liters) * 100) !== Math.round(line.liters * 100)) continue;
    if (Math.abs(Math.round(Number(row.cost) * 100) - Math.round(line.amount * 100)) > 1) continue;
    links.push({ line_id: line.id, fuel_id: row.id });
  }
  return links;
}
