#!/usr/bin/env node
/**
 * Seed: domenica di alta stagione — 12 ottobre 2025
 * Crea ~500 servizi per stress-test del Piano del Giorno.
 * Include casi limite per: hotel_vehicle_limits, max_vehicle_capacity autisti,
 * vehicle_time_blocks, disponibilità driver, numero volo arrivo/partenza, Lista Bruno.
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
  return Math.random() < 0.15 ? rnd(SPECIAL_NOTES) : "";
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
  { place_type: "airport", dest: "Aeroporto Napoli Capodichino", vessel: "Volo", weight: 33 },
  { place_type: "station", dest: "Stazione Napoli Centrale", vessel: "Treno", weight: 27 },
  { place_type: "hotel",   dest: "FlixBus Napoli", vessel: "FlixBus", weight: 10 },
  { place_type: "hotel",   dest: "Porto Napoli Beverello", vessel: "Traghetto", weight: 17 },
  { place_type: "hotel",   dest: "Porto Pozzuoli", vessel: "Traghetto", weight: 8 },
  { place_type: "hotel",   dest: null, vessel: null, weight: 5 },
];

// Veicoli premium per transfer privati/esclusivi
const PRIVATE_VEHICLES = ["Classe E", "SAAB 9-5", "Vito Extra Long"];

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
  "Ischia Porto":     ["05:15","05:30","06:30","07:20","08:40","11:50","12:30","14:00","15:30","16:45"],
  "Ischia Ponte":     ["05:30","06:00","06:30","07:00","07:30","08:40","11:50","12:30","14:00","15:30","16:45"],
  "Casamicciola":     ["05:15","05:30","06:30","07:15","08:45","11:50","12:45","14:00","14:30","15:30","16:50"],
  "Lacco Ameno":      ["05:15","05:20","06:30","07:10","08:40","08:45","11:50","12:30","14:00","15:30","16:50"],
  "Forio":            ["05:00","06:20","07:00","08:30","11:45","12:15","13:45","14:00","15:15","16:45"],
  "Barano":           ["05:00","06:15","07:10","08:15","09:00","11:30","12:00","13:45","15:15","16:30"],
  "Sant'Angelo":      ["05:00","06:00","07:00","08:00","09:00","11:00","13:00","15:00","16:00"],
  "Serrara Fontana":  ["05:00","06:00","07:00","08:00","09:00","11:00","13:00","15:00"],
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

function normalizeRows(rows) {
  const allKeys = new Set();
  for (const r of rows) for (const k of Object.keys(r)) allKeys.add(k);
  return rows.map((r) => {
    const out = {};
    for (const k of allKeys) out[k] = k in r ? r[k] : null;
    return out;
  });
}

async function batchInsert(table, rows, batchSize = 200) {
  const normalized = normalizeRows(rows);
  let inserted = 0;
  for (let i = 0; i < normalized.length; i += batchSize) {
    const chunk = normalized.slice(i, i + batchSize);
    await supabaseFetch(`/${table}`, {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(chunk),
    });
    inserted += chunk.length;
    process.stdout.write(`\r  Inseriti ${inserted}/${normalized.length} in ${table}…`);
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

  // 1. Elimina assignments in batch da 50 (URL limit)
  const BATCH = 50;
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    await supabaseFetch(
      `/assignments?tenant_id=eq.${TENANT_ID}&service_id=in.(${chunk.join(",")})`,
      { method: "DELETE" }
    );
  }

  // 2. Elimina trip_groups del giorno (prima dei servizi)
  await supabaseFetch(
    `/trip_groups?tenant_id=eq.${TENANT_ID}&date=eq.${TEST_DATE}`,
    { method: "DELETE" }
  );

  // 3. Elimina servizi
  await supabaseFetch(
    `/services?tenant_id=eq.${TENANT_ID}&is_test_data=eq.true&date=eq.${TEST_DATE}`,
    { method: "DELETE" }
  );

  // 4. Elimina disponibilità autisti/mezzi e blocchi orari del giorno
  await supabaseFetch(`/driver_daily_availability?tenant_id=eq.${TENANT_ID}&date=eq.${TEST_DATE}`, { method: "DELETE" });
  await supabaseFetch(`/vehicle_daily_availability?tenant_id=eq.${TENANT_ID}&date=eq.${TEST_DATE}`, { method: "DELETE" });
  await supabaseFetch(`/vehicle_time_blocks?tenant_id=eq.${TENANT_ID}&date=eq.${TEST_DATE}`, { method: "DELETE" });
  await supabaseFetch(`/daily_availability_confirmations?tenant_id=eq.${TENANT_ID}&date=eq.${TEST_DATE}`, { method: "DELETE" });

  console.log(`  ✅ Eliminati ${ids.length} servizi di test + dati disponibilità.`);
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

  console.log("Generazione arrivi (target ~250 prenotazioni)…");

  const arrivalRows = [];
  const arrivalStats = {};
  let totalArrivalPax = 0;

  const totalWeight = ARRIVALS_RUNS.reduce((s, r) => s + r[3], 0);
  let sameCognome = IT_LAST[rndInt(0, IT_LAST.length - 1)];
  let sameCognomeCount = 0;

  for (const [time, vessel, porto, weight] of ARRIVALS_RUNS) {
    const targetBookings = Math.max(2, Math.round((weight / totalWeight) * 250));
    const key = `${time} ${vessel}`;
    arrivalStats[key] = { bookings: 0, pax: 0, porto };

    for (let b = 0; b < targetBookings; b++) {
      const pax = genPax();
      const customer = genCustomer();

      if (sameCognomeCount < 3 && Math.random() < 0.08) {
        customer.customer_last_name = sameCognome;
        customer.customer_name = `${customer.customer_first_name} ${sameCognome}`;
        sameCognomeCount++;
      }

      const hotel = rnd(allHotels);
      const notes = genNotes();

      // Simula clienti aeroporto (20% degli arrivi) con numero volo
      const isAirportArrival = Math.random() < 0.20;
      const airlines = ["AZ", "FR", "VY", "U2", "LH"];
      const trainCodes = ["IC709", "FR9341", "IC601", "AV9313"];
      const arrFlightNum = isAirportArrival ? `${rnd(airlines)}${rndInt(1000,9999)}` : null;

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
        place_type: isAirportArrival ? "airport" : "hotel",
        service_type: "transfer",
        train_arrival_number: arrFlightNum ?? (Math.random() < 0.10 ? rnd(trainCodes) : null),
        booking_service_kind: isAirportArrival ? "transfer_airport_hotel" : null,
        ...customer,
      });

      totalArrivalPax += pax;
      arrivalStats[key].bookings++;
      arrivalStats[key].pax += pax;
    }
  }

  // ─── Genera PARTENZE ─────────────────────────────────────────────────────

  console.log("Generazione partenze (target ~250 prenotazioni)…");

  // Orari di partenza realistici per tipo destinazione
  const DEPARTURE_FERRY_TIMES = ["06:20", "07:30", "09:00", "11:00", "13:00", "15:30", "17:00"];
  const DEPARTURE_TRAIN_TIMES = ["09:05", "10:30", "12:00", "14:15", "16:30", "18:00", "19:30"];
  const DEPARTURE_FLIGHT_TIMES = ["07:00", "08:30", "10:00", "12:30", "15:00", "17:30", "20:00"];

  function pickDepartureTime(dest) {
    if (dest.place_type === "airport") return rnd(DEPARTURE_FLIGHT_TIMES);
    if (dest.place_type === "station") return rnd(DEPARTURE_TRAIN_TIMES);
    return rnd(DEPARTURE_FERRY_TIMES);
  }

  // Per stazione/aeroporto: orario barca di connessione
  const FERRY_CONNECTIONS = [
    { barca: "MEDMAR", orario: "06:20", porto: "Casamicciola" },
    { barca: "MEDMAR", orario: "09:00", porto: "Pozzuoli" },
    { barca: "ALILAURO", orario: "07:10", porto: "Ischia Porto" },
    { barca: "SNAV",    orario: "08:30", porto: "Casamicciola" },
  ];

  const departureRows = [];
  const departureStats = {};
  let totalDeparturePax = 0;

  const zoneList = zones.filter((z) => hotelsByZone[z]?.length > 0);
  const targetPerZone = Math.ceil(250 / zoneList.length);
  let totalDepBookings = 0;

  for (const zone of zoneList) {
    const zoneHotels = hotelsByZone[zone] || [];
    if (!zoneHotels.length) continue;
    const pickupTimes = ZONE_PICKUP_TIMES[zone] || ["06:00"];
    departureStats[zone] = { bookings: 0, pax: 0 };

    for (let b = 0; b < targetPerZone && totalDepBookings < 255; b++) {
      const pax = genPax();
      const customer = genCustomer();
      const hotel = rnd(zoneHotels);
      const dest = pickDestination();
      const transportCode = genTransportCode(dest);
      const notes = genNotes();

      // Orario servizio: per traghetti/porto = pickup dall'hotel,
      // per stazione/aeroporto = orario treno/volo
      const isTransport = dest.place_type === "station" || dest.place_type === "airport";
      const serviceTime = isTransport ? pickDepartureTime(dest) : rnd(pickupTimes);

      // pickup_hotel: per stazione/aeroporto = zona pickup, altrimenti null
      const pickupHotel = isTransport ? rnd(pickupTimes) : null;

      // Connessione barca per stazione/aeroporto
      const ferry = isTransport ? rnd(FERRY_CONNECTIONS) : null;
      const barcaCompagnia = ferry?.barca ?? null;
      const orarioBarca = ferry?.orario ?? null;

      const airlines2 = ["AZ", "FR", "VY", "U2", "LH"];
      const trainCodes2 = ["IC709", "FR9341", "IC601"];
      const depFlightNum = dest.place_type === "airport"
        ? `${rnd(airlines2)}${rndInt(1000, 9999)}`
        : dest.place_type === "station"
          ? (Math.random() < 0.60 ? rnd(trainCodes2) : null)
          : null;

      departureRows.push({
        id: uuid(),
        tenant_id: TENANT_ID,
        date: TEST_DATE,
        time: `${serviceTime}:00`,
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
        pickup_hotel: pickupHotel,
        barca_compagnia: barcaCompagnia,
        orario_barca: orarioBarca,
        service_type: "transfer",
        train_departure_number: depFlightNum,
        ...customer,
      });

      totalDeparturePax += pax;
      totalDepBookings++;
      departureStats[zone].bookings++;
      departureStats[zone].pax += pax;
    }
  }

  // ─── Casi limite: gruppi grandi overbooking ───────────────────────────────

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
      pax: rndInt(14, 18),
      hotel_id: hotel.id,
      status: "new",
      is_test_data: true,
      is_draft: false,
      notes: "GRUPPO GRANDE — verificare capienza mezzo",
      transport_code: null,
      pickup_hotel: null,
      barca_compagnia: null,
      orario_barca: null,
      service_type: "transfer",
      place_type: "hotel",
      ...customer,
    });
    totalDeparturePax += rndInt(14, 18);
    if (departureStats["Ischia Porto"]) departureStats["Ischia Porto"].bookings++;
  }

  // ─── Transfer privati/esclusivi ──────────────────────────────────────────
  // ~12 arrivi + ~12 partenze con veicolo premium, sempre via traghetto/aliscafo

  const PRIVATE_FERRY_ARRIVALS = [
    { time: "08:10", vessel: "SNAV FR8110", porto: "Casamicciola" },
    { time: "09:20", vessel: "SNAV FR9200", porto: "Casamicciola" },
    { time: "09:40", vessel: "Medmar MN940", porto: "Ischia Porto" },
    { time: "12:30", vessel: "SNAV FR1230", porto: "Casamicciola" },
    { time: "13:30", vessel: "Medmar MN1330", porto: "Ischia Porto" },
    { time: "16:30", vessel: "Medmar MN1630", porto: "Ischia Porto" },
  ];

  const PRIVATE_FERRY_DEPARTURES = [
    { vessel: "SNAV",   orario: "07:00", porto: "Casamicciola" },
    { vessel: "SNAV",   orario: "09:30", porto: "Casamicciola" },
    { vessel: "Medmar", orario: "06:00", porto: "Ischia Porto" },
    { vessel: "Medmar", orario: "08:00", porto: "Casamicciola" },
    { vessel: "Medmar", orario: "11:00", porto: "Ischia Porto" },
    { vessel: "Medmar", orario: "14:00", porto: "Casamicciola" },
  ];

  const PRIVATE_ORIGIN_DEST = [
    { place_type: "airport", label: "Aeroporto Napoli Capodichino", vessel_dest: "Volo", kind: "transfer_airport_hotel_exclusive" },
    { place_type: "station", label: "Stazione Napoli Centrale",     vessel_dest: "Treno", kind: "transfer_train_hotel_exclusive" },
  ];

  // Arrivi privati: il cliente arriva dall'aeroporto/stazione in traghetto/aliscafo
  for (const ferry of PRIVATE_FERRY_ARRIVALS) {
    const reps = rndInt(1, 2); // 1-2 clienti privati per corsa
    for (let i = 0; i < reps; i++) {
      const customer = genCustomer();
      const hotel = rnd(allHotels);
      const origin = rnd(PRIVATE_ORIGIN_DEST);
      const vehicle = rnd(PRIVATE_VEHICLES);
      arrivalRows.push({
        id: uuid(),
        tenant_id: TENANT_ID,
        date: TEST_DATE,
        time: `${ferry.time}:00`,
        direction: "arrival",
        vessel: ferry.vessel,
        pax: rndInt(1, 3),
        hotel_id: hotel.id,
        status: "new",
        is_test_data: true,
        is_draft: false,
        notes: `Transfer privato — ${vehicle}`,
        meeting_point: ferry.porto === "Casamicciola" ? "Biglietteria SNAV Casamicciola" : "Uscita arrivi",
        place_type: origin.place_type,
        booking_service_kind: origin.kind,
        service_type: "transfer",
        ...customer,
      });
    }
  }

  // Partenze private: il cliente parte dall'hotel per traghetto/aliscafo verso aeroporto/stazione
  for (const ferry of PRIVATE_FERRY_DEPARTURES) {
    const reps = rndInt(1, 2);
    for (let i = 0; i < reps; i++) {
      const customer = genCustomer();
      const zone = rnd(zoneList);
      const hotel = rnd(hotelsByZone[zone] || allHotels);
      const dest = rnd(PRIVATE_ORIGIN_DEST);
      const vehicle = rnd(PRIVATE_VEHICLES);
      const pickupTimes = ZONE_PICKUP_TIMES[zone] || ["06:00"];
      const pickupTime = rnd(pickupTimes);
      const destTime = dest.place_type === "airport"
        ? rnd(DEPARTURE_FLIGHT_TIMES)
        : rnd(DEPARTURE_TRAIN_TIMES);

      departureRows.push({
        id: uuid(),
        tenant_id: TENANT_ID,
        date: TEST_DATE,
        time: `${destTime}:00`,
        direction: "departure",
        vessel: ferry.vessel,
        pax: rndInt(1, 3),
        hotel_id: hotel.id,
        status: "new",
        is_test_data: true,
        is_draft: false,
        notes: `Transfer privato — ${vehicle}`,
        place_type: dest.place_type,
        pickup_hotel: `${pickupTime}:00`,
        barca_compagnia: ferry.vessel,
        orario_barca: `${ferry.orario}:00`,
        booking_service_kind: dest.kind,
        service_type: "transfer",
        ...customer,
      });
    }
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
  const withPickupHotel = departureRows.filter((r) => r.pickup_hotel).length;
  const airportDeps = departureRows.filter((r) => r.place_type === "airport").length;
  const stationDeps = departureRows.filter((r) => r.place_type === "station").length;
  const privatiArr = arrivalRows.filter((r) => r.booking_service_kind?.includes("exclusive")).length;
  const privatiDep = departureRows.filter((r) => r.booking_service_kind?.includes("exclusive")).length;

  console.log(`\n  CASI LIMITE:`);
  console.log(`    Note speciali:           ${withNotes}`);
  console.log(`    Gruppi grandi (11+ PAX): ${withBigGroups}`);
  console.log(`    Telefoni internazionali:  ${intlPhones}`);
  console.log(`    Già completati (test):    ${completed}`);
  console.log(`    Partenze aeroporto:       ${airportDeps}`);
  console.log(`    Partenze stazione:        ${stationDeps}`);
  console.log(`    Con pickup_hotel calcolato: ${withPickupHotel}`);
  console.log(`    Transfer privati arrivi:  ${privatiArr}`);
  console.log(`    Transfer privati partenze:${privatiDep}`);
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

  // ─── Seed disponibilità autisti + vincoli mezzi ───────────────────────────

  console.log("\n  Seeding disponibilità autisti per test constraints…");

  // Carica autisti (driver)
  const drivers = await supabaseFetch(
    `/memberships?select=user_id,full_name,max_vehicle_capacity&tenant_id=eq.${TENANT_ID}&role=eq.driver&limit=30`,
    { method: "GET", headers: { Prefer: "" } }
  );

  if (drivers.length > 0) {
    const driverAvailRows = drivers.map((d, i) => ({
      id: uuid(),
      tenant_id: TENANT_ID,
      driver_user_id: d.user_id,
      date: TEST_DATE,
      // Primo driver non disponibile (test constraint), alternati disponibili con orari
      available: i === 0 ? false : true,
      available_from: i === 2 ? "09:00" : null,  // terzo driver disponibile solo dalle 9
      available_to: i === 3 ? "14:00" : null,     // quarto driver disponibile fino alle 14
      notes: i === 0 ? "Test: non disponibile" : i === 2 ? "Test: disponibile dalle 09:00" : null,
    }));
    await batchInsert("driver_daily_availability", driverAvailRows, 50);
    console.log(`  ${driverAvailRows.length} disponibilità autisti inserite.`);
  }

  // Carica mezzi
  const vehicles = await supabaseFetch(
    `/vehicles?select=id,label,capacity&tenant_id=eq.${TENANT_ID}&active=eq.true&limit=20`,
    { method: "GET", headers: { Prefer: "" } }
  );

  if (vehicles.length >= 2) {
    // Primo mezzo non disponibile
    const vehicleAvailRows = [
      { id: uuid(), tenant_id: TENANT_ID, vehicle_id: vehicles[0].id, date: TEST_DATE, available: false, notes: "Test: fuori servizio" },
    ];
    await batchInsert("vehicle_daily_availability", vehicleAvailRows, 10);

    // Secondo mezzo: blocco orario 09:00-12:00 (manutenzione)
    const blockRows = [
      {
        id: uuid(), tenant_id: TENANT_ID, vehicle_id: vehicles[1].id, date: TEST_DATE,
        block_from: "09:00", block_to: "12:00", reason: "manutenzione",
        reason_notes: "Test: manutenzione programmata",
      },
      {
        id: uuid(), tenant_id: TENANT_ID, vehicle_id: vehicles[1].id, date: TEST_DATE,
        block_from: "15:00", block_to: "17:00", reason: "escursione",
        reason_notes: "Test: escursione privata",
      },
    ];
    await batchInsert("vehicle_time_blocks", blockRows, 10);
    console.log(`  Vincoli mezzi inseriti (1 fuori servizio, 1 con blocchi orari).`);
  }

  // Conferma disponibilità (set confirmed=true per il giorno di test)
  await supabaseFetch("/daily_availability_confirmations", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({
      id: uuid(), tenant_id: TENANT_ID, date: TEST_DATE,
      confirmed: true, confirmed_at: new Date().toISOString(), confirmed_by: null,
    }),
  }).catch(() => {});
  console.log("  Disponibilità confermata per il giorno di test.");

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
