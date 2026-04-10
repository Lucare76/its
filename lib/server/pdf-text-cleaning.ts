function normalizeCommonOcrSeparators(value: string) {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

function normalizeAttachedLabels(value: string) {
  return value
    .replace(/([A-Za-zÀ-ÿ])([0-9]{1,2}[:.][0-9]{2})/g, "$1 $2")
    .replace(/([0-9])([A-Za-zÀ-ÿ])/g, "$1 $2")
    .replace(/([a-zà-ÿ])([A-ZÀ-ß])/g, "$1 $2")
    .replace(/\b(Data|Pratica|Totale|Beneficiari|Descrizione|Pax|Importo|Tasse)([A-Z0-9])/gi, "$1 $2")
    .replace(/\b(TOTALE)(EUR)\b/g, "$1 $2")
    .replace(/\b(DAL|AL|DESCRIZIONE|IMPORTO|TASSE|PAX)([A-Z])/g, "$1 $2");
}

function normalizeCommonOcrArtifacts(value: string) {
  return value
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'")
    .replace(/[‐‑‒–—]/g, "-")
    .replace(/[•·]/g, " ")
    .replace(/0tt/gi, "ott")
    .replace(/hollday/gi, "holiday")
    .replace(/lSCHlA|ISCHlA/gi, "ISCHIA")
    .replace(/(\d{1,2})\.(\d{2})/g, "$1:$2")
    .replace(/\s{2,}/g, " ");
}

function injectServiceBreaks(value: string) {
  return value
    .replace(/\b(TSF PER HOTEL ANDATA)\b/gi, "\n$1")
    .replace(/\b(TSF PER HOTEL RITORNO)\b/gi, "\n$1")
    .replace(/\b(TOUR DELL'ISOLA IN BUS)\b/gi, "\n$1")
    .replace(/\b(Arrivo giorno)\b/gi, "\n$1")
    .replace(/\b(Partenza giorno)\b/gi, "\n$1")
    .replace(/\b(Scegli l['’]orario di partenza)\b/gi, "\n$1");
}

export function cleanExtractedPdfText(value: string) {
  const normalized = injectServiceBreaks(normalizeCommonOcrArtifacts(normalizeAttachedLabels(normalizeCommonOcrSeparators(value))));
  return normalized.replace(/\n{3,}/g, "\n\n").trim();
}

