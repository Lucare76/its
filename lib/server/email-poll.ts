import { type SupabaseClient } from "@supabase/supabase-js";
import { runEmailOperationalImport, type EmailOperationalImportResult } from "@/lib/server/email-test-import";

// Sprint Performance 8 — entrypoint unico applicativo per l'import email IMAP.
// Cron (/api/cron/poll-emails) e refresh manuale (/api/email/operational-import)
// passano entrambi da qui: il lock/cooldown condiviso vive solo in questo modulo,
// mai duplicato nelle route.

type PollEmailAuth = {
  admin: SupabaseClient;
  membership: { tenant_id: string };
};

export type PollEmailStatus = "imported" | "skipped_in_progress" | "skipped_recent" | "error";

export type PollEmailResult = {
  status: PollEmailStatus;
  imported: number;
  started_at?: string;
  finished_at?: string;
  last_success_at?: string | null;
  detail?: EmailOperationalImportResult | null;
  error?: string;
  imap_not_configured?: boolean;
};

// Mailbox singola per tenant al momento (config IMAP unica in env). Il lock è
// comunque scoped per (tenant_id, mailbox) in DB per restare corretto se in
// futuro si aggiungono più caselle per tenant.
const DEFAULT_MAILBOX = "default";

// TTL lock: deve coprire la durata massima realistica di un'esecuzione.
// Entrambe le route che chiamano pollEmailNow hanno `maxDuration = 120`
// (limite Vercel), quindi il TTL è 120s + 30s di margine per lo scarto tra
// "Vercel uccide la function" e "il nostro finally riesce comunque a
// rilasciare il lock". Se la Function viene killata prima del finally, il
// lock si libera comunque da solo alla scadenza del TTL (mai bloccato per
// sempre).
const LOCK_TTL_SECONDS = 150;

// Cooldown: tempo minimo tra un import riuscito e il prossimo import non
// forzato. Lo scheduler esterno (cron-job.org, vedi commento in
// app/api/cron/poll-emails/route.ts) gira su intervalli dell'ordine dei
// minuti, quindi 60s non blocca mai un giro cron legittimo, ma è sufficiente
// a far collassare in un solo import reale eventuali chiamate quasi
// simultanee (es. Vercel Cron + cron-job.org nello stesso minuto). Il
// refresh manuale da Inbox passa force=true e ignora il cooldown (ma non il
// lock di concorrenza).
const COOLDOWN_SECONDS = 60;

type AcquireLockRow = {
  acquired: boolean;
  reason: string;
  last_success_at: string | null;
  lock_expires_at: string | null;
};

function isImapNotConfiguredError(message: string) {
  return message.includes("Missing IMAP_HOST") || message.includes("IMAP_HOST/IMAP_USER/IMAP_PASS");
}

export async function pollEmailNow(
  auth: PollEmailAuth,
  options: { force?: boolean; mailbox?: string } = {}
): Promise<PollEmailResult> {
  const tenantId = auth.membership.tenant_id;
  const mailbox = options.mailbox ?? DEFAULT_MAILBOX;
  const force = options.force ?? false;

  const { data: acquireRows, error: acquireError } = await auth.admin.rpc("acquire_email_import_lock", {
    p_tenant_id: tenantId,
    p_mailbox: mailbox,
    p_ttl_seconds: LOCK_TTL_SECONDS,
    p_cooldown_seconds: COOLDOWN_SECONDS,
    p_force: force
  });

  if (acquireError) {
    return { status: "error", imported: 0, error: acquireError.message };
  }

  const acquireRow = (Array.isArray(acquireRows) ? acquireRows[0] : acquireRows) as AcquireLockRow | undefined;
  if (!acquireRow?.acquired) {
    const status: PollEmailStatus = acquireRow?.reason === "skipped_recent" ? "skipped_recent" : "skipped_in_progress";
    return { status, imported: 0, last_success_at: acquireRow?.last_success_at ?? null };
  }

  const startedAt = new Date().toISOString();
  try {
    const detail = await runEmailOperationalImport(auth as Parameters<typeof runEmailOperationalImport>[0]);
    const finishedAt = new Date().toISOString();
    await auth.admin.rpc("release_email_import_lock", {
      p_tenant_id: tenantId,
      p_mailbox: mailbox,
      p_success: true,
      p_error: null
    });
    return {
      status: "imported",
      imported: detail.draftsCreated,
      started_at: startedAt,
      finished_at: finishedAt,
      last_success_at: finishedAt,
      detail
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    // Rilascia sempre il lock su errore: niente retry aggressivo immediato
    // (il cooldown non scatta perché last_success_at non viene toccato), ma
    // nessun blocco permanente — la prossima richiesta può ritentare subito.
    try {
      await auth.admin.rpc("release_email_import_lock", {
        p_tenant_id: tenantId,
        p_mailbox: mailbox,
        p_success: false,
        p_error: message.slice(0, 2000)
      });
    } catch {
      // Se anche il rilascio fallisce, il TTL impostato in acquire() libera
      // comunque il lock alla scadenza — niente blocco permanente.
    }
    return {
      status: "error",
      imported: 0,
      error: message,
      started_at: startedAt,
      imap_not_configured: isImapNotConfiguredError(message)
    };
  }
}
