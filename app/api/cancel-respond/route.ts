/**
 * POST /api/cancel-respond
 *
 * Risposta dell'agenzia alla richiesta di cancellazione tramite token email.
 * Endpoint PUBBLICO — non richiede login.
 *
 * Body:
 *   token          string (uuid)
 *   action         "accept" | "reject" | "counter"
 *   counter_cents  number?   (solo se action=counter)
 *   note           string?
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { type SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/server/whatsapp";
import { sendEmail } from "@/lib/server/send-email";
import { emailHtml } from "@/lib/server/email-layout";
import { escapeHtml } from "@/lib/server/escape-html";

export const runtime = "nodejs";

const bodySchema = z.object({
  token:         z.string().uuid(),
  action:        z.enum(["accept", "reject", "counter"]),
  counter_cents: z.number().int().min(0).max(9_999_900).optional(),
  note:          z.string().max(500).optional(),
});

function formatEur(cents: number) {
  return (cents / 100).toLocaleString("it-IT", { style: "currency", currency: "EUR" });
}

function formatDate(iso: string): string {
  return (iso ?? "").split("-").reverse().join("/");
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

    // Carica richiesta tramite token
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
      return NextResponse.json({ error: "Questa richiesta non è più in attesa di risposta." }, { status: 409 });
    }

    const svc = Array.isArray(cr.services) ? cr.services[0] : cr.services as Record<string, unknown>;
    const agencyRaw = svc?.agencies;
    const agency = Array.isArray(agencyRaw) ? agencyRaw[0] : agencyRaw as Record<string, string | null> | null;
    const hotelRaw = svc?.hotels;
    const hotelName = (Array.isArray(hotelRaw) ? hotelRaw[0]?.name : (hotelRaw as { name?: string } | null)?.name) ?? "N/D";
    const tenantId = cr.tenant_id as string;
    const penaltyCents = cr.penalty_cents as number ?? 0;

    // ── Aggiorna richiesta ────────────────────────────────────────────────────
    // accept → approved, reject/counter → rimane pending_agency_approval per gestione operatore
    const newStatus = action === "accept" ? "approved" : "pending_agency_approval";

    await admin
      .from("cancellation_requests")
      .update({
        status: newStatus,
        agency_response: action,
        agency_response_note: note ?? null,
        agency_counter_cents: action === "counter" ? (counter_cents ?? null) : null,
        agency_responded_at: new Date().toISOString(),
      })
      .eq("id", cr.id);

    const dateFormatted = formatDate(svc?.arrival_date as string ?? svc?.date as string ?? "");
    const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/$/, "") ?? "";

    // ── Se accetta → applica cancellazione subito ─────────────────────────────
    if (action === "accept") {
      await applyFinalCancellation(admin, tenantId, cr, svc, penaltyCents);

      await admin
        .from("cancellation_requests")
        .update({ resolved_at: new Date().toISOString() })
        .eq("id", cr.id);
    }

    // ── Notifica in-app + email ad admin/operator ─────────────────────────────
    const actionLabel = action === "accept" ? "accettata" : action === "reject" ? "rifiutata" : "controproposta ricevuta";
    const notifTitle = action === "accept"
      ? "Cancellazione approvata"
      : action === "reject"
      ? "Penale rifiutata"
      : "Controproposta penale";
    const notifBody = `${svc?.customer_name as string} — ${hotelName} — ${dateFormatted}`;

    // Notifiche in-app agli admin/operator
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
        link: `/cancellazioni`,
        reference_id: cr.id,
      }));
      await admin.from("notifications").insert(notifications);

      // Email agli admin/operator
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
          subject: `${notifTitle} — ${escapeHtml(svc?.customer_name)}`,
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
              Gestisci richiesta →
            </a>
          `, { title: notifTitle }),
        });
      }
    }

    return NextResponse.json({ ok: true, action, status: newStatus });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Errore" }, { status: 500 });
  }
}

// ── Applica cancellazione finale ──────────────────────────────────────────────
async function applyFinalCancellation(
  admin: SupabaseClient,
  tenantId: string,
  cr: Record<string, unknown>,
  svc: Record<string, unknown>,
  penaltyCents: number
) {
  const serviceId = svc?.id as string;
  const legs = cr.cancel_legs as string;

  if (legs === "both") {
    await admin.from("services").update({ status: "cancelled" }).eq("id", serviceId).eq("tenant_id", tenantId);
  } else if (legs === "arrival") {
    await admin.from("services")
      .update({ arrival_date: null, arrival_time: null, status: "new" })
      .eq("id", serviceId).eq("tenant_id", tenantId);
  } else {
    await admin.from("services")
      .update({ departure_date: null, departure_time: null, status: "new" })
      .eq("id", serviceId).eq("tenant_id", tenantId);
  }

  await admin.from("status_events").insert({
    tenant_id: tenantId,
    service_id: serviceId,
    status: legs === "both" ? "cancelled" : "new",
    notes: `Cancellazione approvata dall'agenzia${penaltyCents > 0 ? ` — Penale: ${formatEur(penaltyCents)}` : ""}`,
  });

  if (penaltyCents > 0) {
    await admin.from("services")
      .update({ agency_quoted_price_cents: penaltyCents, agency_payment_status: "unpaid" })
      .eq("id", serviceId).eq("tenant_id", tenantId);
  }
}
