/**
 * POST /api/ops/cancellation-penalties/[id]/resend-email
 *
 * Reinvio manuale della comunicazione di una penale (channel "penalty") o del
 * suo annullamento (channel "void"). Consentito solo se l'invio precedente è
 * fallito / saltato / senza destinatario (o bloccato in "sending" da oltre
 * 10 minuti): una comunicazione già "sent" non viene mai reinviata.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { PENALTY_ROLES, deliverPenaltyEmail } from "@/lib/server/cancellation-penalty";

export const runtime = "nodejs";

const resendSchema = z.object({
  channel: z.enum(["penalty", "void"]).optional().default("penalty"),
});

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await authorizePricingRequest(request, [...PENALTY_ROLES]);
    if (auth instanceof NextResponse) return auth;

    const { id: penaltyId } = await params;
    if (!z.string().uuid().safeParse(penaltyId).success) {
      return NextResponse.json({ error: "Penale non valida." }, { status: 400 });
    }
    const parsed = resendSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json({ error: "Richiesta non valida." }, { status: 400 });

    const outcome = await deliverPenaltyEmail(auth.admin, {
      tenantId: auth.membership.tenant_id,
      penaltyId,
      channel: parsed.data.channel,
      mode: "resend",
      actorUserId: auth.user.id,
      actorRole: auth.membership.role,
    });

    if (!outcome.claimed) {
      if (outcome.status === "sent") {
        return NextResponse.json({ error: "Email già inviata: nessun nuovo invio.", code: "already_sent", email: outcome }, { status: 409 });
      }
      if (outcome.status === "sending") {
        return NextResponse.json({ error: "Invio già in corso. Attendi qualche istante e ricarica.", code: "in_progress", email: outcome }, { status: 409 });
      }
      return NextResponse.json({ error: outcome.error ?? "Email non reinviabile.", code: "not_resendable", email: outcome }, { status: 409 });
    }

    return NextResponse.json({ ok: true, email: outcome });
  } catch {
    return NextResponse.json({ error: "Errore interno." }, { status: 500 });
  }
}
