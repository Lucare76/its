import { normalizeAgencyModificationTimes } from "@/lib/agency-modification-times";
/**
 * POST /api/agency/modification-request
 *
 * L'agenzia crea una richiesta di modifica di un servizio.
 * L'operatore/admin riceverà una notifica e potrà approvare o rifiutare.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizeServiceRoleRequest } from "@/lib/server/pricing-auth";
import { sendModificationRequestEmail } from "@/lib/server/modification-request-email";

export const runtime = "nodejs";

const schema = z.object({
  service_id: z.string().uuid(),
  changes: z.object({
    arrival_date:        z.string().optional(),
    arrival_time:        z.string().optional(),
    ferry_departure_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
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
    const { service_id } = parsed.data;
    let changes: Record<string, unknown> = parsed.data.changes;

    // Verifica servizio e appartenenza al tenant
    const { data: svc } = await admin
      .from("services")
      .select("id, status, customer_name, pax, time, outbound_time, arrival_date, arrival_time, departure_date, departure_time, hotel_id, booking_service_kind, notes, tenant_id")
      .eq("id", service_id)
      .eq("tenant_id", tenantId)
      .maybeSingle();

    if (!svc) return NextResponse.json({ error: "Servizio non trovato." }, { status: 404 });
    if (svc.status === "cancelled") return NextResponse.json({ error: "Servizio già cancellato." }, { status: 409 });
    try { changes = normalizeAgencyModificationTimes(changes, svc.booking_service_kind); }
    catch (error) { return NextResponse.json({error:error instanceof Error ? error.message : "Orario non valido."}, {status:400}); }

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
      const { data: hotel } = await admin.from("hotels").select("name").eq("id", String(changes.hotel_id)).maybeSingle();
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

    const emailResult = await sendModificationRequestEmail({ customerName: svc.customer_name, changes, hotelName, requestId: mr.id });
    const emailNotification = emailResult.skipped ? "skipped" : emailResult.ok ? "sent" : "failed";
    if (emailNotification !== "sent") console.error("modification_request_email_failed", {tenantId,requestId:mr.id,status:emailNotification});

    return NextResponse.json({ ok: true, request_id: mr.id, email_notification: emailNotification });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Errore" }, { status: 500 });
  }
}
