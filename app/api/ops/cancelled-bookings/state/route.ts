/**
 * GET /api/ops/cancelled-bookings/state?ids=<uuid>,<uuid>
 *
 * Stato derivato per le card (ricerca globale, /cancellazioni): penale
 * attiva, annullamento penale da comunicare, "Ripristinata – da
 * riassegnare/verificare". Sola lettura.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { PENALTY_ROLES } from "@/lib/server/cancellation-penalty";
import { loadCancelledBookingStates } from "@/lib/server/cancelled-booking-state";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, [...PENALTY_ROLES]);
    if (auth instanceof NextResponse) return auth;

    const ids = (request.nextUrl.searchParams.get("ids") ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => z.string().uuid().safeParse(id).success)
      .slice(0, 200);
    if (ids.length === 0) return NextResponse.json({ ok: true, states: {} });

    const states = await loadCancelledBookingStates(auth.admin, auth.membership.tenant_id, ids);
    return NextResponse.json({ ok: true, states });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Errore interno." }, { status: 500 });
  }
}
