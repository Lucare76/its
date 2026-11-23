import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { ticketNumbers } from "@/lib/server/medmar-invoice-compare";
import { findMedmarPdfByUid } from "@/lib/server/medmar-booking/pdf-mailbox-lookup";
import { extractTextItemsFromPdf } from "@/lib/server/medmar-booking/pdf-content-stream";

export const runtime = "nodejs";
export const maxDuration = 60;

const inputSchema = z.object({ booking_code: z.string().trim().regex(/^AG[A-Z0-9]{8,40}$/i) });

/** Recupera un'emissione storica via UID del messaggio originale, senza re-inviare il biglietto. */
export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;
  const parsed = inputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Inserisci un codice prenotazione Medmar AG valido." }, { status: 400 });

  const { data: rows, error } = await auth.admin.from("medmar_delivery_attempts")
    .select("id, medmar_numero, medmar_id_prenotazione, pdf_mailbox_message_uid, ticket_numbers")
    .eq("tenant_id", auth.membership.tenant_id).eq("status", "delivered")
    .ilike("medmar_numero", parsed.data.booking_code).limit(2);
  if (error) return NextResponse.json({ error: "Impossibile leggere l'archivio dei biglietti." }, { status: 500 });
  if (!rows?.length) return NextResponse.json({ error: "Prenotazione inviata non trovata per questo tenant." }, { status: 404 });
  if (rows.length !== 1) return NextResponse.json({ error: "Più invii trovati: verifica la prenotazione." }, { status: 409 });
  const row = rows[0];
  if ((row.ticket_numbers as string[] | null)?.length) return NextResponse.json({ ticket_numbers: row.ticket_numbers, already_saved: true });
  if (!row.pdf_mailbox_message_uid || !row.medmar_id_prenotazione || !row.medmar_numero)
    return NextResponse.json({ error: "Riferimento al PDF originale non disponibile; carica il PDF dei biglietti nel confronto fattura." }, { status: 422 });

  try {
    const found = await findMedmarPdfByUid({ uid: row.pdf_mailbox_message_uid, idPrenotazione: row.medmar_id_prenotazione, medmarNumero: row.medmar_numero });
    if (found.kind !== "found") return NextResponse.json({ error: "PDF non più reperibile nella casella Medmar; usa il PDF originale nel confronto." }, { status: 422 });
    const numbers = ticketNumbers((await extractTextItemsFromPdf(found.pdfBytes)).join(" "));
    if (!numbers.length) return NextResponse.json({ error: "Nessun numero Me leggibile nel PDF originale." }, { status: 422 });
    const { error: saveError } = await auth.admin.from("medmar_delivery_attempts")
      .update({ ticket_numbers: numbers })
      .eq("id", row.id).eq("tenant_id", auth.membership.tenant_id).eq("status", "delivered");
    if (saveError) throw new Error("Salvataggio dei numeri non riuscito.");
    return NextResponse.json({ ticket_numbers: numbers, already_saved: false });
  } catch (cause) {
    return NextResponse.json({ error: cause instanceof Error ? cause.message : "Recupero del PDF non riuscito." }, { status: 422 });
  }
}
