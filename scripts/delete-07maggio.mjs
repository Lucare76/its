/**
 * CANCELLAZIONE EFFETTIVA — Servizi non-navetta 07/05/2026
 * Elimina tutti i servizi del giorno TRANNE le navette (Cristallo, President, San Nicola).
 * Elimina anche tutti i trip_groups attivi per il giorno.
 *
 * PREREQUISITO: eseguire prima dry-run-delete-07maggio.mjs e verificare il report.
 *
 * Esegui con:
 *   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/delete-07maggio.mjs
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL  = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TENANT_ID     = "d200b89a-64c7-4f8d-a430-95a33b83047a";
const TARGET_DATE   = "2026-05-07";
const OPERATOR_ID   = "e49bac54-5caa-4e8d-9f2a-43f6c43b6a5e"; // LUCA RENNA (supervisor)
const OPERATOR_NAME = "LUCA RENNA";

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function isNavetta(row) {
  return (
    row.booking_service_kind === "navetta" ||
    (row.vessel ?? "").trim().toLowerCase() === "navetta"
  );
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║     CANCELLAZIONE EFFETTIVA — 07/05/2026                 ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  // ── 1. Carica servizi del giorno ──────────────────────────────────────────
  console.log("📋 Carico servizi del giorno...");
  const { data: allServices, error: svcErr } = await admin
    .from("services")
    .select("id, customer_name, hotel_id, pax, booking_service_kind, vessel, status")
    .eq("tenant_id", TENANT_ID)
    .eq("date", TARGET_DATE);

  if (svcErr) {
    console.error("ERRORE lettura services:", svcErr.message);
    process.exit(1);
  }

  const daElimin = allServices.filter((r) => !isNavetta(r));
  const navette  = allServices.filter(isNavetta);

  console.log(`  Totale servizi   : ${allServices.length}`);
  console.log(`  Navette (keep)   : ${navette.length}`);
  console.log(`  Da eliminare     : ${daElimin.length}\n`);

  if (daElimin.length === 0) {
    console.log("✅ Nessun servizio da eliminare. Uscita.");
    process.exit(0);
  }

  // ── 2. Hotel lookup per audit log ─────────────────────────────────────────
  const hotelIds = [...new Set(daElimin.map((r) => r.hotel_id).filter(Boolean))];
  const { data: hotels } = await admin
    .from("hotels")
    .select("id, name")
    .in("id", hotelIds);
  const hotelMap = new Map((hotels ?? []).map((h) => [h.id, h.name]));

  // ── 3. FASE 1 — Audit log ────────────────────────────────────────────────
  console.log("📝 FASE 1 — Scrittura audit log...");
  const auditRows = daElimin.map((s) => ({
    tenant_id:           TENANT_ID,
    original_service_id: s.id,
    customer_name:       s.customer_name,
    hotel_name:          hotelMap.get(s.hotel_id) ?? null,
    service_date:        TARGET_DATE,
    pax:                 s.pax,
    booking_service_kind: s.booking_service_kind,
    status:              s.status,
    deleted_by_user_id:  OPERATOR_ID,
    deleted_by_name:     OPERATOR_NAME,
    notes:               "Bulk delete 07/05/2026 — tutti i non-navetta",
  }));

  const { error: auditErr } = await admin
    .from("service_deletion_log")
    .insert(auditRows);

  if (auditErr) {
    console.error("ERRORE audit log:", auditErr.message);
    process.exit(1);
  }
  console.log(`  ✅ ${auditRows.length} righe inserite in service_deletion_log\n`);

  // ── 4. FASE 2 — Eliminazione trip_groups del giorno ───────────────────────
  console.log("🗑️  FASE 2 — Eliminazione trip_groups del giorno...");
  const { data: tripGroups, error: tgReadErr } = await admin
    .from("trip_groups")
    .select("id")
    .eq("tenant_id", TENANT_ID)
    .eq("date", TARGET_DATE)
    .eq("status", "active");

  if (tgReadErr) {
    console.error("ERRORE lettura trip_groups:", tgReadErr.message);
    process.exit(1);
  }

  if ((tripGroups ?? []).length > 0) {
    const tgIds = tripGroups.map((g) => g.id);
    const { error: tgDelErr } = await admin
      .from("trip_groups")
      .delete()
      .eq("tenant_id", TENANT_ID)
      .in("id", tgIds);

    if (tgDelErr) {
      console.error("ERRORE eliminazione trip_groups:", tgDelErr.message);
      process.exit(1);
    }
    console.log(`  ✅ ${tgIds.length} trip_groups eliminati (e relativi assignments in cascade)\n`);
  } else {
    console.log("  ℹ️  Nessun trip_group attivo trovato.\n");
  }

  // ── 5. FASE 3 — Eliminazione servizi non-navetta ──────────────────────────
  console.log("🗑️  FASE 3 — Eliminazione servizi non-navetta...");
  const serviceIdsToDelete = daElimin.map((r) => r.id);

  // Elimina in batch da 200 per sicurezza
  const BATCH = 200;
  let deleted = 0;
  for (let i = 0; i < serviceIdsToDelete.length; i += BATCH) {
    const batch = serviceIdsToDelete.slice(i, i + BATCH);
    const { error: delErr } = await admin
      .from("services")
      .delete()
      .eq("tenant_id", TENANT_ID)
      .in("id", batch);

    if (delErr) {
      console.error(`ERRORE eliminazione batch [${i}..${i + BATCH}]:`, delErr.message);
      process.exit(1);
    }
    deleted += batch.length;
    console.log(`  Eliminati ${deleted}/${serviceIdsToDelete.length}...`);
  }
  console.log(`  ✅ ${deleted} servizi eliminati (status_events in cascade)\n`);

  // ── 6. Verifica finale ────────────────────────────────────────────────────
  console.log("🔍 Verifica finale...");
  const { data: remaining } = await admin
    .from("services")
    .select("id, booking_service_kind, vessel")
    .eq("tenant_id", TENANT_ID)
    .eq("date", TARGET_DATE);

  const remNavette    = (remaining ?? []).filter(isNavetta).length;
  const remNonNavette = (remaining ?? []).filter((r) => !isNavetta(r)).length;

  console.log(`  Servizi rimasti nel giorno : ${(remaining ?? []).length}`);
  console.log(`  ✅ Navette rimaste          : ${remNavette}`);
  if (remNonNavette > 0) {
    console.log(`  ⚠️  Non-navetta ancora presenti: ${remNonNavette} (attenzione!)`);
  } else {
    console.log(`  ✅ Non-navetta rimaste     : 0`);
  }

  const { count: tripGroupsLeft } = await admin
    .from("trip_groups")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", TENANT_ID)
    .eq("date", TARGET_DATE)
    .eq("status", "active");

  console.log(`  Trip groups attivi rimasti : ${tripGroupsLeft ?? 0}\n`);

  console.log("═══════════════════════════════════════════════════════════");
  console.log("✅ CANCELLAZIONE COMPLETATA");
  console.log("═══════════════════════════════════════════════════════════\n");
}

main().catch((err) => {
  console.error("ERRORE:", err);
  process.exit(1);
});
