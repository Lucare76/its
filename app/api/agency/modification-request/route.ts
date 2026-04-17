/**
 * POST /api/agency/modification-request
 *
 * L'agenzia crea una richiesta di modifica di un servizio.
 * L'operatore/admin riceverà una notifica e potrà approvare o rifiutare.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizeServiceRoleRequest } from "@/lib/server/pricing-auth";
import { sendEmail } from "@/lib/server/send-email";
import { emailHtml } from "@/lib/server/email-layout";

export const runtime = "nodejs";

const schema = z.object({
  service_id: z.string().uuid(),
  changes: z.object({
    arrival_date:        z.string().optional(),
    arrival_time:        z.string().optional(),
    departure_date:      z.string().optional(),
    departure_time:      z.string().optional(),
    pax:                 z.number().int().min(1).max(100).optional(),
    hotel_id:            z.string().uuid().optional(),
    booking_service_kind: z.string().optional(),
    phone:               z.string().optional(),
    notes:               z.string().optional(),
  }).refine((c) => Object.keys(c).length > 0, { message: "Nessuna modifica specificata." }),
});

export async function POST(req: NextRequest) {
  try {
    const auth = await authorizeServiceRoleRequest(req, {
      roles: ["agency", "admin"],
      membershipFields: ["agency_id"],
      auditPrefix: "agency_modification_request",
    });
    if (auth instanceof NextResponse) return auth;

    const tenantId = auth.membership.tenant_id;
    const userId   = auth.user.id;
    const admin    = auth.admin;

    const raw    = await req.json().catch(() => null);
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Body non valido." }, { status: 400 });
    }
    const { service_id, changes } = parsed.data;

    // Verifica servizio e appartenenza al tenant
    const { data: svc } = await admin
      .from("services")
      .select("id, status, customer_name, pax, arrival_date, arrival_time, departure_date, departure_time, hotel_id, booking_service_kind, notes, tenant_id")
      .eq("id", service_id)
      .eq("tenant_id", tenantId)
      .maybeSingle();

    if (!svc) return NextResponse.json({ error: "Servizio non trovato." }, { status: 404 });
    if (svc.status === "cancelled") return NextResponse.json({ error: "Servizio già cancellato." }, { status: 409 });

    // Controlla se c'è già una richiesta pendente per questo servizio
    const { data: existing } = await admin
      .from("modification_requests")
      .select("id")
      .eq("service_id", service_id)
      .eq("status", "pending")
      .maybeSingle();

    if (existing) {
      return NextResponse.json({ error: "Esiste già una richiesta di modifica in attesa per questo servizio." }, { status: 409 });
    }

    // Valori originali
    const originalValues: Record<string, unknown> = {};
    for (const key of Object.keys(changes) as Array<keyof typeof changes>) {
      originalValues[key] = (svc as Record<string, unknown>)[key] ?? null;
    }

    // Recupera nome hotel se richiesto
    let hotelName: string | null = null;
    if (changes.hotel_id) {
      const { data: hotel } = await admin.from("hotels").select("name").eq("id", changes.hotel_id).maybeSingle();
      hotelName = hotel?.name ?? null;
    }

    // Inserisci richiesta
    const { data: mr, error: insertErr } = await admin
      .from("modification_requests")
      .insert({
        tenant_id:            tenantId,
        service_id,
        requested_by_user_id: userId,
        changes,
        original_values:      originalValues,
      })
      .select("id")
      .single();

    if (insertErr || !mr) throw new Error(insertErr?.message ?? "Inserimento fallito.");

    // Notifica in-app agli admin/operator
    const { data: members } = await admin
      .from("memberships")
      .select("user_id")
      .eq("tenant_id", tenantId)
      .in("role", ["admin", "operator"]);

    if (members?.length) {
      const notifications = members.map((m: { user_id: string }) => ({
        tenant_id:    tenantId,
        user_id:      m.user_id,
        type:         "modification_requested",
        title:        "Richiesta modifica prenotazione",
        body:         `${svc.customer_name} — vuole modificare la prenotazione`,
        link:         `/richieste-modifica`,
        reference_id: mr.id,
      }));
      await admin.from("notifications").insert(notifications);
    }

    // Email agli admin/operator
    if (members?.length) {
      const userIds = members.map((m: { user_id: string }) => m.user_id);
      const { data: { users } } = await admin.auth.admin.listUsers();
      const opsEmails = (users ?? [])
        .filter((u: { id: string }) => userIds.includes(u.id))
        .map((u: { email?: string }) => u.email)
        .filter(Boolean) as string[];

      if (opsEmails.length) {
        const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/$/, "") ?? "";

        const changeRows = Object.entries(changes)
          .map(([k, v]) => {
            const labels: Record<string, string> = {
              arrival_date: "Data andata", arrival_time: "Ora andata",
              departure_date: "Data ritorno", departure_time: "Ora ritorno",
              pax: "Passeggeri", hotel_id: "Hotel",
              booking_service_kind: "Tipologia servizio", notes: "Note",
            };
            const displayVal = k === "hotel_id" && hotelName ? hotelName : String(v ?? "—");
            return `<tr><td style="padding:8px 12px;background:#f8fafc;font-weight:600;width:40%;">${labels[k] ?? k}</td><td style="padding:8px 12px;">${displayVal}</td></tr>`;
          })
          .join("");

        await sendEmail({
          to: opsEmails,
          subject: `Richiesta modifica — ${svc.customer_name}`,
          html: emailHtml(`
            <h2 style="color:#0f172a;margin-bottom:4px;">Richiesta di modifica prenotazione</h2>
            <p style="color:#475569;margin-bottom:20px;">
              Un'agenzia ha richiesto di modificare la prenotazione di <strong>${svc.customer_name}</strong>.
            </p>
            <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">${changeRows}</table>
            <a href="${appUrl}/richieste-modifica" style="display:inline-block;background:#1e293b;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;font-size:14px;">
              Gestisci richiesta →
            </a>
          `, { title: "Richiesta modifica" }),
        });
      }
    }

    return NextResponse.json({ ok: true, request_id: mr.id });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Errore" }, { status: 500 });
  }
}
