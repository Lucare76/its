/**
 * GET  /api/ops/cancellation-requests        — lista richieste pendenti (admin/operator)
 * POST /api/ops/cancellation-requests        — crea richiesta cancellazione (admin/operator/agency)
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { sendEmail } from "@/lib/server/send-email";
import { emailHtml } from "@/lib/server/email-layout";

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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tenantId = (auth as any).membership.tenant_id as string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const admin = (auth as any).admin;

    const { data, error } = await admin
      .from("cancellation_requests")
      .select(`
        id, cancel_legs, status, penalty_cents, penalty_note,
        requested_by_role, requested_by_user_id, created_at, updated_at,
        agency_response, agency_response_note, agency_counter_cents, agency_responded_at,
        services(
          id, customer_name, pax, date, time, direction,
          arrival_date, arrival_time, departure_date, departure_time,
          booking_service_kind,
          hotels(name),
          agencies(name, booking_email, contact_email)
        )
      `)
      .eq("tenant_id", tenantId)
      .in("status", ["pending_review", "pending_agency_approval"])
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
    return NextResponse.json({ ok: true, requests });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Errore" }, { status: 500 });
  }
}

// ── POST — crea richiesta ─────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const auth = await authorizePricingRequest(req, ["admin", "operator", "agency"]);
    if (auth instanceof NextResponse) return auth;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = auth as any;
    const tenantId = a.membership.tenant_id as string;
    const role = a.membership.role as string;
    const userId = a.user.id as string;
    const admin = a.admin;

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

      // Email agli admin/operator (recupera email da auth)
      const { data: opsMembers } = await admin
        .from("memberships")
        .select("user_id")
        .eq("tenant_id", tenantId)
        .in("role", ["admin", "operator"]);

      if (opsMembers?.length) {
        const userIds = opsMembers.map((m: { user_id: string }) => m.user_id);
        const { data: { users } } = await admin.auth.admin.listUsers();
        const opsEmails = (users ?? [])
          .filter((u: { id: string }) => userIds.includes(u.id))
          .map((u: { email?: string }) => u.email)
          .filter(Boolean) as string[];

        if (opsEmails.length) {
          const legLabel2 = cancel_legs === "both" ? "intero servizio" : cancel_legs === "arrival" ? "solo andata" : "solo ritorno";
          const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/$/, "") ?? "";
          await sendEmail({
            to: opsEmails,
            subject: `Richiesta cancellazione — ${svc.customer_name}`,
            html: emailHtml(`
              <h2 style="color:#0f172a;margin-bottom:4px;">Richiesta di cancellazione</h2>
              <p style="color:#475569;margin-bottom:20px;">
                Un'agenzia ha richiesto la cancellazione di un servizio e attende la tua decisione sulla penale.
              </p>
              <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
                <tr><td style="padding:8px 12px;background:#f8fafc;font-weight:600;width:40%;">Cliente</td><td style="padding:8px 12px;">${svc.customer_name}</td></tr>
                <tr><td style="padding:8px 12px;background:#f1f5f9;font-weight:600;">Tratta</td><td style="padding:8px 12px;">${legLabel2}</td></tr>
              </table>
              <a href="${appUrl}/cancellazioni" style="display:inline-block;background:#1e293b;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;font-size:14px;">
                Gestisci richiesta →
              </a>
            `, { title: "Richiesta cancellazione" }),
          });
        }
      }
    }

    return NextResponse.json({ ok: true, request_id: createdReq.id });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Errore" }, { status: 500 });
  }
}
