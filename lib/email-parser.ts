export interface ParsedInboundFields {
  date?: string;
  time?: string;
  direction?: "arrival" | "departure";
  vessel?: string;
  hotel?: string;
  pickup?: string;
  dropoff?: string;
  pax?: number;
  customer_name?: string;
  phone?: string;
  template_key?: string;
  confidence?: Partial<Record<keyof Omit<ParsedInboundFields, "template_key" | "confidence">, "low" | "medium" | "high">>;
}

interface ParsingTemplate {
  key: string;
  vessel?: RegExp;
  hotel?: RegExp;
  pickup?: RegExp;
  dropoff?: RegExp;
  pax?: RegExp;
  customer_name?: RegExp;
  phone?: RegExp;
  date?: RegExp;
  time?: RegExp;
}

const italianMonths: Record<string, string> = {
  gen: "01",
  feb: "02",
  mar: "03",
  apr: "04",
  mag: "05",
  giu: "06",
  lug: "07",
  ago: "08",
  set: "09",
  ott: "10",
  nov: "11",
  dic: "12"
};

const templates: ParsingTemplate[] = [
  {
    key: "agency-default",
    date: /\b(\d{4}-\d{2}-\d{2})\b/i,
    time: /\b([01]\d|2[0-3]):([0-5]\d)\b/i,
    vessel: /(?:nave|vessel|traghetto|aliscafo)\s*[:=-]?\s*([A-Za-z0-9\s]+)/i,
    hotel: /(?:hotel|dropoff|drop off)\s*[:=-]?\s*([A-Za-z0-9\s']+)/i,
    pickup: /(?:pickup|pick up|ritiro|partenza da)\s*[:=-]?\s*([A-Za-z0-9\s',.-]+)/i,
    dropoff: /(?:dropoff|drop off|arrivo a|destinazione)\s*[:=-]?\s*([A-Za-z0-9\s',.-]+)/i,
    pax: /(?:pax|persone|passengers?)\s*[:=-]?\s*(\d{1,2})/i,
    customer_name: /(?:nome|name|customer)\s*[:=-]?\s*([A-Za-z\s']+)/i,
    phone: /(?:tel|telefono|phone|mobile)\s*[:=-]?\s*(\+?\d[\d\s-]{6,})/i
  },
  {
    key: "agency-compact",
    date: /\bdata\s*[:=-]?\s*(\d{4}-\d{2}-\d{2})\b/i,
    time: /\bora\s*[:=-]?\s*([01]\d|2[0-3]):([0-5]\d)\b/i,
    vessel: /\bnave\s*[:=-]?\s*([A-Za-z0-9\s]+)/i,
    hotel: /\bhotel\s*[:=-]?\s*([A-Za-z0-9\s']+)/i,
    pax: /\bpax\s*[:=-]?\s*(\d{1,2})/i,
    customer_name: /\bnome\s*[:=-]?\s*([A-Za-z\s']+)/i,
    phone: /\b(?:tel|telefono)\s*[:=-]?\s*(\+?\d[\d\s-]{6,})/i
  }
];

function chooseTemplate(templateKey?: string) {
  if (!templateKey) return templates[0];
  return templates.find((item) => item.key === templateKey) ?? templates[0];
}

function extractRegexGroup(source: string, pattern?: RegExp, index = 1) {
  if (!pattern) return undefined;
  const match = source.match(pattern);
  const value = match?.[index];
  return value?.trim();
}

function cleanExtractedValue(raw?: string) {
  if (!raw) return undefined;
  let value = raw.replace(/\s+/g, " ").trim();
  const stopAt = value.search(
    /\s(?:data|ora|pax|tel(?:efono)?|phone|cliente|customer|pickup|pick up|drop ?off|dest(?:inazione)?|nave|vessel)\s*[:=-]/i
  );
  if (stopAt > 0) value = value.slice(0, stopAt).trim();
  value = value.replace(/^[,:;.\-\s]+|[,:;.\-\s]+$/g, "");
  if (value.length < 2) return undefined;
  return value;
}

function buildParsingSource(rawText: string, extractedText?: string | null) {
  const parts = [rawText.trim()];
  if (extractedText?.trim()) {
    parts.push(extractedText.trim());
  }
  return parts
    .filter(Boolean)
    .join("\n\n---\n\n")
    .replace(/\u00a0/g, " ")
    .replace(/[–—]/g, "-");
}

function parseItalianDate(raw?: string) {
  if (!raw) return undefined;
  const match = raw.match(/(\d{1,2})-(gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)-(\d{2,4})/i);
  if (!match) return undefined;
  const day = match[1].padStart(2, "0");
  const month = italianMonths[match[2].toLowerCase()];
  if (!month) return undefined;
  const yearRaw = match[3];
  const year = yearRaw.length === 2 ? `20${yearRaw}` : yearRaw;
  return `${year}-${month}-${day}`;
}

function parseSlashDate(raw?: string) {
  if (!raw) return undefined;
  const match = raw.match(/\b([0-3]?\d)[\/.-]([01]?\d)[\/.-](\d{2,4})\b/);
  if (!match) return undefined;
  const day = match[1].padStart(2, "0");
  const month = match[2].padStart(2, "0");
  const yearRaw = match[3];
  const year = yearRaw.length === 2 ? `20${yearRaw}` : yearRaw;
  return `${year}-${month}-${day}`;
}

function normalizePhone(raw?: string) {
  if (!raw) return undefined;
  return raw.replace(/\s+/g, " ").trim();
}

export function parseInboundEmail(rawText: string, templateKey?: string, extractedText?: string | null): ParsedInboundFields {
  const template = chooseTemplate(templateKey);
  const parsingSource = buildParsingSource(rawText, extractedText);
  const confidence: ParsedInboundFields["confidence"] = {};

  const transferBlockMatch = parsingSource.match(
    /Il\s*([0-3]?\d-(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)-\d{2,4})\s*\d*\s*TRANSFER\s*(STAZIONE\s*\/\s*HOTEL|HOTEL\s*\/\s*STAZIONE)?[\s\S]{0,180}?Dalle\s*([01]?\d|2[0-3])[:.h]([0-5]\d)(?:\s*Alle\s*([01]?\d|2[0-3])[:.h]([0-5]\d))?[\s\S]{0,260}?M\.p\.\s*:\s*([^\n\r]+?)\s+da:\s*([^\n\r]+?)\s+a:\s*([^\n\r]+?)\s+dest:\s*([^\n\r]+?)(?:\s+Cliente:|$)/i
  );
  const transferDate = parseItalianDate(transferBlockMatch?.[1]);
  const transferDirectionRaw = transferBlockMatch?.[2]?.replace(/\s+/g, "").toUpperCase();
  const transferDirection: "arrival" | "departure" | undefined =
    transferDirectionRaw === "STAZIONE/HOTEL" ? "arrival" : transferDirectionRaw === "HOTEL/STAZIONE" ? "departure" : undefined;
  const transferTime = transferBlockMatch?.[3] && transferBlockMatch?.[4] ? `${transferBlockMatch[3].padStart(2, "0")}:${transferBlockMatch[4]}` : undefined;
  const transferPickup = cleanExtractedValue(transferBlockMatch?.[6]);
  const transferDropoff = cleanExtractedValue(transferBlockMatch?.[9]);
  const transferVessel = cleanExtractedValue(transferBlockMatch?.[7]);

  const isoDateMatch = extractRegexGroup(parsingSource, template.date);
  const italianDateMatch = parsingSource.match(/\b\d{1,2}-(?:gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)-\d{2,4}\b/i)?.[0];
  const slashDateMatch = parsingSource.match(/\b[0-3]?\d[\/.-][01]?\d[\/.-]\d{2,4}\b/)?.[0];
  const dateMatch = transferDate ?? isoDateMatch ?? parseItalianDate(italianDateMatch) ?? parseSlashDate(slashDateMatch);
  if (transferDate) confidence.date = "high";
  if (isoDateMatch) confidence.date = "high";
  else if (dateMatch) confidence.date = "medium";

  const timeMatchRaw =
    (transferTime ? [transferTime, transferTime.slice(0, 2), transferTime.slice(3, 5)] : null) ??
    parsingSource.match(template.time ?? /\b([01]?\d|2[0-3])[:.h]([0-5]\d)\b/i) ??
    parsingSource.match(/(?:dalle|ore|h)\s*([01]?\d|2[0-3])(?:[:.h]([0-5]\d))?/i);
  if (transferTime) confidence.time = "high";
  if (timeMatchRaw && parsingSource.match(template.time ?? /\b([01]\d|2[0-3]):([0-5]\d)\b/i)) confidence.time = "high";
  else if (timeMatchRaw) confidence.time = "medium";

  const vesselPrimary = cleanExtractedValue(extractRegexGroup(parsingSource, template.vessel));
  const vesselFallback = cleanExtractedValue(parsingSource.match(/\bCON\s+([A-Za-z][A-Za-z0-9\s-]{1,40})/i)?.[1]);
  const vesselMatch = vesselPrimary ?? transferVessel ?? vesselFallback;
  if (vesselPrimary) confidence.vessel = "high";
  else if (vesselMatch) confidence.vessel = "medium";

  const hotelPrimary = cleanExtractedValue(extractRegexGroup(parsingSource, template.hotel));
  const hotelFallback = cleanExtractedValue(
    parsingSource.match(/(?:dest|destinazione|arrivo a)\s*[:=-]\s*([^\n]+)/i)?.[1] ?? parsingSource.match(/dest:\s*([^\n]+)/i)?.[1]
  );
  const hotelMatch = hotelPrimary ?? transferDropoff ?? hotelFallback;
  if (hotelPrimary) confidence.hotel = "high";
  else if (hotelMatch) confidence.hotel = "medium";

  const pickupMatch =
    transferPickup ??
    cleanExtractedValue(extractRegexGroup(parsingSource, template.pickup)) ??
    cleanExtractedValue(parsingSource.match(/M\.p\.\s*:\s*([^\n]+?)(?:\s+da:|$)/i)?.[1]);
  if (transferPickup) confidence.pickup = "high";
  if (extractRegexGroup(parsingSource, template.pickup)) confidence.pickup = "high";
  else if (pickupMatch) confidence.pickup = "medium";

  const dropoffMatch =
    transferDropoff ??
    cleanExtractedValue(extractRegexGroup(parsingSource, template.dropoff)) ??
    cleanExtractedValue(parsingSource.match(/dest:\s*([^\n]+)/i)?.[1]);
  if (transferDropoff) confidence.dropoff = "high";
  if (extractRegexGroup(parsingSource, template.dropoff)) confidence.dropoff = "high";
  else if (dropoffMatch) confidence.dropoff = "medium";

  const paxMatchRaw =
    parsingSource.match(/(?:Viaggiatori|Travellers?)\s*[:\-]?\s*(\d{1,2})\b/i)?.[1] ??
    extractRegexGroup(parsingSource, template.pax) ??
    parsingSource.match(/\bPAX\b[^\d]{0,20}(\d{1,2})(?!\s*\/)/i)?.[1] ??
    parsingSource.match(/PASSAGGIO MARITTIMO ADULTO\s*(\d{1,2})/i)?.[1];
  if (parsingSource.match(/(?:Viaggiatori|Travellers?)\s*[:\-]?\s*(\d{1,2})\b/i)?.[1]) confidence.pax = "high";
  if (extractRegexGroup(parsingSource, template.pax)) confidence.pax = "high";
  else if (paxMatchRaw) confidence.pax = "medium";

  const nameMatch =
    cleanExtractedValue(extractRegexGroup(parsingSource, template.customer_name)) ??
    cleanExtractedValue(parsingSource.match(/Cliente:\s*([^\n]+)/i)?.[1]);
  if (extractRegexGroup(parsingSource, template.customer_name)) confidence.customer_name = "high";
  else if (nameMatch) confidence.customer_name = "medium";

  const phoneMatch =
    extractRegexGroup(parsingSource, template.phone) ??
    parsingSource.match(/(?:Cellulare\/Tel\.?|Cell\.?|Tel\.?)\s*[:.]?\s*(\+?\d[\d\s/-]{6,})/i)?.[1];
  if (extractRegexGroup(parsingSource, template.phone)) confidence.phone = "high";
  else if (phoneMatch) confidence.phone = "medium";

  return {
    date: dateMatch,
    time: timeMatchRaw ? `${timeMatchRaw[1].padStart(2, "0")}:${(timeMatchRaw[2] ?? "00").padStart(2, "0")}` : undefined,
    direction: transferDirection,
    vessel: vesselMatch,
    hotel: hotelMatch,
    pickup: pickupMatch,
    dropoff: dropoffMatch,
    pax: paxMatchRaw ? Number(paxMatchRaw) : undefined,
    customer_name: nameMatch,
    phone: normalizePhone(phoneMatch),
    template_key: template.key,
    confidence
  };
}
