/**
 * POST /api/pdf/claude-extract
 *
 * Estrazione dati da PDF con Claude Haiku (modulo condiviso pdf-extract-haiku).
 * - Una sola chiamata API (no detect separato)
 * - Solo pagina 1 del PDF
 * - Testo estratto quando leggibile, PDF base64 come fallback
 * - Rilevamento agenzia via regex (0 costo)
 *
 * Body JSON: { pdf_base64: string, email_body?: string, email_subject?: string }
 * Protetto: admin / operator.
 */

import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { extractWithHaiku } from "@/lib/server/pdf-extract-haiku";
import { resolveBusStop } from "@/lib/server/bus-lines-catalog";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator"]);
  if (auth instanceof NextResponse) return auth;

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { ok: false, error: "ANTHROPIC_API_KEY non configurata sul server." },
      { status: 503 }
    );
  }

  let body: { pdf_base64?: string; email_body?: string; email_subject?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "Body JSON non valido." }, { status: 400 });
  }

  const { pdf_base64, email_body = "", email_subject = "" } = body;

  if (!pdf_base64 || typeof pdf_base64 !== "string") {
    return NextResponse.json({ ok: false, error: "pdf_base64 mancante." }, { status: 400 });
  }

  try {
    const result = await extractWithHaiku(pdf_base64, email_body, email_subject);

    // Per servizi bus: usa sempre l'orario dal catalogo fermate (è la fonte autoritativa)
    const form = { ...result.form };
    if (form.tipo_servizio === "bus_city_hotel" && form.citta_partenza) {
      const busStop = resolveBusStop(form.citta_partenza);
      if (busStop?.time) {
        form.orario_arrivo = busStop.time;
      }
    }

    return NextResponse.json({
      ok: true,
      agency: result.agency,
      data: result.rawJson,
      form,
      text_mode: result.textMode
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Errore sconosciuto.";
    return NextResponse.json({ ok: false, error: msg }, { status: 502 });
  }
}
