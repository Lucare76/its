/**
 * POST /api/biglietti/send-bulk
 * Invia fino a 10 PDF come allegati all'email di un'agenzia.
 * Body: multipart/form-data con agency_id, files[] (PDF)
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { parseRole } from "@/lib/rbac";

export const runtime = "nodejs";

function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function authorize(request: NextRequest) {
  const admin = adminClient();
  if (!admin) return null;
  const auth = request.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const { data: { user } } = await admin.auth.getUser(auth.slice(7));
  if (!user) return null;
  const { data: m } = await admin.from("memberships").select("tenant_id, role").eq("user_id", user.id).maybeSingle();
  const role = parseRole(m?.role);
  if (!m?.tenant_id || !role || !["admin", "operator", "supervisor"].includes(role)) return null;
  return { admin, tenantId: m.tenant_id };
}

export async function POST(request: NextRequest) {
  const ctx = await authorize(request);
  if (!ctx) return NextResponse.json({ error: "Non autorizzato." }, { status: 403 });

  const apiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.AGENCY_BOOKING_FROM_EMAIL ?? "noreply@ischiatransferservice.it";
  if (!apiKey) return NextResponse.json({ error: "RESEND_API_KEY non configurata." }, { status: 500 });

  let formData: FormData;
  try { formData = await request.formData(); }
  catch { return NextResponse.json({ error: "Formato richiesta non valido." }, { status: 400 }); }

  const agencyId = formData.get("agency_id") as string | null;
  if (!agencyId) return NextResponse.json({ error: "agency_id mancante." }, { status: 400 });

  // Fetch agenzia
  const { data: agency } = await ctx.admin
    .from("agencies")
    .select("id, name, email")
    .eq("tenant_id", ctx.tenantId)
    .eq("id", agencyId)
    .maybeSingle();

  if (!agency?.email) return NextResponse.json({ error: "Email agenzia non trovata o non configurata." }, { status: 400 });

  // Raccoglie tutti i file PDF
  const files = formData.getAll("files") as File[];
  if (files.length === 0) return NextResponse.json({ error: "Nessun file selezionato." }, { status: 400 });
  if (files.length > 10) return NextResponse.json({ error: "Massimo 10 file per invio." }, { status: 400 });

  // Converte File → base64 per Resend
  const attachments = await Promise.all(
    files.map(async (file) => {
      const buffer = await file.arrayBuffer();
      const base64 = Buffer.from(buffer).toString("base64");
      return { filename: file.name, content: base64 };
    })
  );

  const payload = {
    from: `Ischia Transfer Service <${fromEmail}>`,
    to: [agency.email],
    subject: `Biglietti — ${agency.name}`,
    html: `<p>In allegato trovi ${attachments.length === 1 ? "il biglietto" : `i ${attachments.length} biglietti`} per <strong>${agency.name}</strong>.</p><p>Cordiali saluti,<br>Ischia Transfer Service</p>`,
    text: `Biglietti per ${agency.name} — ${attachments.length} allegato/i.\n\nCordiali saluti,\nIschia Transfer Service`,
    attachments,
  };

  const bccEmail = process.env.NOTIFY_BCC_EMAIL;
  if (bccEmail) Object.assign(payload, { bcc: [bccEmail] });

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return NextResponse.json({ error: `Resend ${res.status}: ${body.slice(0, 200)}` }, { status: 500 });
    }
    const result = await res.json().catch(() => null) as { id?: string } | null;
    return NextResponse.json({ ok: true, message_id: result?.id, sent_to: agency.email, files: attachments.length });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Errore di rete." }, { status: 500 });
  }
}
