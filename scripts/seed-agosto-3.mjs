#!/usr/bin/env node
/**
 * Seed: 3 agosto 2025 — dati operativi reali (demo Piano del Giorno)
 * Legge "03 AGOSTO 2025 PER LUCA .xlsx" dalla cartella Downloads e inserisce i servizi.
 *
 * Uso:
 *   node scripts/seed-agosto-3.mjs          — inserisce dati
 *   node scripts/seed-agosto-3.mjs --clean  — rimuove dati inseriti
 *   node scripts/seed-agosto-3.mjs --dry    — simula senza scrivere
 */

import { readFileSync } from "fs";
import { createInterface } from "readline";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const require = createRequire(import.meta.url);
const xlsx = require("xlsx");

// ─── Config ───────────────────────────────────────────────────────────────────

const SEED_DATE = "2025-08-03";
const TENANT_ID = "d200b89a-64c7-4f8d-a430-95a33b83047a";

// Modifica il percorso se il file si trova altrove
const XLSX_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../Downloads/03 AGOSTO 2025 PER LUCA .xlsx"
);

const envContent = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const getEnv = (k) => {
  const m = envContent.match(new RegExp(`^${k}=(.+)$`, "m"));
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
};

const SUPABASE_URL = getEnv("NEXT_PUBLIC_SUPABASE_URL");
const SERVICE_KEY = getEnv("SUPABASE_SERVICE_ROLE_KEY");
const isDry = process.argv.includes("--dry");
const isClean = process.argv.includes("--clean");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function uuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function extractTime(s) {
  const str = String(s ?? "").replace(",", ".");
  const m = str.match(/(\d{1,2})[.:h](\d{2})/);
  if (!m) return null;
  return `${m[1].padStart(2, "0")}:${m[2]}:00`;
}

function normalizeVessel(s) {
  const t = String(s ?? "").toLowerCase();
  if (t.includes("medmar")) return "Medmar";
  if (t.includes("snav")) return "SNAV";
  if (t.includes("alilauro")) return "Alilauro";
  if (t.includes("caremar")) return "Caremar";
  if (t.includes("gestour")) return "Gestour";
  if (t.includes("aliscafo") || t.includes("alisc")) return "Aliscafo";
  return String(s ?? "").trim() || "Traghetto";
}

function parsePax(s) {
  const str = String(s ?? "").toLowerCase().trim();
  if (!str || str === "0") return 1;
  const nums = str.match(/\d+/g);
  if (!nums) return 1;
  // "43 + 1 CANE" → somma solo i numeri prima di "cane/kg/bagagli"
  const caneIdx = str.indexOf("cane");
  const cleaned = caneIdx >= 0 ? str.slice(0, caneIdx) : str;
  const cleaned2 = cleaned.match(/\d+/g);
  if (!cleaned2) return 1;
  return cleaned2.reduce((s, n) => s + parseInt(n, 10), 0);
}

function formatPickupTime(s) {
  const str = String(s ?? "").replace(",", ".").trim();
  if (!str || str === "***" || str === "**") return null;
  const m = str.match(/^(\d{1,2})[.:h](\d{2})$/);
  if (!m) return null;
  return `${m[1].padStart(2, "0")}:${m[2]}:00`;
}

function extractCustomerName(notes) {
  if (!notes) return null;
  const s = String(notes).trim();
  // Strip leading "pr. XXXX" or "pr.XXXX"
  const cleaned = s.replace(/^pr\.?\s*\d+\s*/i, "");
  // Match "NOME COGNOME [3xxxxxxxxx|phone|TRF|GRP...]"
  const m = cleaned.match(/^([A-ZÀ-Ÿa-zà-ÿ][A-ZÀ-Ÿa-zà-ÿ\s'\-\.]{2,60}?)(?=\s+\d{4,}|\s+TRF|\s+GRP|\s+CHD|\s+nastrino|\s+\(|$)/);
  if (m) return m[1].trim().slice(0, 80);
  return cleaned.slice(0, 80).trim() || null;
}

function inferDeparturePort(vesselStr, destStr) {
  const v = String(vesselStr ?? "").toLowerCase();
  const d = String(destStr ?? "").toLowerCase();
  if (d.includes("stz") || d.includes("stazione") || d.includes("napoli centrale")) return "Stazione Napoli Centrale";
  if (d.includes("apt") || d.includes("aeroporto") || d.includes("capodichino")) return "Aeroporto Capodichino";
  if (d.includes("metropark")) return "Metropark Napoli";
  if (d.includes("bagnoli")) return "Bagnoli";
  if (d.includes("beverello")) return "Napoli Beverello";
  if (d.includes("pozzuoli")) return "Pozzuoli";
  if (d.includes("casamicciola")) return "Porto Casamicciola";
  if (d.includes("linea") || d.includes("bus")) return "Linea Bus";
  // Infer from vessel
  if (v.includes("snav")) return "Ischia Porto";
  if (v.includes("alilauro")) return "Ischia Porto";
  if (v.includes("medmar")) return "Porto Casamicciola";
  if (v.includes("gestour")) return "Porto Casamicciola";
  if (d.includes("snav")) return "Ischia Porto";
  if (d.includes("medmar")) return "Porto Casamicciola";
  if (d.includes("alilauro")) return "Ischia Porto";
  return d || null;
}

function inferArrivalPort(vesselStr) {
  const v = String(vesselStr ?? "").toLowerCase();
  if (v.includes("alilauro")) return "Ischia Porto";
  if (v.includes("caremar")) return "Porto Casamicciola";
  if (v.includes("snav")) return "Porto Casamicciola";
  if (v.includes("medmar")) {
    const t = extractTime(vesselStr);
    if (t === "08:15:00") return "Porto Casamicciola";
    if (t === "12:00:00") return "Ischia Porto";
    return "Ischia Porto";
  }
  return "Ischia Porto";
}

function inferDepartureKind(destStr) {
  const d = String(destStr ?? "").toLowerCase();
  if (d.includes("apt") || d.includes("aeroporto") || d.includes("capodichino")) return "transfer_airport_hotel";
  if (d.includes("stz") || d.includes("stazione") || d.includes("napoli centrale")) return "transfer_train_hotel";
  return "transfer_port_hotel";
}

function inferArrivalKind(originStr) {
  const o = String(originStr ?? "").toLowerCase();
  if (o.includes("apt") || o.includes("aeroporto") || o.includes("capodichino")) return "transfer_airport_hotel";
  if (o.includes("stz") || o.includes("stazione") || o.includes("napoli centrale")) return "transfer_train_hotel";
  return "transfer_port_hotel";
}

function normalizeYear(aa) {
  const y = parseInt(aa, 10);
  if (!y || y === 2025) return true;
  // accetta 2024/2015/2028 come errori di battitura, normalizza a 2025
  return true;
}

// ─── Supabase ─────────────────────────────────────────────────────────────────

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
  if (!options.method || options.method === "GET") {
    const text = await res.text();
    return text ? JSON.parse(text) : [];
  }
  return null;
}

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

async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (ans) => { rl.close(); resolve(ans.trim()); }));
}

// ─── Parser Excel ─────────────────────────────────────────────────────────────

function parseExcel() {
  const wb = xlsx.readFile(XLSX_PATH);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(ws, { header: 1, defval: "" });

  const departures = [];
  const arrivals = [];
  const excursions = [];

  let section = null;

  for (const row of rows) {
    const c = row.map((v) => String(v ?? "").trim());
    const label = c[0]?.toLowerCase() + c[1]?.toLowerCase();

    // Section headers
    if (c[0]?.toUpperCase() === "PARTENZE") { section = "dep"; continue; }
    if (c[0]?.toUpperCase() === "ARRIVI") { section = "arr"; continue; }
    if (c[0]?.toUpperCase() === "ESCURSIONI") { section = "exc"; continue; }
    // Skip sub-headers
    if (c[0] === "gg" && c[1] === "mm") continue;
    // Skip empty rows
    if (!c[0] && !c[4] && !c[5]) continue;

    const [gg, mm, aa, inizio, flight, paxRaw, cliente, da, a, imbarco, , auti, mezzo, tourOp, notes] = c;

    if (!normalizeYear(aa)) continue;
    const pax = parsePax(paxRaw);
    const pickupTime = formatPickupTime(auti);
    const customerName = extractCustomerName(notes);
    const tourOperator = String(tourOp ?? "").trim() || String(cliente ?? "").trim() || null;

    const base = {
      id: uuid(),
      tenant_id: TENANT_ID,
      date: SEED_DATE,
      pax,
      status: "confirmed",
      is_draft: false,
      is_test_data: true,
      customer_name: customerName,
      notes: notes ? String(notes).slice(0, 300) : null,
      service_type: "transfer",
    };

    if (section === "dep") {
      const flightLower = flight.toLowerCase();
      let vessel, vesselTime, meetingPoint, kind;

      if (flightLower === "partenza" || flightLower === "partenza ") {
        // vessel info is in col[8] (a)
        vessel = normalizeVessel(a);
        vesselTime = extractTime(a);
        meetingPoint = inferDeparturePort(a, a);
        kind = inferDepartureKind(a);
      } else if (flightLower === "**" || !flight || (flightLower === "*" )) {
        // special row with vessel in col[4] or col[8]
        if (a && /\d{1,2}:\d{2}/.test(a)) {
          vessel = normalizeVessel(a);
          vesselTime = extractTime(a);
          meetingPoint = inferDeparturePort(a, a);
        } else {
          vessel = normalizeVessel(flight);
          vesselTime = extractTime(flight);
          meetingPoint = inferDeparturePort(flight, a);
        }
        kind = inferDepartureKind(a);
      } else {
        // vessel info is in col[4] (flight)
        vessel = normalizeVessel(flight);
        vesselTime = extractTime(flight);
        meetingPoint = inferDeparturePort(flight, a);
        kind = inferDepartureKind(a);
      }

      if (!vesselTime) continue;

      departures.push({
        ...base,
        direction: "departure",
        time: vesselTime,
        vessel,
        pickup_hotel: pickupTime,
        meeting_point: meetingPoint,
        booking_service_kind: kind,
        customer_name: customerName || (pax > 10 ? `GRUPPO ${tourOperator ?? ""}` : null),
      });

    } else if (section === "arr") {
      const flightLower = flight.toLowerCase();
      let vessel, vesselTime, meetingPoint, kind, hotel;

      if (flightLower === "arrivo" || flightLower === "arrivo ") {
        // vessel/origin is in col[7] (da), destination hotel is col[8] (a)
        vessel = normalizeVessel(da);
        vesselTime = extractTime(da);
        hotel = a;
        meetingPoint = inferArrivalPort(da);
        kind = inferArrivalKind(da);
      } else if (flight && /^\d{2}:\d{2}$/.test(extractTime(flight) ?? "")) {
        // Already a time (should not happen, but guard)
        vessel = normalizeVessel(da);
        vesselTime = extractTime(da);
        hotel = a;
        meetingPoint = inferArrivalPort(da);
        kind = inferArrivalKind(da);
      } else if (flight && flight.toLowerCase() !== "arrivo" && /\S/.test(flight)) {
        // Type A: flight/train arrival — ferry connection in imbarco (col[9])
        vessel = String(flight).trim();
        vesselTime = extractTime(imbarco) ?? extractTime(auti);
        hotel = a;
        meetingPoint = inferArrivalPort(imbarco);
        const origin = da.toLowerCase();
        kind = origin.includes("apt") ? "transfer_airport_hotel"
             : origin.includes("stz") ? "transfer_train_hotel"
             : "transfer_port_hotel";
      } else {
        continue;
      }

      if (!vesselTime) continue;

      arrivals.push({
        ...base,
        direction: "arrival",
        time: vesselTime,
        vessel,
        meeting_point: meetingPoint,
        booking_service_kind: kind,
      });

    } else if (section === "exc") {
      // col[4] = excursion destination, col[7] = from, col[8] = to
      // pickup is going to port, return is from port
      const excDest = flight || da || a;
      const fromPlace = da.toLowerCase();
      const toPlace = a.toLowerCase();
      const isReturn = fromPlace.includes("porto") || fromPlace.includes("casamicciola") || fromPlace.includes("ischia");
      const direction = isReturn ? "arrival" : "departure";
      const t = formatPickupTime(auti) ?? "08:00:00";

      excursions.push({
        ...base,
        direction,
        time: t,
        vessel: null,
        meeting_point: isReturn ? null : (toPlace.includes("casamicciola") ? "Porto Casamicciola" : "Porto Ischia"),
        booking_service_kind: "excursion",
        notes: `Escursione ${excDest} — ${notes ?? ""}`.slice(0, 300),
      });
    }
  }

  return { departures, arrivals, excursions };
}

// ─── CLEAN ────────────────────────────────────────────────────────────────────

async function cleanAugust3() {
  console.log(`\n🧹 Pulizia dati seed agosto 3 (${SEED_DATE})…`);

  const testServices = await supabaseFetch(
    `/services?select=id&tenant_id=eq.${TENANT_ID}&is_test_data=eq.true&date=eq.${SEED_DATE}&limit=2000`,
    { method: "GET", headers: { Prefer: "" } }
  );

  if (!testServices.length) {
    console.log("  Nessun dato di test trovato per questa data.");
    return;
  }

  const ans = await ask(`  Trovati ${testServices.length} servizi. Confermi eliminazione? (sì/no): `);
  if (!["sì","si","s"].includes(ans.toLowerCase())) { console.log("  Annullato."); return; }

  const ids = testServices.map((s) => s.id);
  const BATCH = 50;
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    await supabaseFetch(
      `/assignments?tenant_id=eq.${TENANT_ID}&service_id=in.(${chunk.join(",")})`,
      { method: "DELETE" }
    );
  }
  await supabaseFetch(`/trip_groups?tenant_id=eq.${TENANT_ID}&date=eq.${SEED_DATE}`, { method: "DELETE" });
  await supabaseFetch(`/services?tenant_id=eq.${TENANT_ID}&is_test_data=eq.true&date=eq.${SEED_DATE}`, { method: "DELETE" });

  console.log(`  ✅ Eliminati ${ids.length} servizi di test.`);
}

// ─── SEED ─────────────────────────────────────────────────────────────────────

async function seed() {
  console.log(`\n🌱 Seed dati operativi reali: ${SEED_DATE}`);
  console.log(`   Tenant: ${TENANT_ID} (ISCHIA TRANSFER SERVICE)\n`);

  let parsed;
  try {
    parsed = parseExcel();
  } catch (e) {
    console.error(`\n  ❌ Impossibile leggere il file Excel:\n  ${e.message}`);
    console.error(`  Percorso cercato: ${XLSX_PATH}`);
    process.exit(1);
  }

  const { departures, arrivals, excursions } = parsed;
  const all = [...departures, ...arrivals, ...excursions];

  const totalPax = all.reduce((s, r) => s + (r.pax || 0), 0);
  const arrPax = arrivals.reduce((s, r) => s + (r.pax || 0), 0);
  const depPax = departures.reduce((s, r) => s + (r.pax || 0), 0);

  console.log("══════════════════════════════════════════════════");
  console.log(`  RIEPILOGO — ${SEED_DATE}`);
  console.log("══════════════════════════════════════════════════");
  console.log(`  Partenze:    ${departures.length} servizi — ${depPax} PAX`);
  console.log(`  Arrivi:      ${arrivals.length} servizi — ${arrPax} PAX`);
  console.log(`  Escursioni:  ${excursions.length} servizi`);
  console.log(`  TOTALE:      ${all.length} servizi — ${totalPax} PAX`);
  console.log("══════════════════════════════════════════════════\n");

  if (isDry) {
    console.log("  [--dry] Simulazione completata. Nessun dato scritto.\n");
    return;
  }

  const ans = await ask(`  Confermi inserimento di ${all.length} record nel DB per ${SEED_DATE}? (sì/no): `);
  if (!["sì","si","s"].includes(ans.toLowerCase())) { console.log("  Annullato.\n"); return; }

  const t0 = Date.now();
  console.log("\n  Inserimento in corso…\n");

  if (departures.length) await batchInsert("services", departures, 200);
  if (arrivals.length) await batchInsert("services", arrivals, 200);
  if (excursions.length) await batchInsert("services", excursions, 200);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n  ✅ Completato in ${elapsed}s`);
  console.log(`  ${all.length} servizi inseriti per il ${SEED_DATE}.`);
  console.log(`  Per rimuoverli: node scripts/seed-agosto-3.mjs --clean\n`);
}

// ─── Entry point ──────────────────────────────────────────────────────────────

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Errore: NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY richiesti in .env.local");
  process.exit(1);
}

if (isClean) {
  cleanAugust3().catch((e) => { console.error(e); process.exit(1); });
} else {
  seed().catch((e) => { console.error(e); process.exit(1); });
}
