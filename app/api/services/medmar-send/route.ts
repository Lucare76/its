/**
 * POST /api/services/medmar-send
 *
 * WRAPPER SICURO del flusso di delivery Medmar (lib/server/medmar-booking/pdf-delivery.ts).
 * Body: { service_ids: string[] }
 *
 * Storia: questo endpoint marcava `medmar_ticket_sent_at` INCONDIZIONATAMENTE
 * (prima di qualunque invio email) e allegava un PDF ORIGINALE non pulito
 * caricato dal browser, senza mai controllare la risposta di Resend — un
 * fallimento/errore silenzioso lasciava comunque il servizio segnato come
 * "inviato". Riscritto per delegare SEMPRE a `deliverMedmarTicket`, che
 * imposta `medmar_ticket_sent_at` solo dopo un `message_id` confermato da
 * Resend e invia solo il PDF ridotto/validato da `cleanMedmarPdf` +
 * `validateCleanedMedmarPdf`, mai un allegato fornito dal client.
 *
 * Se i service_ids richiesti non hanno un `medmar_issuing_attempts`
 * "completed" corrispondente (es. flusso legacy mai passato dall'emissione
 * One Click), fail-closed: nessuna mutazione, errore chiaro — non esiste
 * un percorso sicuro per "inviare un PDF qualsiasi" senza il ciclo
 * lookup-mailbox + clean + validate a monte.
 */

import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { deliverMedmarTicket } from "@/lib/server/medmar-booking/pdf-delivery";
import { type SupabaseClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator"]);
  if (auth instanceof NextResponse) return auth;

  const admin = auth.admin as SupabaseClient;
  const tenantId = auth.membership.tenant_id;
  const userId = auth.user.id;

  let body: { service_ids?: string[] };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "Body non valido." }, { status: 400 });
  }

  const { service_ids } = body;
  if (!service_ids?.length) {
    return NextResponse.json({ ok: false, error: "service_ids obbligatorio." }, { status: 400 });
  }

  // Trova l'unico medmar_issuing_attempts "completed" i cui service_ids
  // includono TUTTI quelli richiesti — nessun fallback su un match parziale
  // o su più attempt candidati (ambiguità = fail-closed).
  const { data: attempts, error: attemptsErr } = await admin
    .from("medmar_issuing_attempts")
    .select("id, service_ids")
    .eq("tenant_id", tenantId)
    .eq("status", "completed")
    .overlaps("service_ids", service_ids);

  if (attemptsErr) {
    return NextResponse.json({ ok: false, error: attemptsErr.message }, { status: 500 });
  }

  const requestedSet = new Set(service_ids);
  const matching = (attempts ?? []).filter((a) => {
    const ids: string[] = Array.isArray(a.service_ids) ? a.service_ids : [];
    return requestedSet.size > 0 && [...requestedSet].every((id) => ids.includes(id));
  });

  if (matching.length === 0) {
    return NextResponse.json(
      {
        ok: false,
        code: "no_completed_issuing_attempt",
        error:
          "Nessuna emissione Medmar One Click completata trovata per questi servizi: invio bloccato (nessun PDF client-side viene più accettato da questo endpoint).",
      },
      { status: 409 }
    );
  }
  if (matching.length > 1) {
    return NextResponse.json(
      { ok: false, code: "ambiguous_issuing_attempt", error: "Più emissioni Medmar completate corrispondono a questi servizi: revisione manuale richiesta." },
      { status: 409 }
    );
  }

  const outcome = await deliverMedmarTicket({ admin, tenantId, userId, issuingAttemptId: matching[0]!.id });

  if (outcome.ok) {
    return NextResponse.json({
      ok: true,
      status: outcome.status,
      already_delivered: outcome.already_delivered,
      recipient: outcome.attempt.recipient_email,
      resend_message_id: outcome.attempt.resend_message_id,
    });
  }

  return NextResponse.json({ ok: false, status: outcome.status, error: outcome.error }, { status: 409 });
}
