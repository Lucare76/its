/**
 * GET|POST /api/cron/backup
 *
 * Esporta le tabelle principali in JSON e salva su Supabase Storage
 * nel bucket "backups" con nome backup_YYYY-MM-DD.json (backup primario,
 * retention 15 giorni). Schedulato ogni notte alle 02:00.
 *
 * Disaster Recovery V2: dopo il successo del backup primario, copia lo
 * stesso JSON su Cloudflare R2 (off-provider, bucket privato, retention
 * applicativa 90 giorni — vedi lib/server/r2-backup.ts). Il backup primario
 * e la copia offsite hanno stati indipendenti: un fallimento R2 non tocca
 * mai il backup Supabase gia' caricato, non causa retry/rollback del
 * primario e non esegue mai un restore.
 *
 * Usa paginazione per tabelle con più di 1000 righe (cap REST API Supabase).
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { withJobHealth } from "@/lib/server/job-health";
import { uploadOffsiteBackup, purgeOldOffsiteBackups, type R2UploadResult } from "@/lib/server/r2-backup";

export const runtime = "nodejs";
export const maxDuration = 300;

const TABLES = [
  "services",
  "hotels",
  "memberships",
  "agencies",
  "assignments",
  "vehicles",
  "pricing_rules",
  "price_lists",
  "agency_invoices",
  "tenants",
  "trip_groups",
  "driver_profiles",
  "tenant_bus_lines",
  "tenant_bus_line_stops",
  "tenant_bus_units",
  "tenant_bus_allocations",
  "booking_groups",
  "booking_group_stops",
  "agency_bookings",
  "bus_lot_configs",
  "bus_import_pending",
  "ferry_pickup_rules",
  "hotel_vehicle_limits",
  "driver_availability",
] as const;

const BUCKET = "backups";
const RETENTION_DAYS = 15;
const PAGE_SIZE = 1000;

function hasCronAuth(request: NextRequest) {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  return request.headers.get("authorization") === `Bearer ${expected}`;
}

function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/^["']|["']$/g, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim().replace(/^["']|["']$/g, "");
  if (!url || !key) throw new Error("Supabase env mancante");
  return createClient(url, key, { auth: { persistSession: false } });
}

async function fetchAllRows(
  admin: ReturnType<typeof createAdminClient>,
  table: string
): Promise<{ rows: unknown[]; error?: string }> {
  const rows: unknown[] = [];
  let offset = 0;

  while (true) {
    const { data, error } = await admin
      .from(table)
      .select("*")
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) return { rows, error: error.message };
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return { rows };
}

async function purgeOldBackups(admin: ReturnType<typeof createAdminClient>): Promise<{ deleted: string[]; errors: string[] }> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
  const cutoffIso = cutoff.toISOString().slice(0, 10);

  const { data: files, error } = await admin.storage.from(BUCKET).list("", { limit: 200 });
  if (error || !files) return { deleted: [], errors: [error?.message ?? "lista file fallita"] };

  const old = files.filter((f) => {
    const match = f.name.match(/^backup_(\d{4}-\d{2}-\d{2})\.json$/);
    return match && match[1] < cutoffIso;
  });

  if (old.length === 0) return { deleted: [], errors: [] };

  const { error: removeError } = await admin.storage.from(BUCKET).remove(old.map((f) => f.name));
  if (removeError) return { deleted: [], errors: [removeError.message] };

  return { deleted: old.map((f) => f.name), errors: [] };
}

async function runBackup(admin: ReturnType<typeof createAdminClient>) {
  const today = new Date().toISOString().slice(0, 10);
  const snapshot: Record<string, unknown[]> = {};
  const errors: string[] = [];

  for (const table of TABLES) {
    const { rows, error } = await fetchAllRows(admin, table);
    if (error) {
      errors.push(`${table}: ${error}`);
    } else {
      snapshot[table] = rows;
    }
  }

  const rowTotals: Record<string, number> = {};
  for (const [t, rows] of Object.entries(snapshot)) rowTotals[t] = rows.length;

  const payload = JSON.stringify({
    generated_at: new Date().toISOString(),
    tables: Object.keys(snapshot),
    row_counts: rowTotals,
    errors: errors.length > 0 ? errors : undefined,
    data: snapshot,
  });

  const filename = `backup_${today}.json`;
  const bytes = Buffer.from(payload, "utf-8");

  const { error: uploadError } = await admin.storage
    .from(BUCKET)
    .upload(filename, bytes, {
      contentType: "application/json",
      upsert: true,
    });

  if (uploadError) {
    return {
      ok: false,
      error: `Upload fallito: ${uploadError.message}`,
      table_errors: errors,
    };
  }

  const purge = await purgeOldBackups(admin);

  // Disaster Recovery V2 — copia off-provider su Cloudflare R2. Gira SOLO
  // dopo il successo dell'upload Supabase sopra, e un suo fallimento non
  // tocca in alcun modo il backup primario gia' caricato (nessun rollback,
  // nessuna cancellazione, nessun retry sul primario).
  const offsiteUpload = await uploadOffsiteBackup(filename, bytes);
  const offsitePurge = offsiteUpload.status === "success" ? await purgeOldOffsiteBackups() : { deleted: [], errors: [] };

  return {
    ok: true,
    filename,
    tables_exported: Object.keys(snapshot).length,
    row_counts: rowTotals,
    rows_total: Object.values(snapshot).reduce((s, rows) => s + rows.length, 0),
    table_errors: errors.length > 0 ? errors : undefined,
    purged: purge.deleted.length > 0 ? purge.deleted : undefined,
    purge_errors: purge.errors.length > 0 ? purge.errors : undefined,
    offsite_backup: toOffsiteBackupSummary(offsiteUpload),
    offsite_purge_errors: offsitePurge.errors.length > 0 ? offsitePurge.errors : undefined,
  };
}

/**
 * Proietta l'esito interno di uploadOffsiteBackup nella forma pubblica del
 * risultato del job (provider esplicito, mai credenziali/endpoint con
 * token). "verified" e' sempre presente cosi' i consumer possono distinguere
 * un semplice PutObject riuscito senza verifica da un HeadObject confermato.
 */
function toOffsiteBackupSummary(result: R2UploadResult) {
  if (result.status === "success") {
    return {
      provider: "cloudflare-r2" as const,
      bucket: result.bucket,
      key: result.key,
      status: result.status,
      size_bytes: result.size_bytes,
      verified: result.verified,
    };
  }
  if (result.status === "failed") {
    return {
      provider: "cloudflare-r2" as const,
      bucket: result.bucket,
      key: result.key,
      status: result.status,
      verified: result.verified,
      error: result.error,
    };
  }
  return {
    provider: "cloudflare-r2" as const,
    status: result.status,
    verified: result.verified,
    error: result.error,
  };
}

async function handler(request: NextRequest) {
  if (!hasCronAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const admin = createAdminClient();
    const result = await withJobHealth({
      admin,
      jobKey: "backup",
      jobName: "Backup automatico",
      source: "api/cron/backup",
      metadata: { tables_configured: TABLES.length, retention_days: RETENTION_DAYS }
    }, async () => {
      const backup = await runBackup(admin);
      const tableErrors = Array.isArray(backup.table_errors) ? backup.table_errors.length : 0;
      const purgeErrors = Array.isArray(backup.purge_errors) ? backup.purge_errors.length : 0;
      // Offsite (R2) fallito o non configurato non fa MAI fallire il job (il
      // backup primario e' gia' salvo su Supabase), ma non deve nemmeno
      // risultare "tutto verde": conta come warning, coerente con la regola
      // "primary success + offsite failed -> stato complessivo non healthy".
      const offsiteProblem = backup.offsite_backup?.status === "failed" || backup.offsite_backup?.status === "skipped" ? 1 : 0;
      const offsitePurgeErrors = Array.isArray(backup.offsite_purge_errors) ? backup.offsite_purge_errors.length : 0;
      const warningCount = tableErrors + purgeErrors + offsiteProblem + offsitePurgeErrors;
      return {
        result: backup,
        status: backup.ok ? (warningCount > 0 ? "warning" : "success") : "failed",
        counts: {
          processedCount: typeof backup.tables_exported === "number" ? backup.tables_exported : TABLES.length,
          successCount: typeof backup.tables_exported === "number" ? backup.tables_exported : 0,
          failedCount: tableErrors + (backup.ok ? 0 : 1),
          warningCount
        },
        errorMessage: backup.ok ? null : backup.error,
        metadata: {
          filename: backup.filename,
          tables_exported: backup.tables_exported,
          rows_total: backup.rows_total,
          row_counts: backup.row_counts,
          table_errors: backup.table_errors,
          purged_count: Array.isArray(backup.purged) ? backup.purged.length : 0,
          purge_errors: backup.purge_errors,
          offsite_backup: backup.offsite_backup,
          offsite_purge_errors: backup.offsite_purge_errors
        }
      };
    });
    return NextResponse.json(result, { status: result.ok ? 200 : 500 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  return handler(request);
}

export async function POST(request: NextRequest) {
  return handler(request);
}
