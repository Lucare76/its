/**
 * POST /api/agency/cancel
 * Endpoint operatore per cancellare una o entrambe le tratte di un servizio,
 * con applicazione penale opzionale e invio email all'agenzia.
 *
 * Body:
 *   service_id    string (uuid)
 *   cancel_legs   "arrival" | "departure" | "both"
 *   penalty_cents number (intero, 0 = nessuna penale)
 *   penalty_note  string (facoltativo)
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { parseRole } from "@/lib/rbac";
import { sendEmail } from "@/lib/server/send-email";

export const runtime = "nodejs";

function makeAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function authorizeOperator(request: NextRequest) {
  const admin = makeAdmin();
  if (!admin) return null;
  const auth = request.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const { data: { user } } = await admin.auth.getUser(auth.slice(7));
  if (!user) return null;
  const { data: m } = await admin
    .from("memberships")
    .select("tenant_id, role")
    .eq("user_id", user.id)
    .maybeSingle();
  const role = parseRole(m?.role);
  if (!m?.tenant_id || !role || !["admin", "operator"].includes(role)) return null;
  return { admin, tenantId: m.tenant_id, userId: user.id, role };
}

const bodySchema = z.object({
  service_id:    z.string().uuid(),
  cancel_legs:   z.enum(["arrival", "departure", "both"]),
  penalty_cents: z.number().int().min(0).max(9_999_900).default(0),
  penalty_note:  z.string().max(500).optional(),
});

export async function POST(request: NextRequest) {
  const ctx = await authorizeOperator(request);
  if (!ctx) return NextResponse.json({ error: "Non autorizzato." }, { status: 403 });

  const raw = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Body non valido." }, { status: 400 });
  }

  const { service_id, cancel_legs, penalty_cents, penalty_note } = parsed.data;

  // Carica il servizio con agenzia
  const { data: svc } = await ctx.admin
    .from("services")
    .select(`
      id, date, time, status,
      customer_name, pax, direction,
      arrival_date, arrival_time,
      departure_date, departure_time,
      booking_service_kind,
      hotel_id,
      hotels(name),
      agency_id,
      agencies(name, booking_email, contact_email)
    `)
    .eq("id", service_id)
    .eq("tenant_id", ctx.tenantId)
    .maybeSingle();

  if (!svc) return NextResponse.json({ error: "Servizio non trovato." }, { status: 404 });
  if (svc.status === "cancelled") return NextResponse.json({ ok: true, already_cancelled: true });

  // ── Aggiorna stato ──────────────────────────────────────────────────────
  // Per "arrival" o "departure" singolo: annulliamo comunque il servizio
  // ma lo annotiamo nei notes e nello status_event. In futuro si potrà
  // estendere con colonne separate per leg.
  await ctx.admin
    .from("services")
    .update({ status: "cancelled" })
    .eq("id", service_id)
    .eq("tenant_id", ctx.tenantId);

  // ── Status event ────────────────────────────────────────────────────────
  const legLabel =
    cancel_legs === "arrival" ? "andata" :
    cancel_legs === "departure" ? "ritorno" : "andata+ritorno";

  const eventNotes = [
    `Tratta: ${legLabel}`,
    penalty_cents > 0 ? `Penale: €${(penalty_cents / 100).toFixed(2).replace(".", ",")}` : null,
    penalty_note ? `Note: ${penalty_note}` : null,
  ].filter(Boolean).join(" | ");

  await ctx.admin.from("status_events").insert({
    tenant_id: ctx.tenantId,
    service_id,
    status: "cancelled",
    by_user_id: ctx.userId,
    ...(eventNotes ? { notes: eventNotes } : {}),
  });

  // ── Email agenzia ────────────────────────────────────────────────────────
  // Invia sempre quando: cancellazione totale (both) OPPURE penale > 0
  const shouldSendEmail = cancel_legs === "both" || penalty_cents > 0;

  if (shouldSendEmail) {
    const agencyRaw = svc.agencies;
    const agency = Array.isArray(agencyRaw) ? agencyRaw[0] : agencyRaw as { name?: string; booking_email?: string | null; contact_email?: string | null } | null;
    const agencyEmail = agency?.booking_email ?? agency?.contact_email ?? null;

    if (agencyEmail) {
      const hotelName = (() => {
        const h = svc.hotels;
        return (Array.isArray(h) ? h[0]?.name : (h as { name?: string } | null)?.name) ?? "N/D";
      })();
      const agencyName = agency?.name ?? "Agenzia";
      const dateFormatted = (svc.arrival_date ?? svc.date ?? "").split("-").reverse().join("/");
      const departureDateFormatted = svc.departure_date ? svc.departure_date.split("-").reverse().join("/") : null;
      const penaleEur = (penalty_cents / 100).toLocaleString("it-IT", { style: "currency", currency: "EUR" });

      const subjectSuffix = penalty_cents > 0 ? ` — Penale ${penaleEur}` : "";
      const subject = `Cancellazione servizio — ${svc.customer_name} — ${dateFormatted}${subjectSuffix}`;

      const penaleRow = penalty_cents > 0
        ? `<tr>
            <td style="padding:8px 12px;background:#fef2f2;font-weight:700;color:#991b1b;width:40%;">Penale applicata</td>
            <td style="padding:8px 12px;background:#fef2f2;color:#991b1b;font-size:18px;font-weight:700;">${penaleEur}</td>
           </tr>`
        : "";

      const penaleNoteRow = penalty_note
        ? `<tr>
            <td style="padding:8px 12px;background:#fef9c3;font-weight:600;color:#854d0e;">Note penale</td>
            <td style="padding:8px 12px;color:#854d0e;">${penalty_note}</td>
           </tr>`
        : "";

      const legRow = cancel_legs !== "both"
        ? `<tr>
            <td style="padding:8px 12px;background:#fef2f2;font-weight:600;color:#991b1b;">Tratta cancellata</td>
            <td style="padding:8px 12px;color:#991b1b;">${cancel_legs === "arrival" ? "Solo andata" : "Solo ritorno"}</td>
           </tr>`
        : "";

      await sendEmail({
        to: agencyEmail,
        subject,
        html: `<div style="font-family:sans-serif;max-width:580px;margin:0 auto;padding:24px;">
          <h2 style="color:#991b1b;margin-bottom:6px;">Cancellazione servizio</h2>
          <p style="color:#475569;margin-bottom:20px;">
            Gentile <strong>${agencyName}</strong>,<br>
            il seguente servizio è stato cancellato dal nostro operatore.
          </p>
          <table style="width:100%;border-collapse:collapse;margin:0 0 20px;">
            <tr><td style="padding:8px 12px;background:#f8fafc;font-weight:600;width:40%;">Cliente</td><td style="padding:8px 12px;">${svc.customer_name}</td></tr>
            <tr><td style="padding:8px 12px;background:#f1f5f9;font-weight:600;">Hotel</td><td style="padding:8px 12px;">${hotelName}</td></tr>
            <tr><td style="padding:8px 12px;background:#f8fafc;font-weight:600;">Data arrivo</td><td style="padding:8px 12px;">${dateFormatted}${svc.arrival_time ? ` alle ${svc.arrival_time.slice(0, 5)}` : ""}</td></tr>
            ${departureDateFormatted ? `<tr><td style="padding:8px 12px;background:#f1f5f9;font-weight:600;">Data rientro</td><td style="padding:8px 12px;">${departureDateFormatted}${svc.departure_time ? ` alle ${svc.departure_time.slice(0, 5)}` : ""}</td></tr>` : ""}
            <tr><td style="padding:8px 12px;background:#f8fafc;font-weight:600;">Passeggeri</td><td style="padding:8px 12px;">${svc.pax}</td></tr>
            ${legRow}
            ${penaleRow}
            ${penaleNoteRow}
          </table>
          ${penalty_cents > 0 ? `<p style="color:#991b1b;font-size:14px;font-weight:600;border:1px solid #fca5a5;border-radius:8px;padding:12px 16px;background:#fff5f5;">
            La penale di <strong>${penaleEur}</strong> sarà addebitata sull'estratto conto del corrente mese.
          </p>` : ""}
          <p style="color:#94a3b8;font-size:12px;margin-top:24px;">
            Per chiarimenti contattare l'operatore. — Ischia Transfer Service
          </p>
        </div>`,
      });
    }
  }

  return NextResponse.json({ ok: true, cancelled: true, email_sent: shouldSendEmail });
}
