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

export type ResolvedEscursioneRow = ParsedEscursioneBooking & {
  resolved_line_id: string | null;
  resolved_unit_id: string | null;
  match_confidence: "exact" | "fuzzy" | "none";
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

    const rawBookings = (parsed.bookings ?? []).filter((b) => b.customer_name?.trim());

    // Server-side resolution: match excursion_name → excursion_line + excursion_unit
    const { admin, membership } = auth;
    const dateStr = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;

    const { data: excursionLines } = await admin
      .from("excursion_lines")
      .select("id, name")
      .eq("tenant_id", membership.tenant_id)
      .eq("active", true);

    function normalizeName(s: string): string {
      return s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/[^a-z0-9]+/g, " ").trim();
    }

    const lineMap = new Map<string, string>();
    for (const line of excursionLines ?? []) {
      lineMap.set(normalizeName(line.name), line.id);
    }

    const unitsByLineId = new Map<string, string>();
    if (dateStr && lineMap.size > 0) {
      const { data: units } = await admin
        .from("excursion_units")
        .select("id, excursion_line_id")
        .eq("tenant_id", membership.tenant_id)
        .eq("excursion_date", dateStr)
        .in("excursion_line_id", Array.from(lineMap.values()))
        .order("created_at");
      for (const u of units ?? []) {
        if (!unitsByLineId.has(u.excursion_line_id)) unitsByLineId.set(u.excursion_line_id, u.id);
      }
    }

    const bookings: ResolvedEscursioneRow[] = rawBookings.map((r) => {
      if (!r.excursion_name) return { ...r, resolved_line_id: null, resolved_unit_id: null, match_confidence: "none" };
      const norm = normalizeName(r.excursion_name);
      let lineId: string | null = lineMap.get(norm) ?? null;
      let confidence: "exact" | "fuzzy" | "none" = lineId ? "exact" : "none";
      if (!lineId) {
        for (const [lineName, id] of lineMap) {
          if (lineName.includes(norm) || norm.includes(lineName)) {
            lineId = id; confidence = "fuzzy"; break;
          }
        }
      }
      const unitId = lineId ? (unitsByLineId.get(lineId) ?? null) : null;
      return { ...r, resolved_line_id: lineId, resolved_unit_id: unitId, match_confidence: confidence };
    });

    return NextResponse.json({ ok: true, bookings });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Errore Claude." },
      { status: 502 }
    );
  }
}
