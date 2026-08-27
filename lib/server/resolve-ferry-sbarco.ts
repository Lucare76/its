import type { SupabaseClient } from "@supabase/supabase-js";
import { findFerryPickupRule, resolveAgencyLogic, type FerryPickupRule } from "@/lib/ferry-pickup-rules";

type TransferKind =
  | "transfer_train_hotel"
  | "transfer_train_hotel_exclusive"
  | "transfer_train_hotel_aliscafo"
  | "transfer_airport_hotel"
  | "transfer_airport_hotel_exclusive"
  | "transfer_airport_hotel_aliscafo";

const TRANSFER_KINDS = new Set<string>([
  "transfer_train_hotel",
  "transfer_train_hotel_exclusive",
  "transfer_train_hotel_aliscafo",
  "transfer_airport_hotel",
  "transfer_airport_hotel_exclusive",
  "transfer_airport_hotel_aliscafo",
]);

function bookingKindToTransportType(kind: string): "train" | "flight" | null {
  if (kind.includes("train")) return "train";
  if (kind.includes("airport")) return "flight";
  return null;
}

function bookingKindToBoatType(kind: string): "traghetto" | "aliscafo" {
  return kind.endsWith("_aliscafo") ? "aliscafo" : "traghetto";
}

export type FerrySbarcoResolution = {
  company: string;
  departure_time: string;
  arrival_port: string;
  arrival_time: string | null;
};

/**
 * Per prenotazioni transfer (treno/volo), cerca la regola di abbinamento corsa nave
 * e restituisce la corsa nave prevista verso Ischia.
 * Restituisce null se non applicabile o nessuna regola trovata.
 */
export async function resolveFerrySbarco(opts: {
  admin: SupabaseClient;
  bookingKind: string;
  transportArrivalTime: string;
  bookingDate: string;
  agencyId: string | null;
}): Promise<FerrySbarcoResolution | null> {
  const { admin, bookingKind, transportArrivalTime, bookingDate, agencyId } = opts;
  if (!TRANSFER_KINDS.has(bookingKind)) return null;

  const transportType = bookingKindToTransportType(bookingKind);
  if (!transportType) return null;

  const boatType = bookingKindToBoatType(bookingKind);

  // Determina agency_logic dall'agenzia (se nota)
  let agencyLogic: "aleste" | "sosandra" = "aleste";
  if (agencyId) {
    const { data: agency } = await admin
      .from("agencies")
      .select("name")
      .eq("id", agencyId)
      .maybeSingle();
    if (agency?.name) agencyLogic = resolveAgencyLogic(agency.name);
  }

  // Carica le regole (tabella globale, non tenant-scoped). direction='to_ischia'
  // esplicito: questa funzione risolve solo ARRIVI, mai regole PARTENZA
  // (from_ischia) introdotte per hotel/zona.
  const { data: rulesData } = await admin
    .from("ferry_pickup_rules")
    .select("*")
    .eq("agency_logic", agencyLogic)
    .eq("transport_type", transportType)
    .eq("boat_type", boatType)
    .eq("direction", "to_ischia");

  if (!rulesData?.length) return null;

  const match = findFerryPickupRule(
    rulesData as FerryPickupRule[],
    agencyLogic,
    transportType,
    boatType,
    transportArrivalTime,
    bookingDate
  );

  return match
    ? {
      company: match.company,
      departure_time: match.departureTime,
      arrival_port: match.arrivalPort,
      arrival_time: match.arrivalTime,
    }
    : null;
}

/**
 * Compatibilita: alcuni flussi esistenti consumano solo l'orario di sbarco.
 */
export async function resolveFerryScbarcoTime(opts: {
  admin: SupabaseClient;
  bookingKind: string;
  transportArrivalTime: string;
  bookingDate: string;
  agencyId: string | null;
}): Promise<string | null> {
  const ferry = await resolveFerrySbarco(opts);
  return ferry?.arrival_time ?? null;
}
