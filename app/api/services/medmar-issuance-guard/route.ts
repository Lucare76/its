/**
 * POST /api/services/medmar-issuance-guard
 *
 * Sola lettura: per la coda /biglietti-medmar restituisce, per ogni servizio,
 * le prove di emissione Medmar già avvenuta (medmar_ticket_sent_at, issuing
 * attempt 'completed', cancellazione successiva all'emissione). La UI applica
 * la stessa regola pura delle route di emissione (lib/medmar-issuance-guard.ts);
 * il blocco vero resta comunque server-side su preflight/prepare/issue.
 *
 * Body: { service_ids: string[] } (max 500)
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { type SupabaseClient } from "@supabase/supabase-js";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { loadMedmarIssuanceEvidence } from "@/lib/server/medmar-booking/prior-issuance";

export const runtime = "nodejs";

const bodySchema = z.object({ service_ids: z.array(z.string().uuid()).max(500) });

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "service_ids obbligatorio (array di UUID, max 500)." }, { status: 400 });
  }

  try {
    const evidence = await loadMedmarIssuanceEvidence(auth.admin as SupabaseClient, auth.membership.tenant_id, parsed.data.service_ids);
    return NextResponse.json({ ok: true, evidence: Object.fromEntries(evidence) });
  } catch {
    return NextResponse.json({ ok: false, error: "Impossibile verificare lo storico Medmar." }, { status: 503 });
  }
}
