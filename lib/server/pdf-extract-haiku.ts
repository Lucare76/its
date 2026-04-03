/**
 * Estrazione PDF con Claude Haiku — modulo condiviso.
 *
 * Ottimizzazioni rispetto alla versione Sonnet precedente:
 * - Modello: claude-haiku-4-5-20251001 (12x più economico)
 * - Solo pagina 1 del PDF (pdf-parse { max: 1 })
 * - Testo estratto inviato come testo (non PDF base64) quando leggibile
 * - Fallback a PDF base64 solo se il testo è corrotto/assente
 * - Rilevamento agenzia via regex (0 token, 0 costo)
 * - Una sola chiamata API (no detect separato)
 * - Email body limitato a 1.500 caratteri
 */

import { cleanExtractedPdfText } from "@/lib/server/pdf-text-cleaning";

const MODEL = "claude-haiku-4-5-20251001";

// ─── Prompt di sistema ───────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Sei un sistema di estrazione dati per Ischia Transfer Service.
Leggi conferme d'ordine di agenzie di viaggio italiane.
RISPONDI ESCLUSIVAMENTE con JSON valido. Zero testo aggiuntivo. Zero markdown. Zero backtick.
Se un campo non è presente usa null, non inventare mai dati.`;

// ─── Schema piatto ───────────────────────────────────────────────────────────

const FLAT_SCHEMA = `
Restituisci ESATTAMENTE questo JSON:
{
  "numero_pratica": "XX/XXXXXX",
  "cliente_nome": "NOME COGNOME COMPLETO su una riga",
  "cliente_cellulare": "3XXXXXXXXX oppure null",
  "n_pax": 2,
  "hotel": "Nome Hotel completo",
  "data_arrivo": "YYYY-MM-DD",
  "data_partenza": "YYYY-MM-DD",
  "orario_arrivo": "HH:MM oppure null",
  "orario_partenza": "HH:MM oppure null",
  "numero_mezzo_andata": "codice treno/volo/corsa oppure null",
  "numero_mezzo_ritorno": "codice treno/volo/corsa oppure null",
  "citta_partenza": "città di partenza oppure null",
  "totale_pratica": 000.00,
  "tipo_servizio": "transfer_station_hotel oppure transfer_airport_hotel oppure transfer_port_hotel oppure excursion",
  "tipo_barca_ritorno": "traghetto oppure aliscafo oppure null",
  "agenzia": "Nome Agenzia",
  "note_operative": "note aggiuntive oppure null",
  "agency_key": "aleste oppure angelino oppure holidayweb oppure sosandra oppure zigolo oppure unknown"
}

Regole tipo_servizio:
- STAZIONE / TRENO / ITALO / TRENITALIA / FLIXBUS → "transfer_station_hotel"
- AEROPORTO / VOLO / AEREO → "transfer_airport_hotel"
- PORTO / TRAGHETTO / MEDMAR / SNAV / ALISCAFO → "transfer_port_hotel"
- ESCURSIONE / GIRO ISOLA / CAPRI / SORRENTO / POSITANO / AMALFI / PROCIDA / POMPEI / CASERTA / NAPOLI / CASTELLO / MORTELLA / NITRODI / COOKING CLASS / CRATERI → "excursion"
  (usa "excursion" ogni volta che il documento riguarda una gita o escursione, NON un transfer da/per stazione/aeroporto/porto)

Regole tipo_barca_ritorno (solo per transfer stazione o aeroporto con ritorno):
- Se nel documento del RITORNO è specificato TRAGHETTO / MEDMAR / NAVE → "traghetto"
- Se nel documento del RITORNO è specificato ALISCAFO / SNAV / ALILAURO / VELOCE / NORMALE → "aliscafo"
- Se l'agenzia è Aleste Viaggi → "traghetto" (Aleste è SEMPRE traghetto)
- Se non deducibile → null
`;

// ─── Prompt agenzie ──────────────────────────────────────────────────────────

export const AGENCY_PROMPTS: Record<string, string> = {
  aleste: `Stai leggendo una CONFERMA D'ORDINE di Aleste Viaggi (Ischia).

ISTRUZIONI CAMPO PER CAMPO:
- numero_pratica: campo PRATICA (es: "26/002739")
- cliente_nome: campo "1° BENEFICIARIO" — scrivilo tutto su una riga senza spazi in più (es: "ALLEGRI ORNELLA" non "AL LEGRI ORNELLA")
- cliente_cellulare: cerca in QUESTO ORDINE:
    1) dopo "a: CELL:" (con due punti, es: "a: CELL:3282653533")
    2) dopo "a: CELL." (con punto, es: "a: CELL. 3515859941")
    3) dopo "Cellulare/Tel."
    4) qualsiasi numero di 10 cifre che inizia con 3 nel documento
- n_pax: colonna PAX (numero intero)
- hotel: campo DESCRIZIONE della riga PROGRAMMA — rimuovi eventuale prefisso "AV " o "26/TRENOB" ecc.
- data_arrivo: colonna DAL nella riga PROGRAMMA → converti in YYYY-MM-DD (es: "19-apr-26" → "2026-04-19")
- data_partenza: colonna AL nella riga PROGRAMMA → converti in YYYY-MM-DD (es: "26-apr-26" → "2026-04-26")
- orario_arrivo: dalla sezione operativa, nel blocco del servizio ANDATA (STAZIONE/HOTEL o PORTO/HOTEL): il valore dopo "Alle" (es: "13:43")
- orario_partenza: dalla sezione operativa, nel blocco del servizio RITORNO (HOTEL/STAZIONE o HOTEL/PORTO): il valore dopo "Dalle" (es: "13:20")
- numero_mezzo_andata: per PORTO/TRAGHETTO scrivi esattamente "MEDMAR" oppure "SNAV" (deduci dal documento). Per treni/aerei: codice treno/volo dalla tabella operativa riga 1, colonna "num." (es: "ITA 9919") OPPURE dopo "da:" (es: "ITALO 9919")
- numero_mezzo_ritorno: per PORTO/TRAGHETTO scrivi "MEDMAR" oppure "SNAV" (stesso del ritorno). Per treni/aerei: codice treno/volo riga 2 (es: "ITA 9940") OPPURE dopo "da:" nel blocco ritorno
- citta_partenza: dopo "M.p.:" nel blocco andata OPPURE prima riga della tabella operativa (es: "TORINO P. NUOVA")
- totale_pratica: numero dopo "Totale pratica EUR" (es: 104.00)
- tipo_servizio: deduci dalla descrizione servizi (STAZIONE→station, AEROPORTO→airport, TRAGHETTO/MEDMAR/SNAV→port)

ESEMPIO OUTPUT per un PDF con treno:
{
  "numero_pratica": "26/002739",
  "cliente_nome": "ALLEGRI ORNELLA",
  "cliente_cellulare": "3282653533",
  "n_pax": 2,
  "hotel": "ISOLA VERDE HOTEL & THERMAL SPA",
  "data_arrivo": "2026-04-19",
  "data_partenza": "2026-04-26",
  "orario_arrivo": "13:43",
  "orario_partenza": "13:20",
  "numero_mezzo_andata": "ITA 9919",
  "numero_mezzo_ritorno": "ITA 9940",
  "citta_partenza": "TORINO P. NUOVA",
  "totale_pratica": 104.00,
  "tipo_servizio": "transfer_station_hotel",
  "agenzia": "Aleste Viaggi",
  "note_operative": null,
  "agency_key": "aleste"
}
${FLAT_SCHEMA}`,

  angelino: `Stai leggendo una CONFERMA D'ORDINE di Angelino Tour & Events (Forio, Ischia).
ATTENZIONE: PDF con encoding non standard, leggi dall'immagine.

ISTRUZIONI CAMPO PER CAMPO:
- numero_pratica: campo "pratica" (es: "26/000102")
- cliente_nome: campo "1° beneficiario" — tutto su una riga
- cliente_cellulare: cerca numero 10 cifre che inizia con 3
- n_pax: campo "pax" in alto a destra
- hotel: campo "descrizione" accanto a "programma"
- data_arrivo / data_partenza: campi "dal" / "al" → YYYY-MM-DD
- orario_arrivo: orario del primo servizio (andata) se presente
- orario_partenza: orario del secondo servizio (ritorno) se presente
- numero_mezzo_andata: per PORTO scrivi "MEDMAR" o "SNAV". Per treni/aerei: codice se presente
- numero_mezzo_ritorno: per PORTO scrivi "MEDMAR" o "SNAV". Per treni/aerei: codice se presente
- citta_partenza: città di partenza deducibile dal servizio andata
- totale_pratica: "Totale pratica EUR"
- tipo_servizio: deduci da descrizione (STAZIONE→station, AEROPORTO→airport, PORTO→port)
- note_operative: nominativi passeggeri dalla tabella "num nominativo"
${FLAT_SCHEMA}`,

  holidayweb: `Stai leggendo una CONFERMA D'ORDINE di Holiday Web (Lacco Ameno, Ischia).
ATTENZIONE: PDF con encoding non standard, leggi dall'immagine.

ISTRUZIONI CAMPO PER CAMPO:
- numero_pratica: campo "pratica" (es: "25/000898")
- cliente_nome: campo "1° beneficiario" — tutto su una riga
- cliente_cellulare: cerca numero 10 cifre che inizia con 3
- n_pax: campo "pax"
- hotel: campo "descrizione" nella riga "programma"
- data_arrivo / data_partenza: campi "dal" / "al" → YYYY-MM-DD
- orario_arrivo: orario servizio andata se presente
- orario_partenza: orario servizio ritorno se presente
- numero_mezzo_andata: per PORTO scrivi "MEDMAR" o "SNAV". Per treni/aerei: codice se presente ("PONTE SAN GIOVANNI" indica stazione)
- numero_mezzo_ritorno: per PORTO scrivi "MEDMAR" o "SNAV". Per treni/aerei: codice se presente
- citta_partenza: deduci da "PONTE SAN GIOVANNI", "PORTO SAN GIOVANNI" o simile
- totale_pratica: "Totale pratica EUR"
- tipo_servizio: deduci da descrizione
- note_operative: nominativi dalla tabella "num nominativo"
${FLAT_SCHEMA}`,

  sosandra: `Stai leggendo un documento di Sosandra Tour / Rossella Viaggi / Dimhotels (Ischia Porto).
Può essere una CONFERMA SERVIZIO (lettera libera) OPPURE un VOUCHER SNAV compilato.

CASO A — Lettera di conferma servizio (riconosci perché inizia con "Alla C.A Ischia Transfert" o "Oggetto: Transfer"):
- numero_pratica: null
- cliente_nome: dopo "per i Sigg" o "a nome" — tutto su una riga (es: "Scala Roberto")
- cliente_cellulare: dopo "Cellulare cliente" — IGNORA se contiene "TRF NORMALE", "AGGIUNTA DI 1 PAX", "ATTESA SALDO" → metti null in quel caso
- n_pax: dopo "numero persone" o "numero X persone"
- hotel: dopo "per Hotel" o nome hotel esplicito
- data_arrivo: dopo "Arrivo giorno" → YYYY-MM-DD
- data_partenza: dopo "Ritorno giorno" → YYYY-MM-DD
- orario_arrivo: orario del mezzo in arrivo (dopo "alle ore") — es: "13:53", "07:45"
- orario_partenza: orario prelevamento ritorno (dopo "prelevamento alle ore") — es: "14:35", "08:00"
- numero_mezzo_andata: per PORTO/ALISCAFO scrivi "MEDMAR" o "SNAV". Per treni/bus: numero se indicato
- numero_mezzo_ritorno: per PORTO/ALISCAFO scrivi "MEDMAR" o "SNAV". Per treni/bus: numero se indicato
- citta_partenza: città di partenza
- totale_pratica: null
- tipo_servizio: deduci (ITALO/TRENO→station, BUS→station, SNAV/ALISCAFO→port)
- note_operative: testo aggiuntivo + note tipo "AGGIUNTA DI 1 PAX", "ATTESA SALDO"

CASO B — Voucher SNAV compilato (riconosci perché ha logo SNAV, "Numero Passeggeri:" e checkbox orari ☐/☑):
- cliente_nome: unisci "Nome:" + "Cognome:" su una riga
- cliente_cellulare: campo "Cellulare:"
- n_pax: campo "Numero Passeggeri:"
- hotel: campo "Hotel di destinazione:"
- data_arrivo: campo "Data di Arrivo ad Ischia:" → YYYY-MM-DD
- data_partenza: campo "Data di Partenza da Ischia:" → YYYY-MM-DD
- orario_arrivo: orario selezionato (checkbox marcato) colonna "da Napoli Beverello a Casamicciola"
- orario_partenza: orario selezionato colonna "da Casamicciola a Napoli Beverello"
- numero_mezzo_andata: null
- numero_mezzo_ritorno: null
- citta_partenza: "NAPOLI BEVERELLO"
- totale_pratica: null
- tipo_servizio: "transfer_port_hotel"
- numero_pratica: null
${FLAT_SCHEMA}`,

  zigolo: `Stai leggendo un documento "Elenco richieste conferme annullamenti servizi" di Zigolo Viaggi (Barano d'Ischia).

ISTRUZIONI CAMPO PER CAMPO:
- numero_pratica: campo "Pratica" (es: "26/000248")
- cliente_nome: colonna "Beneficiari" — tutto su una riga
- cliente_cellulare: cerca numero 10 cifre che inizia con 3 se presente
- n_pax: numero passeggeri se indicato
- hotel: deduci dal contesto se presente
- data_arrivo: campo "Dal" → YYYY-MM-DD
- data_partenza: campo "Al" se presente → YYYY-MM-DD
- orario_arrivo / orario_partenza: orari indicati nel documento
- numero_mezzo_andata: per PORTO scrivi "MEDMAR" o "SNAV" se deducibile, altrimenti null
- numero_mezzo_ritorno: per PORTO scrivi "MEDMAR" o "SNAV" se deducibile, altrimenti null
- citta_partenza: null
- totale_pratica: campo "TOTALE EUR"
- tipo_servizio: deduci dalla descrizione (IN BUS→station o bus, TRAGHETTO→port)
${FLAT_SCHEMA}`,

  unknown: `Stai leggendo una conferma d'ordine di un'agenzia di viaggio italiana.
Cerca tutti i campi nelle posizioni tipiche del documento.
Per "agenzia" usa il nome esatto che trovi nell'intestazione del documento.
${FLAT_SCHEMA}`
};

export const AGENCY_LABELS: Record<string, string> = {
  aleste: "Aleste Viaggi",
  angelino: "Angelino Tour & Events",
  holidayweb: "Holiday Web",
  sosandra: "Sosandra / Rossella Viaggi",
  zigolo: "Zigolo Viaggi",
  unknown: "Agenzia non identificata"
};

// ─── Tipi ────────────────────────────────────────────────────────────────────

export type ClaudeFormState = {
  cliente_nome: string;
  cliente_cellulare: string;
  n_pax: string;
  hotel: string;
  data_arrivo: string;
  orario_arrivo: string;
  data_partenza: string;
  orario_partenza: string;
  tipo_servizio: string;
  treno_andata: string;
  treno_ritorno: string;
  citta_partenza: string;
  totale_pratica: string;
  note: string;
  numero_pratica: string;
  agenzia: string;
  tipo_barca_ritorno: string;
};

export type HaikuExtractResult = {
  agency: string;
  form: ClaudeFormState;
  rawJson: Record<string, unknown>;
  textMode: boolean; // true = testo estratto, false = PDF base64
};

type ClaudeJson = {
  agency_key?: string | null;
  numero_pratica?: string | null;
  cliente_nome?: string | null;
  cliente_cellulare?: string | null;
  n_pax?: number | null;
  hotel?: string | null;
  data_arrivo?: string | null;
  data_partenza?: string | null;
  orario_arrivo?: string | null;
  orario_partenza?: string | null;
  numero_mezzo_andata?: string | null;
  numero_mezzo_ritorno?: string | null;
  citta_partenza?: string | null;
  totale_pratica?: number | null;
  note_operative?: string | null;
  agenzia?: string | null;
  tipo_servizio?: string | null;
  tipo_barca_ritorno?: string | null;
  servizi?: Array<{
    orario?: string | null;
    numero_mezzo?: string | null;
    partenza?: string | null;
    tipo?: string | null;
    mezzo?: string | null;
    compagnia?: string | null;
  }>;
};

// ─── Rilevamento agenzia via regex (gratis, 0 token) ────────────────────────

const KNOWN_AGENCIES = ["aleste", "angelino", "holidayweb", "sosandra", "zigolo"] as const;

export function detectAgencyFromText(text: string, subject = ""): string {
  const t = (text + " " + subject).toUpperCase();
  if (t.includes("ALESTE")) return "aleste";
  if (t.includes("ANGELINO")) return "angelino";
  if (t.includes("HOLIDAY WEB") || t.includes("HOLIDAYWEB")) return "holidayweb";
  if (t.includes("SOSANDRA") || t.includes("ROSSELLA VIAGGI") || t.includes("DIMHOTELS")) return "sosandra";
  if (t.includes("ZIGOLO")) return "zigolo";
  return "unknown";
}

// ─── Estrazione testo pagina 1 ───────────────────────────────────────────────

async function extractPage1Text(base64: string): Promise<string> {
  const buffer = Buffer.from(base64, "base64");
  const mod = await import("pdf-parse");
  const parse = mod.default as (buf: Buffer, opts?: { max?: number }) => Promise<{ text?: string }>;
  const result = await parse(buffer, { max: 1 });
  return result.text?.trim() ?? "";
}

function isUsableText(text: string): boolean {
  const words = (text.match(/[A-Za-zÀ-ÿ]{3,}/g) ?? []).length;
  const controlChars = (text.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g) ?? []).length;
  const corruptRatio = controlChars / Math.max(text.length, 1);
  if (text.length <= 200 || words < 15 || corruptRatio >= 0.02) return false;
  // Form vuoto: ha le etichette ma non i valori compilati → forzare PDF base64 (visivo)
  const normalized = text.replace(/\r/g, "\n");
  const looksLikeEmptyForm =
    /Nome:\s*[\n\r]\s*Cognome:/i.test(normalized) ||
    /Cellulare:\s*[\n\r]\s*Hotel di destinazione:/i.test(normalized) ||
    /Numero Passeggeri:\s*[\n\r]/i.test(normalized);
  const hasFilledValues =
    /Numero Passeggeri:\s*[0-9]/i.test(normalized) ||
    /Data di Arrivo ad Ischia:\s*[0-9]/i.test(normalized) ||
    /Cellulare:\s*[+0-9]{7}/i.test(normalized);
  if (looksLikeEmptyForm && !hasFilledValues) return false;
  return true;
}

// ─── Chiamata API ────────────────────────────────────────────────────────────

async function callHaiku(body: Record<string, unknown>): Promise<Response> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY non configurata.");
  return fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify(body)
  });
}

// ─── Mappatura JSON → form ───────────────────────────────────────────────────

function normalizeTipo(raw: string | null | undefined): string {
  if (!raw) return "transfer_station_hotel";
  const r = raw.toLowerCase();
  if (r.includes("airport") || r.includes("aeroporto")) return "transfer_airport_hotel";
  if (r.includes("port") || r.includes("porto") || r.includes("traghetto") || r.includes("medmar") || r.includes("snav")) return "transfer_port_hotel";
  return "transfer_station_hotel";
}

function jsonToForm(json: ClaudeJson, agency: string): ClaudeFormState {
  const servizi = json.servizi ?? [];
  const andataLegacy = servizi[0] ?? null;
  const ritornoLegacy =
    servizi.find((s, i) => i > 0 && /ritorno|hotel.st|hotel.ae|hotel.po/i.test(s.tipo ?? "")) ??
    servizi[1] ??
    null;

  return {
    cliente_nome: json.cliente_nome ?? "",
    cliente_cellulare: json.cliente_cellulare ?? "",
    n_pax: String(json.n_pax ?? 1),
    hotel: json.hotel ?? "",
    data_arrivo: json.data_arrivo ?? "",
    orario_arrivo: json.orario_arrivo ?? andataLegacy?.orario ?? "",
    data_partenza: json.data_partenza ?? "",
    orario_partenza: json.orario_partenza ?? ritornoLegacy?.orario ?? "",
    tipo_servizio: normalizeTipo(json.tipo_servizio),
    treno_andata: json.numero_mezzo_andata ?? andataLegacy?.numero_mezzo ?? "",
    treno_ritorno: json.numero_mezzo_ritorno ?? ritornoLegacy?.numero_mezzo ?? "",
    citta_partenza: json.citta_partenza ?? andataLegacy?.partenza ?? "",
    totale_pratica: json.totale_pratica ? String(json.totale_pratica) : "",
    note: json.note_operative ?? "",
    numero_pratica: json.numero_pratica ?? "",
    agenzia: AGENCY_LABELS[agency] ?? json.agenzia ?? agency,
    tipo_barca_ritorno: agency === "aleste" ? "traghetto" : (json.tipo_barca_ritorno ?? "")
  };
}

// ─── Funzione principale ─────────────────────────────────────────────────────

export async function extractWithHaiku(
  pdfBase64: string | null,
  emailBody: string,
  emailSubject: string
): Promise<HaikuExtractResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY non configurata sul server.");
  }

  // 1. Estrai testo pagina 1 (gratis, nessun token)
  let page1Text = "";
  let textMode = false;
  if (pdfBase64) {
    try {
      const raw = await extractPage1Text(pdfBase64);
      page1Text = cleanExtractedPdfText(raw);
      textMode = isUsableText(page1Text);
    } catch {
      // fallback: useremo il PDF base64
    }
  }

  // 2. Rileva agenzia via regex (0 costo)
  const agency = detectAgencyFromText(page1Text + " " + emailBody, emailSubject);
  const prompt = AGENCY_PROMPTS[agency];

  // 3. Costruisci contenuto: testo se leggibile, PDF base64 altrimenti
  const contentParts: unknown[] = [];
  if (!textMode && pdfBase64) {
    contentParts.push({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: pdfBase64 }
    });
  }
  if (page1Text) {
    contentParts.push({ type: "text", text: `[PRIMA PAGINA PDF]\n${page1Text}` });
  }
  const emailSnippet = emailBody.slice(0, 1500).trim();
  if (emailSnippet) {
    contentParts.push({ type: "text", text: `[TESTO EMAIL]\n${emailSnippet}` });
  }
  contentParts.push({ type: "text", text: prompt });

  // 4. Singola chiamata Haiku
  const res = await callHaiku({
    model: MODEL,
    max_tokens: 1000,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: contentParts }]
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Errore Haiku: ${errText}`);
  }

  const resData = (await res.json()) as { content?: Array<{ text?: string }> };
  let rawText = resData.content?.map((b) => b.text ?? "").join("") ?? "";
  rawText = rawText.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  const match = rawText.match(/\{[\s\S]*\}/);

  if (!match) {
    throw new Error("Haiku non ha restituito JSON valido.");
  }

  const rawJson = JSON.parse(match[0]) as ClaudeJson & { agency_key?: string };

  // agency_key dal JSON ha priorità sulla regex se è un'agenzia nota
  const jsonAgencyKey = rawJson.agency_key ?? "";
  const finalAgency = (KNOWN_AGENCIES as readonly string[]).includes(jsonAgencyKey) ? jsonAgencyKey : agency;

  const form = jsonToForm(rawJson, finalAgency);

  return {
    agency: finalAgency,
    form,
    rawJson: rawJson as Record<string, unknown>,
    textMode
  };
}
