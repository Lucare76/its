/** Operational bus rows in an Aleste confirmation; summary rows are deliberately ignored. */
export function extractAlesteMultiStopRows(text: string) {
  const rows: Array<{ direction: "andata" | "ritorno"; date: string; time: string; pax: number; stop: string; destination: string }> = [];
  const blocks = text.split(/\bIl\s*(?=\d{1,2}-(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)-\d{2,4}\b)/i);
  for (const block of blocks.slice(1)) {
    const header = block.match(/^\s*(\d{1,2}-(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)-\d{2,4})\s+(\d+)\s*BUS DA\s+(.+?)\s+(?:PARTENZA|PICK-UP)\s+ORE\s+(\d{1,2}[:.]\d{1,2})/i);
    if (!header) continue;
    const detail = block.match(/Meeting point:\s*(.+?)\s+da:\s*(.+?)\s+a:\s*(.+?)\s+dest:\s*(.+?)(?=\s+Cliente:|\s+Cellulare\/Tel|\s+L['’]ORARIO|\s+SPETT\.LE|\s+Pagina\s+\d+\s+di\s+\d+|$)/is);
    if (!detail) continue;
    const direction = /HOTEL\s+ISCHIA/i.test(header[3]) ? "ritorno" : "andata";
    rows.push({
      direction,
      date: header[1],
      time: header[4].replace(".", ":").replace(/:(\d)$/, ":0$1").replace(/^(\d):/, "0$1:"),
      pax: Number(header[2]),
      stop: detail[1].replace(/\s+/g, " ").trim(),
      destination: detail[4].split(/\f|\bPagina\s+\d+\s+di\s+\d+\b/i)[0].replace(/\s+/g, " ").trim()
    });
  }
  return rows;
}

export function isAlesteMultiStop(text: string) {
  if (!/STAFF\s+ALESTE|Ufficio Booking\s*-\s*Aleste Viaggi/i.test(text)) return false;
  const rows = extractAlesteMultiStopRows(text);
  if (rows.filter((row) => row.direction === "andata").length > 1 || rows.filter((row) => row.direction === "ritorno").length > 1) return true;
  // The operational detail may be damaged by OCR; the price table still exposes repeated bus legs.
  const summaryRows = [...text.matchAll(/^\s*\d{1,2}-(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)\s+\d{1,2}[:.]\d{2}\s+BUS\s+DA\s+(.+?)\s+(?:PARTENZA|PICK-UP)\s+ORE/gim)];
  return summaryRows.length > 2 || summaryRows.filter((match) => !/HOTEL\s+ISCHIA/i.test(match[1])).length > 1 || summaryRows.filter((match) => /HOTEL\s+ISCHIA/i.test(match[1])).length > 1;
}

export function pairAlesteBusRows(rows: ReturnType<typeof extractAlesteMultiStopRows>) {
  const outward = rows.filter((row) => row.direction === "andata");
  const returns = rows.filter((row) => row.direction === "ritorno");
  if (outward.length < 2 || outward.length !== returns.length) return null;
  const unused = new Set(returns.map((_, index) => index));
  const pairs = [];
  for (const arrival of outward) {
    const key = arrival.stop.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const matches = [...unused].filter((index) => returns[index].destination.toUpperCase().replace(/[^A-Z0-9]/g, "") === key);
    if (matches.length !== 1 || arrival.pax !== returns[matches[0]].pax) return null;
    const index = matches[0];
    unused.delete(index);
    pairs.push({ arrival, departure: returns[index] });
  }
  return unused.size === 0 ? pairs : null;
}

export function hasAlesteMultiStopSummary(input: { agency?: string | null; sender?: string | null; note?: string | null }) {
  return /aleste/i.test(`${input.agency ?? ""} ${input.sender ?? ""}`) &&
    /due\s+bus\s+separat|due\s+fermate|milano[\s\S]*valdarno|valdarno[\s\S]*milano/i.test(input.note ?? "");
}
