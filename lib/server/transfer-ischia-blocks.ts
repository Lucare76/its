/**
 * transfer-ischia-blocks.ts
 *
 * Logica per la gestione dei blocchi traghetto Transfer Ischia.
 *
 * Responsabilità:
 * - Calcolo orario arrivo a Ischia dato orario partenza + porto partenza + compagnia
 * - Ricerca o creazione automatica del pickup_run corretto (stesso porto, entro 30 min)
 * - Collegamento di un servizio Formula Medmar/SNAV al suo blocco
 * - Calcolo alert posti liberi su bus di smistamento linea
 *
 * Regola blocchi principali (domenica):
 *   Linea Centro    → Pozzuoli → Casamicciola 12:00 dep → ~13:10 arr  🔵 #3b82f6
 *   Linea Adriatica → Pozzuoli → Ischia Porto  13:30 dep → ~15:00 arr  🟠 #f97316
 *   Linea Italia    → Pozzuoli → Casamicciola 18:30 dep → ~19:40 arr  🟣 #8b5cf6
 *
 * Regola raggruppamento: stesso porto di arrivo a Ischia + entro 30 minuti → stesso blocco.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

// ── Costanti ──────────────────────────────────────────────────────────────────

/** Tempo di transito in minuti per ogni rotta (approssimato) */
const TRANSIT_MINUTES: Record<string, Record<string, number>> = {
  pozzuoli: {
    casamicciola: 70,   // Pozzuoli → Casamicciola
    ischia_porto: 90,   // Pozzuoli → Ischia Porto
  },
  napoli_beverello: {
    casamicciola: 75,   // Napoli → Casamicciola (via Procida, SNAV)
    ischia_porto: 90,   // Napoli → Ischia Porto
  },
};

/** Finestra di raggruppamento in minuti */
const GROUPING_WINDOW_MINUTES = 30;

/** Mappa linea bus → config traghetto fisso */
export const BUS_LINE_FERRY_MAP = {
  centro: {
    family_code: "centro",
    departure_port: "pozzuoli",
    arrival_port: "casamicciola",
    departure_time: "12:00",
    line_color: "#3b82f6",
    line_label: "Linea Centro",
  },
  adriatica: {
    family_code: "adriatica",
    departure_port: "pozzuoli",
    arrival_port: "ischia_porto",
    departure_time: "13:30",
    line_color: "#f97316",
    line_label: "Linea Adriatica",
  },
  italia: {
    family_code: "italia",
    departure_port: "pozzuoli",
    arrival_port: "casamicciola",
    departure_time: "18:30",
    line_color: "#8b5cf6",
    line_label: "Linea Italia",
  },
} as const;

export type BusLineFamilyCode = keyof typeof BUS_LINE_FERRY_MAP;

// ── Helpers orari ─────────────────────────────────────────────────────────────

/** Converte "HH:MM" in minuti dall'inizio del giorno */
function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Converte minuti dall'inizio del giorno in "HH:MM" */
function minutesToTime(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  const hh = String(Math.floor(m / 60)).padStart(2, "0");
  const mm = String(m % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * Calcola l'orario di arrivo a Ischia dato orario partenza + rotta.
 * Ritorna null se la rotta non è riconosciuta.
 */
export function calcArrivalTime(
  departureTime: string,  // "HH:MM"
  departurePort: string,  // es. "pozzuoli"
  arrivalPort: string,    // es. "casamicciola"
): string | null {
  const transit = TRANSIT_MINUTES[departurePort]?.[arrivalPort];
  if (!transit) return null;
  return minutesToTime(timeToMinutes(departureTime) + transit);
}

/**
 * Dato il vessel (es. "MEDMAR") e il meeting_point (es. "Porto Pozzuoli"),
 * ricava il porto di partenza normalizzato.
 */
export function resolveVesselDeparturePort(vessel: string, meetingPoint?: string | null): string | null {
  const v = (vessel ?? "").toLowerCase();
  const mp = (meetingPoint ?? "").toLowerCase();

  if (v.includes("medmar") || v.includes("snav")) {
    if (mp.includes("pozzuoli")) return "pozzuoli";
    if (mp.includes("napoli") || mp.includes("beverello")) return "napoli_beverello";
    // Default Medmar = Pozzuoli
    if (v.includes("medmar")) return "pozzuoli";
    // Default SNAV = Napoli Beverello
    if (v.includes("snav")) return "napoli_beverello";
  }
  return null;
}

/**
 * Dato vessel + meeting_point, ricava il porto di arrivo a Ischia.
 * Medmar da Pozzuoli può arrivare a Ischia Porto o Casamicciola a seconda dell'orario.
 * Usiamo la tabella MEDMAR_POZZUOLI_ROUTES per determinarlo.
 */
const MEDMAR_POZZUOLI_ARRIVAL_MAP: Record<string, string> = {
  "09:40": "ischia_porto",
  "13:30": "ischia_porto",
  "16:30": "ischia_porto",
  "08:15": "casamicciola",
  "12:00": "casamicciola",
  "15:00": "casamicciola",
  "18:30": "casamicciola",
};

const SNAV_NAPOLI_ARRIVAL_MAP: Record<string, string> = {
  "08:10": "casamicciola",
  "08:30": "casamicciola",
  "09:20": "casamicciola",
  "11:30": "casamicciola",
  "12:30": "casamicciola",
  "13:55": "casamicciola",
  "15:10": "casamicciola",
  "16:20": "casamicciola",
  "17:10": "casamicciola",
  "19:00": "casamicciola",
};

export function resolveArrivalPort(
  vessel: string,
  departurePort: string,
  departureTime: string,
): string | null {
  const v = (vessel ?? "").toLowerCase();
  const t = departureTime?.slice(0, 5) ?? "";

  if (v.includes("medmar") && departurePort === "pozzuoli") {
    return MEDMAR_POZZUOLI_ARRIVAL_MAP[t] ?? null;
  }
  if (v.includes("snav") && departurePort === "napoli_beverello") {
    return SNAV_NAPOLI_ARRIVAL_MAP[t] ?? "casamicciola";
  }
  if (v.includes("medmar") && departurePort === "napoli_beverello") {
    return "ischia_porto";
  }
  return null;
}

/**
 * Verifica se due orari (formato "HH:MM") sono entro N minuti di distanza.
 */
export function withinMinutes(a: string, b: string, minutes: number): boolean {
  return Math.abs(timeToMinutes(a) - timeToMinutes(b)) <= minutes;
}

// ── Logica blocchi ────────────────────────────────────────────────────────────

export interface FerryBlockInput {
  date: string;           // "YYYY-MM-DD"
  arrivalPort: string;    // "ischia_porto" | "casamicciola"
  arrivalTime: string;    // "HH:MM" (orario arrivo a Ischia)
  ferryLabel: string;     // es. "Medmar 12:00" per la UI
  direction: "arrival" | "departure";
  tenantId: string;
}

/**
 * Cerca un pickup_run esistente per la data/porto/finestra indicati.
 * Se non esiste, lo crea automaticamente.
 * Ritorna l'id del run trovato/creato.
 */
export async function findOrCreatePickupRun(
  admin: SupabaseClient,
  input: FerryBlockInput,
): Promise<string> {
  const { date, arrivalPort, arrivalTime, ferryLabel, direction, tenantId } = input;
  const arrivalMinutes = timeToMinutes(arrivalTime);

  // Cerca run esistente per stessa data + porto + direzione con finestra entro 30 min
  const { data: existing } = await admin
    .from("pickup_runs")
    .select("id, window_open, window_close")
    .eq("tenant_id", tenantId)
    .eq("run_date", date)
    .eq("port", arrivalPort)
    .eq("direction", direction);

  if (existing) {
    for (const run of existing) {
      const openMin = timeToMinutes(run.window_open as string);
      const closeMin = timeToMinutes(run.window_close as string);
      const midMin = Math.round((openMin + closeMin) / 2);
      if (Math.abs(arrivalMinutes - midMin) <= GROUPING_WINDOW_MINUTES) {
        return run.id as string;
      }
    }
  }

  // Nessun run trovato → crea nuovo
  const windowOpen = minutesToTime(arrivalMinutes - 10);
  const windowClose = minutesToTime(arrivalMinutes + GROUPING_WINDOW_MINUTES);

  const { data: created, error } = await admin
    .from("pickup_runs")
    .insert({
      tenant_id: tenantId,
      run_date: date,
      port: arrivalPort,
      direction,
      window_open: windowOpen,
      window_close: windowClose,
      total_pax: 0,
      status: "planned",
      notes: ferryLabel,
    })
    .select("id")
    .single();

  if (error || !created) throw new Error(`Impossibile creare blocco traghetto: ${error?.message}`);
  return created.id as string;
}

/**
 * Collega un servizio Formula Medmar/SNAV al blocco traghetto corretto.
 * Se il blocco non esiste lo crea. Se il passeggero è già collegato non fa nulla.
 *
 * @returns id del pickup_run a cui è stato collegato
 */
export async function linkServiceToFerryBlock(
  admin: SupabaseClient,
  params: {
    tenantId: string;
    serviceId: string;
    date: string;           // "YYYY-MM-DD"
    vessel: string;         // "MEDMAR" | "SNAV"
    meetingPoint?: string | null;
    departureTime: string;  // "HH:MM" orario partenza da mainland
    passengerName: string;
    passengerPhone?: string | null;
    hotelId?: string | null;
    hotelName: string;
    hotelZone?: string | null;
    pax: number;
    direction: "arrival" | "departure";
  },
): Promise<{ runId: string; created: boolean } | null> {
  const {
    tenantId, serviceId, date, vessel, meetingPoint,
    departureTime, passengerName, passengerPhone,
    hotelId, hotelName, hotelZone, pax, direction,
  } = params;

  // Verifica se già collegato
  const { data: existing } = await admin
    .from("pickup_run_services")
    .select("id, run_id")
    .eq("service_id", serviceId)
    .maybeSingle();

  if (existing) return { runId: existing.run_id as string, created: false };

  // Ricava porto partenza e porto arrivo
  const departurePort = resolveVesselDeparturePort(vessel, meetingPoint);
  if (!departurePort) return null;

  const arrivalPort = resolveArrivalPort(vessel, departurePort, departureTime);
  if (!arrivalPort) return null;

  const arrivalTime = calcArrivalTime(departureTime, departurePort, arrivalPort);
  if (!arrivalTime) return null;

  const ferryLabel = `${vessel.charAt(0).toUpperCase() + vessel.slice(1).toLowerCase()} ${departureTime}`;

  const runId = await findOrCreatePickupRun(admin, {
    date, arrivalPort, arrivalTime, ferryLabel, direction, tenantId,
  });

  // Inserisci passeggero nel blocco
  await admin.from("pickup_run_services").insert({
    tenant_id: tenantId,
    run_id: runId,
    service_id: serviceId,
    passenger_name: passengerName,
    passenger_phone: passengerPhone ?? null,
    hotel_id: hotelId ?? null,
    hotel_name: hotelName,
    hotel_zone: hotelZone ?? null,
    pax,
  });

  // Aggiorna total_pax del run
  await admin.rpc("increment_pickup_run_pax", { p_run_id: runId, p_delta: pax });

  return { runId, created: true };
}

// ── Alert posti liberi su bus smistamento linea ───────────────────────────────

export interface DistBusFreeSeatsAlert {
  distBusId: string;
  distBusLabel: string;
  distBusZone: string;
  busLineFamilyCode: string;
  lineLabel: string;
  lineColor: string;
  freeSeats: number;
  passengers: Array<{
    runServiceId: string;
    serviceId: string | null;
    passengerName: string;
    passengerPhone: string | null;
    hotelName: string;
    hotelZone: string | null;
    pax: number;
  }>;
}

/**
 * Per un dato blocco traghetto (pickup_run), calcola gli alert:
 * bus di smistamento linea con posti liberi verso la stessa zona hotel.
 *
 * Un alert viene generato se:
 * - Il bus smistamento è della stessa data
 * - Il bus smistamento copre la stessa zona hotel del passeggero Transfer Ischia
 * - Il bus ha posti liberi sufficienti
 * - Il passeggero non è già stato spostato (moved_to_dist_bus_id is null)
 */
export async function computeFerryBlockAlerts(
  admin: SupabaseClient,
  params: {
    tenantId: string;
    runId: string;
    date: string;
    arrivalPort: string;  // per filtrare i bus smistamento dello stesso porto
  },
): Promise<DistBusFreeSeatsAlert[]> {
  const { tenantId, runId, date, arrivalPort } = params;

  // Carica passeggeri del blocco non ancora spostati
  const { data: passengers } = await admin
    .from("pickup_run_services")
    .select("id, service_id, passenger_name, passenger_phone, hotel_name, hotel_zone, pax")
    .eq("run_id", runId)
    .is("moved_to_dist_bus_id", null);

  if (!passengers?.length) return [];

  // Carica bus smistamento linea per quella data
  const { data: distBuses } = await admin
    .from("bus_ischia_dist_buses")
    .select(`
      id, label, zone, capacity,
      bus_ischia_dist_allocations ( pax_assigned )
    `)
    .eq("tenant_id", tenantId)
    .eq("date", date);

  if (!distBuses?.length) return [];

  // Carica config linee per avere label e colore
  const { data: lineConfigs } = await admin
    .from("bus_line_ferry_config")
    .select("bus_line_family_code, line_color, line_label, arrival_port")
    .eq("tenant_id", tenantId)
    .eq("arrival_port", arrivalPort);

  const lineConfigMap = new Map(
    (lineConfigs ?? []).map((c) => [c.bus_line_family_code as string, c]),
  );

  const alerts: DistBusFreeSeatsAlert[] = [];

  for (const bus of distBuses) {
    const allocations = (bus.bus_ischia_dist_allocations as Array<{ pax_assigned: number }>) ?? [];
    const paxUsed = allocations.reduce((s, a) => s + a.pax_assigned, 0);
    const freeSeats = (bus.capacity as number) - paxUsed;
    if (freeSeats <= 0) continue;

    // Passeggeri che vanno nella stessa zona del bus
    const matchingPassengers = passengers.filter(
      (p) => p.hotel_zone && (bus.zone as string) === p.hotel_zone,
    );
    if (!matchingPassengers.length) continue;

    // Ricava info linea dal bus_line_id (se disponibile)
    // Per ora usiamo la config port-based
    const lineConfig = lineConfigs?.[0];

    alerts.push({
      distBusId: bus.id as string,
      distBusLabel: bus.label as string,
      distBusZone: bus.zone as string,
      busLineFamilyCode: lineConfig?.bus_line_family_code ?? "",
      lineLabel: lineConfig?.line_label ?? "Linea Bus",
      lineColor: lineConfig?.line_color ?? "#64748b",
      freeSeats,
      passengers: matchingPassengers.map((p) => ({
        runServiceId: p.id as string,
        serviceId: p.service_id as string | null,
        passengerName: p.passenger_name as string,
        passengerPhone: p.passenger_phone as string | null,
        hotelName: p.hotel_name as string,
        hotelZone: p.hotel_zone as string | null,
        pax: p.pax as number,
      })),
    });
  }

  return alerts;
}

// ── Auto-collegamento servizi dopo import ─────────────────────────────────────

/**
 * Dato un array di service_id appena inseriti, collega automaticamente
 * quelli di tipo Formula Medmar/SNAV al loro blocco traghetto.
 * Chiamato dopo ogni import (Excel, email, PDF).
 *
 * I servizi che non sono Medmar/SNAV o non hanno orario/hotel vengono ignorati.
 */
export async function autoLinkImportedServices(
  admin: SupabaseClient,
  tenantId: string,
  serviceIds: string[],
): Promise<{ linked: number; skipped: number }> {
  if (!serviceIds.length) return { linked: 0, skipped: 0 };

  // Carica i dati necessari per ciascun servizio
  const { data: services } = await admin
    .from("services")
    .select("id, vessel, date, time, meeting_point, customer_name, phone, pax, hotel_id, direction, booking_service_kind")
    .in("id", serviceIds)
    .eq("tenant_id", tenantId);

  if (!services?.length) return { linked: 0, skipped: 0 };

  // Filtra solo formula Medmar o SNAV in arrivo a Ischia
  const candidates = services.filter((s) => {
    const vessel = (s.vessel ?? "").toLowerCase();
    const kind = (s.booking_service_kind ?? "").toLowerCase();
    const isTransferPortHotel = kind === "transfer_port_hotel" || vessel.includes("medmar") || vessel.includes("snav");
    const isArrival = (s.direction ?? "arrival") === "arrival";
    return isTransferPortHotel && isArrival && s.date && s.time;
  });

  if (!candidates.length) return { linked: 0, skipped: serviceIds.length };

  // Carica le zone hotel per i candidati
  const hotelIds = [...new Set(candidates.map((s) => s.hotel_id).filter(Boolean))] as string[];
  type HotelRow = { id: string; name: string; zone: string | null };
  let hotels: HotelRow[] = [];
  if (hotelIds.length) {
    const { data } = await admin.from("hotels").select("id, name, zone").in("id", hotelIds);
    hotels = (data ?? []) as HotelRow[];
  }

  const hotelMap = new Map(hotels.map((h) => [h.id, h]));

  let linked = 0;
  let skipped = 0;

  for (const svc of candidates) {
    const hotel = svc.hotel_id ? hotelMap.get(svc.hotel_id) : null;
    const result = await linkServiceToFerryBlock(admin, {
      tenantId,
      serviceId: svc.id,
      date: svc.date,
      vessel: svc.vessel ?? "MEDMAR",
      meetingPoint: svc.meeting_point,
      departureTime: (svc.time as string).slice(0, 5),
      passengerName: svc.customer_name ?? "N/D",
      passengerPhone: svc.phone ?? null,
      hotelId: svc.hotel_id ?? null,
      hotelName: hotel?.name ?? "Hotel sconosciuto",
      hotelZone: hotel?.zone ?? null,
      pax: svc.pax ?? 1,
      direction: "arrival",
    });
    if (result) linked++;
    else skipped++;
  }

  return { linked, skipped };
}

/**
 * Sposta un passeggero Transfer Ischia su un bus di smistamento linea.
 * Crea l'allocazione sul dist_bus e aggiorna moved_to_dist_bus_id.
 */
export async function movePassengerToDistBus(
  admin: SupabaseClient,
  params: {
    tenantId: string;
    runServiceId: string;
    distBusId: string;
  },
): Promise<void> {
  const { tenantId, runServiceId, distBusId } = params;

  const { data: rs } = await admin
    .from("pickup_run_services")
    .select("service_id, passenger_name, hotel_name, hotel_zone, pax")
    .eq("id", runServiceId)
    .single();

  if (!rs) throw new Error("Passeggero non trovato.");

  // Crea allocazione sul bus smistamento
  await admin.from("bus_ischia_dist_allocations").insert({
    tenant_id: tenantId,
    dist_bus_id: distBusId,
    service_id: rs.service_id,
    pax_assigned: rs.pax,
    customer_name: rs.passenger_name,
    hotel_name: rs.hotel_name,
    hotel_zone: rs.hotel_zone ?? "",
  });

  // Segna il passeggero come spostato
  await admin
    .from("pickup_run_services")
    .update({ moved_to_dist_bus_id: distBusId })
    .eq("id", runServiceId);
}
