/**
 * GET /api/ops/services/[id]/cancellation-state
 *
 * Dettaglio per le modali "Ripristina prenotazione" e "Gestisci penale":
 * servizio + tratta collegata, dati cancellazione, penali attive e storico,
 * avvisi Medmar, destinatario email agenzia risolto. Sola lettura.
 */

import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { PENALTY_ROLES } from "@/lib/server/cancellation-penalty";
import { loadServiceCancellationDetail } from "@/lib/server/cancelled-booking-state";

export const runtime = "nodejs";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await authorizePricingRequest(request, [...PENALTY_ROLES]);
    if (auth instanceof NextResponse) return auth;

    const { id } = await params;
    const detail = await loadServiceCancellationDetail(auth.admin, auth.membership.tenant_id, id);
    if (!detail) return NextResponse.json({ error: "Prenotazione non trovata." }, { status: 404 });
    return NextResponse.json({ ok: true, ...detail });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Errore interno." }, { status: 500 });
  }
}
