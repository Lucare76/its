/**
 * POST /api/services/medmar-resend-ticket
 *
 * "Rimanda biglietto" (MVP sicuro) — WRAPPER SICURO di
 * lib/server/medmar-booking/ticket-resend.ts#resendMedmarTicket.
 *
 * Body: { delivery_attempt_id: string } — NIENTE recipient_email nel
 * payload: il destinatario e' sempre quello gia' salvato in
 * medmar_delivery_attempts.recipient_email, mai modificabile da qui.
 *
 * Nessuna nuova emissione, nessun lock/booking/payment: reinvia solo il PDF
 * gia' pulito/validato dallo stesso invio originale.
 */

import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { resendMedmarTicket } from "@/lib/server/medmar-booking/ticket-resend";
import { type SupabaseClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  const admin = auth.admin as SupabaseClient;
  const tenantId = auth.membership.tenant_id;
  const userId = auth.user.id;

  let body: { delivery_attempt_id?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "Body non valido." }, { status: 400 });
  }

  const deliveryAttemptId = body.delivery_attempt_id;
  if (typeof deliveryAttemptId !== "string" || !deliveryAttemptId.trim()) {
    return NextResponse.json({ ok: false, error: "delivery_attempt_id obbligatorio." }, { status: 400 });
  }

  const outcome = await resendMedmarTicket({ admin, tenantId, userId, deliveryAttemptId: deliveryAttemptId.trim() });

  if (outcome.ok) {
    return NextResponse.json({
      ok: true,
      status: outcome.status,
      resend_message_id: outcome.resendMessageId,
      hash_warning: outcome.hashWarning,
      ledger_id: outcome.ledgerId,
    });
  }

  const statusCode =
    outcome.status === "delivery_attempt_not_found"
      ? 404
      : outcome.status === "not_delivered" ||
          outcome.status === "recipient_email_missing" ||
          outcome.status === "medmar_id_prenotazione_missing" ||
          outcome.status === "medmar_numero_missing" ||
          outcome.status === "pdf_mailbox_message_uid_missing" ||
          outcome.status === "delivered_confirmation_missing"
        ? 422
        : 409;

  return NextResponse.json(
    { ok: false, status: outcome.status, error: outcome.error, ledger_id: outcome.ledgerId },
    { status: statusCode }
  );
}
