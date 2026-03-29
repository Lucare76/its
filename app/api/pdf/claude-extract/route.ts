/**
 * POST /api/pdf/claude-extract
 *
 * Proxy server-side per le chiamate all'API Claude.
 * Mantiene ANTHROPIC_API_KEY sul server, non esposta al client.
 *
 * Body JSON:
 *   { pdf_base64: string, step: "detect" }            → { agency: string }
 *   { pdf_base64: string, step: "extract", agency: string } → { ok: true, data: {...} }
 *
 * Protetto: admin / operator.
 */

import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

const MODEL = "claude-sonnet-4-6";

const SYSTEM_PROMPT = `Sei un sistema di estrazione dati per Ischia Transfer Service.
Leggi conferme d'ordine di agenzie di viaggio italiane.
RISPONDI ESCLUSIVAMENTE con JSON valido. Zero testo aggiuntivo. Zero markdown. Zero backtick.
Se un campo non è presente usa null, non inventare mai dati.`;

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
- tipo_servizio: deduci dalla descrizione servizi

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
- numero_mezzo_andata: codice treno/volo andata se presente
- numero_mezzo_ritorno: codice treno/volo ritorno se presente
- citta_partenza: città di partenza deducibile dal servizio andata
- totale_pratica: "Totale pratica EUR"
- tipo_servizio: deduci da descrizione
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
- numero_mezzo_andata: codice treno/volo andata ("PONTE SAN GIOVANNI" indica stazione)
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
- orario_arrivo: orario selezionato (checkbox marcato) colonna "da Napoli Beverello a Casamicciola" (es: "08:25")
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
- numero_mezzo_andata / numero_mezzo_ritorno: null
- citta_partenza: null
- totale_pratica: campo "TOTALE EUR"
- tipo_servizio: deduci dalla descrizione
${FLAT_SCHEMA}`,

  unknown: `Stai leggendo una conferma d'ordine di un'agenzia di viaggio italiana.
Cerca tutti i campi nelle posizioni tipiche del documento.
Per "agenzia" usa il nome esatto che trovi nell'intestazione del documento.
${FLAT_SCHEMA}`
};

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

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator"]);
  if (auth instanceof NextResponse) return auth;

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { ok: false, error: "ANTHROPIC_API_KEY non configurata sul server." },
      { status: 503 }
    );
  }

  let body: { pdf_base64?: string; step?: string; agency?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "Body JSON non valido." }, { status: 400 });
  }

  const { pdf_base64, step, agency } = body;

  if (!pdf_base64 || typeof pdf_base64 !== "string") {
    return NextResponse.json({ ok: false, error: "pdf_base64 mancante." }, { status: 400 });
  }

  // ── STEP 1: riconoscimento agenzia ─────────────────────────────────────────
  if (step === "detect") {
    const res = await callClaude({
      model: MODEL,
      max_tokens: 50,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: pdf_base64 }
            },
            {
              type: "text",
              text: "Rispondi SOLO con il nome agenzia in minuscolo senza spazi: aleste | angelino | holidayweb | sosandra | zigolo | unknown"
            }
          ]
        }
      ]
    });

    if (!res.ok) {
      const err = await res.text();
      return NextResponse.json({ ok: false, error: `Errore Claude: ${err}` }, { status: 502 });
    }

    const data = (await res.json()) as { content?: Array<{ text?: string }> };
    const raw = data.content?.map((b) => b.text ?? "").join("").trim().toLowerCase() ?? "unknown";
    const known = ["aleste", "angelino", "holidayweb", "sosandra", "zigolo"];
    const detected = known.find((a) => raw.includes(a)) ?? "unknown";
    return NextResponse.json({ ok: true, agency: detected });
  }

  // ── STEP 2: estrazione dati ────────────────────────────────────────────────
  if (step === "extract") {
    const agencyKey = typeof agency === "string" && agency in AGENCY_PROMPTS ? agency : "unknown";
    const prompt = AGENCY_PROMPTS[agencyKey];

    const res = await callClaude({
      model: MODEL,
      max_tokens: 1200,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: pdf_base64 }
            },
            { type: "text", text: prompt }
          ]
        }
      ]
    });

    if (!res.ok) {
      const err = await res.text();
      return NextResponse.json({ ok: false, error: `Errore Claude: ${err}` }, { status: 502 });
    }

    const data = (await res.json()) as { content?: Array<{ text?: string }> };
    let raw = data.content?.map((b) => b.text ?? "").join("") ?? "";
    raw = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) {
      return NextResponse.json({ ok: false, error: "Il modello non ha restituito JSON valido." }, { status: 422 });
    }

    try {
      const extracted = JSON.parse(match[0]) as Record<string, unknown>;
      return NextResponse.json({ ok: true, data: extracted });
    } catch {
      return NextResponse.json({ ok: false, error: "JSON malformato dal modello." }, { status: 422 });
    }
  }

  return NextResponse.json({ ok: false, error: "Step non valido. Usa 'detect' o 'extract'." }, { status: 400 });
}
