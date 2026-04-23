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
    const a = auth as any;
    const tenantId = a.membership.tenant_id as string;
    const userId   = a.user.id as string;
    const admin    = a.admin;

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

    // Aggiorna richiesta
    await admin
      .from("modification_requests")
      .update({
        status:              newStatus,
        operator_notes:      notes ?? null,
        resolved_at:         new Date().toISOString(),
        resolved_by_user_id: userId,
      })
      .eq("id", id);

    // Se approvata — applica le modifiche al servizio
    if (action === "approve") {
      const changes = mr.changes as Record<string, unknown>;
      const serviceUpdate: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(changes)) {
        serviceUpdate[k] = v;
      }
      await admin
        .from("services")
        .update(serviceUpdate)
        .eq("id", mr.service_id as string)
        .eq("tenant_id", tenantId);

      // Nessun cambio di status_events: la modifica non cambia lo stato operativo del servizio.
    }

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
