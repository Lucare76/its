#!/usr/bin/env node
/**
 * Seed: domenica di alta stagione — 12 ottobre 2025
 * Crea ~600 arrivi e ~600 partenze per stress-test del Piano del Giorno.
 * Tutti i record sono marcati con is_test_data=true per pulizia facile.
 *
 * Uso:
 *   node scripts/seed-test-sunday.mjs          — inserisce dati
 *   node scripts/seed-test-sunday.mjs --clean  — rimuove dati di test
 *   node scripts/seed-test-sunday.mjs --dry    — simula senza scrivere
 */

import { readFileSync } from "fs";
import { createInterface } from "readline";

// ─── Config ───────────────────────────────────────────────────────────────────

const TEST_DATE = "2025-10-12";
const TENANT_ID = "d200b89a-64c7-4f8d-a430-95a33b83047a"; // ISCHIA TRANSFER SERVICE

const envContent = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const getEnv = (k) => {
  const m = envContent.match(new RegExp(`^${k}=(.+)$`, "m"));
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
};

const SUPABASE_URL = getEnv("NEXT_PUBLIC_SUPABASE_URL");
const SERVICE_KEY  = getEnv("SUPABASE_SERVICE_ROLE_KEY");

const isDry   = process.argv.includes("--dry");
const isClean = process.argv.includes("--clean");

// ─── Generazione nomi ─────────────────────────────────────────────────────────

const IT_FIRST = ["Marco","Luca","Giovanni","Roberto","Andrea","Paolo","Francesco","Antonio","Mario","Giuseppe","Sofia","Giulia","Chiara","Laura","Sara","Elena","Francesca","Valentina","Anna","Maria"];
const IT_LAST  = ["Rossi","Ferrari","Russo","Bianchi","Romano","Gallo","Conti","Esposito","Bruno","Marino","Costa","Colombo","Ricci","Mancini","Greco","De Luca","Barbieri","Fontana","Moretti","Caruso"];
const DE_FIRST = ["Thomas","Michael","Andreas","Stefan","Klaus","Monika","Sabine","Petra","Ursula","Ingrid","Hans","Wolfgang","Karl","Jürgen","Helmut","Christina","Claudia","Brigitte","Angelika","Renate"];
const DE_LAST  = ["Müller","Schmidt","Schneider","Fischer","Weber","Meyer","Wagner","Becker","Schulz","Hoffmann","Schäfer","Koch","Bauer","Richter","Klein","Wolf","Schröder","Neumann","Zimmermann","Braun"];
const FR_FIRST = ["Jean","Pierre","Michel","Philippe","Alain","Marie","Isabelle","Nathalie","Catherine","Sophie","François","Jacques","Paul","Dominique","Laurent","Anne","Christine","Sandrine","Véronique","Claire"];
const FR_LAST  = ["Martin","Bernard","Thomas","Petit","Robert","Richard","Durand","Dubois","Moreau","Laurent","Simon","Michel","Lefebvre","Leroy","Roux","David","Bertrand","Morel","Fournier","Girard"];
const EN_FIRST = ["James","John","Robert","Michael","William","Elizabeth","Mary","Patricia","Jennifer","Linda","David","Richard","Joseph","Thomas","Charles","Barbara","Susan","Jessica","Sarah","Karen"];
const EN_LAST  = ["Smith","Johnson","Williams","Jones","Brown","Davis","Miller","Wilson","Moore","Taylor","Anderson","Thomas","Jackson","White","Harris","Martin","Thompson","Garcia","Martinez","Robinson"];

const NATIONALITIES = [
  { first: IT_FIRST, last: IT_LAST, phone: "+39 3", lang: "it", weight: 60 },
  { first: DE_FIRST, last: DE_LAST, phone: "+49 1", lang: "de", weight: 20 },
  { first: FR_FIRST, last: FR_LAST, phone: "+33 6", lang: "fr", weight: 10 },
  { first: EN_FIRST, last: EN_LAST, phone: "+44 7", lang: "en", weight: 10 },
];

function rnd(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function rndInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function pad(n) { return String(n).padStart(2, "0"); }
function uuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === "x" ? r : r & 0x3 | 0x8).toString(16);
  });
}

function pickNat() {
  const roll = rndInt(1, 100);
  let acc = 0;
  for (const n of NATIONALITIES) { acc += n.weight; if (roll <= acc) return n; }
  return NATIONALITIES[0];
}

function genCustomer() {
  const nat = pickNat();
  const first = rnd(nat.first);
  const last  = rnd(nat.last);
  const phoneBody = Array.from({ length: 8 }, () => rndInt(0, 9)).join("");
  const phone = `${nat.phone}${phoneBody}`;
  return {
    customer_name: `${first} ${last}`,
    customer_first_name: first,
    customer_last_name: last,
    phone,
    phone_e164: phone.replace(/\s/g, ""),
    customer_email: `${first.toLowerCase()}.${last.toLowerCase()}${rndInt(1, 99)}@${rnd(["gmail.com","yahoo.com","hotmail.com","outlook.com","web.de","libero.it","orange.fr"])}`,
  };
}

function genPax() {
  const r = Math.random();
  if (r < 0.20) return 1;
  if (r < 0.45) return 2;
  if (r < 0.65) return 3;
  if (r < 0.80) return rndInt(4, 5);
  if (r < 0.93) return rndInt(6, 10);
  return rndInt(11, 18);
}

const SPECIAL_NOTES = [
  "Bagagli extra — 4 valigie grandi",
  "PRM — passeggero con difficoltà motorie, richiede supporto",
  "Bambino in carrozzina",
  "Animale al seguito (cane medio)",
  "Neonato con carrozzina",
  "Richiede veicolo con aria condizionata",
  "Cliente VIP — massima cortesia",
  "Ritardo previsto — attendere fino a 20 minuti",
  "Gruppi scolastici — bambini",
  "Bagagli sportivi (bici al seguito)",
  "Passeggero anziano — assistenza alla salita",
  "Doppio trasferimento — ritiro da due hotel diversi",
];

function genNotes() {
  return Math.random() < 0.15 ? rnd(SPECIAL_NOTES) : null;
}

// ─── Corse traghetto ──────────────────────────────────────────────────────────

const ARRIVALS_RUNS = [
  // [orario, vessel, porto, peso-pax]
  ["08:10", "SNAV FR8110", "Casamicciola", 90],
  ["08:30", "SNAV FR8300", "Casamicciola", 75],
  ["09:20", "SNAV FR9200", "Casamicciola", 100],
  ["11:30", "SNAV FR1130", "Casamicciola", 65],
  ["12:30", "SNAV FR1230", "Casamicciola", 70],
  ["13:55", "SNAV FR1355", "Casamicciola", 50],
  ["15:10", "SNAV FR1510", "Casamicciola", 40],
  ["16:20", "SNAV FR1620", "Casamicciola", 45],
  ["17:10", "SNAV FR1710", "Casamicciola", 35],
  ["19:00", "SNAV FR1900", "Casamicciola", 20],
  ["06:25", "Medmar MN625", "Ischia Porto", 18],
  ["09:40", "Medmar MN940", "Ischia Porto", 55],
  ["13:30", "Medmar MN1330", "Ischia Porto", 65],
  ["16:30", "Medmar MN1630", "Ischia Porto", 40],
  ["08:15", "Medmar MN815C", "Casamicciola", 38],
  ["12:00", "Medmar MN1200C", "Casamicciola", 58],
  ["15:00", "Medmar MN1500C", "Casamicciola", 48],
  ["18:30", "Medmar MN1830C", "Casamicciola", 24],
];

// ─── Destinazioni partenze ────────────────────────────────────────────────────

const DEPARTURE_DESTINATIONS = [
  { place_type: "airport", dest: "Aeroporto Napoli Capodichino", vessel: "Volo", weight: 30 },
  { place_type: "station", dest: "Stazione Napoli Centrale", vessel: "Treno", weight: 25 },
  { place_type: "station", dest: "Stazione Napoli Afragola", vessel: "Treno AV", weight: 10 },
  { place_type: "bus_stop", dest: "FlixBus Napoli", vessel: "FlixBus", weight: 8 },
  { place_type: "port", dest: "Porto Napoli Beverello", vessel: "Traghetto", weight: 15 },
  { place_type: "port", dest: "Porto Pozzuoli", vessel: "Traghetto", weight: 7 },
  { place_type: "hotel", dest: null, vessel: null, weight: 5 },
];

function pickDestination() {
  const roll = rndInt(1, 100);
  let acc = 0;
  for (const d of DEPARTURE_DESTINATIONS) {
    acc += d.weight;
    if (roll <= acc) return d;
  }
  return DEPARTURE_DESTINATIONS[0];
}

function genTransportCode(dest) {
  if (!dest.vessel) return null;
  if (dest.place_type === "airport") {
    const airlines = ["AZ", "FR", "VY", "U2", "LH", "AF"];
    return `${rnd(airlines)}${rndInt(1000, 9999)}`;
  }
  if (dest.place_type === "station") {
    return `IC${rndInt(100, 999)}`;
  }
  return null;
}

// ─── Fasce pickup per zona ────────────────────────────────────────────────────

const ZONE_PICKUP_TIMES = {
  "Ischia Porto":     ["04:00","04:30","05:00","05:30","06:00","06:30","07:00","07:30","08:00","08:30","09:00","09:30","10:00","10:30","11:00","12:00"],
  "Ischia Ponte":     ["03:30","04:00","04:30","05:00","05:30","06:00","06:30","07:00","07:30","08:00","09:00","10:00","11:00"],
  "Casamicciola":     ["03:30","04:00","04:30","05:00","05:30","06:00","06:30","07:00","07:30","08:00","09:00","10:00"],
  "Lacco Ameno":      ["03:00","03:30","04:00","04:30","05:00","05:30","06:00","06:30","07:00","08:00","09:00"],
  "Forio":            ["02:30","03:00","03:30","04:00","04:30","05:00","05:30","06:00","06:30","07:00","08:00"],
  "Barano":           ["03:30","04:00","04:30","05:00","05:30","06:00","06:30","07:00","08:00"],
  "Sant'Angelo":      ["02:30","03:00","03:30","04:00","04:30","05:00","05:30","06:00","06:30"],
  "Serrara Fontana":  ["02:30","03:00","03:30","04:00","04:30","05:00","05:30"],
};

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
    throw new Error(`Supabase error ${res.status}: ${err}`);
  }
  if (options.method === "GET" || !options.method) {
    const text = await res.text();
    return text ? JSON.parse(text) : [];
  }
  return null;
}

async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (ans) => { rl.close(); resolve(ans.trim()); });
  });
}

// ─── Batch insert ─────────────────────────────────────────────────────────────

async function batchInsert(table, rows, batchSize = 200) {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize);
    await supabaseFetch(`/${table}`, {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(chunk),
    });
    inserted += chunk.length;
    process.stdout.write(`\r  Inseriti ${inserted}/${rows.length} in ${table}…`);
  }
  console.log();
  return inserted;
}

// ─── CLEAN ────────────────────────────────────────────────────────────────────

async function cleanTestData() {
  console.log(`\n🧹 Pulizia dati di test (${TEST_DATE})…`);

  // Fetch test service IDs
  const testServices = await supabaseFetch(
    `/services?select=id&tenant_id=eq.${TENANT_ID}&is_test_data=eq.true&date=eq.${TEST_DATE}&limit=2000`,
    { method: "GET", headers: { Prefer: "" } }
  );

  if (!testServices.length) {
    console.log("  Nessun dato di test trovato per questa data.");
    return;
  }

  console.log(`  Trovati ${testServices.length} servizi da eliminare.`);

  const ans = await ask(`  Confermi eliminazione di ${testServices.length} servizi di test? (sì/no): `);
  if (ans.toLowerCase() !== "sì" && ans.toLowerCase() !== "si" && ans.toLowerCase() !== "s") {
    console.log("  Annullato.");
    return;
  }

  const ids = testServices.map((s) => s.id);

  // Elimina assignments prima (FK)
  await supabaseFetch(
    `/assignments?tenant_id=eq.${TENANT_ID}&service_id=in.(${ids.join(",")})`,
    { method: "DELETE" }
  );

  // Elimina servizi
  await supabaseFetch(
    `/services?tenant_id=eq.${TENANT_ID}&is_test_data=eq.true&date=eq.${TEST_DATE}`,
    { method: "DELETE" }
  );

  // Elimina trip_groups del giorno di test
  await supabaseFetch(
    `/trip_groups?tenant_id=eq.${TENANT_ID}&date=eq.${TEST_DATE}`,
    { method: "DELETE" }
  );

  console.log(`  ✅ Eliminati ${ids.length} servizi di test.`);
}

// ─── SEED ─────────────────────────────────────────────────────────────────────

async function seed() {
  console.log(`\n🌱 Seed domenica di test: ${TEST_DATE}`);
  console.log(`   Tenant: ${TENANT_ID} (ISCHIA TRANSFER SERVICE)\n`);

  // 1. Carica hotels per zona
  console.log("Caricamento hotel per zona…");
  const hotels = await supabaseFetch(
    `/hotels?select=id,name,zone&tenant_id=eq.${TENANT_ID}&is_active=eq.true&limit=300`,
    { method: "GET", headers: { Prefer: "" } }
  );

  const hotelsByZone = {};
  for (const h of hotels) {
    const z = h.zone || "Ischia Porto";
    if (!hotelsByZone[z]) hotelsByZone[z] = [];
    hotelsByZone[z].push(h);
  }
  const allHotels = hotels;
  const zones = Object.keys(ZONE_PICKUP_TIMES);

  console.log(`  ${hotels.length} hotel caricati in ${Object.keys(hotelsByZone).length} zone.\n`);

  // ─── Genera ARRIVI ───────────────────────────────────────────────────────

  console.log("Generazione arrivi (target ~600 PAX)…");

  const arrivalRows = [];
  const arrivalStats = {};
  let totalArrivalPax = 0;

  // Distribuisci i pax target sulle corse in proporzione al peso
  const totalWeight = ARRIVALS_RUNS.reduce((s, r) => s + r[3], 0);

  // Casi limite speciali per arrivi
  let sameCognome = IT_LAST[rndInt(0, IT_LAST.length - 1)];
  let sameCognomeCount = 0;

  for (const [time, vessel, porto, weight] of ARRIVALS_RUNS) {
    const targetPax = Math.round((weight / totalWeight) * 600);
    const key = `${time} ${vessel}`;
    arrivalStats[key] = { bookings: 0, pax: 0, porto };

    let runPax = 0;
    while (runPax < targetPax - 5) {
      const pax = Math.min(genPax(), targetPax - runPax);
      if (pax <= 0) break;

      const customer = genCustomer();

      // Caso limite: stesso cognome su corse diverse (prime 3 occorrenze)
      if (sameCognomeCount < 3 && Math.random() < 0.08) {
        customer.customer_last_name = sameCognome;
        customer.customer_name = `${customer.customer_first_name} ${sameCognome}`;
        sameCognomeCount++;
      }

      const hotel = rnd(allHotels);
      const notes = genNotes();

      arrivalRows.push({
        id: uuid(),
        tenant_id: TENANT_ID,
        date: TEST_DATE,
        time: `${time}:00`,
        direction: "arrival",
        vessel,
        pax,
        hotel_id: hotel.id,
        status: Math.random() < 0.04 ? "completato" : "new",
        is_test_data: true,
        is_draft: false,
        notes,
        meeting_point: porto === "Casamicciola" ? "Biglietteria SNAV Casamicciola" : "Uscita arrivi",
        service_type: "transfer",
        ...customer,
      });

      runPax += pax;
      arrivalStats[key].bookings++;
      arrivalStats[key].pax += pax;
    }
    totalArrivalPax += runPax;
  }

  // ─── Genera PARTENZE ─────────────────────────────────────────────────────

  console.log("Generazione partenze (target ~600 PAX)…");

  const departureRows = [];
  const departureStats = {};
  let totalDeparturePax = 0;

  // Distribuisci uniformemente su zone e fasce
  const zoneList = zones.filter((z) => hotelsByZone[z]?.length > 0);
  let depPax = 0;

  // Zone con più hotels → più partenze
  for (const zone of zoneList) {
    const zoneHotels = hotelsByZone[zone] || [];
    if (!zoneHotels.length) continue;
    const pickupTimes = ZONE_PICKUP_TIMES[zone] || ["06:00"];
    const targetPaxZone = Math.round(600 / zoneList.length * (zoneHotels.length / hotels.length * zoneList.length));

    let zonePax = 0;
    departureStats[zone] = { bookings: 0, pax: 0 };

    while (zonePax < targetPaxZone - 3 && depPax < 620) {
      const pax = Math.min(genPax(), targetPaxZone - zonePax);
      if (pax <= 0) break;

      const customer = genCustomer();
      const hotel = rnd(zoneHotels);
      const pickupTime = rnd(pickupTimes);
      const dest = pickDestination();
      const transportCode = genTransportCode(dest);
      const notes = genNotes();

      departureRows.push({
        id: uuid(),
        tenant_id: TENANT_ID,
        date: TEST_DATE,
        time: `${pickupTime}:00`,
        direction: "departure",
        vessel: dest.vessel ?? "Traghetto",
        place_type: dest.place_type,
        pax,
        hotel_id: hotel.id,
        status: Math.random() < 0.04 ? "completato" : "new",
        is_test_data: true,
        is_draft: false,
        notes,
        transport_code: transportCode,
        service_type: "transfer",
        ...customer,
      });

      zonePax += pax;
      depPax += pax;
      departureStats[zone].bookings++;
      departureStats[zone].pax += pax;
    }
    totalDeparturePax += zonePax;
  }

  // ─── Casi limite aggiuntivi ───────────────────────────────────────────────

  // Partenze con pickup molto vicini nella stessa zona (overbooking test)
  const ischiaPortoHotels = hotelsByZone["Ischia Porto"] || [];
  for (let i = 0; i < 3; i++) {
    const customer = genCustomer();
    const hotel = rnd(ischiaPortoHotels.length ? ischiaPortoHotels : allHotels);
    departureRows.push({
      id: uuid(),
      tenant_id: TENANT_ID,
      date: TEST_DATE,
      time: "05:30:00",
      direction: "departure",
      vessel: "Traghetto",
      pax: rndInt(14, 18), // overbooking su van 8/9 posti
      hotel_id: hotel.id,
      status: "new",
      is_test_data: true,
      is_draft: false,
      notes: "GRUPPO GRANDE — verificare capienza mezzo",
      service_type: "transfer",
      place_type: "port",
      ...customer,
    });
    totalDeparturePax += rndInt(14, 18);
    departureStats["Ischia Porto"].bookings++;
  }

  // ─── Preview e conferma ───────────────────────────────────────────────────

  const total = arrivalRows.length + departureRows.length;

  console.log("\n══════════════════════════════════════════════════");
  console.log(`  RIEPILOGO DATASET — ${TEST_DATE} (domenica)`);
  console.log("══════════════════════════════════════════════════");
  console.log(`\n  ARRIVI: ${arrivalRows.length} prenotazioni — ${totalArrivalPax} PAX`);
  for (const [key, stat] of Object.entries(arrivalStats)) {
    if (stat.bookings > 0) {
      console.log(`    ${key.padEnd(30)} ${String(stat.pax).padStart(4)} PAX  ${stat.bookings} prenotazioni`);
    }
  }

  console.log(`\n  PARTENZE: ${departureRows.length} prenotazioni — ${totalDeparturePax} PAX`);
  for (const [zone, stat] of Object.entries(departureStats)) {
    if (stat.bookings > 0) {
      console.log(`    ${zone.padEnd(20)} ${String(stat.pax).padStart(4)} PAX  ${stat.bookings} prenotazioni`);
    }
  }

  const withNotes = [...arrivalRows, ...departureRows].filter((r) => r.notes).length;
  const withBigGroups = [...arrivalRows, ...departureRows].filter((r) => r.pax >= 11).length;
  const intlPhones = [...arrivalRows, ...departureRows].filter((r) => !r.phone.startsWith("+39")).length;
  const completed = [...arrivalRows, ...departureRows].filter((r) => r.status === "completato").length;

  console.log(`\n  CASI LIMITE:`);
  console.log(`    Note speciali:           ${withNotes}`);
  console.log(`    Gruppi grandi (11+ PAX): ${withBigGroups}`);
  console.log(`    Telefoni internazionali:  ${intlPhones}`);
  console.log(`    Già completati (test):    ${completed}`);
  console.log(`\n  TOTALE INSERIMENTI: ${total} prenotazioni`);
  console.log("══════════════════════════════════════════════════\n");

  if (isDry) {
    console.log("  [--dry] Simulazione completata. Nessun dato scritto.\n");
    return;
  }

  const ans = await ask(`  Confermi inserimento di ${total} record nel DB? (sì/no): `);
  if (ans.toLowerCase() !== "sì" && ans.toLowerCase() !== "si" && ans.toLowerCase() !== "s") {
    console.log("  Annullato.\n");
    return;
  }

  console.log("\n  Inserimento in corso…\n");

  const t0 = Date.now();
  await batchInsert("services", arrivalRows, 200);
  await batchInsert("services", departureRows, 200);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n  ✅ Completato in ${elapsed}s`);
  console.log(`  ${arrivalRows.length} arrivi + ${departureRows.length} partenze inseriti.`);
  console.log(`  Per rimuoverli: node scripts/seed-test-sunday.mjs --clean\n`);
}

// ─── Entry point ──────────────────────────────────────────────────────────────

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Errore: NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY richiesti in .env.local");
  process.exit(1);
}

if (isClean) {
  cleanTestData().catch((e) => { console.error(e); process.exit(1); });
} else {
  seed().catch((e) => { console.error(e); process.exit(1); });
}
