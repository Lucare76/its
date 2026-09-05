#!/usr/bin/env node

/**
 * ITS Disaster Recovery — backup snapshot verifier.
 *
 * READ-ONLY: validates a local JSON backup file. It never connects to
 * Supabase and never writes data.
 *
 * Usage:
 *   node scripts/verify-backup-snapshot.mjs path/to/backup_YYYY-MM-DD.json
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";

const file = process.argv[2];

if (!file) {
  console.error("Usage: node scripts/verify-backup-snapshot.mjs path/to/backup_YYYY-MM-DD.json");
  process.exit(2);
}

const REQUIRED_TABLES = [
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
];

function fail(message, failures) {
  failures.push(message);
}

try {
  const raw = await readFile(file, "utf8");
  const bytes = Buffer.byteLength(raw, "utf8");
  const failures = [];
  const warnings = [];

  if (bytes === 0) fail("file vuoto", failures);

  let snapshot;
  try {
    snapshot = JSON.parse(raw);
  } catch (error) {
    fail(`JSON non valido: ${error instanceof Error ? error.message : String(error)}`, failures);
  }

  if (snapshot && typeof snapshot === "object") {
    if (!snapshot.generated_at || Number.isNaN(Date.parse(snapshot.generated_at))) {
      fail("generated_at mancante o non valido", failures);
    }

    if (!Array.isArray(snapshot.tables)) {
      fail("tables mancante o non array", failures);
    }

    if (!snapshot.data || typeof snapshot.data !== "object" || Array.isArray(snapshot.data)) {
      fail("data mancante o non oggetto", failures);
    }

    if (!snapshot.row_counts || typeof snapshot.row_counts !== "object" || Array.isArray(snapshot.row_counts)) {
      fail("row_counts mancante o non oggetto", failures);
    }

    const declaredTables = new Set(Array.isArray(snapshot.tables) ? snapshot.tables : []);

    for (const table of REQUIRED_TABLES) {
      if (!declaredTables.has(table)) {
        fail(`tabella richiesta non dichiarata: ${table}`, failures);
        continue;
      }

      const rows = snapshot.data?.[table];
      if (!Array.isArray(rows)) {
        fail(`data.${table} non e' un array`, failures);
        continue;
      }

      const declaredCount = snapshot.row_counts?.[table];
      if (!Number.isInteger(declaredCount) || declaredCount < 0) {
        fail(`row_counts.${table} non valido`, failures);
      } else if (declaredCount !== rows.length) {
        fail(`conteggio ${table} incoerente: dichiarato=${declaredCount}, reale=${rows.length}`, failures);
      }
    }

    if (Array.isArray(snapshot.errors) && snapshot.errors.length > 0) {
      fail(`backup contiene errori di esportazione (${snapshot.errors.length})`, failures);
    }

    const services = Array.isArray(snapshot.data?.services) ? snapshot.data.services : [];
    const assignments = Array.isArray(snapshot.data?.assignments) ? snapshot.data.assignments : [];
    const tenants = Array.isArray(snapshot.data?.tenants) ? snapshot.data.tenants : [];

    if (tenants.length === 0) fail("nessun tenant nel backup", failures);
    if (services.length === 0) warnings.push("nessun servizio nel backup");

    const serviceIds = new Set(services.map((row) => row?.id).filter(Boolean));
    const orphanAssignments = assignments.filter((row) => row?.service_id && !serviceIds.has(row.service_id));
    if (orphanAssignments.length > 0) {
      fail(`assignments orfani rispetto ai services: ${orphanAssignments.length}`, failures);
    }

    const tenantIds = new Set(tenants.map((row) => row?.id).filter(Boolean));
    const scopedTables = ["services", "hotels", "memberships", "agencies", "assignments", "vehicles", "trip_groups", "driver_profiles"];
    let unknownTenantRows = 0;
    for (const table of scopedTables) {
      const rows = Array.isArray(snapshot.data?.[table]) ? snapshot.data[table] : [];
      for (const row of rows) {
        if (row?.tenant_id && !tenantIds.has(row.tenant_id)) unknownTenantRows += 1;
      }
    }
    if (unknownTenantRows > 0) {
      fail(`righe con tenant_id sconosciuto: ${unknownTenantRows}`, failures);
    }
  }

  console.log(`Backup: ${basename(file)}`);
  console.log(`Bytes: ${bytes}`);

  if (warnings.length > 0) {
    console.log("\nWARNINGS");
    for (const warning of warnings) console.log(`- ${warning}`);
  }

  if (failures.length > 0) {
    console.error("\nHARD FAILURES");
    for (const failure of failures) console.error(`- ${failure}`);
    console.error("\n🔴 BACKUP SNAPSHOT: FAIL");
    process.exit(1);
  }

  console.log("\n🟢 BACKUP SNAPSHOT: PASS");
  process.exit(0);
} catch (error) {
  console.error(`Backup verifier error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
