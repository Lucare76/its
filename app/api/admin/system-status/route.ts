/**
 * GET /api/admin/system-status
 * Restituisce lo stato del sistema: ultimo backup, cron job, variabili d'ambiente.
 * Solo admin e supervisor.
 */

import { NextRequest, NextResponse } from "next/server";
import { readSystemJobHealthSummary, readRecentJobRuns } from "@/lib/server/job-health";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { JOB_HEALTH_CONFIG, JOB_HEALTH_KEYS } from "@/lib/server/job-health-config";
import { evaluateJobHealth, computeOverallHealth, summarizeJobHealthCounts } from "@/lib/server/job-health-evaluator";

export const runtime = "nodejs";

const BUCKET = "backups";

const CRON_JOBS = [
  { name: "Agency Reminders",     path: "/api/cron/agency-reminders",     schedule: "0 8 * * *",  description: "Reminder giornalieri alle agenzie" },
  { name: "Agency Invoices",      path: "/api/cron/agency-invoices",      schedule: "0 8 * * *",  description: "Generazione fatture mensili agenzie" },
  { name: "Vehicle Expiry Check", path: "/api/cron/vehicle-expiry-check", schedule: "0 8 * * *",  description: "Controllo scadenze assicurazione/bollo/collaudo" },
  { name: "Backup notturno",      path: "/api/cron/backup",               schedule: "0 2 * * *",  description: "Backup automatico DB → Storage (retention 30gg)" },
];

// Riusa le chiavi dalla configurazione centrale (job-health-config.ts) invece di
// duplicarle qui — stesso ordine ["backup", "poll-emails", "whatsapp-reminders"].
const HEALTH_JOB_KEYS = JOB_HEALTH_KEYS;

const ENV_VARS = [
  { key: "NEXT_PUBLIC_SUPABASE_URL",       label: "Supabase URL",            group: "Supabase" },
  { key: "NEXT_PUBLIC_SUPABASE_ANON_KEY",  label: "Supabase Anon Key",       group: "Supabase" },
  { key: "SUPABASE_SERVICE_ROLE_KEY",      label: "Supabase Service Role",   group: "Supabase" },
  { key: "CRON_SECRET",                    label: "Cron Secret",             group: "Sicurezza" },
  { key: "RESEND_API_KEY",                 label: "Resend API Key",          group: "Email" },
  { key: "IMAP_HOST",                      label: "IMAP Host",               group: "Email" },
  { key: "IMAP_USER",                      label: "IMAP User",               group: "Email" },
  { key: "IMAP_PASS",                      label: "IMAP Password",           group: "Email" },
  { key: "ANTHROPIC_API_KEY",              label: "Anthropic API Key",       group: "AI" },
  { key: "WHATSAPP_ACCESS_TOKEN",          label: "WhatsApp System User Token", group: "WhatsApp" },
  { key: "WHATSAPP_PHONE_NUMBER_ID",       label: "WhatsApp Phone Number ID",group: "WhatsApp" },
  { key: "WHATSAPP_VERIFY_TOKEN",          label: "WhatsApp Verify Token",   group: "WhatsApp" },
  { key: "WHATSAPP_BUSINESS_ACCOUNT_ID",   label: "WhatsApp Business Account ID", group: "WhatsApp" },
  { key: "WHATSAPP_APP_SECRET",            label: "WhatsApp App Secret",     group: "WhatsApp" },
  { key: "WHATSAPP_GRAPH_API_VERSION",     label: "WhatsApp Graph API Version", group: "WhatsApp" },
  { key: "WHATSAPP_REMINDER_WINDOW_MINUTES", label: "WhatsApp Reminder Window", group: "WhatsApp" },
  { key: "WHATSAPP_TEMPLATE_LANGUAGE",     label: "WhatsApp Template Language", group: "WhatsApp" },
  { key: "WHATSAPP_REMINDER_2H_ENABLED",   label: "WhatsApp Reminder 2H",    group: "WhatsApp" },
  { key: "WHATSAPP_ALLOW_TEXT_FALLBACK",   label: "WhatsApp Text Fallback",  group: "WhatsApp" },
  { key: "RADIUS_REFRESH_TOKEN",           label: "Radius Refresh Token",    group: "GPS" },
  { key: "RADIUS_CUSTOMER_ID",            label: "Radius Customer ID",      group: "GPS" },
];

export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin"]);
  if (auth instanceof NextResponse) return auth;

  // Verifica env
  const envStatus = ENV_VARS.map(({ key, label, group }) => ({
    key,
    label,
    group,
    present: Boolean(process.env[key]),
  }));

  // Ultimo backup da Storage
  let lastBackup: { filename: string; date: string; size_bytes: number } | null = null;
  let backupCount = 0;
  const { data: files } = await auth.admin.storage.from(BUCKET).list("", { limit: 200, sortBy: { column: "name", order: "desc" } });
  if (files && files.length > 0) {
    backupCount = files.length;
    const latest = files[0];
    const match = latest.name.match(/^backup_(\d{4}-\d{2}-\d{2})\.json$/);
    lastBackup = {
      filename: latest.name,
      date: match?.[1] ?? "",
      size_bytes: latest.metadata?.size ?? 0,
    };
  }

  const now = new Date();
  const recentSince = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const [jobHealth, recentRunsByKey] = await Promise.all([
    readSystemJobHealthSummary(auth.admin, auth.membership.tenant_id, HEALTH_JOB_KEYS, recentSince),
    readRecentJobRuns(auth.admin, auth.membership.tenant_id, HEALTH_JOB_KEYS),
  ]);

  // Centro Salute ITS (Sprint 2): interpretazione EXECUTION STATUS -> HEALTH
  // STATUS, calcolata SOLO qui (server-side) — la UI si limita a renderizzare
  // health/reason/enabled/consecutive_failures/stale/stuck gia' decisi.
  const healthEvaluations = HEALTH_JOB_KEYS.map((jobKey) =>
    evaluateJobHealth({
      config: JOB_HEALTH_CONFIG[jobKey]!,
      runs: recentRunsByKey[jobKey] ?? [],
      now,
    })
  );
  const healthByKey = new Map(healthEvaluations.map((e) => [e.jobKey, e]));

  const jobHealthEnriched = jobHealth.map((entry) => {
    const evaluation = healthByKey.get(entry.job_key);
    return {
      ...entry,
      health: evaluation?.healthStatus ?? "unknown",
      reason: evaluation?.reason ?? "",
      technical_detail: evaluation?.technicalDetail ?? null,
      enabled: evaluation?.enabled ?? true,
      consecutive_failures: evaluation?.consecutiveFailures ?? 0,
      recent_warning_count: evaluation?.recentWarningCount ?? 0,
      stale: evaluation?.stale ?? false,
      stuck: evaluation?.stuck ?? false,
      notes: evaluation?.notes ?? [],
    };
  });

  return NextResponse.json({
    ok: true,
    generated_at: now.toISOString(),
    overall_health: computeOverallHealth(healthEvaluations),
    job_health_summary: summarizeJobHealthCounts(healthEvaluations),
    backup: {
      last: lastBackup,
      total_files: backupCount,
      retention_days: 15,
      bucket: BUCKET,
    },
    cron_jobs: CRON_JOBS,
    job_health: jobHealthEnriched,
    env: envStatus,
  });
}
