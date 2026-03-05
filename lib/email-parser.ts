export interface ParsedInboundFields {
  date?: string;
  time?: string;
  vessel?: string;
  hotel?: string;
  pickup?: string;
  dropoff?: string;
  pax?: number;
  customer_name?: string;
  phone?: string;
  template_key?: string;
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

function buildParsingSource(rawText: string, extractedText?: string | null) {
  const parts = [rawText.trim()];
  if (extractedText?.trim()) {
    parts.push(extractedText.trim());
  }
  return parts.filter(Boolean).join("\n\n---\n\n");
}

export function parseInboundEmail(rawText: string, templateKey?: string, extractedText?: string | null): ParsedInboundFields {
  const template = chooseTemplate(templateKey);
  const parsingSource = buildParsingSource(rawText, extractedText);

  const dateMatch = extractRegexGroup(parsingSource, template.date);
  const timeMatchRaw = parsingSource.match(template.time ?? /\b([01]\d|2[0-3]):([0-5]\d)\b/i);
  const vesselMatch = extractRegexGroup(parsingSource, template.vessel);
  const hotelMatch = extractRegexGroup(parsingSource, template.hotel);
  const pickupMatch = extractRegexGroup(parsingSource, template.pickup);
  const dropoffMatch = extractRegexGroup(parsingSource, template.dropoff);
  const paxMatchRaw = extractRegexGroup(parsingSource, template.pax);
  const nameMatch = extractRegexGroup(parsingSource, template.customer_name);
  const phoneMatch = extractRegexGroup(parsingSource, template.phone);

  return {
    date: dateMatch,
    time: timeMatchRaw ? `${timeMatchRaw[1]}:${timeMatchRaw[2]}` : undefined,
    vessel: vesselMatch,
    hotel: hotelMatch,
    pickup: pickupMatch,
    dropoff: dropoffMatch,
    pax: paxMatchRaw ? Number(paxMatchRaw) : undefined,
    customer_name: nameMatch,
    phone: phoneMatch?.replace(/\s+/g, " ").trim(),
    template_key: template.key
  };
}
