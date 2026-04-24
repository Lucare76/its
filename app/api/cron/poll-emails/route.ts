/**
 * GET /api/cron/poll-emails
 * Polling IMAP ogni 15 minuti — scarica nuove email inbound e le processa.
 * Vercel Cron: schedule ogni-15-minuti (via cron-job.org su Hobby plan)
 *
 * Riusa la logica esistente in runEmailOperationalImport (lib/server/email-test-import.ts).
 * Dopo ogni import manda push notification agli admin/operator se ci sono nuovi booking.
 *
 * Env vars IMAP: IMAP_HOST, IMAP_PORT, IMAP_USER, IMAP_PASS, IMAP_TLS (optional)
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { runEmailOperationalImport } from "@/lib/server/email-test-import";
import { sendPushToTenantRoles } from "@/lib/server/web-push";

export const runtime = "nodejs";
export const maxDuration = 120;

function adminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/^["']|["']$/g, "")!,
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim().replace(/^["']|["']$/g, "")!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

export async function GET(request: NextRequest) {
  // Autorizzazione cron
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ ok: false, error: "Server configuration error" }, { status: 500 });
  }
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  // IMAP configurato?
  if (!process.env.IMAP_HOST || !process.env.IMAP_USER || !process.env.IMAP_PASS) {
    return NextResponse.json({ ok: false, error: "IMAP non configurato.", imap_not_configured: true });
  }

  const admin = adminClient();

  // Risolvi tenant (usa INBOUND_DEFAULT_TENANT_ID o primo tenant)
  let tenantId = process.env.INBOUND_DEFAULT_TENANT_ID ?? null;
  if (!tenantId) {
    const { data: firstTenant } = await admin.from("tenants").select("id").limit(1).maybeSingle();
    tenantId = firstTenant?.id ?? null;
  }
  if (!tenantId) {
    return NextResponse.json({ ok: false, error: "Nessun tenant disponibile." }, { status: 400 });
  }

  try {
    // runEmailOperationalImport richiede un auth context
    const fakeAuth = {
      admin,
      user: { id: "cron-system", email: null as string | null },
      membership: { tenant_id: tenantId, role: "admin", suspended: false },
    };

    const result = await runEmailOperationalImport(fakeAuth as Parameters<typeof runEmailOperationalImport>[0]);

    // Se ci sono nuovi servizi importati, manda push agli admin/operator
    const importedCount = (result as Record<string, unknown>).imported_count as number | undefined ?? 0;
    if (importedCount > 0) {
      await sendPushToTenantRoles(tenantId, ["admin", "operator"], {
        title: `📧 ${importedCount} nuov${importedCount === 1 ? "a" : "e"} email${importedCount === 1 ? "" : ""} importat${importedCount === 1 ? "a" : "e"}`,
        body: "Nuovi booking da processare in Posta in arrivo.",
        url: "/inbox",
        tag: "inbound-import",
      });
    }

    return NextResponse.json({ ok: true, ...result as object });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    // IMAP non raggiungibile non è un errore critico
    if (message.includes("IMAP") || message.includes("imap") || message.includes("ECONNREFUSED")) {
      return NextResponse.json({ ok: false, error: `IMAP non raggiungibile: ${message}` });
    }
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
