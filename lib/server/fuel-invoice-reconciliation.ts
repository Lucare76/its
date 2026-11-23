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
  const candidates = manual.filter((row) => row.invoice_supplier === supplier && !alreadyLinked.has(row.id)
    && row.fuel_date === line.date && row.station
    && normalizeStation(row.station) && normalizeStation(line.station)
    && (normalizeStation(row.station).includes(normalizeStation(line.station))
      || normalizeStation(line.station).includes(normalizeStation(row.station))));
  const ranked = candidates.map((row) => ({ row,
    amountDifference: row.cost == null ? null : Math.round((line.amount - row.cost) * 100) / 100,
    litersDifference: row.liters == null ? null : Math.round((line.liters - row.liters) * 100) / 100,
  }));
  return ranked.length === 1 ? { status: "candidate" as const, ...ranked[0]! }
    : { status: ranked.length ? "ambiguous" as const : "missing" as const, candidates: ranked };
}
