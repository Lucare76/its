/**
 * POST /api/ops/cancellation-requests/[id]/resolve
 *
 * Admin/operatore imposta la penale (o zero) e invia email all'agenzia.
 * Se nessuna agenzia collegata, chiude direttamente il servizio.
 *
 * Body:
 *   penalty_cents  number   (0 = nessuna penale)
 *   penalty_note   string?
 *   force_close    boolean? (chiude senza attendere risposta agenzia)
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { sendEmail } from "@/lib/server/send-email";
import { emailHtml } from "@/lib/server/email-layout";

export const runtime = "nodejs";

const bodySchema = z.object({
  penalty_cents: z.number().int().min(0).max(9_999_900).default(0),
  penalty_note:  z.string().max(500).optional(),
  force_close:   z.boolean().optional(),
});

function formatEur(cents: number) {
  return (cents / 100).toLocaleString("it-IT", { style: "currency", currency: "EUR" });
}

function legLabel(legs: string) {
  if (legs === "arrival") return "Solo andata";
  if (legs === "departure") return "Solo ritorno";
  return "Intero servizio";
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const auth = await authorizePricingRequest(req, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = auth as any;
    const tenantId = a.membership.tenant_id as string;
    const userId   = a.user.id as string;
    const admin    = a.admin;

    const raw = await req.json().catch(() => null);
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Body non valido." }, { status: 400 });
    }
    const { penalty_cents, penalty_note, force_close } = parsed.data;

    // Carica richiesta
    const { data: cr } = await admin
      .from("cancellation_requests")
      .select(`
        id, cancel_legs, status, approval_token,
        services(
          id, customer_name, pax, date, time,
          arrival_date, arrival_time, departure_date, departure_time,
          booking_service_kind, customer_email, phone,
          hotels(name),
          agencies(id, name, booking_email, contact_email)
        )
      `)
      .eq("id", id)
      .eq("tenant_id", tenantId)
      .maybeSingle();

    if (!cr) return NextResponse.json({ error: "Richiesta non trovata." }, { status: 404 });
    if (!["pending_review", "rejected", "pending_agency_approval"].includes(cr.status as string)) {
      return NextResponse.json({ error: "Richiesta non in stato modificabile." }, { status: 409 });
    }

    const svc = Array.isArray(cr.services) ? cr.services[0] : cr.services as Record<string, unknown>;
    const agencyRaw = svc?.agencies;
    const agency = Array.isArray(agencyRaw) ? agencyRaw[0] : agencyRaw as Record<string, string | null> | null;
    const agencyEmail = agency?.booking_email ?? agency?.contact_email ?? null;
    const hotelRaw = svc?.hotels;
    const hotelName = (Array.isArray(hotelRaw) ? hotelRaw[0]?.name : (hotelRaw as { name?: string } | null)?.name) ?? "N/D";

    const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/$/, "") ?? "";

    // ── Caso A: force_close o nessuna agenzia collegata ─────────────────────
    if (force_close || !agency?.id) {
      await applyCancellation(admin, tenantId, cr, svc, penalty_cents, userId);

      // Aggiorna richiesta → closed
      await admin
        .from("cancellation_requests")
        .update({ status: "closed", penalty_cents, penalty_note: penalty_note ?? null, resolved_at: new Date().toISOString(), resolved_by_user_id: userId })
        .eq("id", id);

      // Email al cliente privato se ha email
      const customerEmail = svc?.customer_email as string | null;
      if (customerEmail) {
        const dateFormatted = formatDate(svc?.arrival_date as string ?? svc?.date as string ?? "");
        await sendEmail({
          to: customerEmail,
          subject: `Cancellazione servizio — ${svc?.customer_name}`,
          html: emailHtml(buildCancellationEmailBody({
            recipientName: svc?.customer_name as string,
            hotelName,
            dateFormatted,
            departureDateFormatted: svc?.departure_date ? formatDate(svc.departure_date as string) : null,
            pax: svc?.pax as number,
            cancelLegs: cr.cancel_legs,
            penaltyCents: penalty_cents,
            penaltyNote: penalty_note,
            showApprovalButton: false,
          }), { title: "Cancellazione servizio" }),
        });
      }

      return NextResponse.json({ ok: true, closed: true });
    }

    // ── Caso B: agenzia collegata → invia per approvazione ──────────────────
    await admin
      .from("cancellation_requests")
      .update({
        status: "pending_agency_approval",
        penalty_cents,
        penalty_note: penalty_note ?? null,
        agency_response: null,
        agency_response_note: null,
        agency_counter_cents: null,
        agency_responded_at: null,
      })
      .eq("id", id);

    const dateFormatted = formatDate(svc?.arrival_date as string ?? svc?.date as string ?? "");
    const tokenLink = `${appUrl}/cancellazione/${cr.approval_token as string}`;

    // Email all'agenzia
    if (agencyEmail) {
      const penaltyLabel = penalty_cents > 0 ? ` — Penale ${formatEur(penalty_cents)}` : "";
      await sendEmail({
        to: agencyEmail,
        subject: `Cancellazione servizio — ${svc?.customer_name as string} — ${dateFormatted}${penaltyLabel}`,
        html: emailHtml(buildCancellationEmailBody({
          recipientName: agency?.name as string ?? "Agenzia",
          hotelName,
          dateFormatted,
          departureDateFormatted: svc?.departure_date ? formatDate(svc.departure_date as string) : null,
          pax: svc?.pax as number,
          cancelLegs: cr.cancel_legs,
          penaltyCents: penalty_cents,
          penaltyNote: penalty_note,
          showApprovalButton: true,
          approvalLink: tokenLink,
        }), { title: "Cancellazione servizio" }),
      });
    }

    // Notifica in-app all'agenzia (se ha account nel sistema)
    if (agency?.id) {
      await admin.from("notifications").insert({
        tenant_id: tenantId,
        agency_id: agency.id,
        type: "cancellation_penalty_set",
        title: penalty_cents > 0 ? `Penale cancellazione: ${formatEur(penalty_cents)}` : "Cancellazione servizio",
        body: `${svc?.customer_name as string} — ${legLabel(cr.cancel_legs)} — ${dateFormatted}`,
        link: `/cancellazione/${cr.approval_token as string}`,
        reference_id: cr.id,
      });
    }

    return NextResponse.json({ ok: true, pending_agency_approval: true, email_sent: !!agencyEmail });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Errore" }, { status: 500 });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  return (iso ?? "").split("-").reverse().join("/");
}

async function applyCancellation(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any,
  tenantId: string,
  cr: Record<string, unknown>,
  svc: Record<string, unknown>,
  penaltyCents: number,
  userId: string
) {
  const serviceId = svc?.id as string;
  const legs = cr.cancel_legs as string;

  if (legs === "both") {
    await admin.from("services").update({ status: "cancelled" }).eq("id", serviceId).eq("tenant_id", tenantId);
  } else if (legs === "arrival") {
    await admin.from("services").update({ arrival_date: null, arrival_time: null }).eq("id", serviceId).eq("tenant_id", tenantId);
    // Se rimane solo il ritorno, ripristina active
    await admin.from("services").update({ status: "new" }).eq("id", serviceId).eq("tenant_id", tenantId);
  } else {
    await admin.from("services").update({ departure_date: null, departure_time: null }).eq("id", serviceId).eq("tenant_id", tenantId);
    await admin.from("services").update({ status: "new" }).eq("id", serviceId).eq("tenant_id", tenantId);
  }

  // Status event
  const legLbl = legLabel(legs);
  const eventNotes = [
    `Tratta: ${legLbl}`,
    penaltyCents > 0 ? `Penale: ${formatEur(penaltyCents)}` : null,
  ].filter(Boolean).join(" | ");

  await admin.from("status_events").insert({
    tenant_id: tenantId,
    service_id: serviceId,
    status: legs === "both" ? "cancelled" : "new",
    by_user_id: userId,
    notes: eventNotes,
  });

  // Penale → estratto conto (aggiorna il servizio con l'importo)
  if (penaltyCents > 0) {
    await admin
      .from("services")
      .update({ agency_quoted_price_cents: penaltyCents, agency_payment_status: "unpaid" })
      .eq("id", serviceId)
      .eq("tenant_id", tenantId);
  }
}

function buildCancellationEmailBody(opts: {
  recipientName: string;
  hotelName: string;
  dateFormatted: string;
  departureDateFormatted: string | null;
  pax: number;
  cancelLegs: string;
  penaltyCents: number;
  penaltyNote?: string;
  showApprovalButton: boolean;
  approvalLink?: string;
}): string {
  const { recipientName, hotelName, dateFormatted, departureDateFormatted, pax, cancelLegs, penaltyCents, penaltyNote, showApprovalButton, approvalLink } = opts;
  const penaleEur = penaltyCents > 0 ? formatEur(penaltyCents) : null;
  const hasNoAgency = !showApprovalButton;

  const penaleRow = penaleEur
    ? `<tr>
        <td style="padding:8px 12px;background:#fef2f2;font-weight:700;color:#991b1b;width:40%;">Penale applicata</td>
        <td style="padding:8px 12px;background:#fef2f2;color:#991b1b;font-size:18px;font-weight:700;">${penaleEur}</td>
       </tr>`
    : "";

  const penaleNoteRow = penaltyNote
    ? `<tr>
        <td style="padding:8px 12px;background:#fef9c3;font-weight:600;color:#854d0e;width:40%;">Note penale</td>
        <td style="padding:8px 12px;color:#854d0e;">${penaltyNote}</td>
       </tr>`
    : "";

  const ritornoRow = departureDateFormatted
    ? `<tr><td style="padding:8px 12px;background:#f1f5f9;font-weight:600;width:40%;">Data rientro</td><td style="padding:8px 12px;">${departureDateFormatted}</td></tr>`
    : "";

  const approvalButtons = showApprovalButton && approvalLink
    ? `<div style="margin:24px 0;text-align:center;">
        <a href="${approvalLink}?action=accept" style="display:inline-block;background:#16a34a;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:700;font-size:14px;margin:0 6px;">
          ✓ Accetto
        </a>
        <a href="${approvalLink}?action=counter" style="display:inline-block;background:#d97706;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:700;font-size:14px;margin:0 6px;">
          Proponi importo diverso
        </a>
        <a href="${approvalLink}?action=reject" style="display:inline-block;background:#dc2626;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:700;font-size:14px;margin:0 6px;">
          ✗ Rifiuto
        </a>
      </div>
      <p style="color:#94a3b8;font-size:12px;text-align:center;">
        Oppure apri: <a href="${approvalLink}" style="color:#6366f1;">${approvalLink}</a>
      </p>`
    : "";

  const intro = hasNoAgency
    ? `il seguente servizio è stato cancellato.`
    : penaleEur
    ? `il seguente servizio è stato cancellato. È prevista una penale di <strong>${penaleEur}</strong> che richiede la tua approvazione.`
    : `il seguente servizio è stato cancellato. Non sono previste penali.`;

  return `
    <h2 style="color:#991b1b;margin-bottom:4px;">Cancellazione servizio</h2>
    <p style="color:#475569;margin-bottom:20px;">
      Gentile <strong>${recipientName}</strong>,<br>${intro}
    </p>
    <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
      <tr><td style="padding:8px 12px;background:#f8fafc;font-weight:600;width:40%;">Hotel</td><td style="padding:8px 12px;">${hotelName}</td></tr>
      <tr><td style="padding:8px 12px;background:#f1f5f9;font-weight:600;width:40%;">Data arrivo</td><td style="padding:8px 12px;">${dateFormatted}</td></tr>
      ${ritornoRow}
      <tr><td style="padding:8px 12px;background:#f8fafc;font-weight:600;width:40%;">Passeggeri</td><td style="padding:8px 12px;">${pax}</td></tr>
      <tr><td style="padding:8px 12px;background:#f1f5f9;font-weight:600;width:40%;">Tratta</td><td style="padding:8px 12px;">${legLabel(cancelLegs)}</td></tr>
      ${penaleRow}
      ${penaleNoteRow}
    </table>
    ${approvalButtons}
    ${penaleEur && !hasNoAgency ? `<p style="color:#991b1b;font-size:13px;border:1px solid #fca5a5;border-radius:8px;padding:12px 16px;background:#fff5f5;">
      La penale sarà addebitata sull'estratto conto solo dopo la tua approvazione.
    </p>` : ""}
  `;
}
