/**
 * POST /api/email/import-escursioni
 *
 * Analizza testo libero (corpo email o PDF) con Claude Haiku
 * ed estrae prenotazioni di escursioni (lista passeggeri).
 *
 * Body: { text: string, date?: string }
 * Risponde con: { ok, bookings: ParsedEscursioneBooking[] }
 * Protetto: admin / operator
 */

import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

export type ParsedEscursioneBooking = {
  customer_name: string;
  pax: number;
  hotel_name: string | null;
  agency_name: string | null;
  phone: string | null;
  excursion_name: string | null;
  excursion_date: string | null;
  notes: string | null;
};

const SYSTEM = `Sei un assistente che estrae prenotazioni di escursioni da email e documenti.
RISPONDI ESCLUSIVAMENTE con JSON valido. Zero testo aggiuntivo. Zero markdown. Zero backtick.
Se un campo non è presente usa null, non inventare mai dati.`;

const buildPrompt = (text: string, dateHint: string) => `
Data di riferimento (oggi): ${dateHint}

Estrai TUTTE le prenotazioni di escursioni presenti nel seguente testo.
Ogni prenotazione è un passeggero o gruppo di passeggeri per una stessa escursione.

Restituisci ESATTAMENTE questo JSON:
{
  "bookings": [
    {
      "customer_name": "NOME COGNOME completo",
      "pax": 2,
      "hotel_name": "Nome hotel oppure null",
      "agency_name": "Nome agenzia oppure null",
      "phone": "numero telefono oppure null",
      "excursion_name": "nome escursione (es. Capri, Sorrento, Procida) oppure null",
      "excursion_date": "YYYY-MM-DD oppure null",
      "notes": "note aggiuntive oppure null"
    }
  ]
}

Se ci sono più passeggeri per la stessa escursione ma con dati diversi, crea una riga per ciascuno.
Se l'agenzia è la stessa per tutto il documento, applicala a tutte le righe.

Testo da analizzare:
---
${text.slice(0, 6000)}
---`;

export async function POST(req: NextRequest) {
  const auth = await authorizePricingRequest(req, ["admin", "operator"]);
  if (auth instanceof NextResponse) return auth;

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ ok: false, error: "ANTHROPIC_API_KEY non configurata." }, { status: 503 });
  }

  let body: { text?: string; date?: string };
  try { body = await req.json(); } catch {
    return NextResponse.json({ ok: false, error: "Body JSON non valido." }, { status: 400 });
  }

  const { text, date } = body;
  if (!text || typeof text !== "string" || text.trim().length < 10) {
    return NextResponse.json({ ok: false, error: "Testo troppo corto." }, { status: 400 });
  }

  const dateHint = date ?? new Date().toISOString().slice(0, 10);

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY!,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2048,
        system: SYSTEM,
        messages: [{ role: "user", content: buildPrompt(text, dateHint) }],
      }),
    });
    if (!resp.ok) throw new Error(`Anthropic ${resp.status}: ${await resp.text()}`);
    const apiRes = await resp.json() as { content: Array<{ type: string; text: string }> };
    const raw = apiRes.content[0].text.trim();
    let parsed: { bookings: ParsedEscursioneBooking[] };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return NextResponse.json({ ok: false, error: "Claude ha restituito JSON non valido.", raw }, { status: 502 });
    }

    const bookings = (parsed.bookings ?? []).filter((b) => b.customer_name?.trim());
    return NextResponse.json({ ok: true, bookings });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Errore Claude." },
      { status: 502 }
    );
  }
}
