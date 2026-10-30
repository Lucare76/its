/**
 * GET  /api/ops/cancellation-requests        — lista richieste pendenti (admin/operator)
 * POST /api/ops/cancellation-requests        — crea richiesta cancellazione (admin/operator/agency)
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { sendCancellationRequestEmail } from "@/lib/server/cancellation-request-email";

export const runtime = "nodejs";

const createSchema = z.object({
  service_id:  z.string().uuid(),
  cancel_legs: z.enum(["arrival", "departure", "both"]),
});

// ── GET — lista richieste pendenti ────────────────────────────────────────────
export async function GET(req: NextRequest) {
  try {
    const auth = await authorizePricingRequest(req, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;
    const tenantId = auth.membership.tenant_id;
    const admin = auth.admin;

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await admin
      .from("cancellation_requests")
      .select(`
        id, cancel_legs, status, penalty_cents, penalty_note,
        requested_by_role, requested_by_user_id, created_at, updated_at,
        agency_response, agency_response_note, agency_counter_cents, agency_responded_at,
        services(
          id, status, linked_service_id, customer_name, pax, date, time, direction,
          arrival_date, arrival_time, departure_date, departure_time,
          booking_service_kind,
          hotels(name),
          agencies(name, booking_email, contact_email)
        )
      `)
      .eq("tenant_id", tenantId)
      .or(`status.in.(pending_review,pending_agency_approval),and(status.in.(closed,approved),created_at.gte.${thirtyDaysAgo})`)
      .order("created_at", { ascending: false });

    // Risolvi nome di chi ha richiesto la cancellazione
    const userIds = [...new Set((data ?? []).map((r: Record<string, unknown>) => r.requested_by_user_id).filter(Boolean))] as string[];
    const nameById: Record<string, string> = {};
    if (userIds.length) {
      const { data: members } = await admin
        .from("memberships")
        .select("user_id, full_name")
        .eq("tenant_id", tenantId)
        .in("user_id", userIds);
      for (const m of members ?? []) nameById[m.user_id] = m.full_name ?? "";
      // fallback: auth.users per chi non ha membership (es. agenzia esterna)
      const missing = userIds.filter((id) => !nameById[id]);
      if (missing.length) {
        const { data: { users } } = await admin.auth.admin.listUsers();
        for (const u of users ?? []) {
          if (missing.includes(u.id)) {
            nameById[u.id] = u.user_metadata?.full_name ?? u.email ?? u.id;
          }
        }
      }
    }

    if (error) throw new Error(error.message);
    const requests = (data ?? []).map((r: Record<string, unknown>) => ({
      ...r,
      requested_by_name: r.requested_by_user_id ? (nameById[r.requested_by_user_id as string] ?? null) : null,
    }));

    // Servizi cancellati direttamente (senza cancellation_request) — ultimi 30 giorni
    const serviceIds = new Set((data ?? []).map((r: Record<string, unknown>) => {
      const svc = r.services as Record<string, unknown> | null;
      return svc?.id as string | undefined;
    }).filter(Boolean));

    const { data: directlyCancelled } = await admin
      .from("services")
      .select("id, status, linked_service_id, customer_name, pax, date, time, arrival_date, arrival_time, departure_date, departure_time, booking_service_kind, updated_at, hotels(name), agencies(name, booking_email)")
      .eq("tenant_id", tenantId)
      .eq("status", "cancelled")
      .gte("updated_at", thirtyDaysAgo);

    const directRequests = ((directlyCancelled ?? []) as Record<string, unknown>[])
      .filter((s) => !serviceIds.has(s.id as string))
      .map((s) => ({
        id: `direct_${s.id as string}`,
        cancel_legs: "both" as const,
        status: "closed" as const,
        penalty_cents: null,
        penalty_note: null,
        requested_by_role: "operator",
        requested_by_name: null,
        created_at: s.updated_at as string ?? new Date().toISOString(),
        updated_at: s.updated_at as string ?? null,
        agency_response: null,
        agency_response_note: null,
        agency_counter_cents: null,
        agency_responded_at: null,
        services: s,
      }));

    return NextResponse.json({ ok: true, requests: [...requests, ...directRequests] });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Errore" }, { status: 500 });
  }
}

// ── POST — crea richiesta ─────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const auth = await authorizePricingRequest(req, ["admin", "operator", "agency"]);
    if (auth instanceof NextResponse) return auth;
    const { admin, membership, user } = auth;
    const tenantId = membership.tenant_id;
    const role = membership.role;
    const userId = user.id;

    const raw = await req.json().catch(() => null);
    const parsed = createSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Body non valido." }, { status: 400 });
    }
    const { service_id, cancel_legs } = parsed.data;

    // Verifica servizio
    const { data: svc } = await admin
      .from("services")
      .select("id, status, customer_name, pax, agency_id, tenant_id, arrival_date, departure_date")
      .eq("id", service_id)
      .eq("tenant_id", tenantId)
      .maybeSingle();

    if (!svc) return NextResponse.json({ error: "Servizio non trovato." }, { status: 404 });
    if (svc.status === "cancelled") return NextResponse.json({ error: "Servizio già cancellato." }, { status: 409 });
    if (svc.status === "pending_cancellation") return NextResponse.json({ error: "Richiesta di cancellazione già in corso." }, { status: 409 });

    // Crea la richiesta
    const { data: createdReq, error: insertErr } = await admin
      .from("cancellation_requests")
      .insert({
        tenant_id: tenantId,
        service_id,
        cancel_legs,
        requested_by_role: role,
        requested_by_user_id: userId,
        status: "pending_review",
      })
      .select("id, approval_token")
      .single();

    if (insertErr || !createdReq) throw new Error(insertErr?.message ?? "Inserimento fallito.");

    // Servizio → pending_cancellation
    await admin
      .from("services")
      .update({ status: "pending_cancellation" })
      .eq("id", service_id)
      .eq("tenant_id", tenantId);

    await admin.from("status_events").insert({
      tenant_id: tenantId,
      service_id,
      status: "pending_cancellation",
      by_user_id: userId,
      notes: `Richiesta cancellazione: ${cancel_legs === "both" ? "intero servizio" : cancel_legs === "arrival" ? "solo andata" : "solo ritorno"} — da ${role}`,
    });

    let emailNotification: "sent" | "failed" | "skipped" = "skipped";

    // Se richiesta da agenzia → notifica in-app a admin/operator
    if (role === "agency") {
      const legLabel = cancel_legs === "both" ? "intero servizio" : cancel_legs === "arrival" ? "solo andata" : "solo ritorno";

      // Recupera tutti gli admin/operator del tenant per notifica in-app
      const { data: members } = await admin
        .from("memberships")
        .select("user_id")
        .eq("tenant_id", tenantId)
        .in("role", ["admin", "operator"]);

      if (members?.length) {
        const notifications = members.map((m: { user_id: string }) => ({
          tenant_id: tenantId,
          user_id: m.user_id,
          type: "cancellation_requested",
          title: "Richiesta cancellazione",
          body: `${svc.customer_name} — ${legLabel}`,
          link: `/cancellazioni`,
          reference_id: createdReq.id,
        }));
        await admin.from("notifications").insert(notifications);
      }

      const emailResult = await sendCancellationRequestEmail({
        customerName: svc.customer_name,
        cancelLegs: cancel_legs,
        requestId: createdReq.id,
      });
      emailNotification = emailResult.skipped ? "skipped" : emailResult.ok ? "sent" : "failed";
      if (emailNotification !== "sent") {
        console.error("cancellation_request_email_failed", { tenantId, requestId: createdReq.id, status: emailNotification });
      }
    }

    return NextResponse.json({ ok: true, request_id: createdReq.id, email_notification: emailNotification });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Errore" }, { status: 500 });
  }
}
