/**
 * DRY RUN — Cancellazione selettiva servizi 07/05/2026
 * NON esegue nessuna modifica al DB.
 * Mostra esattamente cosa verrebbe eliminato e cosa verrebbe mantenuto.
 *
 * Esegui con:
 *   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/dry-run-delete-07maggio.mjs
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TENANT_ID    = "d200b89a-64c7-4f8d-a430-95a33b83047a";
const TARGET_DATE  = "2026-05-07";

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
  console.log("║     DRY RUN — Cancellazione selettiva 07/05/2026         ║");
  console.log("║     NESSUNA MODIFICA AL DATABASE                         ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  // ── Tutti i servizi del giorno ────────────────────────────────────────────
  const { data: allServices, error } = await admin
    .from("services")
    .select("id, time, direction, customer_name, pax, booking_service_kind, vessel, status, hotel_id, service_type")
    .eq("tenant_id", TENANT_ID)
    .eq("date", TARGET_DATE)
    .order("time");

  if (error) {
    console.error("ERRORE query services:", error.message);
    process.exit(1);
  }

  const navette   = allServices.filter(isNavetta);
  const daElimin  = allServices.filter((r) => !isNavetta(r));

  // ── Hotel lookup ──────────────────────────────────────────────────────────
  const hotelIds = [...new Set(allServices.map((r) => r.hotel_id).filter(Boolean))];
  const { data: hotels } = await admin
    .from("hotels")
    .select("id, name")
    .in("id", hotelIds);
  const hotelMap = new Map((hotels ?? []).map((h) => [h.id, h.name]));

  // ── Trip groups per il giorno ─────────────────────────────────────────────
  const { data: tripGroups } = await admin
    .from("trip_groups")
    .select("id, driver_user_id, vehicle_label, status")
    .eq("tenant_id", TENANT_ID)
    .eq("date", TARGET_DATE)
    .eq("status", "active");

  // ── Assignments interessati ───────────────────────────────────────────────
  const serviceIdsToDelete = new Set(daElimin.map((r) => r.id));
  let affectedAssignments = 0;
  if (serviceIdsToDelete.size > 0) {
    const { count } = await admin
      .from("assignments")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", TENANT_ID)
      .in("service_id", [...serviceIdsToDelete]);
    affectedAssignments = count ?? 0;
  }

  // ── STATUS EVENTS interessati ─────────────────────────────────────────────
  let affectedStatusEvents = 0;
  if (serviceIdsToDelete.size > 0) {
    const { count } = await admin
      .from("status_events")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", TENANT_ID)
      .in("service_id", [...serviceIdsToDelete]);
    affectedStatusEvents = count ?? 0;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // REPORT
  // ═══════════════════════════════════════════════════════════════════════════

  console.log(`📅  Data target: ${TARGET_DATE}\n`);
  console.log("┌─────────────────────────────────────────────────┐");
  console.log(`│  Totale servizi nel giorno     : ${String(allServices.length).padStart(4)}            │`);
  console.log(`│  ✅ Navette da MANTENERE        : ${String(navette.length).padStart(4)}            │`);
  console.log(`│  🗑️  Servizi da ELIMINARE        : ${String(daElimin.length).padStart(4)}            │`);
  console.log("└─────────────────────────────────────────────────┘\n");

  // ── Dettaglio navette mantenute ────────────────────────────────────────────
  console.log(`✅ NAVETTE CHE VERRANNO MANTENUTE (${navette.length}):\n`);

  // Raggruppa per nome hotel/navetta
  const navetteByHotel = {};
  for (const n of navette) {
    const hotelName = hotelMap.get(n.hotel_id) ?? n.customer_name ?? "—";
    if (!navetteByHotel[hotelName]) navetteByHotel[hotelName] = [];
    navetteByHotel[hotelName].push(n);
  }
  for (const [hotelName, rows] of Object.entries(navetteByHotel)) {
    const deps = rows.filter((r) => r.direction === "departure").length;
    const arrs = rows.filter((r) => r.direction === "arrival").length;
    console.log(`  📍 ${hotelName}`);
    console.log(`     ${rows.length} corse totali — ${deps} partenze / ${arrs} arrivi`);
    const times = rows.map((r) => r.time.slice(0, 5)).sort().join(", ");
    console.log(`     Orari: ${times}\n`);
  }

  // ── Dettaglio servizi da eliminare ─────────────────────────────────────────
  console.log(`\n🗑️  SERVIZI CHE VERRANNO ELIMINATI (${daElimin.length}):\n`);

  // Raggruppa per tipo
  const byKind = {};
  for (const s of daElimin) {
    const kind = s.booking_service_kind ?? s.service_type ?? "transfer";
    if (!byKind[kind]) byKind[kind] = [];
    byKind[kind].push(s);
  }

  for (const [kind, rows] of Object.entries(byKind).sort()) {
    console.log(`  📂 ${kind.toUpperCase()} — ${rows.length} servizi:`);
    // Mostra i primi 10 per tipo, poi "e altri N"
    const sample = rows.slice(0, 10);
    for (const s of sample) {
      const dir  = s.direction === "arrival" ? "ARR" : "PAR";
      const ora  = s.time.slice(0, 5);
      const nome = (s.customer_name ?? "—").slice(0, 30);
      const hotel = (hotelMap.get(s.hotel_id) ?? "hotel?").slice(0, 25);
      const vessel = s.vessel ? ` [${s.vessel.slice(0, 20)}]` : "";
      console.log(`     ${dir} ${ora} | ${nome.padEnd(30)} | ${hotel}${vessel}`);
    }
    if (rows.length > 10) {
      console.log(`     ... e altri ${rows.length - 10} servizi`);
    }
    console.log();
  }

  // ── Impatto sulle tabelle collegate ───────────────────────────────────────
  console.log("📊 IMPATTO SULLE TABELLE COLLEGATE:\n");
  console.log(`  assignments    → ${affectedAssignments} righe eliminate (ON DELETE CASCADE)`);
  console.log(`  status_events  → ${affectedStatusEvents} righe eliminate (ON DELETE CASCADE)`);
  console.log(`  whatsapp_events→ service_id → NULL (ON DELETE SET NULL, dati conservati)`);
  console.log();

  // ── Trip groups ────────────────────────────────────────────────────────────
  if ((tripGroups ?? []).length > 0) {
    console.log(`⚠️  TRIP GROUPS ATTIVI PER IL 07/05/2026: ${tripGroups.length}`);
    console.log("   I giri pianificati perderanno i servizi eliminati.");
    console.log("   I trip_groups non vengono cancellati automaticamente (restano vuoti).");
    console.log("   Si consiglia di eliminare manualmente i trip_groups dopo la cancellazione.");
    for (const tg of tripGroups) {
      const driver = tg.driver_user_id ? `driver: ${tg.driver_user_id.slice(0, 8)}...` : "no driver";
      console.log(`   → group ${tg.id.slice(0, 8)}... | ${tg.vehicle_label ?? "no mezzo"} | ${driver}`);
    }
    console.log();
  } else {
    console.log("✅ Nessun trip_group attivo per il 07/05/2026 — nessun piano da pulire.\n");
  }

  // ── SQL che verrebbe eseguito ──────────────────────────────────────────────
  console.log("═══════════════════════════════════════════════════════════");
  console.log("SQL CHE VERREBBE ESEGUITO (non ancora eseguito):");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`
-- FASE 1: Log di audit (PRIMA della cancellazione)
INSERT INTO public.service_deletion_log
  (tenant_id, original_service_id, customer_name, hotel_name,
   service_date, pax, booking_service_kind, status,
   deleted_by_user_id, deleted_by_name, notes)
SELECT
  s.tenant_id,
  s.id,
  s.customer_name,
  h.name,
  s.date,
  s.pax,
  s.booking_service_kind,
  s.status::text,
  -- <USER_ID_OPERATORE>,
  -- '<NOME_OPERATORE>',
  'Bulk delete 07/05/2026 — tutti i non-navetta'
FROM public.services s
LEFT JOIN public.hotels h ON h.id = s.hotel_id
WHERE s.tenant_id = '${TENANT_ID}'
  AND s.date = '${TARGET_DATE}'
  AND NOT (
    s.booking_service_kind = 'navetta'
    OR lower(trim(coalesce(s.vessel, ''))) = 'navetta'
  );

-- FASE 2: Cancellazione effettiva
DELETE FROM public.services
WHERE tenant_id = '${TENANT_ID}'
  AND date = '${TARGET_DATE}'
  AND NOT (
    booking_service_kind = 'navetta'
    OR lower(trim(coalesce(vessel, ''))) = 'navetta'
  );

-- Assignments e status_events vengono eliminati automaticamente
-- per ON DELETE CASCADE su service_id.
`);

  console.log("═══════════════════════════════════════════════════════════");
  console.log("DRY RUN COMPLETATO — nessuna modifica eseguita.");
  console.log("Esegui il file delete-07maggio.mjs per applicare le modifiche.");
  console.log("═══════════════════════════════════════════════════════════\n");
}

main().catch((err) => {
  console.error("ERRORE:", err);
  process.exit(1);
});
