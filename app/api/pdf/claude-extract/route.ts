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

const AGENCY_PROMPTS: Record<string, string> = {
  aleste: `Stai leggendo una conferma d'ordine di Aleste Viaggi (Ischia).
Formato tabellare fisso. Estrai:
- numero_conferma: dopo "CONFERMA D'ORDINE n."
- numero_pratica: campo PRATICA (es: 26/002739)
- data_conferma: campo Data in alto a destra
- cliente_nome: campo "1° BENEFICIARIO"
- n_pax: colonna PAX nella riga intestazione pratica (numero intero, es: 2)
- cliente_cellulare: dopo "CELL:" o "Cellulare/Tel." nella sezione operativa in fondo
- hotel: colonna DESCRIZIONE nella riga PROGRAMMA
- data_arrivo / data_partenza: colonne DAL/AL nella riga PROGRAMMA
- servizi: tabella con colonne DAL AL DESCRIZIONE IMPORTO PAX NUM TOTALE — ogni riga è un servizio
  - il mezzo si ricava dalla tabella treni/bus sotto (cerca ITALO, FLIXBUS, EASYJET)
  - compagnia: es "ITALO"
  - numero_mezzo: solo il numero (es "9919" da "ITALO ITA 9919")
  - orario: formato HH:MM accanto alla data servizio
  - partenza: stazione/città di partenza dalla tabella treni (es "TORINO P. NUOVA")
  - destinazione: stazione/città di arrivo (es "NAPOLI CENTRALE")
- totale_pratica: campo "Totale pratica EUR"

Rispondi con lo schema JSON richiesto.`,

  angelino: `Stai leggendo una conferma d'ordine di Angelino Tour & Events (Forio, Ischia).
Formato tabella compatta. ATTENZIONE: questo PDF ha encoding non standard, leggi dall'immagine.
Estrai:
- numero_conferma: dopo "CONFERMA D'ORDINE n."
- numero_pratica: campo "pratica" (es: 26/000102)
- cliente_nome: campo "1° beneficiario"
- n_pax: campo "pax" in alto a destra
- hotel: campo "descrizione" accanto a "programma"
- data_arrivo / data_partenza: campi "dal" / "al" nella riga programma
- servizi: tabella con colonne "dal al descrizione importo tasse pax num totale"
  - tipo: il testo descrizione (es: "TRASFERIMENTO STAZIONE NAPOLI - HOTEL IS")
  - mezzo: deducilo dal tipo (STAZIONE→TRENO, AEROPORTO→AEREO, PORTO→ALISCAFO/TRAGHETTO)
- nominativi passeggeri: tabella "num nominativo" in fondo — mettili in note_operative
- totale_pratica: "Totale pratica EUR"

Rispondi con lo schema JSON richiesto.`,

  holidayweb: `Stai leggendo una conferma d'ordine di Holiday Web (Lacco Ameno, Ischia).
Formato tabella compatta. ATTENZIONE: questo PDF ha encoding non standard, leggi dall'immagine.
Estrai:
- numero_conferma: dopo "CONFERMA D'ORDINE n."
- numero_pratica: campo "pratica" (es: 25/000898)
- cliente_nome: campo "1° beneficiario"
- n_pax: campo "pax"
- hotel: campo "descrizione" nella riga "programma"
- data_arrivo / data_partenza: campi "dal" / "al"
- servizi: tabella con colonne "dal al descrizione importo tasse pax num totale"
  - per le tratte: "ISCHIA TRANSFER SERVICE-ISCHIA (NA)" indica trasferimento locale
  - cerca "PONTE SAN GIOVANNI", "PORTO SAN GIOVANNI" per identificare la città di partenza
- nominativi: tabella "num nominativo" → metti in note_operative
- totale_pratica: "Totale pratica EUR"

Rispondi con lo schema JSON richiesto.`,

  sosandra: `Stai leggendo una conferma servizio di Sosandra Tour / Rossella Viaggi (Ischia Porto).
Formato lettera libera, NON tabellare.
Estrai:
- numero_conferma: cerca numero documento nel testo se presente, altrimenti null
- cliente_nome: cerca "Sigg" o "a nome" o "Clienti"
- cliente_cellulare: dopo "Cellulare cliente" (ignora se c'è scritto "TRF NORMALE" o "AGGIUNTA DI 1 PAX")
- n_pax: cerca "numero persone" o "numero X persone"
- hotel: dopo "per Hotel" o "Hotel Cristallo" o "Hotel President" ecc.
- data_arrivo: dopo "Arrivo giorno"
- data_partenza: dopo "Ritorno giorno"
- servizi[0] (andata): data_arrivo, tipo "TRANSFER STAZIONE/HOTEL", mezzo dal contesto (ITALO→TRENO, BUS→BUS)
- servizi[1] (ritorno): data_partenza, tipo "TRANSFER HOTEL/STAZIONE", orario partenza dal testo
- note_operative: includi TUTTO quello che sta nel riquadro "Orario di prelevamento da Hotel",
  e qualunque nota tipo "AGGIUNTA DI 1 PAX", "ATTESA SALDO €XX"
- totale_pratica: null (Sosandra non riporta totale nel documento transfer)

Rispondi con lo schema JSON richiesto.`,

  zigolo: `Stai leggendo un "Elenco richieste conferme annullamenti servizi" di Zigolo Viaggi (Barano d'Ischia).
Estrai:
- numero_conferma: numero dopo "n." nel titolo (es: "000038")
- numero_pratica: campo "Pratica" (es: 26/000248)
- data_conferma: campo "Data"
- cliente_nome: colonna "Beneficiari"
- hotel: deducilo dal contesto se presente
- data_arrivo: campo "Dal"
- servizi: tabella con colonne "NUM Servizio Beneficiari" + tabella importi sotto
  - tipo: descrizione servizio (es: "GIRO DELL'ISOLA IN BUS")
  - mezzo: deducilo dal tipo (IN BUS→BUS, ecc.)
- totale_pratica: campo "TOTALE EUR"

Rispondi con lo schema JSON richiesto.`,

  unknown: `Stai leggendo una conferma d'ordine di un'agenzia di viaggio italiana non identificata.
Cerca tutti i campi dello schema JSON nelle posizioni tipiche di documenti simili.
Imposta "agenzia" con il nome esatto dell'agenzia mittente che trovi nell'intestazione.
Rispondi con lo schema JSON richiesto.`
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
