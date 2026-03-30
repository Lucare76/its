/**
 * Server-side Claude extraction for inbound emails.
 * Schema JSON PIATTO — nessun array servizi, ogni campo estratto direttamente.
 */

const MODEL = "claude-sonnet-4-6";

const SYSTEM_PROMPT = `Sei un sistema di estrazione dati per Ischia Transfer Service.
Leggi conferme d'ordine di agenzie di viaggio italiane.
RISPONDI ESCLUSIVAMENTE con JSON valido. Zero testo aggiuntivo. Zero markdown. Zero backtick.
Se un campo non è presente usa null, non inventare mai dati.`;

// ─── Schema piatto comune ────────────────────────────────────────────────────
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
  "tipo_servizio": "transfer_station_hotel oppure transfer_airport_hotel oppure transfer_port_hotel",
  "agenzia": "Nome Agenzia",
  "note_operative": "note aggiuntive oppure null"
}

Regole tipo_servizio:
- STAZIONE / TRENO / ITALO / TRENITALIA / FLIXBUS → "transfer_station_hotel"
- AEROPORTO / VOLO / AEREO → "transfer_airport_hotel"
- PORTO / TRAGHETTO / MEDMAR / SNAV / ALISCAFO → "transfer_port_hotel"
`;

const AGENCY_PROMPTS: Record<string, string> = {
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
- numero_mezzo_andata: dalla sezione operativa tabella treni/voli, riga 1: colonna "num." (es: "ITA 9919") OPPURE dopo "da:" nel blocco andata (es: "ITALO 9919")
- numero_mezzo_ritorno: dalla sezione operativa tabella treni/voli, riga 2: colonna "num." (es: "ITA 9940") OPPURE dopo "da:" nel blocco ritorno (es: "ITALO 9940")
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
  "note_operative": null
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
- numero_mezzo_andata: codice treno/volo andata se presente (es: da descrizione "STAZIONE NAPOLI")
- numero_mezzo_ritorno: codice treno/volo ritorno se presente
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
- numero_mezzo_andata: codice treno/volo andata ("PONTE SAN GIOVANNI" o simile indica stazione)
- numero_mezzo_ritorno: codice treno/volo ritorno
- citta_partenza: deduci da "PONTE SAN GIOVANNI", "PORTO SAN GIOVANNI" o simile
- totale_pratica: "Totale pratica EUR"
- tipo_servizio: deduci da descrizione
- note_operative: nominativi dalla tabella "num nominativo"
${FLAT_SCHEMA}`,

  sosandra: `Stai leggendo un documento di Sosandra Tour / Rossella Viaggi (Ischia Porto).
Può essere una CONFERMA SERVIZIO (lettera libera) OPPURE un VOUCHER SNAV compilato.

CASO A — Lettera di conferma servizio (riconosci perché inizia con "Alla C.A Ischia Transfert" o "Oggetto: Transfer"):
- numero_pratica: null
- cliente_nome: dopo "per i Sigg" o "a nome" — tutto su una riga (es: "Scala Roberto")
- cliente_cellulare: dopo "Cellulare cliente" — IGNORA se contiene "TRF NORMALE", "AGGIUNTA DI 1 PAX", "ATTESA SALDO" → metti null in quel caso
- n_pax: dopo "numero persone" o "numero X persone"
- hotel: dopo "per Hotel" o "Hotel Cristallo" o "Hotel President" ecc.
- data_arrivo: dopo "Arrivo giorno" → YYYY-MM-DD
- data_partenza: dopo "Ritorno giorno" → YYYY-MM-DD
- orario_arrivo: orario del mezzo in arrivo (dopo "alle ore") — es: "13:53", "07:45"
- orario_partenza: orario prelevamento ritorno (dopo "prelevamento alle ore") — es: "14:35", "08:00"
- numero_mezzo_andata: numero treno/bus andata se indicato (es: "ITALO")
- numero_mezzo_ritorno: numero treno/bus ritorno se indicato
- citta_partenza: città di partenza (es: "MILANO", "LARGO MAZZONI DIFRONTE NEGOZIO SMEA")
- totale_pratica: null
- tipo_servizio: deduci (ITALO/TRENO→station, BUS→station, SNAV/ALISCAFO→port)
- note_operative: testo nel riquadro "Orario di prelevamento da Hotel" + note tipo "AGGIUNTA DI 1 PAX", "ATTESA SALDO"

CASO B — Voucher SNAV compilato (riconosci perché ha logo SNAV, "Numero Passeggeri:" e checkbox orari ☐/☑):
- cliente_nome: unisci "Nome:" + "Cognome:" su una riga (es: "Salvatore Valentino")
- cliente_cellulare: campo "Cellulare:"
- n_pax: campo "Numero Passeggeri:"
- hotel: campo "Hotel di destinazione:"
- data_arrivo: campo "Data di Arrivo ad Ischia:" → YYYY-MM-DD
- data_partenza: campo "Data di Partenza da Ischia:" → YYYY-MM-DD
- orario_arrivo: orario selezionato (checkbox marcato, quadratino pieno) colonna "da Napoli Beverello a Casamicciola" (es: "08:25")
- orario_partenza: orario selezionato colonna "da Casamicciola a Napoli Beverello" (es: "09:45")
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
- numero_mezzo_andata / numero_mezzo_ritorno: null (Zigolo solitamente non li indica)
- citta_partenza: null
- totale_pratica: campo "TOTALE EUR"
- tipo_servizio: deduci dalla descrizione (IN BUS→station o bus, TRAGHETTO→port)
${FLAT_SCHEMA}`,

  unknown: `Stai leggendo una conferma d'ordine di un'agenzia di viaggio italiana.
Cerca tutti i campi nelle posizioni tipiche del documento.
Per "agenzia" usa il nome esatto che trovi nell'intestazione del documento.
${FLAT_SCHEMA}`
};

const AGENCY_LABELS: Record<string, string> = {
  aleste: "Aleste Viaggi",
  angelino: "Angelino Tour & Events",
  holidayweb: "Holiday Web",
  sosandra: "Sosandra / Rossella Viaggi",
  zigolo: "Zigolo Viaggi",
  unknown: "Agenzia non identificata"
};

// ─── Tipi ───────────────────────────────────────────────────────────────────

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
};

export type ClaudeEmailExtractResult = {
  agency: string;
  form: ClaudeFormState;
  rawJson: Record<string, unknown>;
};

// ─── Tipi interni ────────────────────────────────────────────────────────────

type ClaudeJson = {
  agency_key?: string | null;
  // Schema piatto (preferito)
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
  // Legacy array (fallback per compatibilità)
  servizi?: Array<{
    orario?: string | null;
    numero_mezzo?: string | null;
    partenza?: string | null;
    tipo?: string | null;
    mezzo?: string | null;
    compagnia?: string | null;
  }>;
};

function deduceTipoFromServizi(servizi: NonNullable<ClaudeJson["servizi"]>, agency: string): string {
  const text = servizi.map((s) => `${s.tipo ?? ""} ${s.mezzo ?? ""} ${s.compagnia ?? ""}`).join(" ").toUpperCase();
  if (/AEROPORTO/.test(text)) return "transfer_airport_hotel";
  if (/STAZIONE|ITALO|TRENITALIA|FLIXBUS/.test(text)) return "transfer_station_hotel";
  if (/PORTO|TRAGHETTO|ALISCAFO|MEDMAR|SNAV/.test(text)) return "transfer_port_hotel";
  if (agency === "aleste" || agency === "zigolo") return "transfer_station_hotel";
  return "transfer_port_hotel";
}

function normalizeTipoServizio(raw: string | null | undefined, servizi: NonNullable<ClaudeJson["servizi"]>, agency: string): string {
  if (raw) {
    const r = raw.toLowerCase();
    if (r.includes("airport") || r.includes("aeroporto")) return "transfer_airport_hotel";
    if (r.includes("station") || r.includes("stazione") || r.includes("treno")) return "transfer_station_hotel";
    if (r.includes("port") || r.includes("porto") || r.includes("traghetto") || r.includes("medmar") || r.includes("snav")) return "transfer_port_hotel";
  }
  return deduceTipoFromServizi(servizi, agency);
}

function claudeJsonToForm(json: ClaudeJson, agency: string): ClaudeFormState {
  const servizi = json.servizi ?? [];
  const andataLegacy = servizi[0] ?? null;
  const ritornoLegacy =
    servizi.find((s, i) => i > 0 && /ritorno|hotel.st|hotel.ae|hotel.po/i.test(s.tipo ?? "")) ??
    servizi[1] ??
    null;

  const tipo = normalizeTipoServizio(json.tipo_servizio, servizi, agency);

  return {
    cliente_nome: json.cliente_nome ?? "",
    cliente_cellulare: json.cliente_cellulare ?? "",
    n_pax: String(json.n_pax ?? 1),
    hotel: json.hotel ?? "",
    data_arrivo: json.data_arrivo ?? "",
    orario_arrivo: json.orario_arrivo ?? andataLegacy?.orario ?? "",
    data_partenza: json.data_partenza ?? "",
    orario_partenza: json.orario_partenza ?? ritornoLegacy?.orario ?? "",
    tipo_servizio: tipo,
    treno_andata: json.numero_mezzo_andata ?? andataLegacy?.numero_mezzo ?? "",
    treno_ritorno: json.numero_mezzo_ritorno ?? ritornoLegacy?.numero_mezzo ?? "",
    citta_partenza: json.citta_partenza ?? andataLegacy?.partenza ?? "",
    totale_pratica: json.totale_pratica ? String(json.totale_pratica) : "",
    note: json.note_operative ?? "",
    numero_pratica: json.numero_pratica ?? "",
    agenzia: AGENCY_LABELS[agency] ?? json.agenzia ?? agency
  };
}

async function callClaude(body: Record<string, unknown>): Promise<Response> {
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

function buildContent(pdfBase64: string | null, textParts: string[]) {
  const content: unknown[] = [];
  if (pdfBase64) {
    content.push({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: pdfBase64 }
    });
  }
  for (const text of textParts) {
    if (text.trim()) content.push({ type: "text", text });
  }
  return content;
}

// ─── Prompt combinato (detect + extract in una sola chiamata) ───────────────

const COMBINED_PROMPT = `PASSO 1 — Identifica l'agenzia dal logo/intestazione/formato del documento:
- "aleste"     → Aleste Viaggi (intestazione "ALESTE", tabella PROGRAMMA/SERVIZI, codice pratica "2X/XXXXXX")
- "angelino"   → Angelino Tour & Events (Forio, Ischia)
- "holidayweb" → Holiday Web (Lacco Ameno, Ischia)
- "sosandra"   → Sosandra / Rossella Viaggi (lettera libera o voucher SNAV con checkbox orari)
- "zigolo"     → Zigolo Viaggi ("Elenco richieste conferme annullamenti servizi", Barano d'Ischia)
- "unknown"    → agenzia non riconosciuta

PASSO 2 — Estrai i dati usando le istruzioni specifiche per l'agenzia identificata:

══ SE aleste ══
${AGENCY_PROMPTS.aleste}

══ SE angelino ══
${AGENCY_PROMPTS.angelino}

══ SE holidayweb ══
${AGENCY_PROMPTS.holidayweb}

══ SE sosandra ══
${AGENCY_PROMPTS.sosandra}

══ SE zigolo ══
${AGENCY_PROMPTS.zigolo}

══ SE unknown ══
${AGENCY_PROMPTS.unknown}

Aggiungi al JSON il campo "agency_key" con il codice agenzia identificato (aleste/angelino/holidayweb/sosandra/zigolo/unknown).`;

// ─── Export principale ──────────────────────────────────────────────────────

export async function claudeEmailExtract(
  pdfBase64: string | null,
  emailBody: string,
  emailSubject: string
): Promise<ClaudeEmailExtractResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY non configurata sul server.");
  }

  // Singola chiamata: detect + extract in un colpo solo, PDF inviato una volta sola
  const content = buildContent(pdfBase64, [
    emailSubject ? `Oggetto email: ${emailSubject}` : "",
    emailBody ? `Testo email:\n${emailBody.slice(0, 3000)}` : "",
    COMBINED_PROMPT
  ]);

  const res = await callClaude({
    model: MODEL,
    max_tokens: 1400,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content }]
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Errore Claude extraction: ${errText}`);
  }

  const resData = (await res.json()) as { content?: Array<{ text?: string }> };
  let rawText = resData.content?.map((b) => b.text ?? "").join("") ?? "";
  rawText = rawText.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  const match = rawText.match(/\{[\s\S]*\}/);

  if (!match) {
    throw new Error("Claude non ha restituito JSON valido dall'estrazione.");
  }

  const rawJson = JSON.parse(match[0]) as ClaudeJson & { agency_key?: string };
  const known = ["aleste", "angelino", "holidayweb", "sosandra", "zigolo"];
  const agency = known.includes(rawJson.agency_key ?? "") ? (rawJson.agency_key as string) : "unknown";
  const form = claudeJsonToForm(rawJson, agency);

  return { agency, form, rawJson: rawJson as Record<string, unknown> };
}
