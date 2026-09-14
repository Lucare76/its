/**
 * POST /api/ops/cancellation-requests/[id]/restore
 *
 * Annulla la richiesta di cancellazione e ripristina il servizio
 * allo stato "new" (o "assigned" se aveva un'assegnazione).
 */

import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { getOperatorName } from "@/lib/server/service-audit-log";
import { recordServiceAuditEvent, SERVICE_AUDIT_EVENT_TYPES, SERVICE_AUDIT_SOURCES } from "@/lib/server/service-audit-events";

export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const auth = await authorizePricingRequest(req, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;
    const { admin, membership, user } = auth;
    const tenantId = membership.tenant_id;
    const userId   = user.id;

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

      // Gap A (Timeline per-servizio) — il restore non era tracciato da
      // nessuna fonte esistente (verificato in audit): service_change_logs
      // vede solo l'update di status_events sopra, che confonde un restore
      // con un normale cambio di stato. Best-effort, non blocca la risposta.
      void getOperatorName(auth).then((operatorName) =>
        recordServiceAuditEvent(admin, {
          tenantId,
          serviceId,
          eventType: SERVICE_AUDIT_EVENT_TYPES.SERVICE_RESTORED,
          source: SERVICE_AUDIT_SOURCES.MANUAL,
          actorUserId: userId,
          actorName: operatorName,
          actorEmail: user.email ?? null,
          reason: "Richiesta di cancellazione annullata",
          oldData: { cancellation_request_id: id },
          newData: { status: restoredStatus },
        })
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Errore" }, { status: 500 });
  }
}
