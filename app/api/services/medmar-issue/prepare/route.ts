/**
 * POST /api/services/medmar-issue/prepare
 *
 * Step 1 del gate di conferma server-side per l'emissione Medmar One Click
 * (Fase 2B.3). SOLO lettura verso Medmar (preflight) + validazioni
 * puramente locali (dati cliente). NON apre turni, NON blocca posti, NON
 * crea prenotazioni, NON effettua pagamenti. Restituisce un
 * confirmation_token single-use, breve scadenza, che
 * POST /api/services/medmar-issue richiede per procedere.
 *
 * Body: { service_ids: string[] }
 */

import { NextRequest, NextResponse } from "next/server";
import { type SupabaseClient } from "@supabase/supabase-js";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { auditLog } from "@/lib/server/ops-audit";
import { preflightInputSchema } from "@/lib/server/medmar-booking/validation";
import { runMedmarPreflight } from "@/lib/server/medmar-booking/preflight";
import { buildIssueCustomer, MedmarIssuePayloadError } from "@/lib/server/medmar-booking/issue-payload";
import { createIssueRepository } from "@/lib/server/medmar-booking/issue-repository";
import { createConfirmationToken } from "@/lib/server/medmar-booking/issue-confirmation";
import { getMedmarIssueConfig } from "@/lib/server/medmar-booking/issue-config";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  const admin = auth.admin as SupabaseClient;
  const tenantId = auth.membership.tenant_id;

  const parsed = preflightInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "service_ids obbligatorio (array di UUID, max 20)." }, { status: 400 });
  }

  try {
    const preflight = await runMedmarPreflight(admin, tenantId, parsed.data.service_ids);
    if (!preflight.ok || !preflight.can_issue || !preflight.is_live) {
      auditLog({
        event: "medmar_issue_prepare",
        level: "warn",
        tenantId,
        userId: auth.user.id,
        role: auth.membership.role,
        outcome: preflight.status,
        details: { service_count: parsed.data.service_ids.length },
      });
      return NextResponse.json({ ok: false, status: preflight.status, error: "Preflight Medmar non valido." }, { status: 422 });
    }

    if (preflight.expected_total_cents == null) {
      return NextResponse.json({ ok: false, status: "manual_review", error: "Prezzo atteso Medmar non disponibile." }, { status: 422 });
    }

    const repo = createIssueRepository(admin);
    const services = await repo.loadServices(tenantId, parsed.data.service_ids);
    if (services.length !== parsed.data.service_ids.length) {
      return NextResponse.json({ ok: false, status: "manual_review", error: "Servizi non trovati nel tenant corrente." }, { status: 422 });
    }
    try {
      buildIssueCustomer(services);
    } catch (err) {
      const message = err instanceof MedmarIssuePayloadError ? err.message : "Dati cliente incompleti.";
      return NextResponse.json({ ok: false, status: "manual_review", error: message }, { status: 422 });
    }

    const { confirmation_token, expires_at } = await createConfirmationToken(admin, {
      tenantId,
      serviceIds: parsed.data.service_ids,
      expectedTotalCents: preflight.expected_total_cents,
      routeSnapshot: {
        outward_id_corsa: preflight.outward?.id_corsa ?? null,
        return_id_corsa: preflight.return?.id_corsa ?? null,
      },
      createdBy: auth.user.id,
    });

    auditLog({
      event: "medmar_issue_prepare",
      level: "info",
      tenantId,
      userId: auth.user.id,
      role: auth.membership.role,
      outcome: "confirmation_issued",
      details: { service_count: parsed.data.service_ids.length },
    });

    return NextResponse.json({
      ok: true,
      confirmation_token,
      expires_at,
      expected_total_cents: preflight.expected_total_cents,
      route: { outward: preflight.outward, return: preflight.return },
      pax: preflight.pax,
      service_ids: [...parsed.data.service_ids].sort(),
      // Capability derivata server-side, MAI il valore raw di
      // process.env.MEDMAR_ISSUING_ENABLED: la UI la usa per sapere se la
      // CTA finale potrebbe mai essere abilitata, senza dover indovinare.
      issuing_enabled: getMedmarIssueConfig().enabled,
    });
  } catch {
    auditLog({
      event: "medmar_issue_prepare_error",
      level: "error",
      tenantId,
      userId: auth.user.id,
      role: auth.membership.role,
    });
    return NextResponse.json({ ok: false, error: "Errore interno durante la preparazione dell'emissione Medmar." }, { status: 500 });
  }
}
