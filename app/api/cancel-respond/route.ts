/**
 * POST /api/cancel-respond
 *
 * Risposta dell'agenzia alla richiesta di cancellazione tramite token email.
 * Endpoint pubblico: non richiede login.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/server/whatsapp";
import { sendEmail } from "@/lib/server/send-email";
import { emailHtml } from "@/lib/server/email-layout";
import { escapeHtml } from "@/lib/server/escape-html";
import { notifyDriverServiceCancelled } from "@/lib/server/driver-cancellation-whatsapp";
import { auditLog } from "@/lib/server/ops-audit";

export const runtime = "nodejs";

const bodySchema = z.object({
  token: z.string().uuid(),
  action: z.enum(["accept", "reject", "counter"]),
  counter_cents: z.number().int().min(0).max(9_999_900).optional(),
  note: z.string().max(500).optional(),
});

function formatEur(cents: number) {
  return (cents / 100).toLocaleString("it-IT", { style: "currency", currency: "EUR" });
}

function formatDate(iso: string): string {
  return (iso ?? "").split("-").reverse().join("/");
}

function toAgencyResponse(action: "accept" | "reject" | "counter"): "accepted" | "rejected" | "counter" {
  if (action === "accept") return "accepted";
  if (action === "reject") return "rejected";
  return "counter";
}

export async function POST(req: NextRequest) {
  try {
    const admin = createAdminClient();

    const raw = await req.json().catch(() => null);
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Body non valido." }, { status: 400 });
    }
    const { token, action, counter_cents, note } = parsed.data;

    const { data: cr } = await admin
      .from("cancellation_requests")
      .select(`
        id, tenant_id, cancel_legs, status, penalty_cents, penalty_note, approval_token,
        services(
          id, customer_name, pax, date, time,
          arrival_date, arrival_time, departure_date, departure_time,
          hotels(name),
          agencies(name, booking_email, contact_email)
        )
      `)
      .eq("approval_token", token)
      .maybeSingle();

    if (!cr) return NextResponse.json({ error: "Richiesta non trovata o link non valido." }, { status: 404 });
    if (cr.status !== "pending_agency_approval") {
      return NextResponse.json({ error: "Questa richiesta non e piu in attesa di risposta." }, { status: 409 });
    }

    const svc = Array.isArray(cr.services) ? cr.services[0] : cr.services as Record<string, unknown>;
    const agencyRaw = svc?.agencies;
    const agency = Array.isArray(agencyRaw) ? agencyRaw[0] : agencyRaw as Record<string, string | null> | null;
    const hotelRaw = svc?.hotels;
    const hotelName = (Array.isArray(hotelRaw) ? hotelRaw[0]?.name : (hotelRaw as { name?: string } | null)?.name) ?? "N/D";
    const tenantId = cr.tenant_id as string;
    const penaltyCents = cr.penalty_cents as number ?? 0;
    const newStatus = action === "accept" ? "approved" : "pending_agency_approval";
    const agencyResponse = toAgencyResponse(action);

    if (action === "accept") {
      const { data: assignmentBeforeCancellation } = await admin
        .from("assignments")
        .select("driver_user_id")
        .eq("tenant_id", tenantId)
        .eq("service_id", svc.id as string)
        .maybeSingle();

      const { error: finalizeError } = await admin.rpc("finalize_cancellation_request", {
        p_request_id: cr.id,
        p_tenant_id: tenantId,
        p_user_id: null,
        p_status: "approved",
        p_agency_response: agencyResponse,
        p_agency_response_note: note ?? null,
        p_agency_counter_cents: null,
        p_penalty_cents: penaltyCents,
        p_penalty_note: cr.penalty_note ?? null,
      });

      if (finalizeError) {
        auditLog({
          event: "cancel_respond_finalize_failed",
          level: "error",
          tenantId,
          serviceId: svc?.id as string | null,
          details: { requestId: cr.id, message: finalizeError.message },
        });
        return NextResponse.json({ error: "Impossibile completare la richiesta di cancellazione." }, { status: 500 });
      }

      void notifyDriverServiceCancelled({
        admin,
        tenantId,
        service: {
          id: svc.id as string,
          customer_name: svc.customer_name as string | null,
          date: (svc.arrival_date as string | null) ?? (svc.date as string | null),
          time: (svc.arrival_time as string | null) ?? (svc.time as string | null),
        },
        driverUserId: assignmentBeforeCancellation?.driver_user_id as string | null | undefined,
        requestedByUserId: null,
      });
    } else {
      const { error: updateError } = await admin
        .from("cancellation_requests")
        .update({
          status: newStatus,
          agency_response: agencyResponse,
          agency_response_note: note ?? null,
          agency_counter_cents: action === "counter" ? (counter_cents ?? null) : null,
          agency_responded_at: new Date().toISOString(),
        })
        .eq("id", cr.id);

      if (updateError) {
        auditLog({
          event: "cancel_respond_update_failed",
          level: "error",
          tenantId,
          serviceId: svc?.id as string | null,
          details: { requestId: cr.id, action, message: updateError.message },
        });
        return NextResponse.json({ error: "Impossibile completare la risposta alla richiesta di cancellazione." }, { status: 500 });
      }
    }

    const dateFormatted = formatDate(svc?.arrival_date as string ?? svc?.date as string ?? "");
    const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/$/, "") ?? "";
    const actionLabel = action === "accept" ? "accettata" : action === "reject" ? "rifiutata" : "controproposta ricevuta";
    const notifTitle = action === "accept"
      ? "Cancellazione approvata"
      : action === "reject"
      ? "Penale rifiutata"
      : "Controproposta penale";
    const notifBody = `${svc?.customer_name as string} - ${hotelName} - ${dateFormatted}`;

    const { data: opsMembers } = await admin
      .from("memberships")
      .select("user_id")
      .eq("tenant_id", tenantId)
      .in("role", ["admin", "operator"]);

    if (opsMembers?.length) {
      const notifications = (opsMembers as { user_id: string }[]).map((m) => ({
        tenant_id: tenantId,
        user_id: m.user_id,
        type: `cancellation_${action}`,
        title: notifTitle,
        body: notifBody,
        link: "/cancellazioni",
        reference_id: cr.id,
      }));
      await admin.from("notifications").insert(notifications);

      const userIds = opsMembers.map((m: { user_id: string }) => m.user_id);
      const { data: { users } } = await admin.auth.admin.listUsers();
      const opsEmails = (users ?? [])
        .filter((u: { id: string }) => userIds.includes(u.id))
        .map((u: { email?: string }) => u.email)
        .filter(Boolean) as string[];

      if (opsEmails.length) {
        const counterNote = action === "counter" && counter_cents !== undefined
          ? `<p style="color:#d97706;font-weight:600;">Controproposta: <strong>${formatEur(counter_cents)}</strong></p>`
          : "";
        const noteHtml = note ? `<p style="color:#475569;font-size:13px;"><em>"${escapeHtml(note)}"</em></p>` : "";

        await sendEmail({
          to: opsEmails,
          subject: `${notifTitle} - ${escapeHtml(svc?.customer_name)}`,
          html: emailHtml(`
            <h2 style="color:#0f172a;margin-bottom:4px;">${notifTitle}</h2>
            <p style="color:#475569;margin-bottom:16px;">
              ${escapeHtml(agency?.name ?? "L'agenzia")} ha <strong>${actionLabel}</strong> la richiesta di cancellazione.
            </p>
            <table style="width:100%;border-collapse:collapse;margin-bottom:16px;">
              <tr><td style="padding:8px 12px;background:#f8fafc;font-weight:600;width:40%;">Cliente</td><td style="padding:8px 12px;">${escapeHtml(svc?.customer_name)}</td></tr>
              <tr><td style="padding:8px 12px;background:#f1f5f9;font-weight:600;">Hotel</td><td style="padding:8px 12px;">${escapeHtml(hotelName)}</td></tr>
              <tr><td style="padding:8px 12px;background:#f8fafc;font-weight:600;">Data</td><td style="padding:8px 12px;">${escapeHtml(dateFormatted)}</td></tr>
              ${penaltyCents > 0 ? `<tr><td style="padding:8px 12px;background:#fef2f2;font-weight:600;color:#991b1b;">Penale richiesta</td><td style="padding:8px 12px;color:#991b1b;font-weight:700;">${formatEur(penaltyCents)}</td></tr>` : ""}
            </table>
            ${counterNote}
            ${noteHtml}
            <a href="${appUrl}/cancellazioni" style="display:inline-block;background:#1e293b;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;font-size:14px;">
              Gestisci richiesta
            </a>
          `, { title: notifTitle }),
        });
      }
    }

    return NextResponse.json({ ok: true, action, status: newStatus });
  } catch (err) {
    auditLog({
      event: "cancel_respond_unhandled_error",
      level: "error",
      details: { message: err instanceof Error ? err.message : String(err) },
    });
    return NextResponse.json({ ok: false, error: "Si è verificato un errore durante l'elaborazione della richiesta." }, { status: 500 });
  }
}
