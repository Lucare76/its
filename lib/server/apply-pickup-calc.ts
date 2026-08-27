/**
 * applyPickupCalc — calcola e restituisce i campi di pickup per servizi di partenza.
 *
 * Da chiamare prima di ogni INSERT/UPDATE su services con:
 *   direction = 'departure'  AND  booking_service_kind e' un transfer treno/aeroporto
 *
 * NB: `place_type` descrive l'origine del pickup (quasi sempre "hotel" per le
 * partenze), non la destinazione — non e' un indicatore affidabile del mezzo.
 * Il trigger usa `booking_service_kind`, che codifica il mezzo esplicitamente.
 *
 * Popola: pickup_hotel, barca_compagnia, orario_barca, porto_bruno, pickup_alert, vessel
 */
import { calcPickupTime } from "@/lib/server/calc-pickup-time";

const TRAIN_KINDS = new Set(["transfer_train_hotel", "transfer_train_hotel_exclusive", "transfer_train_hotel_aliscafo"]);
const AIRPORT_KINDS = new Set(["transfer_airport_hotel", "transfer_airport_hotel_exclusive", "transfer_airport_hotel_aliscafo"]);
const ALISCAFO_KINDS = new Set(["transfer_train_hotel_aliscafo", "transfer_airport_hotel_aliscafo"]);

function mezzoFromKind(kind: string | null | undefined): "treno" | "aereo" | null {
  if (!kind) return null;
  if (TRAIN_KINDS.has(kind)) return "treno";
  if (AIRPORT_KINDS.has(kind)) return "aereo";
  return null;
}

/**
 * Mappa billing_party_name → agency_key per le regole di calcPickupTime.
 * Sosandra/Dimhotels hanno regole diverse (aliscafo alternato, nessun pickup_hotel).
 * Tutte le altre agenzie usano le stesse regole di Aleste (Medmar traghetto).
 */
function billingToAgencyKey(name: string | null | undefined): string {
  const n = (name ?? "").toLowerCase();
  if (n.includes("sosandra") || n.includes("dimhotel")) return "sosandra";
  if (n.includes("aleste")) return "aleste";
  if (n.includes("angelino")) return "angelino";
  if (n.includes("zigolo")) return "zigolo";
  return "aleste"; // default: stesse regole Aleste (Medmar traghetto)
}

/**
 * Deriva tipo_barca. Priorita': variante "_aliscafo" nel booking_service_kind
 * (esplicita), poi fallback sul nome vessel gia' noto (Alilauro/Snav = aliscafo).
 */
function tipoBarcaFor(kind: string | null | undefined, vessel: string | null | undefined): "traghetto" | "aliscafo" {
  if (kind && ALISCAFO_KINDS.has(kind)) return "aliscafo";
  const v = (vessel ?? "").toLowerCase();
  if (v.includes("alilauro") || v.includes("snav")) return "aliscafo";
  return "traghetto";
}

export type PickupCalcFields = {
  pickup_hotel: string | null;
  barca_compagnia: string | null;
  orario_barca: string | null;
  porto_bruno: string | null;
  pickup_alert: string | null;
  vessel: string;
};

/**
 * Ritorna i campi calcolati da aggiungere all'INSERT/UPDATE, oppure {} se
 * il servizio non è una partenza in treno o aereo (booking_service_kind).
 */
export function applyPickupCalc(opts: {
  direction: string;
  booking_service_kind?: string | null;
  time: string;                       // orario treno/volo HH:MM
  billing_party_name?: string | null; // nome agenzia per determinare le regole
  vessel?: string | null;             // vessel già noto (per tipo_barca, fallback)
}): Partial<PickupCalcFields> {
  if (opts.direction !== "departure") return {};
  const mezzo = mezzoFromKind(opts.booking_service_kind);
  if (!mezzo) return {};
  if (!opts.time) return {};

  const agency_key = billingToAgencyKey(opts.billing_party_name);
  const tipo_barca = tipoBarcaFor(opts.booking_service_kind, opts.vessel);

  const result = calcPickupTime({ agency_key, mezzo, tipo_barca, orario: opts.time });

  return {
    pickup_hotel:    result.pickup_hotel,
    barca_compagnia: result.barca_compagnia,
    orario_barca:    result.orario_barca,
    porto_bruno:     result.porto_bruno,
    pickup_alert:    result.alert,
    // Aggiorna vessel con la compagnia calcolata (se non già impostato)
    vessel: result.barca_compagnia ?? opts.vessel ?? "",
  };
}
