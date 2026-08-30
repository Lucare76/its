/**
 * Helper server condiviso per risolvere la connessione marittima (traghetto/
 * aliscafo, agency-aware) di UNA gamba (arrivo o ritorno) di un servizio
 * treno/volo. Fonte canonica unica: resolveOperationalConnection
 * (lib/operational-connection-resolver.ts) — questo file non reimplementa
 * mai le regole (zona, traghetto/aliscafo, compagnia): carica solo il
 * contesto DB e traduce l'esito in una forma compatta per la UI.
 *
 * Nato per essere condiviso da:
 *  - GET /api/ops/services/[id] (ferry_meta in risposta, sola lettura)
 *  - GET/PATCH /api/ops/services/[id]/ferry-connection (già esistente —
 *    loadContext locale sostituito da loadFerryConnectionContext qui sotto,
 *    stessa query, nessuna duplicazione)
 *  - preview incoming_ferry_meta nella risposta 409 di duplicate detection
 *    (app/api/pdf/claude-save-draft, app/api/email/inbox-approve)
 *
 * Principio "mai una compagnia inventata" (audit pratica 26/010806,
 * MATTIOLI ALESSANDRA): resolveFerryLeg ritorna un risultato SOLO quando
 * resolveOperationalConnection produce source==="canonical_rule" — un
 * fallback legacy (motore commerciale su ferry_schedules, preferenze non
 * agency-aware) NON basta, perché può comunque coincidere per puro orario
 * con una corsa di compagnia/mezzo sbagliati (esattamente il bug: un
 * aliscafo ALILAURO delle 13:20 scambiato per il traghetto del ritorno solo
 * perché l'orario del treno coincide). In quel caso il risultato è null —
 * la UI mostra "Da determinare", mai un dato inventato.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  resolveOperationalConnection,
  type OperationalDirection,
  type OperationalPickupRule,
} from "@/lib/operational-connection-resolver";
import type { FerryScheduleRow } from "@/lib/travel-connection-resolver";
import { ferryPortLabel } from "@/lib/ferry-schedule-options";

const ZONE_PATTERN = /forio|lacco|casamicciola|barano|ischia/;

export type FerryConnectionContext = {
  operationalRules: OperationalPickupRule[];
  ferrySchedules: FerryScheduleRow[];
};

/**
 * Contesto DB canonico: tutte le ferry_pickup_rules + tutte le ferry_schedules.
 * Stessa query già scritta in app/api/ops/services/[id]/ferry-connection/route.ts
 * (loadContext) — ora unica, importata da entrambe le route invece che
 * duplicata. La zona hotel resta un parametro separato (resolveHotelZone
 * sotto) perché non tutti i chiamanti hanno un hotel_id già risolto (es. la
 * preview della nuova prenotazione, dove l'hotel potrebbe non esistere
 * ancora a sistema).
 */
export async function loadFerryConnectionContext(admin: SupabaseClient): Promise<FerryConnectionContext> {
  const [rulesRes, schedulesRes] = await Promise.all([
    admin.from("ferry_pickup_rules").select("*"),
    admin
      .from("ferry_schedules")
      .select("id, company, departure_port, arrival_port, departure_time, arrival_time, direction, days_of_week, valid_from, valid_to"),
  ]);
  return {
    operationalRules: (rulesRes.data ?? []) as OperationalPickupRule[],
    ferrySchedules: (schedulesRes.data ?? []) as FerryScheduleRow[],
  };
}

/** Zona normalizzata + flag di riconoscimento, da un hotel_id (lookup puntuale). */
export async function resolveHotelZone(
  admin: SupabaseClient,
  hotelId: string | null | undefined
): Promise<{ zone: string | null; zoneRecognized: boolean }> {
  if (!hotelId) return { zone: null, zoneRecognized: false };
  const { data } = await admin.from("hotels").select("zone").eq("id", hotelId).maybeSingle();
  const rawZone = String((data as { zone?: string | null } | null)?.zone ?? "").toLowerCase();
  return { zone: rawZone || null, zoneRecognized: ZONE_PATTERN.test(rawZone) };
}

/** Rappresentazione compatta e display-ready di UNA gamba nave, SOLO quando affidabile (source canonical_rule). */
export type FerryConnectionLeg = {
  company: string;
  ferry_type: "traghetto" | "aliscafo";
  departure_port: string | null;
  arrival_port: string | null;
  departure_time: string | null;
  arrival_time: string | null;
  pickup_time: string | null;
};

export type ResolveFerryLegInput = {
  direction: OperationalDirection;
  bookingServiceKind: string | null | undefined;
  /** Orario treno/volo (partenza per from_ischia, arrivo per to_ischia), HH:MM o HH:MM:SS. */
  transportTime: string | null | undefined;
  date: string | null | undefined; // YYYY-MM-DD
  hotelId?: string | null;
  zone?: string | null;
  zoneRecognized?: boolean;
  agencyName?: string | null;
  pax?: number | null;
  context: FerryConnectionContext;
};

const TRAIN_OR_FLIGHT = /train|flight|airport/;

/**
 * Risolve UNA gamba (arrivo O ritorno) via resolveOperationalConnection.
 * Ritorna null quando:
 *  - mancano i dati minimi (orario/data/kind);
 *  - il kind non è treno/volo (bus, escursione, hotel-hotel, ecc. — fuori
 *    dominio, non un errore);
 *  - il risultato NON è una regola canonica affidabile (source !==
 *    "canonical_rule") — mai un fallback legacy travestito da dato reale.
 */
export function resolveFerryLeg(input: ResolveFerryLegInput): FerryConnectionLeg | null {
  const kind = input.bookingServiceKind ?? "";
  const time = (input.transportTime ?? "").slice(0, 5);
  const date = input.date ?? "";
  if (!kind || !time || !date || !TRAIN_OR_FLIGHT.test(kind)) return null;

  const result = resolveOperationalConnection({
    direction: input.direction,
    bookingServiceKind: kind,
    transportTime: time,
    date,
    hotelId: input.hotelId ?? null,
    zone: input.zone ?? null,
    zoneRecognized: input.zoneRecognized ?? false,
    agencyName: input.agencyName ?? null,
    operationalRules: input.context.operationalRules,
    ferrySchedules: input.context.ferrySchedules,
    pax: input.pax ?? null,
  });

  if (result.source !== "canonical_rule" || !result.company || !result.ferryType) return null;

  return {
    company: result.company,
    ferry_type: result.ferryType,
    departure_port: result.embarkPort,
    arrival_port: result.arrivalPort,
    departure_time: result.ferryDepartureTime,
    arrival_time: result.ferryArrivalTime,
    pickup_time: result.pickupTime,
  };
}

/** Forma di risposta JSON per una gamba (label compagnia in maiuscolo, porti leggibili) — condivisa tra tutte le route che espongono ferry_meta/incoming_ferry_meta, mai duplicata. */
export type FerryConnectionLegResponse = {
  company: string | null;
  ferry_type: "traghetto" | "aliscafo" | null;
  departure_port: string | null;
  arrival_port: string | null;
  departure_time: string | null;
  arrival_time: string | null;
  pickup_time: string | null;
};

export function ferryLegForResponse(leg: FerryConnectionLeg | null): FerryConnectionLegResponse | null {
  if (!leg) return null;
  return {
    company: leg.company.toUpperCase(),
    ferry_type: leg.ferry_type,
    departure_port: leg.departure_port ? ferryPortLabel(leg.departure_port) : null,
    arrival_port: leg.arrival_port ? ferryPortLabel(leg.arrival_port) : null,
    departure_time: leg.departure_time,
    arrival_time: leg.arrival_time,
    pickup_time: leg.pickup_time,
  };
}

export type PreviewBookingInput = {
  bookingServiceKind: string | null | undefined;
  arrivalDate: string | null | undefined;
  arrivalTime: string | null | undefined;
  departureDate: string | null | undefined;
  departureTime: string | null | undefined;
  hotelId?: string | null;
  agencyName?: string | null;
  pax?: number | null;
};

/**
 * Preview canonica (outbound + return) per una prenotazione NON ancora
 * salvata — usata dalla risposta 409 del duplicate detection (PARTE 3:
 * incoming_ferry_meta) così la modale duplicati confronta due valori
 * calcolati con la STESSA logica server-side, mai un resolver lato client.
 * `hotelId`, se noto (es. hotel già a sistema, individuato dal match
 * duplicato), abilita il Livello 1/2 di resolveOperationalConnection
 * (hotel/zona); se assente, resta comunque valutabile una regola generale
 * (Livello 3) — mai un fallback silenzioso su una zona indovinata.
 */
export async function resolveIncomingFerryMeta(
  admin: SupabaseClient,
  input: PreviewBookingInput
): Promise<{ outbound: FerryConnectionLegResponse | null; return: FerryConnectionLegResponse | null }> {
  const [context, hotelZone] = await Promise.all([
    loadFerryConnectionContext(admin),
    resolveHotelZone(admin, input.hotelId ?? null),
  ]);
  const outbound = resolveFerryLeg({
    direction: "to_ischia",
    bookingServiceKind: input.bookingServiceKind,
    transportTime: input.arrivalTime,
    date: input.arrivalDate,
    hotelId: input.hotelId ?? null,
    zone: hotelZone.zone,
    zoneRecognized: hotelZone.zoneRecognized,
    agencyName: input.agencyName,
    pax: input.pax,
    context,
  });
  const returnLeg = resolveFerryLeg({
    direction: "from_ischia",
    bookingServiceKind: input.bookingServiceKind,
    transportTime: input.departureTime,
    date: input.departureDate ?? input.arrivalDate,
    hotelId: input.hotelId ?? null,
    zone: hotelZone.zone,
    zoneRecognized: hotelZone.zoneRecognized,
    agencyName: input.agencyName,
    pax: input.pax,
    context,
  });
  return { outbound: ferryLegForResponse(outbound), return: ferryLegForResponse(returnLeg) };
}
