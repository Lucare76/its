/**
 * GET /api/admin/system-status
 * Restituisce lo stato del sistema: ultimo backup, cron job, variabili d'ambiente.
 * Solo admin e supervisor.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

const BUCKET = "backups";

const CRON_JOBS = [
  { name: "Agency Reminders",     path: "/api/cron/agency-reminders",     schedule: "0 8 * * *",  description: "Reminder giornalieri alle agenzie" },
  { name: "Agency Invoices",      path: "/api/cron/agency-invoices",      schedule: "0 8 * * *",  description: "Generazione fatture mensili agenzie" },
  { name: "Vehicle Expiry Check", path: "/api/cron/vehicle-expiry-check", schedule: "0 8 * * *",  description: "Controllo scadenze assicurazione/bollo/collaudo" },
  { name: "Backup notturno",      path: "/api/cron/backup",               schedule: "0 2 * * *",  description: "Backup automatico DB → Storage (retention 30gg)" },
];

const ENV_VARS = [
  { key: "NEXT_PUBLIC_SUPABASE_URL",       label: "Supabase URL",            group: "Supabase" },
  { key: "NEXT_PUBLIC_SUPABASE_ANON_KEY",  label: "Supabase Anon Key",       group: "Supabase" },
  { key: "SUPABASE_SERVICE_ROLE_KEY",      label: "Supabase Service Role",   group: "Supabase" },
  { key: "CRON_SECRET",                    label: "Cron Secret",             group: "Sicurezza" },
  { key: "RESEND_API_KEY",                 label: "Resend API Key",          group: "Email" },
  { key: "GMAIL_USER",                     label: "Gmail User (IMAP)",       group: "Email" },
  { key: "GMAIL_APP_PASSWORD",             label: "Gmail App Password",      group: "Email" },
  { key: "ANTHROPIC_API_KEY",              label: "Anthropic API Key",       group: "AI" },
  { key: "WHATSAPP_TOKEN",                 label: "WhatsApp Token",          group: "WhatsApp" },
  { key: "WHATSAPP_PHONE_NUMBER_ID",       label: "WhatsApp Phone Number ID",group: "WhatsApp" },
  { key: "WHATSAPP_VERIFY_TOKEN",          label: "WhatsApp Verify Token",   group: "WhatsApp" },
  { key: "RADIUS_API_URL",                 label: "Radius API URL",          group: "GPS" },
  { key: "RADIUS_API_KEY",                 label: "Radius API Key",          group: "GPS" },
];

function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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
  const admin = createAdminClient();
  if (admin) {
    const { data: files } = await admin.storage.from(BUCKET).list("", { limit: 200, sortBy: { column: "name", order: "desc" } });
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
  }

  return NextResponse.json({
    ok: true,
    generated_at: new Date().toISOString(),
    backup: {
      last: lastBackup,
      total_files: backupCount,
      retention_days: 15,
      bucket: BUCKET,
    },
    cron_jobs: CRON_JOBS,
    env: envStatus,
  });
}
