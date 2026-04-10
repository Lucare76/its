/**
 * GET|POST /api/cron/backup
 *
 * Esporta le tabelle principali in JSON e salva su Supabase Storage
 * nel bucket "backups" con nome backup_YYYY-MM-DD.json
 * Schedulato ogni notte alle 02:00.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const maxDuration = 120;

const TABLES = [
  "services",
  "hotels",
  "memberships",
  "agencies",
  "assignments",
  "vehicles",
  "pricing_rules",
  "price_lists",
  "invoices",
  "tenants",
] as const;

const BUCKET = "backups";
const RETENTION_DAYS = 15;

function hasCronAuth(request: NextRequest) {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  return request.headers.get("authorization") === `Bearer ${expected}`;
}

function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase env mancante");
  return createClient(url, key, { auth: { persistSession: false } });
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

async function runBackup() {
  const admin = createAdminClient();
  const today = new Date().toISOString().slice(0, 10);
  const snapshot: Record<string, unknown[]> = {};
  const errors: string[] = [];

  // Scarica ogni tabella
  for (const table of TABLES) {
    const { data, error } = await admin.from(table).select("*").limit(50000);
    if (error) {
      errors.push(`${table}: ${error.message}`);
    } else {
      snapshot[table] = data ?? [];
    }
  }

  const payload = JSON.stringify({
    generated_at: new Date().toISOString(),
    tables: Object.keys(snapshot),
    errors: errors.length > 0 ? errors : undefined,
    data: snapshot,
  });

  const filename = `backup_${today}.json`;
  const bytes = Buffer.from(payload, "utf-8");

  // Salva su Supabase Storage
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

  return {
    ok: true,
    filename,
    tables_exported: Object.keys(snapshot).length,
    rows_total: Object.values(snapshot).reduce((s, rows) => s + rows.length, 0),
    table_errors: errors.length > 0 ? errors : undefined,
    purged: purge.deleted.length > 0 ? purge.deleted : undefined,
    purge_errors: purge.errors.length > 0 ? purge.errors : undefined,
  };
}

async function handler(request: NextRequest) {
  if (!hasCronAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runBackup();
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
