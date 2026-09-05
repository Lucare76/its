#!/usr/bin/env node
/**
 * ITS Sunday Torture V1 — verificatore READ-ONLY.
 *
 * Non crea, modifica o elimina dati. Legge soltanto i servizi marcati
 * is_test_data=true per tenant/data, più assignments e allocazioni bus
 * riferite a quei servizi, e produce PASS/FAIL su invarianti dure.
 *
 * Uso:
 *   pnpm exec tsx scripts/verify-test-sunday.mjs
 *   pnpm exec tsx scripts/verify-test-sunday.mjs --date=2025-10-12
 *   pnpm exec tsx scripts/verify-test-sunday.mjs --min-services=400
 */

import { readFileSync } from "fs";

const DEFAULT_DATE = "2025-10-12";
const DEFAULT_TENANT = "d200b89a-64c7-4f8d-a430-95a33b83047a";

const arg = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const DATE = arg("date") || DEFAULT_DATE;
const TENANT_ID = arg("tenant") || DEFAULT_TENANT;
const EXPECTED_MIN = Number(arg("min-services") || 400);

const envContent = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const getEnv = (key) => {
  const match = envContent.match(new RegExp(`^${key}=(.+)$`, "m"));
  return match ? match[1].trim().replace(/^["']|["']$/g, "") : null;
};

const SUPABASE_URL = getEnv("NEXT_PUBLIC_SUPABASE_URL");
const SERVICE_KEY = getEnv("SUPABASE_SERVICE_ROLE_KEY");

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Errore: NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY richiesti in .env.local");
  process.exit(2);
}

async function get(path) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      Accept: "application/json",
    },
  });
  if (!response.ok) throw new Error(`Supabase GET ${response.status}: ${await response.text()}`);
  return response.json();
}

function chunks(values, size = 50) {
  const out = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

async function getForServiceIds(table, select, ids) {
  const rows = [];
  for (const chunk of chunks(ids)) {
    const encodedIds = chunk.join(",");
    const part = await get(`/${table}?select=${select}&tenant_id=eq.${TENANT_ID}&service_id=in.(${encodedIds})&limit=5000`);
    rows.push(...part);
  }
  return rows;
}

async function main() {
  console.log("\n🔥 ITS SUNDAY TORTURE V1 — READ ONLY");
  console.log(`   Tenant: ${TENANT_ID}`);
  console.log(`   Data:   ${DATE}`);
  console.log(`   Minimo: ${EXPECTED_MIN} servizi\n`);

  const services = await get(
    `/services?select=id,tenant_id,date,pax,direction,status,is_test_data&tenant_id=eq.${TENANT_ID}&date=eq.${DATE}&is_test_data=eq.true&limit=2000`,
  );

  if (services.length === 0) {
    console.error("❌ Nessun servizio di test trovato. Prima prepara la giornata con seed:test-sunday (preferibilmente su ambiente non-production).\n");
    process.exit(1);
  }

  const ids = services.map((service) => service.id);
  const assignments = await getForServiceIds(
    "assignments",
    "id,tenant_id,service_id,driver_user_id,vehicle_label,locked_by_operator",
    ids,
  );
  const busAllocations = await getForServiceIds(
    "tenant_bus_allocations",
    "id,tenant_id,service_id,bus_unit_id,pax_assigned",
    ids,
  );
  const busUnits = await get(
    `/tenant_bus_units?select=id,tenant_id,label,capacity&tenant_id=eq.${TENANT_ID}&limit=500`,
  );

  const { evaluateItsSundayTorture } = await import("../lib/server/its-sunday-torture.ts");
  const report = evaluateItsSundayTorture({
    tenantId: TENANT_ID,
    date: DATE,
    expectedMinServices: EXPECTED_MIN,
    services,
    assignments,
    busAllocations,
    busUnits,
  });

  console.log("RISULTATO");
  console.log(`  Servizi:         ${report.stats.services}`);
  console.log(`  PAX:             ${report.stats.pax}`);
  console.log(`  Arrivi:          ${report.stats.arrivalServices}`);
  console.log(`  Partenze:        ${report.stats.departureServices}`);
  console.log(`  Assignments:     ${report.stats.assignments}`);
  console.log(`  Allocazioni bus: ${report.stats.busAllocations}`);
  console.log(`  Bus censiti:     ${report.stats.busUnits}\n`);

  if (report.hardFailures.length) {
    console.log(`❌ HARD FAILURES (${report.hardFailures.length})`);
    for (const issue of report.hardFailures) console.log(`  [${issue.code}] ${issue.message}`);
  } else {
    console.log("✅ Nessuna violazione dura");
  }

  if (report.warnings.length) {
    console.log(`\n⚠️ WARNING (${report.warnings.length})`);
    for (const issue of report.warnings.slice(0, 30)) console.log(`  [${issue.code}] ${issue.message}`);
    if (report.warnings.length > 30) console.log(`  ... altri ${report.warnings.length - 30} warning`);
  }

  console.log(report.passed ? "\n🟢 DOMENICA ITS: PASS\n" : "\n🔴 DOMENICA ITS: FAIL\n");
  process.exit(report.passed ? 0 : 1);
}

main().catch((error) => {
  console.error("\n❌ Torture test interrotto:", error);
  process.exit(2);
});
