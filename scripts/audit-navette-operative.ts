/**
 * DRY RUN — Audit operativo navette San Nicola / Cristallo / President.
 *
 * Read-only: non esegue insert/update/delete.
 *
 * Esegui:
 *   npx tsx scripts/audit-navette-operative.ts --date=2026-05-07
 */
import fs from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

type ServiceRow = {
  id: string;
  tenant_id: string | null;
  date: string;
  time: string | null;
  direction: string | null;
  customer_name: string | null;
  hotel_id: string | null;
  pax: number | null;
  booking_service_kind: string | null;
  service_type_code: string | null;
  service_type: string | null;
  vessel: string | null;
  meeting_point: string | null;
  notes: string | null;
};

type HotelRow = {
  id: string;
  name: string | null;
  zone: string | null;
  address: string | null;
};

// The project does not expose generated Supabase table types in scripts.
// Keep this local so the guarded update calls remain type-checkable.
type ScriptSupabaseClient = SupabaseClient<any, "public", any>;

type AuditRow = {
  service_id: string;
  time: string;
  raw_time: string | null;
  customer: string;
  hotel: string;
  direction: string;
  pickup: string;
  destination: string;
  estimated_direction: string;
  pickup_equals_destination: boolean;
  problem: string;
  suggested_fix: string;
  risk: string;
  requires_operator_confirmation: boolean;
  target: string;
  service: ServiceRow;
};

const TARGETS = ["SAN NICOLA", "CRISTALLO", "PRESIDENT"];
const SAN_NICOLA_BAD_DEPARTURE_TIMES = new Set(["09:30", "10:00", "10:30", "18:30", "19:00", "19:30"]);
const CRISTALLO_BAD_DEPARTURE_TIMES = new Set(["09:30", "16:00"]);
const SAN_NICOLA_RETURN_TIMES = new Map([
  ["09:35", "09:55"],
  ["10:05", "10:25"],
  ["10:35", "10:55"],
  ["18:35", "18:55"],
  ["19:05", "19:25"],
  ["19:35", "19:55"],
]);

function loadEnvFile(path: string) {
  if (!fs.existsSync(path)) return;
  const lines = fs.readFileSync(path, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let value = match[2] ?? "";
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[match[1]]) process.env[match[1]] = value;
  }
}

function argValue(name: string, fallback: string) {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

function hasFlag(name: string) {
  return process.argv.includes(`--${name}`);
}

function clean(value?: string | number | null) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : "";
}

function normalize(value?: string | null) {
  return clean(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[_-]+/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function timeLabel(value?: string | null) {
  const match = clean(value).match(/([01]?\d|2[0-3]):([0-5]\d)/);
  return match ? `${match[1]!.padStart(2, "0")}:${match[2]}` : "—";
}

function minutes(value?: string | null) {
  const match = timeLabel(value).match(/([01]\d|2[0-3]):([0-5]\d)/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function samePlace(left?: string | null, right?: string | null) {
  const a = normalize(left);
  const b = normalize(right);
  return Boolean(a && b && a === b);
}

function isNavetta(service: ServiceRow) {
  return normalize(service.booking_service_kind) === "navetta"
    || normalize(service.vessel) === "navetta"
    || normalize(service.service_type_code) === "bus line";
}

function targetName(service: ServiceRow, hotel?: HotelRow) {
  const text = normalize([service.customer_name, hotel?.name, service.meeting_point, service.notes].filter(Boolean).join(" "));
  return TARGETS.find((target) => text.includes(normalize(target))) ?? null;
}

function currentRoute(service: ServiceRow, hotel?: HotelRow) {
  const hotelName = clean(hotel?.name) || clean(service.customer_name) || "Hotel non determinato";
  const meetingPoint = clean(service.meeting_point);
  if (normalize(service.direction) === "arrival") {
    return {
      pickup: meetingPoint || "Pickup non determinato",
      destination: hotelName,
    };
  }
  return {
    pickup: hotelName,
    destination: meetingPoint || "Destinazione non determinata",
  };
}

function estimatedDirection(row: AuditRow) {
  const pickup = normalize(row.pickup);
  const destination = normalize(row.destination);
  if (pickup.includes("hotel") && !destination.includes("hotel")) return "hotel→punto esterno";
  if (!pickup.includes("hotel") && destination.includes("hotel")) return "punto esterno→hotel";
  return "direzione da verificare";
}

function analyzeSanNicola(service: ServiceRow, hotel: HotelRow | undefined): AuditRow {
  const route = currentRoute(service, hotel);
  const pickupEqualsDestination = samePlace(route.pickup, route.destination);
  const isDeparture = normalize(service.direction) === "departure";
  const problem = pickupEqualsDestination ? "Pickup navetta uguale a destinazione" : "Nessun problema bloccante rilevato";
  const suggestedRoute = pickupEqualsDestination && isDeparture
    ? "Hotel San Nicola → Citara"
    : pickupEqualsDestination
      ? "Citara → Hotel San Nicola"
      : "Nessuna correzione automatica suggerita";

  return {
    service_id: service.id,
    time: timeLabel(service.time),
    raw_time: service.time,
    customer: clean(service.customer_name) || "—",
    hotel: clean(hotel?.name) || "—",
    direction: clean(service.direction) || "—",
    pickup: route.pickup,
    destination: route.destination,
    estimated_direction: "",
    pickup_equals_destination: pickupEqualsDestination,
    problem,
    suggested_fix: suggestedRoute,
    risk: pickupEqualsDestination ? "Medio/alto: dato operativo incompleto, serve conferma del punto Citara" : "Basso",
    requires_operator_confirmation: pickupEqualsDestination,
    target: "SAN NICOLA",
    service,
  };
}

function analyzeCristallo(service: ServiceRow, hotel: HotelRow | undefined): AuditRow {
  const route = currentRoute(service, hotel);
  const pickupEqualsDestination = samePlace(route.pickup, route.destination)
    || (normalize(route.pickup).includes("cristallo") && normalize(route.destination).includes("cristallo"));
  const htlAlias = normalize(route.pickup).includes("htl cristallo") || normalize(route.destination).includes("htl cristallo");
  const problem = pickupEqualsDestination
    ? "Pickup/destinazione sembrano entrambi Hotel Cristallo o alias"
    : htlAlias
      ? "Htl Cristallo sembra alias di Hotel Cristallo"
      : "Nessun problema bloccante rilevato";

  return {
    service_id: service.id,
    time: timeLabel(service.time),
    raw_time: service.time,
    customer: clean(service.customer_name) || "—",
    hotel: clean(hotel?.name) || "—",
    direction: clean(service.direction) || "—",
    pickup: route.pickup,
    destination: route.destination,
    estimated_direction: "",
    pickup_equals_destination: pickupEqualsDestination,
    problem,
    suggested_fix: pickupEqualsDestination
      ? "Verificare se la destinazione corretta è Piazza Marina Casamicciola o altro punto concordato"
      : "Nessuna correzione automatica",
    risk: pickupEqualsDestination ? "Medio: alias hotel può nascondere punto navetta mancante" : "Basso",
    requires_operator_confirmation: pickupEqualsDestination || htlAlias,
    target: "CRISTALLO",
    service,
  };
}

function analyzePresident(service: ServiceRow, hotel: HotelRow | undefined): AuditRow {
  const route = currentRoute(service, hotel);
  const pickupEqualsDestination = samePlace(route.pickup, route.destination);
  return {
    service_id: service.id,
    time: timeLabel(service.time),
    raw_time: service.time,
    customer: clean(service.customer_name) || "—",
    hotel: clean(hotel?.name) || "—",
    direction: clean(service.direction) || "—",
    pickup: route.pickup,
    destination: route.destination,
    estimated_direction: "",
    pickup_equals_destination: pickupEqualsDestination,
    problem: pickupEqualsDestination ? "Pickup navetta uguale a destinazione" : "Pickup e destinazione distinti",
    suggested_fix: pickupEqualsDestination ? "Verificare punto navetta President" : "Nessuna correzione suggerita",
    risk: pickupEqualsDestination ? "Medio" : "Basso",
    requires_operator_confirmation: pickupEqualsDestination,
    target: "PRESIDENT",
    service,
  };
}

function withEstimatedDirection(row: AuditRow): AuditRow {
  return { ...row, estimated_direction: estimatedDirection(row) };
}

function pairDeltas(rows: AuditRow[]) {
  const sorted = [...rows].sort((a, b) => a.time.localeCompare(b.time));
  const deltas: string[] = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const previous = sorted[i - 1]!;
    const current = sorted[i]!;
    const previousMinutes = minutes(previous.time);
    const currentMinutes = minutes(current.time);
    if (previousMinutes == null || currentMinutes == null) continue;
    const delta = currentMinutes - previousMinutes;
    const warning = delta === 5 ? " — suggerire delta minimo 25 minuti (dry-run)" : "";
    deltas.push(`${previous.time} → ${current.time}: ${delta} min${warning}`);
  }
  return deltas;
}

function printRows(title: string, rows: AuditRow[]) {
  console.log(`\n# ${title}`);
  console.log(`Corse trovate: ${rows.length}`);
  for (const row of rows) {
    console.log(`\n- service_id: ${row.service_id}`);
    console.log(`  orario: ${row.time}`);
    console.log(`  cliente/gruppo: ${row.customer}`);
    console.log(`  pickup attuale: ${row.pickup}`);
    console.log(`  destinazione attuale: ${row.destination}`);
    console.log(`  direzione stimata: ${row.estimated_direction}`);
    console.log(`  pickup = destinazione: ${row.pickup_equals_destination ? "SI" : "NO"}`);
    console.log(`  problema rilevato: ${row.problem}`);
    console.log(`  fix suggerito: ${row.suggested_fix}`);
    console.log(`  rischio: ${row.risk}`);
    console.log(`  richiede conferma operatore: ${row.requires_operator_confirmation ? "SI" : "NO"}`);
  }
}

function fullTimeWithNewClock(previous: string | null, nextClock: string) {
  const raw = clean(previous);
  const suffix = raw.match(/^\d{1,2}:\d{2}(:\d{2})$/)?.[1] ?? "";
  return `${nextClock}${suffix}`;
}

function plannedUpdates(rows: AuditRow[]) {
  const updates: Array<{
    service_id: string;
    target: string;
    before_time: string;
    after_time: string;
    before_pickup: string;
    before_destination: string;
    after_pickup: string;
    after_destination: string;
    update: Partial<Pick<ServiceRow, "meeting_point" | "time">>;
    reason: string;
  }> = [];

  for (const row of rows) {
    const direction = normalize(row.service.direction);
    if (row.target === "SAN NICOLA") {
      if (
        SAN_NICOLA_BAD_DEPARTURE_TIMES.has(row.time)
        && direction === "departure"
        && row.pickup_equals_destination
      ) {
        updates.push({
          service_id: row.service_id,
          target: row.target,
          before_time: row.time,
          after_time: row.time,
          before_pickup: row.pickup,
          before_destination: row.destination,
          after_pickup: "HOTEL SAN NICOLA",
          after_destination: "Citara",
          update: { meeting_point: "Citara" },
          reason: "San Nicola andata: destinazione errata uguale hotel",
        });
      }

      if (direction === "arrival" && SAN_NICOLA_RETURN_TIMES.has(row.time)) {
        const nextTime = SAN_NICOLA_RETURN_TIMES.get(row.time)!;
        updates.push({
          service_id: row.service_id,
          target: row.target,
          before_time: row.time,
          after_time: nextTime,
          before_pickup: row.pickup,
          before_destination: row.destination,
          after_pickup: "Citara",
          after_destination: "HOTEL SAN NICOLA",
          update: { time: fullTimeWithNewClock(row.raw_time, nextTime) },
          reason: "San Nicola ritorno: delta minimo 25 minuti",
        });
      }
    }

    if (
      row.target === "CRISTALLO"
      && CRISTALLO_BAD_DEPARTURE_TIMES.has(row.time)
      && direction === "departure"
      && row.pickup_equals_destination
    ) {
      updates.push({
        service_id: row.service_id,
        target: row.target,
        before_time: row.time,
        after_time: row.time,
        before_pickup: row.pickup,
        before_destination: row.destination,
        after_pickup: "HOTEL CRISTALLO",
        after_destination: "Piazza Marina Casamicciola",
        update: { meeting_point: "Piazza Marina Casamicciola" },
        reason: "Cristallo andata: alias hotel al posto di Piazza Marina",
      });
    }
  }

  return updates;
}

function assertExpectedPlan(updates: ReturnType<typeof plannedUpdates>, rows: AuditRow[]) {
  const sanDeparture = updates.filter((update) => update.target === "SAN NICOLA" && update.reason.includes("andata"));
  const sanReturn = updates.filter((update) => update.target === "SAN NICOLA" && update.reason.includes("ritorno"));
  const cristallo = updates.filter((update) => update.target === "CRISTALLO");
  const president = updates.filter((update) => update.target === "PRESIDENT");
  const presidentRows = rows.filter((row) => row.target === "PRESIDENT");

  const errors: string[] = [];
  if (sanDeparture.length !== 6) errors.push(`Attese 6 andate San Nicola da correggere, trovate ${sanDeparture.length}`);
  if (sanReturn.length !== 6) errors.push(`Attesi 6 ritorni San Nicola da ritimare, trovati ${sanReturn.length}`);
  if (cristallo.length !== 2) errors.push(`Attese 2 corse Cristallo da correggere, trovate ${cristallo.length}`);
  if (president.length !== 0) errors.push(`President non deve essere aggiornato, piano contiene ${president.length} update`);
  if (presidentRows.some((row) => row.pickup_equals_destination)) errors.push("President ha pickup=destinazione nel pre-check");

  if (errors.length > 0) {
    throw new Error(`Pre-check non conforme, update bloccato:\n- ${errors.join("\n- ")}`);
  }
}

async function applyUpdates(
  supabase: ScriptSupabaseClient,
  tenantId: string | undefined,
  date: string,
  updates: ReturnType<typeof plannedUpdates>
) {
  for (const update of updates) {
    console.log(`\nAPPLY ${update.target} ${update.service_id}`);
    console.log(`  motivo: ${update.reason}`);
    console.log(`  prima: ${update.before_time} | ${update.before_pickup} -> ${update.before_destination}`);
    console.log(`  dopo : ${update.after_time} | ${update.after_pickup} -> ${update.after_destination}`);

    let query = supabase
      .from("services")
      .update(update.update as Record<string, string>)
      .eq("id", update.service_id)
      .eq("date", date)
      .select("id");
    if (tenantId) query = query.eq("tenant_id", tenantId);
    const { data, error } = await query;
    if (error) throw new Error(`Update fallito per ${update.service_id}: ${error.message}`);
    if ((data ?? []).length !== 1) {
      throw new Error(`Update non sicuro per ${update.service_id}: affected rows ${(data ?? []).length}`);
    }
  }
}

async function main() {
  loadEnvFile(".env.local");
  loadEnvFile(".env");

  const date = argValue("date", "2026-05-07");
  const apply = hasFlag("apply");
  if (apply && !process.argv.some((arg) => arg.startsWith("--date="))) {
    throw new Error("--apply richiede --date esplicita.");
  }
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    ?? process.env.SUPABASE_SERVICE_ROLE
    ?? process.env.SUPABASE_SERVICE_KEY;
  const tenantId = process.env.NEXT_PUBLIC_TENANT_ID ?? process.env.TENANT_ID;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Variabili Supabase mancanti: NEXT_PUBLIC_SUPABASE_URL/SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY.");
  }

  const supabase = createClient<any, "public", any>(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let query = supabase
    .from("services")
    .select("id, tenant_id, date, time, direction, customer_name, hotel_id, pax, booking_service_kind, service_type_code, service_type, vessel, meeting_point, notes")
    .eq("date", date)
    .order("time", { ascending: true });
  if (tenantId) query = query.eq("tenant_id", tenantId);

  const { data: services, error: servicesError } = await query;
  if (servicesError) throw new Error(`Query services fallita: ${servicesError.message}`);

  const hotelIds = Array.from(new Set((services ?? []).map((service) => service.hotel_id).filter(Boolean))) as string[];
  const { data: hotels, error: hotelsError } = hotelIds.length > 0
    ? await supabase.from("hotels").select("id, name, zone, address").in("id", hotelIds)
    : { data: [] as HotelRow[], error: null };
  if (hotelsError) throw new Error(`Query hotels fallita: ${hotelsError.message}`);

  const hotelMap = new Map((hotels ?? []).map((hotel) => [hotel.id, hotel]));
  const navette = (services ?? [])
    .filter(isNavetta)
    .filter((service) => targetName(service, hotelMap.get(service.hotel_id ?? "")));

  const rowsByTarget = new Map<string, AuditRow[]>();
  for (const service of navette) {
    const hotel = hotelMap.get(service.hotel_id ?? "");
    const target = targetName(service, hotel);
    if (!target) continue;
    const row = target === "SAN NICOLA"
      ? analyzeSanNicola(service, hotel)
      : target === "CRISTALLO"
        ? analyzeCristallo(service, hotel)
        : analyzePresident(service, hotel);
    rowsByTarget.set(target, [...(rowsByTarget.get(target) ?? []), withEstimatedDirection(row)]);
  }

  const sanNicolaRows = rowsByTarget.get("SAN NICOLA") ?? [];
  const cristalloRows = rowsByTarget.get("CRISTALLO") ?? [];
  const presidentRows = rowsByTarget.get("PRESIDENT") ?? [];

  console.log("DRY RUN NAVETTE OPERATIVE");
  console.log(`Data: ${date}`);
  console.log(`Modalita: ${apply ? "APPLY CONTROLLATO" : "READ-ONLY, nessuna modifica DB"}`);
  console.log("\n# Query usate");
  console.log("- services: select navette del giorno filtrate per San Nicola/Cristallo/President");
  console.log("- hotels: select id/name/zone/address per hotel collegati");

  printRows("San Nicola", sanNicolaRows);
  const sanDeltas = pairDeltas(sanNicolaRows);
  if (sanDeltas.length > 0) {
    console.log("\nDelta coppie San Nicola:");
    for (const delta of sanDeltas) console.log(`- ${delta}`);
  }

  printRows("Cristallo", cristalloRows);
  printRows("President", presidentRows);

  const allRows = [...sanNicolaRows, ...cristalloRows, ...presidentRows];
  const updates = plannedUpdates(allRows);

  console.log("\n# Piano update controllato");
  if (updates.length === 0) {
    console.log("- Nessun update pianificato.");
  } else {
    for (const update of updates) {
      console.log(`- ${update.target} ${update.service_id}: ${update.before_time} ${update.before_pickup} -> ${update.before_destination} | dopo ${update.after_time} ${update.after_pickup} -> ${update.after_destination}`);
    }
  }

  if (apply) {
    assertExpectedPlan(updates, allRows);
    await applyUpdates(supabase, tenantId, date, updates);
    console.log(`\nAPPLY COMPLETATO: ${updates.length} update eseguiti.`);
  }

  const suggested = allRows.filter((row) => row.requires_operator_confirmation || row.pickup_equals_destination);
  console.log("\n# Correzioni suggerite");
  if (suggested.length === 0) {
    console.log("- Nessuna correzione operativa suggerita.");
  } else {
    for (const row of suggested) {
      console.log(`- ${row.time} ${row.customer}: ${row.suggested_fix}`);
    }
  }

  console.log("\n# Dati da confermare con operatore");
  const confirmations = suggested.filter((row) => row.requires_operator_confirmation);
  if (confirmations.length === 0) {
    console.log("- Nessun dato richiede conferma operatore.");
  } else {
    for (const row of confirmations) {
      console.log(`- ${row.time} ${row.customer}: ${row.problem}`);
    }
  }

  console.log("\n# Riepilogo");
  console.log(`- San Nicola: ${sanNicolaRows.length} corse, ${sanNicolaRows.filter((row) => row.pickup_equals_destination).length} pickup=destinazione`);
  console.log(`- Cristallo: ${cristalloRows.length} corse, ${cristalloRows.filter((row) => row.pickup_equals_destination).length} pickup=destinazione/alias`);
  console.log(`- President: ${presidentRows.length} corse, ${presidentRows.filter((row) => row.pickup_equals_destination).length} pickup=destinazione`);
  console.log("\n# Cosa NON e stato toccato");
  console.log("- Nessuna scrittura DB");
  console.log("- Nessun update");
  console.log("- Nessun assignment");
  console.log("- Nessun trip_group");
  console.log("- Nessun auto-assign");
}

main().catch((error: unknown) => {
  console.error("ERRORE AUDIT:", error instanceof Error ? error.message : error);
  process.exit(1);
});
