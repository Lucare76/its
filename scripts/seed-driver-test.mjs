#!/usr/bin/env node
/**
 * Seed: dati di test realistici per autisti — data di domani
 * Crea ~15 servizi assegnati agli autisti registrati nel tenant.
 * Tutti i record hanno is_test_data=true per pulizia facile.
 *
 * Uso:
 *   node scripts/seed-driver-test.mjs          — inserisce dati
 *   node scripts/seed-driver-test.mjs --clean  — rimuove dati di test
 *   node scripts/seed-driver-test.mjs --dry    — simula senza scrivere
 */

import { readFileSync } from "fs";

// ─── Config ───────────────────────────────────────────────────────────────────

const TENANT_ID = "d200b89a-64c7-4f8d-a430-95a33b83047a";

// Prova .env.local poi .env
let envContent;
try { envContent = readFileSync(new URL("../.env.local", import.meta.url), "utf8"); }
catch { envContent = readFileSync(new URL("../.env", import.meta.url), "utf8"); }
const getEnv = (k) => {
  const m = envContent.match(new RegExp(`^${k}=(.+)$`, "m"));
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
};

const SUPABASE_URL = getEnv("NEXT_PUBLIC_SUPABASE_URL");
const SERVICE_KEY  = getEnv("SUPABASE_SERVICE_ROLE_KEY");

const isDry   = process.argv.includes("--dry");
const isClean = process.argv.includes("--clean");
const driverArg = (() => { const i = process.argv.indexOf("--driver"); return i !== -1 ? process.argv[i + 1]?.toLowerCase() : null; })();

// Domani
const tomorrow = new Date();
tomorrow.setDate(tomorrow.getDate() + 1);
const TEST_DATE = tomorrow.toISOString().slice(0, 10);

console.log(`\n📅  Data test: ${TEST_DATE}${isDry ? "  [DRY RUN]" : ""}\n`);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function uuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === "x" ? r : r & 0x3 | 0x8).toString(16);
  });
}
function rnd(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function rndInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

// ─── Nomi clienti realistici ──────────────────────────────────────────────────

const CUSTOMERS = [
  ["Marco", "Tramonto d'oro"],
  ["Anna", "Colella"],
  ["Luigi", "Augusto"],
  ["Sophie", "Müller"],
  ["Jean", "Dupont"],
  ["Robert", "Johnson"],
  ["Giulia", "Ferrari"],
  ["Maria", "Esposito"],
  ["Thomas", "Schmidt"],
  ["Elena", "Bianchi"],
  ["David", "Williams"],
  ["Francesca", "Romano"],
  ["Hans", "Wagner"],
  ["Carla", "De Luca"],
  ["Michael", "Brown"],
];

function pickCustomer(idx) {
  const [first, last] = CUSTOMERS[idx % CUSTOMERS.length];
  return {
    customer_name: `${first} ${last}`,
    customer_first_name: first,
    customer_last_name: last,
    phone: `+39 3${rndInt(10, 99)}${rndInt(1000000, 9999999)}`,
    customer_email: `${first.toLowerCase()}.${last.toLowerCase().replace(/['\s]/g, "")}${rndInt(1,9)}@gmail.com`,
  };
}

// ─── Supabase fetch ───────────────────────────────────────────────────────────

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
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}

async function insert(table, rows) {
  if (isDry) { console.log(`  [dry] INSERT ${table} ×${rows.length}`); return rows; }
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`Insert ${table}: ${await res.text()}`);
  return res.json();
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // 1. Carica hotel
  const hotels = await supabaseFetch(
    `/hotels?tenant_id=eq.${TENANT_ID}&select=id,name,zone,lat,lng&limit=30`,
    { headers: { Prefer: "" } }
  );
  if (!hotels.length) { console.error("Nessun hotel trovato."); process.exit(1); }
  console.log(`✅  ${hotels.length} hotel trovati`);

  // 2. Carica autisti
  const drivers = await supabaseFetch(
    `/memberships?tenant_id=eq.${TENANT_ID}&role=eq.driver&select=user_id,full_name&limit=20`,
    { headers: { Prefer: "" } }
  );
  if (!drivers.length) { console.error("Nessun autista trovato nel tenant."); process.exit(1); }
  console.log(`✅  ${drivers.length} autisti trovati:`);
  drivers.forEach((d) => console.log(`    — ${d.full_name ?? d.user_id}`));

  // ─── CLEAN ────────────────────────────────────────────────────────────────
  if (isClean) {
    console.log("\n🧹  Pulizia dati di test...");
    const existing = await supabaseFetch(
      `/services?tenant_id=eq.${TENANT_ID}&is_test_data=eq.true&date=eq.${TEST_DATE}&select=id`,
      { headers: { Prefer: "" } }
    );
    const ids = existing.map((s) => s.id);
    if (ids.length) {
      await supabaseFetch(
        `/assignments?tenant_id=eq.${TENANT_ID}&service_id=in.(${ids.join(",")})`,
        { method: "DELETE" }
      );
      await supabaseFetch(
        `/services?tenant_id=eq.${TENANT_ID}&is_test_data=eq.true&date=eq.${TEST_DATE}`,
        { method: "DELETE" }
      );
      console.log(`✅  Rimossi ${ids.length} servizi e relativi assignment.`);
    } else {
      console.log("ℹ️   Nessun dato di test da rimuovere.");
    }
    return;
  }

  // ─── BUILD SERVICES ───────────────────────────────────────────────────────

  // Corse di arrivo: 3 navi, gruppi da 3-5 clienti ciascuna
  const ARRIVALS = [
    { time: "09:20", vessel: "SNAV FR9200", meeting_point: "Casamicciola Porto" },
    { time: "13:30", vessel: "Medmar MN1330", meeting_point: "Ischia Porto" },
    { time: "16:30", vessel: "Medmar MN1630", meeting_point: "Ischia Porto" },
  ];

  // Hotel di partenza: 2 hotel, gruppi da 2-3 clienti ciascuno
  const DEP_HOTELS = hotels.slice(0, 2);

  const now = new Date().toISOString();
  let customerIdx = 0;
  const services = [];

  // Arrivi
  for (const arr of ARRIVALS) {
    const count = rndInt(2, 4);
    for (let i = 0; i < count; i++) {
      const hotel = rnd(hotels);
      const customer = pickCustomer(customerIdx++);
      const pax = rndInt(1, 4);
      services.push({
        id: uuid(),
        tenant_id: TENANT_ID,
        date: TEST_DATE,
        time: arr.time,
        service_type: "transfer",
        direction: "arrival",
        vessel: arr.vessel,
        pax,
        hotel_id: hotel.id,
        ...customer,
        notes: i === 0 ? "Bagagli extra" : "",
        status: "assigned",
        meeting_point: arr.meeting_point,
        pickup_time: null,
        booking_service_kind: "formula_snav",
        arrival_date: TEST_DATE,
        arrival_time: arr.time,
        departure_date: TEST_DATE,
        departure_time: "18:00",
        is_test_data: true,
        is_draft: false,
        created_at: now,
      });
    }
  }

  // Partenze
  for (const hotel of DEP_HOTELS) {
    const count = rndInt(2, 3);
    const depTime = rnd(["07:30", "08:00", "08:30", "09:00"]);
    for (let i = 0; i < count; i++) {
      const customer = pickCustomer(customerIdx++);
      const pax = rndInt(1, 3);
      services.push({
        id: uuid(),
        tenant_id: TENANT_ID,
        date: TEST_DATE,
        time: depTime,
        service_type: "transfer",
        direction: "departure",
        vessel: "SNAV FR8110",
        pax,
        hotel_id: hotel.id,
        ...customer,
        notes: "",
        status: "assigned",
        meeting_point: null,
        pickup_time: depTime,
        booking_service_kind: "formula_snav",
        arrival_date: TEST_DATE,
        arrival_time: "10:00",
        departure_date: TEST_DATE,
        departure_time: depTime,
        is_test_data: true,
        is_draft: false,
        created_at: now,
      });
    }
  }

  console.log(`\n📋  ${services.length} servizi da creare`);
  if (isDry) {
    services.forEach((s) => console.log(`    [${s.direction}] ${s.time} ${s.vessel ?? s.hotel_id} — ${s.customer_name} ×${s.pax}`));
    return;
  }

  // Insert servizi
  const inserted = await insert("services", services);
  console.log(`✅  ${inserted.length} servizi inseriti`);

  // ─── ASSIGNMENTS ──────────────────────────────────────────────────────────
  // Ogni gruppo (stessa nave o stesso hotel) va allo stesso autista,
  // così ogni driver vede più servizi raggruppati come nella realtà.
  const vehicles = ["Vito", "Sprinter", "Classe E", "Touran"];

  // Raggruppa i servizi inseriti per chiave (vessel + time oppure hotel_id + time)
  const groupMap = new Map();
  for (const svc of inserted) {
    const key = svc.direction === "arrival"
      ? `arr_${svc.vessel}_${svc.time}`
      : `dep_${svc.hotel_id}_${svc.time}`;
    if (!groupMap.has(key)) groupMap.set(key, []);
    groupMap.get(key).push(svc);
  }

  // Se --driver <nome> assegna tutto a quell'autista, altrimenti round-robin
  const targetDriver = driverArg
    ? drivers.find((d) => (d.full_name ?? "").toLowerCase().includes(driverArg))
    : null;
  if (driverArg && !targetDriver) { console.error(`Autista "${driverArg}" non trovato.`); process.exit(1); }
  if (targetDriver) console.log(`\n🎯  Tutti i servizi → ${targetDriver.full_name}`);

  const assignments = [];
  let driverIdx = 0;
  for (const [, groupServices] of groupMap) {
    const driver = targetDriver ?? drivers[driverIdx % drivers.length];
    const vehicle = vehicles[driverIdx % vehicles.length];
    if (!targetDriver) driverIdx++;
    for (const svc of groupServices) {
      assignments.push({
        id: uuid(),
        tenant_id: TENANT_ID,
        service_id: svc.id,
        driver_user_id: driver.user_id,
        vehicle_label: vehicle,
        group_id: null,
        created_at: now,
      });
    }
  }

  await insert("assignments", assignments);
  console.log(`✅  ${assignments.length} assignment creati`);

  // Riepilogo per autista
  console.log("\n📊  Riepilogo per autista:");
  for (const driver of drivers) {
    const mine = assignments.filter((a) => a.driver_user_id === driver.user_id);
    const svcIds = new Set(mine.map((a) => a.service_id));
    const myServices = inserted.filter((s) => svcIds.has(s.id));
    const totalPax = myServices.reduce((acc, s) => acc + s.pax, 0);
    console.log(`    ${driver.full_name ?? driver.user_id}: ${mine.length} servizi · ${totalPax} pax`);
  }

  console.log(`\n✅  Done! Usa --clean per rimuovere.\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
