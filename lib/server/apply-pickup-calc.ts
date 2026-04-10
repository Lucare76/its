/**
 * applyPickupCalc — calcola e restituisce i campi di pickup per servizi di partenza.
 *
 * Da chiamare prima di ogni INSERT/UPDATE su services con:
 *   direction = 'departure'  AND  place_type IN ('station', 'airport')
 *
 * Popola: pickup_hotel, barca_compagnia, orario_barca, porto_bruno, pickup_alert, vessel
 */
import { calcPickupTime } from "@/lib/server/calc-pickup-time";

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
 * Deriva tipo_barca dal nome del vessel già salvato sul servizio (se disponibile).
 * Alilauro/Snav = aliscafo; tutto il resto = traghetto.
 */
function vesselToTipoBarca(vessel: string | null | undefined): "traghetto" | "aliscafo" {
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
 * il servizio non è una partenza con stazione/aeroporto.
 */
export function applyPickupCalc(opts: {
  direction: string;
  place_type?: string | null;
  time: string;                       // orario treno/volo HH:MM
  billing_party_name?: string | null; // nome agenzia per determinare le regole
  vessel?: string | null;             // vessel già noto (per tipo_barca)
}): Partial<PickupCalcFields> {
  if (opts.direction !== "departure") return {};
  if (!opts.place_type || !["station", "airport"].includes(opts.place_type)) return {};

  const agency_key = billingToAgencyKey(opts.billing_party_name);
  const mezzo: "treno" | "aereo" = opts.place_type === "station" ? "treno" : "aereo";
  const tipo_barca = vesselToTipoBarca(opts.vessel);

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
