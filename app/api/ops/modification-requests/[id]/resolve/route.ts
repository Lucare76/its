/**
 * POST /api/ops/modification-requests/[id]/resolve
 *
 * Admin/operator approva o rifiuta una richiesta di modifica.
 * body: { action: "approve" | "reject", notes?: string }
 *
 * Se approvata, i campi in changes vengono applicati al servizio.
 * In entrambi i casi, l'agenzia riceve una notifica in-app.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { sendEmail } from "@/lib/server/send-email";
import { emailHtml } from "@/lib/server/email-layout";
import { getOperatorName } from "@/lib/server/service-audit-log";
import { recordServiceAuditEvent, SERVICE_AUDIT_EVENT_TYPES, SERVICE_AUDIT_SOURCES } from "@/lib/server/service-audit-events";

export const runtime = "nodejs";

const schema = z.object({
  action: z.enum(["approve", "reject"]),
  notes:  z.string().optional(),
});

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

    const raw    = await req.json().catch(() => null);
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Body non valido." }, { status: 400 });
    }
    const { action, notes } = parsed.data;

    // Carica richiesta
    const { data: mr } = await admin
      .from("modification_requests")
      .select("id, status, service_id, changes, requested_by_user_id, services(customer_name, agency_id, agencies(booking_email, contact_email, name))")
      .eq("id", id)
      .eq("tenant_id", tenantId)
      .maybeSingle();

    if (!mr) return NextResponse.json({ error: "Richiesta non trovata." }, { status: 404 });
    if (mr.status !== "pending") {
      return NextResponse.json({ error: "Richiesta già risolta." }, { status: 409 });
    }

    const newStatus = action === "approve" ? "approved" : "rejected";

    // Fix P1 (audit pre-go-live): se approvata, applica PRIMA le modifiche al
    // servizio e verifica l'esito. La richiesta non deve mai passare a
    // "approved" se l'update del servizio fallisce — evita lo stato
    // incoerente modification_request.approved + services update fallito.
    if (action === "approve") {
      const changes = mr.changes as Record<string, unknown>;
      const serviceUpdate: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(changes)) {
        serviceUpdate[k] = v;
      }
      const { error: serviceError } = await admin
        .from("services")
        .update(serviceUpdate)
        .eq("id", mr.service_id as string)
        .eq("tenant_id", tenantId);

      if (serviceError) {
        return NextResponse.json(
          { error: "Impossibile applicare le modifiche al servizio: " + serviceError.message },
          { status: 500 }
        );
      }
      // Nessun cambio di status_events: la modifica non cambia lo stato operativo del servizio.
    }

    // Aggiorna richiesta — solo ora che, per approve, il service update è
    // riuscito. Se anche questo update fallisce, non proseguiamo con
    // audit/notifiche/email di un'approvazione che non risulta persistita.
    const { error: mrError } = await admin
      .from("modification_requests")
      .update({
        status:              newStatus,
        operator_notes:      notes ?? null,
        resolved_at:         new Date().toISOString(),
        resolved_by_user_id: userId,
      })
      .eq("id", id);

    if (mrError) {
      return NextResponse.json(
        { error: "Impossibile registrare l'esito della richiesta: " + mrError.message },
        { status: 500 }
      );
    }

    // Gap E (Timeline per-servizio) — approvazione/rifiuto agenzia non aveva
    // alcuna traccia strutturata con esito dedicato (solo auditLog generico,
    // verificato in audit): qui l'esito approved/rejected e le modifiche
    // (mr.changes, già un diff controllato di campi — non un payload grezzo)
    // sono persistiti esplicitamente. Best-effort, non blocca la risposta.
    void getOperatorName(auth).then((operatorName) =>
      recordServiceAuditEvent(admin, {
        tenantId,
        serviceId: mr.service_id as string,
        eventType: action === "approve" ? SERVICE_AUDIT_EVENT_TYPES.AGENCY_APPROVED : SERVICE_AUDIT_EVENT_TYPES.AGENCY_REJECTED,
        source: SERVICE_AUDIT_SOURCES.AGENCY_PORTAL,
        actorUserId: userId,
        actorName: operatorName,
        actorEmail: user.email ?? null,
        reason: notes ?? null,
        newData: action === "approve" ? (mr.changes as Record<string, unknown>) : null,
        metadata: { modification_request_id: id, requested_by_user_id: mr.requested_by_user_id ?? null },
      })
    );

    // Notifica in-app all'agenzia (chi ha fatto la richiesta)
    const svc = Array.isArray(mr.services) ? mr.services[0] : mr.services as Record<string, unknown> | null;
    const customerName = (svc?.customer_name as string) ?? "il cliente";
    const agencyRaw    = svc ? (Array.isArray(svc.agencies) ? svc.agencies[0] : svc.agencies) : null;
    const agencyData   = agencyRaw as { booking_email?: string; contact_email?: string; name?: string } | null;

    if (mr.requested_by_user_id) {
      await admin.from("notifications").insert({
        tenant_id:    tenantId,
        user_id:      mr.requested_by_user_id as string,
        type:         action === "approve" ? "modification_approved" : "modification_rejected",
        title:        action === "approve" ? "Modifica approvata" : "Modifica rifiutata",
        body:         action === "approve"
          ? `La modifica per ${customerName} è stata approvata.`
          : `La modifica per ${customerName} è stata rifiutata.${notes ? ` Note: ${notes}` : ""}`,
        link:         `/agency/bookings`,
        reference_id: id,
      });
    }

    // Email all'agenzia
    const agencyEmail = agencyData?.booking_email ?? agencyData?.contact_email;
    if (agencyEmail) {
      const appUrl     = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/$/, "") ?? "";
      const isApproved = action === "approve";
      await sendEmail({
        to: [agencyEmail],
        subject: `Modifica ${isApproved ? "approvata" : "rifiutata"} — ${customerName}`,
        html: emailHtml(`
          <h2 style="color:#0f172a;margin-bottom:4px;">
            Modifica prenotazione ${isApproved ? "approvata ✅" : "rifiutata ❌"}
          </h2>
          <p style="color:#475569;margin-bottom:16px;">
            La tua richiesta di modifica per <strong>${customerName}</strong> è stata
            <strong>${isApproved ? "approvata" : "rifiutata"}</strong>.
          </p>
          ${notes ? `<p style="color:#475569;background:#f1f5f9;padding:12px;border-radius:8px;margin-bottom:16px;"><strong>Note operatore:</strong> ${notes}</p>` : ""}
          <a href="${appUrl}/agency/bookings" style="display:inline-block;background:#1e293b;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;font-size:14px;">
            Vai alle prenotazioni →
          </a>
        `, { title: `Modifica ${isApproved ? "approvata" : "rifiutata"}` }),
      });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Errore" }, { status: 500 });
  }
}
