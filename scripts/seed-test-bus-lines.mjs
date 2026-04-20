#!/usr/bin/env node
/**
 * Seed: domenica 21/09/2025 — stress test 3 linee bus (~300 arrivi)
 * Crea servizi + allocazioni tenant_bus_allocations per smistamento Ischia.
 * Se un bus supera 54 pax ne crea uno nuovo da 54 automaticamente.
 *
 * Uso:
 *   node scripts/seed-test-bus-lines.mjs          — inserisce
 *   node scripts/seed-test-bus-lines.mjs --clean  — rimuove
 *   node scripts/seed-test-bus-lines.mjs --dry    — simula
 */

import { readFileSync } from "fs";
import { createInterface } from "readline";

// ─── Config ───────────────────────────────────────────────────────────────────

const TEST_DATE    = "2025-09-21";
const TENANT_ID    = "d200b89a-64c7-4f8d-a430-95a33b83047a";
const BUS_CAPACITY = 54;

const envContent = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const getEnv = (k) => {
  const m = envContent.match(new RegExp(`^${k}=(.+)$`, "m"));
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
};
const SUPABASE_URL = getEnv("NEXT_PUBLIC_SUPABASE_URL");
const SERVICE_KEY  = getEnv("SUPABASE_SERVICE_ROLE_KEY");

const isDry   = process.argv.includes("--dry");
const isClean = process.argv.includes("--clean");

// ─── Linee ────────────────────────────────────────────────────────────────────

const LINES = {
  centro: {
    id:     "75523299-187a-4775-a1d1-2402d7e11e15",
    time:   "12:00:00",
    vessel: "Medmar",
    port:   "Casamicciola",
    meeting_point: "Biglietteria Medmar Casamicciola",
    units: [
      { id: "f1eaaeff-2b4c-4531-9919-e678d1c13eb7", label: "CENTRO 1" },
      { id: "21f9f603-3858-4d71-b2e0-6759d15160da", label: "CENTRO 2" },
      { id: "8cf1869e-eae4-4763-ad25-2d74d9210273", label: "CENTRO 3" },
      { id: "22afa079-5e35-412f-bef7-061fc8aef399", label: "CENTRO 4" },
    ],
    stops: [
      { id: "697d1e4c-625f-4281-bf5d-27f8dec3848c", city: "TERNI" },
      { id: "beaace1c-722f-473f-88b0-63b6b4eff5ac", city: "PONZANO" },
      { id: "47ba5f4b-7899-4f52-977c-c4e7648b59bf", city: "GUIDONIA" },
      { id: "771326fe-cca8-4270-aa8a-1eea2e2f375b", city: "COLLEFERRO" },
      { id: "36324347-5a32-42e7-932f-7a49bdfbda90", city: "FOLIGNO" },
      { id: "110edac1-612d-484d-978b-596e4b9a32d3", city: "SPOLETO" },
      { id: "c1815d5b-152e-4140-b81f-436db63497b2", city: "ORTE" },
      { id: "d27ad066-e75e-4c8b-affe-cdf565ca9a13", city: "CITTA DI CASTELLO" },
      { id: "a4e27026-c2da-452f-8945-98bbb85356be", city: "UMBERTIDE" },
      { id: "5fab686f-30a3-4399-a347-8ef5634c26f7", city: "PERUGIA" },
      { id: "a28fc6af-f5b0-4db1-a3bb-c288fd131716", city: "PONTE SAN GIOVANNI" },
      { id: "0d98be19-390e-4710-ab09-12558a76c949", city: "SANTA MARIA DEGLI ANGELI" },
      { id: "186f0dc8-2cc8-467b-9b50-dc4a82db0226", city: "VITERBO" },
      { id: "f5a47e18-2e66-4f1c-8ea1-07aa8c732df6", city: "AMELIA" },
    ],
    target: 100,
  },
  adriatica: {
    id:     "afcccc6b-e8ef-4e79-8d7c-854cb651d0d2",
    time:   "13:30:00",
    vessel: "Medmar",
    port:   "Ischia Porto",
    meeting_point: "Uscita arrivi Ischia Porto",
    units: [
      { id: "be30e228-0a52-47b3-9894-bec00c248d3f", label: "ADRIATICA 1" },
      { id: "0a28ebdf-b894-4429-b216-04f6270f5fe3", label: "ADRIATICA 2" },
    ],
    stops: [
      { id: "301be971-0e18-4418-a784-227674218a48", city: "RAVENNA" },
      { id: "f8cc8a51-92cc-493b-bde1-3319248dfb4c", city: "FORLI" },
      { id: "b731dc29-d147-46da-9ed2-ac6e55171288", city: "CESENA" },
      { id: "9533fd9c-58cf-43b1-938a-ea8bd77a6979", city: "RIMINI" },
      { id: "0d22eae1-dd1f-4740-bf52-3a640b508af9", city: "CASSINO" },
    ],
    target: 100,
  },
  italia: {
    id:     "8f90f2e7-8737-4e34-a141-1b0f8fb2c099",
    time:   "18:30:00",
    vessel: "Medmar",
    port:   "Casamicciola",
    meeting_point: "Biglietteria Medmar Casamicciola",
    units: [
      { id: "0a0d0d43-dd0a-4205-918f-1f78fb3aa61a", label: "ITALIA 1" },
      { id: "f7a7ec1d-2a78-412e-912b-63a44f45e68c", label: "ITALIA 2" },
      { id: "74c17ca2-ebbd-4175-be76-5eaa90dcf4ca", label: "ITALIA 3" },
      { id: "69070402-5f5b-435c-99e8-9ee0d097df8a", label: "ITALIA 4" },
      { id: "1384e0f3-5a08-4320-85e9-1287a9606f06", label: "ITALIA 5" },
      { id: "493a4e7c-eac7-496b-aeac-a318419f0505", label: "ITALIA PUGLIA" },
      { id: "eaf90662-4d05-4a39-9fb2-2fa532064da7", label: "ITALIA PUGLIA 2" },
    ],
    stops: [
      { id: "49bfbbf3-f616-416a-a09b-266cdc5a4134", city: "TORINO" },
      { id: "2602097e-d66a-482f-9bc8-d9fef79535c8", city: "MILANO" },
      { id: "feb37dae-e902-449c-8988-db8319124f6a", city: "BRESCIA" },
      { id: "64c26ecf-a9d2-4cdb-8e0a-ee452a0498bf", city: "PADOVA" },
      { id: "86a14eac-5a69-4463-8b31-e3487e2f3aa6", city: "MESTRE" },
      { id: "9fb09ce9-8cd8-48cd-84fa-a88ddfc418bb", city: "TREVISO" },
      { id: "142fc8b4-fcce-45f1-9342-0ac5f89cc7aa", city: "FELTRE" },
      { id: "cac04261-ae1c-4a39-ade5-61d2c5ea5516", city: "BOLOGNA" },
      { id: "3998fce3-4ca3-4a5d-bd7c-a3bc44242446", city: "REGGIO EMILIA" },
      { id: "7fc89533-8e9f-42af-a736-e45eb1fbe673", city: "PARMA" },
      { id: "91c386ba-f5f9-48a0-a56a-7447182db50c", city: "FIRENZE" },
      { id: "341e69bf-5ff5-466e-be01-f6520c5ed314", city: "ROMA" },
      { id: "3f93519f-c5fc-441e-88c1-41c3271de74f", city: "BARI" },
      { id: "87882b7a-7a82-4641-ac6f-b391e39f885f", city: "NOVARA" },
      { id: "a6d36642-1a87-4f42-98be-301580d1551e", city: "VARESE" },
    ],
    target: 100,
  },
};

// ID unità "base" predefinite nel DB (non vanno mai eliminate)
const BASE_UNIT_IDS = new Set(
  Object.values(LINES).flatMap(l => l.units.map(u => u.id))
);

// ─── Nomi ─────────────────────────────────────────────────────────────────────

const IT_FIRST = ["Marco","Luca","Giovanni","Roberto","Andrea","Paolo","Francesco","Antonio","Mario","Giuseppe","Sofia","Giulia","Chiara","Laura","Sara","Elena","Francesca","Valentina","Anna","Maria"];
const IT_LAST  = ["Rossi","Ferrari","Russo","Bianchi","Romano","Gallo","Conti","Esposito","Bruno","Marino","Costa","Colombo","Ricci","Mancini","Greco","De Luca","Barbieri","Fontana","Moretti","Caruso"];

function rnd(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function rndInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function uuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === "x" ? r : r & 0x3 | 0x8).toString(16);
  });
}

function genCustomer() {
  const first = rnd(IT_FIRST);
  const last  = rnd(IT_LAST);
  const phone = `+39 3${Array.from({ length: 8 }, () => rndInt(0, 9)).join("")}`;
  return { customer_first_name: first, customer_last_name: last, customer_name: `${first} ${last}`, phone };
}

function genPax() {
  const r = Math.random();
  if (r < 0.30) return 1;
  if (r < 0.60) return 2;
  if (r < 0.80) return 3;
  return 4;
}

// ─── Unit pool con bin-packing ────────────────────────────────────────────────

// pool: Map<lineId, Array<{ id, label, remaining, isNew }>>
const unitPool = new Map();

function initPool(line, lineName) {
  unitPool.set(line.id, line.units.map(u => ({
    id: u.id,
    label: u.label,
    remaining: BUS_CAPACITY,
    isNew: false,
  })));
}

// Restituisce un'unità con abbastanza spazio; crea una nuova se necessario.
// Aggiunge la nuova unità a newUnitRows se la crea.
function assignUnit(line, lineName, pax, newUnitRows) {
  const pool = unitPool.get(line.id);

  // Prima unità con capienza sufficiente (first-fit)
  let unit = pool.find(u => u.remaining >= pax);

  if (!unit) {
    const count = pool.length + 1;
    const prefix = lineName.toUpperCase();
    const label = `${prefix} ${count}`;
    const newId = uuid();
    unit = { id: newId, label, remaining: BUS_CAPACITY, isNew: true };
    pool.push(unit);
    newUnitRows.push({
      id: newId,
      tenant_id: TENANT_ID,
      bus_line_id: line.id,
      label,
      capacity: BUS_CAPACITY,
      sort_order: count,
    });
  }

  unit.remaining -= pax;
  return unit;
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────

async function supabaseFetch(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...options,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
      ...options.headers,
    },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase ${res.status}: ${err}`);
  }
  if (!options.method || options.method === "GET") {
    const t = await res.text();
    return t ? JSON.parse(t) : [];
  }
  return null;
}

async function batchInsert(table, rows, batchSize = 200) {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    await supabaseFetch(`/${table}`, {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(rows.slice(i, i + batchSize)),
    });
    inserted += rows.slice(i, i + batchSize).length;
    process.stdout.write(`\r  → ${table}: ${inserted}/${rows.length}`);
  }
  console.log();
}

async function ask(q) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(r => rl.question(q, a => { rl.close(); r(a.trim()); }));
}

// ─── CLEAN ────────────────────────────────────────────────────────────────────

async function clean() {
  console.log(`\n🧹 Pulizia dati test bus lines (${TEST_DATE})…`);

  const svcs = await supabaseFetch(
    `/services?select=id&tenant_id=eq.${TENANT_ID}&is_test_data=eq.true&date=eq.${TEST_DATE}&booking_service_kind=eq.bus_city_hotel&limit=2000`,
    { method: "GET", headers: { Prefer: "" } }
  );

  if (!svcs.length) { console.log("  Nessun dato da rimuovere."); return; }
  console.log(`  Trovati ${svcs.length} servizi bus linea da rimuovere.`);

  // Raccogli unit IDs usate prima di eliminare le allocazioni
  const allUnitIds = new Set();
  const ids = svcs.map(s => s.id);
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const allocs = await supabaseFetch(
      `/tenant_bus_allocations?select=bus_unit_id&tenant_id=eq.${TENANT_ID}&service_id=in.(${chunk.join(",")})`,
      { method: "GET", headers: { Prefer: "" } }
    );
    for (const a of allocs) allUnitIds.add(a.bus_unit_id);
  }

  // Unità create dinamicamente (non nelle base)
  const extraUnitIds = [...allUnitIds].filter(id => !BASE_UNIT_IDS.has(id));

  const ans = await ask(`  Confermi? (sì/no): `);
  if (!["sì","si","s"].includes(ans.toLowerCase())) { console.log("  Annullato."); return; }

  // Elimina allocazioni
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    await supabaseFetch(
      `/tenant_bus_allocations?tenant_id=eq.${TENANT_ID}&service_id=in.(${chunk.join(",")})`,
      { method: "DELETE" }
    );
  }
  // Elimina servizi
  await supabaseFetch(
    `/services?tenant_id=eq.${TENANT_ID}&is_test_data=eq.true&date=eq.${TEST_DATE}&booking_service_kind=eq.bus_city_hotel`,
    { method: "DELETE" }
  );
  // Elimina unità extra create dinamicamente
  if (extraUnitIds.length) {
    for (let i = 0; i < extraUnitIds.length; i += 50) {
      const chunk = extraUnitIds.slice(i, i + 50);
      await supabaseFetch(
        `/tenant_bus_units?tenant_id=eq.${TENANT_ID}&id=in.(${chunk.join(",")})`,
        { method: "DELETE" }
      );
    }
    console.log(`  🗑  Rimosse ${extraUnitIds.length} unità bus extra.`);
  }

  console.log(`  ✅ Rimossi ${svcs.length} servizi e relative allocazioni.`);
}

// ─── SEED ─────────────────────────────────────────────────────────────────────

async function seed() {
  console.log(`\n🚌 Seed bus linee — ${TEST_DATE}`);

  // Carica hotels
  const hotels = await supabaseFetch(
    `/hotels?select=id,zone&tenant_id=eq.${TENANT_ID}&is_active=eq.true&limit=300`,
    { method: "GET", headers: { Prefer: "" } }
  );
  if (!hotels.length) { console.error("Nessun hotel trovato."); process.exit(1); }

  const serviceRows = [];
  const allocRows   = [];
  const newUnitRows = [];
  const stats       = {};

  for (const [lineName, line] of Object.entries(LINES)) {
    stats[lineName] = { bookings: 0, pax: 0 };
    initPool(line, lineName);
    let generated = 0;

    while (generated < line.target) {
      const customer  = genCustomer();
      const pax       = genPax();
      const hotel     = rnd(hotels);
      const stop      = rnd(line.stops);
      const serviceId = uuid();
      const allocId   = uuid();

      const unit = assignUnit(line, lineName, pax, newUnitRows);

      serviceRows.push({
        id: serviceId,
        tenant_id: TENANT_ID,
        date: TEST_DATE,
        time: line.time,
        direction: "arrival",
        vessel: line.vessel,
        pax,
        hotel_id: hotel.id,
        status: "new",
        is_test_data: true,
        is_draft: false,
        booking_service_kind: "bus_city_hotel",
        service_type: "transfer",
        meeting_point: line.meeting_point,
        place_type: "hotel",
        bus_city_origin: stop.city,
        notes: Math.random() < 0.10 ? "Bagagli extra" : "",
        ...customer,
      });

      allocRows.push({
        id: allocId,
        tenant_id: TENANT_ID,
        service_id: serviceId,
        bus_line_id: line.id,
        bus_unit_id: unit.id,
        stop_id: stop.id,
        stop_name: stop.city,
        direction: "arrival",
        pax_assigned: pax,
        notes: `Hotel: ${hotel.id}`,
        root_allocation_id: allocId,
        split_from_allocation_id: null,
      });

      stats[lineName].bookings++;
      stats[lineName].pax += pax;
      generated++;
    }
  }

  // Riepilogo bus per linea
  console.log("\n══════════════════════════════════════════════════");
  console.log(`  RIEPILOGO — ${TEST_DATE} (domenica)`);
  console.log("══════════════════════════════════════════════════");
  let totalBookings = 0, totalPax = 0;
  for (const [name, s] of Object.entries(stats)) {
    const line = LINES[name];
    const pool = unitPool.get(line.id);
    const busDetail = pool.map(u => {
      const used = BUS_CAPACITY - u.remaining;
      return `${u.label}(${used}/${BUS_CAPACITY})${u.isNew ? "*" : ""}`;
    }).join(", ");
    console.log(`  ${name.toUpperCase().padEnd(12)} → ${line.time.slice(0,5)} ${line.port.padEnd(15)} ${s.bookings} prenotazioni  ${s.pax} PAX`);
    console.log(`               ${busDetail}`);
    totalBookings += s.bookings;
    totalPax += s.pax;
  }
  console.log("──────────────────────────────────────────────────");
  console.log(`  ${"TOTALE".padEnd(12)}   ${"".padEnd(21)} ${totalBookings} prenotazioni  ${totalPax} PAX`);
  if (newUnitRows.length) console.log(`  ⚡ ${newUnitRows.length} bus extra creati automaticamente (marcati con *)`);
  console.log("══════════════════════════════════════════════════\n");

  if (isDry) { console.log("  [--dry] Nessun dato scritto.\n"); return; }

  const ans = await ask(
    `  Confermi inserimento di ${totalBookings} servizi + ${allocRows.length} allocazioni` +
    (newUnitRows.length ? ` + ${newUnitRows.length} bus extra` : "") +
    `? (sì/no): `
  );
  if (!["sì","si","s"].includes(ans.toLowerCase())) { console.log("  Annullato.\n"); return; }

  console.log("\n  Inserimento…\n");
  const t0 = Date.now();
  if (newUnitRows.length) await batchInsert("tenant_bus_units", newUnitRows, 100);
  await batchInsert("services", serviceRows, 200);
  await batchInsert("tenant_bus_allocations", allocRows, 200);
  console.log(`\n  ✅ Completato in ${((Date.now()-t0)/1000).toFixed(1)}s`);
  console.log(`  Per rimuovere: node scripts/seed-test-bus-lines.mjs --clean\n`);
}

// ─── Entry ────────────────────────────────────────────────────────────────────

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Mancano NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}
if (isClean) { clean().catch(e => { console.error(e); process.exit(1); }); }
else { seed().catch(e => { console.error(e); process.exit(1); }); }
