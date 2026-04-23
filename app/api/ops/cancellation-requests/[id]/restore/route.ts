/**
 * POST /api/ops/cancellation-requests/[id]/restore
 *
 * Annulla la richiesta di cancellazione e ripristina il servizio
 * allo stato "new" (o "assigned" se aveva un'assegnazione).
 */

import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const auth = await authorizePricingRequest(req, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;
    const a = auth as any;
    const tenantId = a.membership.tenant_id as string;
    const userId   = a.user.id as string;
    const admin    = a.admin;

    const { data: cr } = await admin
      .from("cancellation_requests")
      .select("id, status, services(id)")
      .eq("id", id)
      .eq("tenant_id", tenantId)
      .maybeSingle();

    if (!cr) return NextResponse.json({ error: "Richiesta non trovata." }, { status: 404 });
    if (!["pending_review", "pending_agency_approval"].includes(cr.status as string)) {
      return NextResponse.json({ error: "Solo richieste pendenti possono essere ripristinate." }, { status: 409 });
    }

    const svc = Array.isArray(cr.services) ? cr.services[0] : cr.services as { id: string } | null;
    const serviceId = svc?.id as string | undefined;

    // Chiudi la richiesta di cancellazione
    await admin
      .from("cancellation_requests")
      .update({ status: "closed", resolved_at: new Date().toISOString(), resolved_by_user_id: userId })
      .eq("id", id);

    // Ripristina il servizio: controlla se ha un'assegnazione attiva
    if (serviceId) {
      const { data: assignment } = await admin
        .from("assignments")
        .select("id")
        .eq("service_id", serviceId)
        .not("driver_user_id", "is", null)
        .maybeSingle();

      const restoredStatus = assignment ? "assigned" : "new";

      await admin
        .from("services")
        .update({ status: restoredStatus })
        .eq("id", serviceId)
        .eq("tenant_id", tenantId);

      await admin.from("status_events").insert({
        tenant_id: tenantId,
        service_id: serviceId,
        status: restoredStatus,
        by_user_id: userId,
        notes: "Richiesta di cancellazione annullata — servizio ripristinato",
      });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Errore" }, { status: 500 });
  }
}
