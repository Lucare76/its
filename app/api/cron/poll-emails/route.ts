/**
 * GET /api/cron/poll-emails
 * Polling IMAP — scarica nuove email inbound e le processa.
 * Vercel Cron: schedule ogni-15-minuti (via cron-job.org su Hobby plan)
 *
 * Sprint Performance 8: passa da pollEmailNow() (lib/server/email-poll.ts),
 * lo stesso entrypoint usato da /api/email/operational-import. Lock e
 * cooldown condivisi garantiscono che, se questo trigger e un altro
 * (Vercel Cron, cron-job.org, refresh manuale Inbox) partono vicini nel
 * tempo, solo uno dei due apra davvero una connessione IMAP.
 * Dopo ogni import reale manda push notification agli admin/operator se ci sono nuovi booking.
 *
 * Env vars IMAP: IMAP_HOST, IMAP_PORT, IMAP_USER, IMAP_PASS, IMAP_TLS (optional)
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { pollEmailNow } from "@/lib/server/email-poll";
import { withJobHealth } from "@/lib/server/job-health";
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

  // runEmailOperationalImport richiede un auth context
  const fakeAuth = {
    admin,
    user: { id: "cron-system", email: null as string | null },
    membership: { tenant_id: tenantId, role: "admin", suspended: false },
  };

  // force=false: il cron rispetta lock e cooldown condivisi. Se questo giro
  // arriva mentre un altro trigger (Vercel Cron, cron-job.org, o un refresh
  // manuale) ha già un import in corso o appena completato, non apre una
  // seconda connessione IMAP — vedi lib/server/email-poll.ts.
  const result = await withJobHealth({
    admin,
    tenantId,
    jobKey: "poll-emails",
    jobName: "Polling email",
    source: "api/cron/poll-emails"
  }, async () => {
    const pollResult = await pollEmailNow(fakeAuth, { force: false });
    const detail = pollResult.detail;
    const skipped = pollResult.status === "skipped_in_progress" || pollResult.status === "skipped_recent";
    return {
      result: pollResult,
      status: pollResult.status === "error" ? "failed" : "success",
      counts: {
        processedCount: detail?.emailsProcessed ?? 0,
        successCount: detail?.draftsCreated ?? 0,
        failedCount: pollResult.status === "error" ? 1 : 0,
        warningCount: (detail?.duplicateWarnings ?? 0) + (detail?.skippedNoPdf ?? 0)
      },
      errorMessage: pollResult.status === "error" ? pollResult.error : null,
      metadata: {
        status: pollResult.status,
        skipped,
        mailbox: detail?.mailbox,
        unread_found: detail?.unreadFound,
        emails_processed: detail?.emailsProcessed,
        pdf_found: detail?.pdfFound,
        drafts_created: detail?.draftsCreated,
        duplicate_warnings: detail?.duplicateWarnings,
        skipped_no_pdf: detail?.skippedNoPdf,
        last_success_at: pollResult.last_success_at
      }
    };
  });

  if (result.status === "error") {
    if (result.imap_not_configured) {
      return NextResponse.json({ ok: false, error: "IMAP non configurato.", imap_not_configured: true });
    }
    const message = result.error ?? "Unknown error";
    // IMAP non raggiungibile non è un errore critico
    if (message.includes("IMAP") || message.includes("imap") || message.includes("ECONNREFUSED")) {
      return NextResponse.json({ ok: false, error: `IMAP non raggiungibile: ${message}` });
    }
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }

  if (result.status === "skipped_in_progress" || result.status === "skipped_recent") {
    return NextResponse.json({ ok: true, status: result.status, skipped: true, last_success_at: result.last_success_at ?? null });
  }

  // Se ci sono nuovi servizi importati, manda push agli admin/operator
  const detail = result.detail!;
  const importedCount = detail.draftsCreated;
  if (importedCount > 0) {
    await sendPushToTenantRoles(tenantId, ["admin", "operator"], {
      title: `📧 ${importedCount} nuov${importedCount === 1 ? "a" : "e"} email${importedCount === 1 ? "" : ""} importat${importedCount === 1 ? "a" : "e"}`,
      body: "Nuovi booking da processare in Posta in arrivo.",
      url: "/inbox",
      tag: "inbound-import",
    });
  }

  return NextResponse.json({
    ok: true,
    status: "imported",
    mailbox: detail.mailbox,
    unreadFound: detail.unreadFound,
    emailsProcessed: detail.emailsProcessed,
    pdfFound: detail.pdfFound,
    draftsCreated: detail.draftsCreated,
    duplicateWarnings: detail.duplicateWarnings,
    skippedNoPdf: detail.skippedNoPdf,
    started_at: result.started_at,
    finished_at: result.finished_at,
    last_success_at: result.last_success_at,
  });
}
