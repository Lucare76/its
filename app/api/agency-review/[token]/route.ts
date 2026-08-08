/**
 * GET  /api/agency-review/[token]  — legge la sessione (pubblico, no auth)
 * POST /api/agency-review/[token]  — invia approvazione o modifiche (pubblico)
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getVerifiedFromEmail, resendFetch } from "@/lib/server/send-email";
import { escapeHtml } from "@/lib/server/escape-html";
import { auditLog } from "@/lib/server/ops-audit";

export const runtime = "nodejs";

const modSchema = z.object({
  service_id: z.string(),
  field:      z.string(),
  original:   z.string(),
  modified:   z.string(),
});

const submitSchema = z.object({
  action:        z.enum(["approved", "modified"]),
  modifications: z.array(modSchema).optional(),
  agency_notes:  z.string().max(1000).optional(),
});

function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/^["']|["']$/g, "")!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim().replace(/^["']|["']$/g, "")!;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const admin = adminClient();
  const { data, error } = await admin
    .from("agency_review_sessions")
    .select("id, agency_name, report_type, target_date, services, status, expires_at")
    .eq("token", token)
    .maybeSingle();

  if (error || !data) return NextResponse.json({ error: "Sessione non trovata." }, { status: 404 });
  if (new Date(data.expires_at as string) < new Date()) {
    return NextResponse.json({ error: "Link scaduto." }, { status: 410 });
  }
  if (data.status !== "pending") {
    return NextResponse.json({ error: "Già risposto.", status: data.status }, { status: 409 });
  }
  return NextResponse.json(data);
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const admin = adminClient();

  // Legge la sessione
  const { data: session, error: sessionErr } = await admin
    .from("agency_review_sessions")
    .select("id, tenant_id, agency_name, report_type, target_date, services, status, expires_at")
    .eq("token", token)
    .maybeSingle();

  if (sessionErr || !session) return NextResponse.json({ error: "Sessione non trovata." }, { status: 404 });
  if (new Date(session.expires_at as string) < new Date()) return NextResponse.json({ error: "Link scaduto." }, { status: 410 });
  if (session.status !== "pending") return NextResponse.json({ error: "Già risposto." }, { status: 409 });

  const body = submitSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: body.error.issues[0]?.message ?? "Dati non validi." }, { status: 400 });

  // Aggiorna la sessione
  const { error: updateErr } = await admin
    .from("agency_review_sessions")
    .update({
      status:        body.data.action,
      modifications: body.data.modifications ?? null,
      agency_notes:  body.data.agency_notes ?? null,
      reviewed_at:   new Date().toISOString(),
    })
    .eq("id", session.id);

  if (updateErr) {
    auditLog({
      event: "agency_review_update_failed",
      level: "error",
      tenantId: session.tenant_id as string,
      details: { sessionId: session.id, message: updateErr.message },
    });
    return NextResponse.json({ error: "Impossibile registrare la risposta." }, { status: 500 });
  }

  // Se ci sono modifiche, invia email all'operatore
  if (body.data.action === "modified" && body.data.modifications?.length) {
    await sendDiffEmailToOperator({
      admin,
      tenantId:      session.tenant_id as string,
      sessionId:     session.id as string,
      agencyName:    session.agency_name as string,
      targetDate:    session.target_date as string,
      services:      session.services as ServiceSnapshot[],
      modifications: body.data.modifications,
      agencyNotes:   body.data.agency_notes ?? null,
    });
  }

  // Email di conferma all'agenzia (se abbiamo la sua email)
  await sendConfirmationEmailToAgency({
    admin,
    tenantId:   session.tenant_id as string,
    agencyName: session.agency_name as string,
    targetDate: session.target_date as string,
    action:     body.data.action,
    modCount:   body.data.modifications?.length ?? 0,
  });

  return NextResponse.json({ ok: true });
}

/* ─── Tipi ─────────────────────────────────────────────────────────────── */

type ServiceSnapshot = {
  service_id?: string;
  date: string;
  time: string;
  customer_name: string;
  phone?: string | null;
  pax: number;
  hotel_or_destination: string | null;
  direction: "arrival" | "departure";
  transport_type?: string | null;
  transport_time?: string | null;
};

type Modification = {
  service_id: string;
  field: string;
  original: string;
  modified: string;
};

/* ─── Email diff all'operatore ─────────────────────────────────────────── */

const FIELD_LABELS: Record<string, string> = {
  date:                 "Data",
  time:                 "Orario",
  pax:                  "Pax",
  hotel_or_destination: "Hotel / Destinazione",
  direction:            "Direzione",
  customer_name:        "Nome cliente",
  phone:                "Telefono",
  transport_type:       "Mezzo",
  transport_time:       "Orario mezzo",
};

async function sendDiffEmailToOperator(params: {
  admin: SupabaseClient;
  tenantId: string;
  sessionId: string;
  agencyName: string;
  targetDate: string;
  services: ServiceSnapshot[];
  modifications: Modification[];
  agencyNotes: string | null;
}) {
  const apiKey = process.env.RESEND_API_KEY;
  const from   = getVerifiedFromEmail();
  if (!apiKey || !from) return;

  // Trova contact_email dal profilo tenant
  const { data: tenant } = await params.admin
    .from("tenants")
    .select("contact_email, name")
    .eq("id", params.tenantId)
    .maybeSingle();

  // Se non c'è contact_email, cerca l'email del primo admin del tenant
  let toEmail: string = tenant?.contact_email ?? "";
  if (!toEmail) {
    const { data: adminMembers } = await params.admin
      .from("memberships")
      .select("user_id")
      .eq("tenant_id", params.tenantId)
      .eq("role", "admin")
      .limit(5);
    if (adminMembers?.length) {
      for (const m of adminMembers) {
        const { data: adminUser } = await params.admin.auth.admin.getUserById(m.user_id);
        if (adminUser?.user?.email) { toEmail = adminUser.user.email; break; }
      }
    }
  }
  if (!toEmail) toEmail = from;
  const appUrl  = process.env.NEXT_PUBLIC_APP_URL ?? "https://ischiatransferservice.it";

  // Raggruppa modifiche per servizio
  const byService = new Map<string, { service: ServiceSnapshot; mods: Modification[] }>();
  for (const mod of params.modifications) {
    const service = params.services.find((s) => s.service_id === mod.service_id || s.customer_name === mod.service_id);
    if (!service) continue;
    const key = mod.service_id;
    if (!byService.has(key)) byService.set(key, { service, mods: [] });
    byService.get(key)!.mods.push(mod);
  }

  const diffRows = Array.from(byService.values()).map(({ service, mods }) => {
    const modRows = mods.map((m) => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;color:#64748b;">${escapeHtml(FIELD_LABELS[m.field] ?? m.field)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;color:#475569;text-decoration:line-through;">${escapeHtml(m.original)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;font-weight:700;color:#854d0e;background:#fef9c3;">${escapeHtml(m.modified)} ✏️</td>
      </tr>`).join("");
    return `
      <tr>
        <td colspan="3" style="padding:10px 12px;background:#f1f5f9;font-size:13px;font-weight:700;color:#0f2744;border-bottom:1px solid #e2e8f0;">
          ${escapeHtml(service.customer_name)} — ${escapeHtml(service.date)} ${escapeHtml(service.time)}
        </td>
      </tr>
      ${modRows}`;
  }).join("");

  const html = `<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"/></head>
<body style="font-family:-apple-system,Arial,sans-serif;font-size:14px;color:#1a1a1a;background:#eef2f7;padding:32px;">
<div style="max-width:640px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,0.08);">
  <div style="background:linear-gradient(135deg,#854d0e,#a16207);padding:28px 32px;">
    <div style="font-size:22px;font-weight:800;color:#fff;">✏️ Modifiche da ${escapeHtml(params.agencyName)}</div>
    <div style="font-size:13px;color:rgba(255,255,255,0.7);margin-top:4px;">Riepilogo ${escapeHtml(params.targetDate)} · ${params.modifications.length} modifiche</div>
  </div>
  <div style="padding:28px 32px;">
    <p style="color:#475569;margin-bottom:20px;">
      <strong>${escapeHtml(params.agencyName)}</strong> ha segnalato delle modifiche al riepilogo del <strong>${escapeHtml(params.targetDate)}</strong>.
      ${params.agencyNotes ? `<br/><br/>Nota agenzia: <em>"${escapeHtml(params.agencyNotes)}"</em>` : ""}
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;border-radius:10px;overflow:hidden;border:1px solid #e2e8f0;">
      <thead>
        <tr style="background:#f8fafc;">
          <th style="padding:10px 12px;text-align:left;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#64748b;">Campo</th>
          <th style="padding:10px 12px;text-align:left;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#64748b;">Originale</th>
          <th style="padding:10px 12px;text-align:left;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#854d0e;">Modificato</th>
        </tr>
      </thead>
      <tbody>${diffRows}</tbody>
    </table>
    <div style="margin-top:24px;text-align:center;">
      <a href="${appUrl}/inbox/agency-reviews" style="display:inline-block;background:#0f2744;color:#fff;text-decoration:none;padding:12px 28px;border-radius:10px;font-weight:700;font-size:14px;">
        👁 Rivedi e applica modifiche
      </a>
    </div>
  </div>
  <div style="background:#f8fafc;padding:16px 32px;text-align:center;font-size:12px;color:#94a3b8;border-top:1px solid #e2e8f0;">
    Ischia Transfer Service · Risposta agenzia ricevuta automaticamente
  </div>
</div>
</body></html>`;

  await resendFetch(apiKey, {
    from,
    to: [toEmail],
    subject: `✏️ Modifiche da ${params.agencyName} — ${params.targetDate}`,
    html,
  });
}

/* ─── Email conferma all'agenzia ───────────────────────────────────────────── */

async function sendConfirmationEmailToAgency(params: {
  admin: SupabaseClient;
  tenantId: string;
  agencyName: string;
  targetDate: string;
  action: "approved" | "modified";
  modCount: number;
}) {
  const apiKey = process.env.RESEND_API_KEY;
  const from   = getVerifiedFromEmail();
  if (!apiKey || !from) return;

  // Cerca email booking dell'agenzia
  const { data: agency } = await params.admin
    .from("agencies")
    .select("booking_email, contact_email")
    .eq("tenant_id", params.tenantId)
    .ilike("name", `%${params.agencyName.replace(" (TEST)", "")}%`)
    .maybeSingle();

  const toEmail = agency?.booking_email ?? agency?.contact_email;
  if (!toEmail) return; // nessuna email trovata per questa agenzia

  const isApproved = params.action === "approved";
  const html = `<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"/></head>
<body style="font-family:-apple-system,Arial,sans-serif;font-size:14px;color:#1a1a1a;background:#eef2f7;padding:32px;">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,0.08);">
  <div style="background:${isApproved ? "linear-gradient(135deg,#166534,#15803d)" : "linear-gradient(135deg,#854d0e,#a16207)"};padding:28px 32px;">
    <div style="font-size:22px;font-weight:800;color:#fff;">${isApproved ? "✅ Riepilogo approvato" : "✏️ Modifiche ricevute"}</div>
    <div style="font-size:13px;color:rgba(255,255,255,0.7);margin-top:4px;">${escapeHtml(params.agencyName)} · ${escapeHtml(params.targetDate)}</div>
  </div>
  <div style="padding:28px 32px;">
    ${isApproved
      ? `<p style="color:#475569;font-size:15px;">Grazie! La tua approvazione del riepilogo del <strong>${escapeHtml(params.targetDate)}</strong> è stata ricevuta correttamente da Ischia Transfer Service.</p>`
      : `<p style="color:#475569;font-size:15px;">Grazie! Le tue <strong>${params.modCount} modifiche</strong> al riepilogo del <strong>${escapeHtml(params.targetDate)}</strong> sono state ricevute. Il nostro team le verificherà e aggiornerà i servizi al più presto.</p>`
    }
    <p style="color:#94a3b8;font-size:13px;margin-top:20px;">Per informazioni scrivi a <a href="mailto:${from}" style="color:#3b82f6;">${from}</a></p>
  </div>
  <div style="background:#f8fafc;padding:14px 32px;text-align:center;font-size:12px;color:#94a3b8;border-top:1px solid #e2e8f0;">
    Ischia Transfer Service · Conferma automatica
  </div>
</div>
</body></html>`;

  await resendFetch(apiKey, {
    from,
    to: [toEmail],
    subject: isApproved
      ? `✅ Riepilogo approvato — ${params.targetDate}`
      : `✏️ Modifiche ricevute — ${params.targetDate}`,
    html,
  }).catch(() => null); // non bloccare se fallisce
}
