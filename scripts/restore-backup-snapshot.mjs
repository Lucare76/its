#!/usr/bin/env node

/**
 * ITS Disaster Recovery — RESTORE runner (drill / real recovery).
 *
 * Ripristina un backup applicativo JSON (prodotto da app/api/cron/backup/route.ts)
 * dentro un progetto Supabase DI RESTORE, SEPARATO dalla produzione.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PROTEZIONI (non disattivabili):
 *  - Legge SOLO env dedicate: RESTORE_SUPABASE_URL / RESTORE_SUPABASE_SERVICE_ROLE_KEY.
 *    NON usa mai NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY per scrivere.
 *  - Rifiuta di partire se la destinazione coincide con la produzione:
 *      · RESTORE_SUPABASE_URL === NEXT_PUBLIC_SUPABASE_URL
 *      · RESTORE_SUPABASE_SERVICE_ROLE_KEY === SUPABASE_SERVICE_ROLE_KEY
 *      · l'host contiene un project-ref di produzione noto (KNOWN_PROD_REFS)
 *  - Default: --dry-run. Nessuna scrittura senza --confirm-restore.
 *  - Fail-fast: al primo errore di tabella STOP, nessuna prosecuzione silenziosa.
 *  - Non stampa MAI il contenuto delle righe (niente PII): solo tabelle, conteggi,
 *    ordine, destinazione (ref mascherato), operazioni previste.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * USO:
 *   # 1) dry-run (default) — nessuna scrittura, stampa il piano
 *   RESTORE_SUPABASE_URL=https://<restore-ref>.supabase.co \
 *   RESTORE_SUPABASE_SERVICE_ROLE_KEY=<restore-service-role-key> \
 *   node scripts/restore-backup-snapshot.mjs --snapshot ./backup_2026-09-05.json
 *
 *   # 2) restore reale (richiede lo schema gia' presente nella destinazione)
 *   ... node scripts/restore-backup-snapshot.mjs --snapshot ./backup_2026-09-05.json --confirm-restore
 *
 *   # 3) verifica post-restore (read-only): conteggi + orfani nel DB di restore
 *   ... node scripts/restore-backup-snapshot.mjs --snapshot ./backup_2026-09-05.json --verify-only
 *
 * FLAG:
 *   --snapshot <path>       (obbligatorio) file JSON del backup locale
 *   --dry-run               (default) nessuna scrittura
 *   --confirm-restore       esegue le scritture (upsert per id)
 *   --verify-only           salta le scritture, esegue solo le verifiche post-restore
 *   --null-user-fks         durante il restore azzera le colonne che referenziano
 *                           auth.users (created_by_user_id, driver_user_id, user_id,
 *                           habitual_driver_user_id, by_user_id, assigned_by).
 *                           Necessario se il progetto di restore non ha gli stessi
 *                           auth.users. Le righe di memberships con user_id NULL
 *                           verranno RIFIUTATE dal DB (colonna NOT NULL): il restore
 *                           di memberships si fermera' (fail-fast) — atteso, documentato.
 *   --only <t1,t2>          restringe il restore/verify a queste tabelle
 *   --chunk <n>             righe per batch upsert (default 500)
 *   --allow-schema-drift    non abortire se una tabella del backup non esiste nella
 *                           destinazione: la salta e la segnala (default: STOP)
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { createClient } from "@supabase/supabase-js";

// ─── Project-ref di PRODUZIONE noti (host contiene questa stringa -> STOP) ────
// Ref letto da supabase/config.toml (project_id) e da .env al 2026-09-05.
const KNOWN_PROD_REFS = ["lnjgwxqblapmxabwiyrg"];

// ─── Ordine di ripristino (derivato dalle FK reali, vedi docs/disaster-recovery.md) ──
// Le tabelle in coda (services, assignments, tenant_bus_line_stops,
// tenant_bus_allocations, booking_group_stops) chiudono un ciclo FK e vanno
// SEMPRE dopo le altre. tenant_bus_line_stops <-> tenant_bus_allocations e' un
// ciclo reale: si inseriscono prima gli stop (con allocation_id che potrebbe
// puntare a righe non ancora presenti) -> la destinazione deve avere quelle FK
// DEFERRABLE, oppure si accetta un secondo passaggio di upsert che le risolve.
const RESTORE_ORDER = [
  "tenants",
  "agencies",
  "hotels",
  "driver_profiles",
  "vehicles",
  "memberships",
  "price_lists",
  "pricing_rules",
  "agency_invoices",
  "ferry_pickup_rules",
  "hotel_vehicle_limits",
  "driver_daily_availability",
  "bus_lot_configs",
  "tenant_bus_lines",
  "tenant_bus_units",
  "trip_groups",
  "booking_groups",
  "agency_bookings",
  "services",
  "assignments",
  "tenant_bus_line_stops",
  "tenant_bus_allocations",
  "booking_group_stops",
];

// Colonne che referenziano auth.users (azzerate con --null-user-fks).
const USER_FK_COLUMNS = new Set([
  "created_by_user_id",
  "driver_user_id",
  "by_user_id",
  "user_id",
  "habitual_driver_user_id",
  "assigned_by",
]);

// ─── CLI ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { dryRun: true, confirmRestore: false, verifyOnly: false, nullUserFks: false, allowSchemaDrift: false, chunk: 500, snapshot: null, only: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--confirm-restore") args.confirmRestore = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--verify-only") args.verifyOnly = true;
    else if (a === "--null-user-fks") args.nullUserFks = true;
    else if (a === "--allow-schema-drift") args.allowSchemaDrift = true;
    else if (a === "--snapshot") args.snapshot = argv[++i];
    else if (a === "--only") args.only = String(argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--chunk") args.chunk = Math.max(1, Number(argv[++i]) || 500);
    else { console.error(`Flag sconosciuto: ${a}`); process.exit(2); }
  }
  if (args.confirmRestore) args.dryRun = false;
  return args;
}

function maskRef(url) {
  const m = String(url || "").match(/https:\/\/([a-z0-9]{4})[a-z0-9]*\.supabase\.co/i);
  return m ? `https://${m[1]}***.supabase.co` : "(url non riconosciuto)";
}

function die(msg) {
  console.error(`\n🔴 STOP — ${msg}\n`);
  process.exit(1);
}

// ─── Guardie ambiente ───────────────────────────────────────────────────────
function assertNotProduction() {
  const restoreUrl = (process.env.RESTORE_SUPABASE_URL ?? "").trim().replace(/^["']|["']$/g, "");
  const restoreKey = (process.env.RESTORE_SUPABASE_SERVICE_ROLE_KEY ?? "").trim().replace(/^["']|["']$/g, "");
  const prodUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim().replace(/^["']|["']$/g, "");
  const prodKey = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim().replace(/^["']|["']$/g, "");

  if (!restoreUrl || !restoreKey) {
    die("mancano RESTORE_SUPABASE_URL e/o RESTORE_SUPABASE_SERVICE_ROLE_KEY. Questo script NON usa mai le env di produzione per scrivere.");
  }
  if (!/^https:\/\/[a-z0-9]+\.supabase\.co\/?$/i.test(restoreUrl)) {
    die(`RESTORE_SUPABASE_URL non ha il formato atteso https://<ref>.supabase.co : ${maskRef(restoreUrl)}`);
  }
  if (prodUrl && restoreUrl.replace(/\/$/, "") === prodUrl.replace(/\/$/, "")) {
    die("RESTORE_SUPABASE_URL coincide con NEXT_PUBLIC_SUPABASE_URL (produzione).");
  }
  if (prodKey && restoreKey === prodKey) {
    die("RESTORE_SUPABASE_SERVICE_ROLE_KEY coincide con SUPABASE_SERVICE_ROLE_KEY (produzione).");
  }
  for (const ref of KNOWN_PROD_REFS) {
    if (restoreUrl.includes(ref)) die(`RESTORE_SUPABASE_URL contiene un project-ref di produzione noto (${ref}).`);
  }
  return { restoreUrl: restoreUrl.replace(/\/$/, ""), restoreKey };
}

// ─── Snapshot ───────────────────────────────────────────────────────────────
async function loadSnapshot(path) {
  if (!path) die("--snapshot <path> e' obbligatorio.");
  let raw;
  try { raw = await readFile(path, "utf8"); } catch (e) { die(`impossibile leggere ${path}: ${e.message}`); }
  const bytes = Buffer.byteLength(raw, "utf8");
  let snap;
  try { snap = JSON.parse(raw); } catch (e) { die(`JSON non valido: ${e.message}`); }
  if (!snap || typeof snap !== "object" || !snap.data || typeof snap.data !== "object") die("snapshot senza campo 'data' valido.");
  if (Array.isArray(snap.errors) && snap.errors.length > 0) {
    console.error(`⚠️  Lo snapshot dichiara ${snap.errors.length} errori di esportazione:`);
    for (const e of snap.errors) console.error(`   - ${String(e).slice(0, 200)}`);
    die("snapshot con errori di esportazione: NON usarlo per un restore.");
  }
  return { snap, bytes, path };
}

function stripUserFks(rows) {
  let touched = 0;
  const out = rows.map((row) => {
    if (!row || typeof row !== "object") return row;
    let changed = false;
    const copy = { ...row };
    for (const k of Object.keys(copy)) {
      if (USER_FK_COLUMNS.has(k) && copy[k] != null) { copy[k] = null; changed = true; }
    }
    if (changed) touched += 1;
    return copy;
  });
  return { rows: out, touched };
}

// ─── Restore ────────────────────────────────────────────────────────────────
async function tableExists(client, table) {
  const { error } = await client.from(table).select("*", { count: "exact", head: true }).limit(1);
  if (!error) return true;
  const msg = String(error.message || "").toLowerCase();
  if (msg.includes("does not exist") || msg.includes("could not find the table") || msg.includes("schema cache")) return false;
  throw new Error(`probe ${table}: ${error.message}`);
}

async function restore({ client, snap, order, args }) {
  const planned = [];
  for (const table of order) {
    const rows = Array.isArray(snap.data?.[table]) ? snap.data[table] : null;
    if (rows == null) { planned.push({ table, rows: 0, note: "assente nello snapshot — skip" }); continue; }
    planned.push({ table, rows: rows.length });
  }

  console.log("\n─── PIANO DI RESTORE ───────────────────────────────────────");
  console.log(`Destinazione:        ${maskRef(args._restoreUrl)}`);
  console.log(`Snapshot:            ${basename(args.snapshot)}  (generato: ${snap.generated_at ?? "?"})`);
  console.log(`Modalita':           ${args.dryRun ? "DRY-RUN (nessuna scrittura)" : "RESTORE REALE (upsert per id)"}`);
  console.log(`Azzera FK auth.users: ${args.nullUserFks ? "SI (--null-user-fks)" : "NO"}`);
  console.log(`Chunk:               ${args.chunk}`);
  console.log("Ordine / righe:");
  for (const p of planned) console.log(`  ${String(p.rows).padStart(7)}  ${p.table}${p.note ? "  · " + p.note : ""}`);
  const totalRows = planned.reduce((s, p) => s + p.rows, 0);
  console.log(`  ${String(totalRows).padStart(7)}  TOTALE`);
  console.log("───────────────────────────────────────────────────────────\n");

  if (args.dryRun) {
    console.log("DRY-RUN: nessuna scrittura effettuata. Rilancia con --confirm-restore per eseguire.\n");
    return { wrote: false, results: planned };
  }

  const results = [];
  for (const table of order) {
    let rows = Array.isArray(snap.data?.[table]) ? snap.data[table] : null;
    if (rows == null) { results.push({ table, inserted: 0, skipped: 0, note: "assente nello snapshot" }); continue; }

    let exists;
    try { exists = await tableExists(client, table); }
    catch (e) { die(`impossibile verificare l'esistenza di ${table}: ${e.message}`); }
    if (!exists) {
      if (args.allowSchemaDrift) { results.push({ table, inserted: 0, skipped: rows.length, note: "TABELLA ASSENTE nella destinazione (schema drift) — saltata" }); console.warn(`⚠️  ${table}: assente nella destinazione, saltata (--allow-schema-drift)`); continue; }
      die(`la tabella '${table}' esiste nel backup ma NON nella destinazione (schema drift). Allinea le migration o rilancia con --allow-schema-drift.`);
    }

    let userFkTouched = 0;
    if (args.nullUserFks) { const r = stripUserFks(rows); rows = r.rows; userFkTouched = r.touched; }

    let inserted = 0;
    for (let i = 0; i < rows.length; i += args.chunk) {
      const batch = rows.slice(i, i + args.chunk);
      const { error } = await client.from(table).upsert(batch, { onConflict: "id", ignoreDuplicates: false });
      if (error) {
        console.error(`\n🔴 ERRORE su ${table} (righe ${i}..${i + batch.length - 1}): ${error.message}`);
        console.error(`   Restore INTERROTTO (fail-fast). Tabelle completate: ${results.map((r) => r.table).join(", ") || "(nessuna)"}\n`);
        process.exit(1);
      }
      inserted += batch.length;
      process.stdout.write(`\r  ${table}: ${inserted}/${rows.length}   `);
    }
    process.stdout.write("\n");
    results.push({ table, inserted, skipped: 0, userFkTouched });
  }
  return { wrote: true, results };
}

// ─── Verifica post-restore (read-only sul DB di restore) ─────────────────────
async function verify({ client, snap, order }) {
  console.log("\n─── VERIFICA POST-RESTORE (read-only) ─────────────────────");
  const rowChecks = [];
  for (const table of order) {
    const expected = Array.isArray(snap.data?.[table]) ? snap.data[table].length : null;
    if (expected == null) continue;
    const { count, error } = await client.from(table).select("*", { count: "exact", head: true });
    if (error) { rowChecks.push({ table, expected, actual: "ERRORE", ok: false, note: error.message }); continue; }
    rowChecks.push({ table, expected, actual: count ?? 0, ok: (count ?? 0) >= expected });
  }
  console.log("Conteggi  (atteso = righe nello snapshot, reale = righe nel DB di restore):");
  for (const c of rowChecks) {
    const flag = c.ok ? "✅" : "❌";
    console.log(`  ${flag}  ${c.table.padEnd(24)} atteso=${String(c.expected).padStart(6)}  reale=${String(c.actual).padStart(6)}${c.note ? "  · " + c.note : ""}`);
  }

  const idSet = async (table, col = "id") => {
    const ids = new Set();
    let from = 0;
    for (;;) {
      const { data, error } = await client.from(table).select(col).range(from, from + 999);
      if (error) throw new Error(`${table}.${col}: ${error.message}`);
      if (!data || data.length === 0) break;
      for (const r of data) if (r[col] != null) ids.add(r[col]);
      if (data.length < 1000) break;
      from += 1000;
    }
    return ids;
  };

  const fkChecks = [];
  try {
    const [serviceIds, tenantIds, busUnitIds, groupIds] = await Promise.all([
      idSet("services"), idSet("tenants"), idSet("tenant_bus_units"), idSet("booking_groups"),
    ]);
    const countOrphans = async (table, col, universe) => {
      let from = 0, orphans = 0, total = 0;
      for (;;) {
        const { data, error } = await client.from(table).select(`id, ${col}`).range(from, from + 999);
        if (error) throw new Error(`${table}.${col}: ${error.message}`);
        if (!data || data.length === 0) break;
        for (const r of data) { total += 1; if (r[col] != null && !universe.has(r[col])) orphans += 1; }
        if (data.length < 1000) break;
        from += 1000;
      }
      return { total, orphans };
    };
    fkChecks.push(["assignments.service_id -> services", await countOrphans("assignments", "service_id", serviceIds)]);
    fkChecks.push(["services.tenant_id -> tenants", await countOrphans("services", "tenant_id", tenantIds)]);
    fkChecks.push(["tenant_bus_allocations.service_id -> services", await countOrphans("tenant_bus_allocations", "service_id", serviceIds)]);
    fkChecks.push(["tenant_bus_allocations.bus_unit_id -> tenant_bus_units", await countOrphans("tenant_bus_allocations", "bus_unit_id", busUnitIds)]);
    fkChecks.push(["booking_group_stops.booking_group_id -> booking_groups", await countOrphans("booking_group_stops", "booking_group_id", groupIds)]);
    fkChecks.push(["services.booking_group_id -> booking_groups", await countOrphans("services", "booking_group_id", groupIds)]);
  } catch (e) {
    console.log(`  ⚠️  Controllo FK interrotto: ${e.message}`);
  }
  console.log("\nForeign key (orfani nel DB di restore):");
  for (const [label, res] of fkChecks) {
    const flag = res.orphans === 0 ? "✅" : "❌";
    console.log(`  ${flag}  ${label.padEnd(52)} orfani=${res.orphans} / ${res.total}`);
  }
  console.log("───────────────────────────────────────────────────────────\n");

  const allRowsOk = rowChecks.every((c) => c.ok);
  const allFkOk = fkChecks.length > 0 && fkChecks.every(([, r]) => r.orphans === 0);
  return { allRowsOk, allFkOk, rowChecks, fkChecks };
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { restoreUrl, restoreKey } = assertNotProduction();
  args._restoreUrl = restoreUrl;

  const { snap, bytes } = await loadSnapshot(args.snapshot);

  console.log("🧪 ITS DISASTER RECOVERY — RESTORE RUNNER");
  console.log(`   Destinazione:  ${maskRef(restoreUrl)}  (NON produzione — guardie superate)`);
  console.log(`   Snapshot:      ${basename(args.snapshot)}  ${(bytes / 1024 / 1024).toFixed(2)} MiB`);
  console.log(`   Generato:      ${snap.generated_at ?? "?"}`);
  console.log(`   Tabelle nello snapshot: ${Object.keys(snap.data).length}`);

  const client = createClient(restoreUrl, restoreKey, { auth: { persistSession: false } });

  let order = RESTORE_ORDER.filter((t) => Array.isArray(snap.data?.[t]));
  const extraInSnapshot = Object.keys(snap.data).filter((t) => !RESTORE_ORDER.includes(t));
  if (extraInSnapshot.length) {
    console.log(`   ⚠️  Tabelle nello snapshot senza posizione nell'ordine di restore (in coda): ${extraInSnapshot.join(", ")}`);
    order = [...order, ...extraInSnapshot];
  }
  if (args.only) order = order.filter((t) => args.only.includes(t));

  if (args.verifyOnly) {
    const v = await verify({ client, snap, order });
    console.log(v.allRowsOk && v.allFkOk ? "🟢 VERIFICA POST-RESTORE: PASS\n" : "🔴 VERIFICA POST-RESTORE: FAIL\n");
    process.exit(v.allRowsOk && v.allFkOk ? 0 : 1);
  }

  const t0 = Date.now();
  const { wrote } = await restore({ client, snap, order, args });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  if (!wrote) process.exit(0);

  console.log(`\n✅ Restore scritture completate in ${elapsed}s. Avvio verifica post-restore...\n`);
  const v = await verify({ client, snap, order });
  console.log(`RTO parziale (solo scrittura+verifica dati): ${elapsed}s`);
  console.log(v.allRowsOk && v.allFkOk ? "🟢 RESTORE + VERIFICA: PASS\n" : "🟡 RESTORE OK ma VERIFICA con scostamenti (vedi sopra)\n");
  process.exit(0);
}

main().catch((e) => { console.error(`\n🔴 Restore runner error: ${e?.message ?? e}\n`); process.exit(2); });
