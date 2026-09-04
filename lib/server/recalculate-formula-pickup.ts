/**
 * recalculateDirectFormulaPickupForEdit — STEP B: ricalcolo write-time di
 * pickup_hotel/pickup_alert per Formula SNAV/MEDMAR diretta (formula_snav,
 * formula_medmar_napoli, formula_medmar_pozzuoli) quando un service
 * ESISTENTE viene modificato in un campo che influenza la direct ferry rule
 * (hotel, agenzia, data rilevante della partenza, orario nave).
 *
 * Condiviso dai 3 write path che possono modificare una Formula direct dopo
 * la creazione (nessuna duplicazione della change-detection o del calcolo):
 *  - app/api/ops/services/[id]/route.ts (PATCH principale + blocco
 *    outbound/return ferry + propagazione linked date)
 *  - app/api/agency/bookings/[id]/route.ts (PATCH agenzia)
 *  - app/api/ops/services/[id]/replace/route.ts (sostituzione pratica)
 *
 * Riusa SEMPRE applyPickupCalc() (dominio B, lib/server/apply-pickup-calc.ts)
 * e il contesto DB gia' condiviso da lib/server/ferry-connection-lookup.ts
 * (stesso usato dal GET read-only di app/api/ops/services/[id]/route.ts) —
 * nessuna reimplementazione di findCanonicalDirectRule/resolveOperationalConnection/
 * agency logic/zone logic. Fallback statico (getPickupRule) invariato: gestito
 * internamente da applyPickupCalc, non duplicato qui.
 *
 * Fuori scope (per design, mai attivato): train/flight (dominio A),
 * transfer_port_hotel, bus_city_hotel, qualunque altro booking_service_kind,
 * e la gamba "arrival" (pickup_hotel esiste solo sulla riga direction=departure).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { applyPickupCalc } from "@/lib/server/apply-pickup-calc";
import { loadFerryConnectionContext, resolveHotelZone } from "@/lib/server/ferry-connection-lookup";

const DIRECT_FORMULA_KINDS = new Set(["formula_snav", "formula_medmar_napoli", "formula_medmar_pozzuoli"]);

export function isDirectFormulaKind(kind: string | null | undefined): boolean {
  return Boolean(kind && DIRECT_FORMULA_KINDS.has(kind));
}

/** Stato (corrente o finale/dopo-patch) degli input che influenzano la Formula direct rule per UNA riga. */
export type FormulaPickupEditState = {
  booking_service_kind: string | null | undefined;
  direction: string | null | undefined;
  hotel_id: string | null | undefined;
  billing_party_name: string | null | undefined;
  /** Orario canonico Formula direct — vedi apply-pickup-calc.ts: NON ricostruito da vessel. */
  orario_barca: string | null | undefined;
  departure_date: string | null | undefined;
  departure_time: string | null | undefined;
  /** Colonna "date" generica, fallback quando departure_date manca (stesso pattern del GET read-only). */
  date: string | null | undefined;
};

function normalize(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function effectiveTime(state: FormulaPickupEditState): string | null {
  return normalize(state.orario_barca) ?? normalize(state.departure_time);
}

function effectiveDate(state: FormulaPickupEditState): string | null {
  return normalize(state.departure_date) ?? normalize(state.date);
}

/**
 * true SOLO se almeno un input pickup-relevant e' semanticamente cambiato tra
 * current e final (hotel_id, agenzia, orario nave, data partenza). Confronto
 * su valori normalizzati (null/undefined/stringa vuota equivalenti) — un
 * PATCH che ri-invia lo stesso valore non deve mai attivare il ricalcolo.
 */
export function directFormulaPickupInputsChanged(
  current: FormulaPickupEditState,
  final: FormulaPickupEditState
): boolean {
  if (normalize(current.hotel_id) !== normalize(final.hotel_id)) return true;
  if (normalize(current.billing_party_name) !== normalize(final.billing_party_name)) return true;
  if (effectiveTime(current) !== effectiveTime(final)) return true;
  if (effectiveDate(current) !== effectiveDate(final)) return true;
  return false;
}

export type FormulaPickupRecalcFields = {
  pickup_hotel: string | null;
  pickup_alert: string | null;
};

/**
 * Ricalcola pickup_hotel/pickup_alert per una Formula direct dopo un edit.
 * Ritorna null quando il ricalcolo NON e' applicabile (kind diverso da
 * Formula, riga non-departure) o quando nessun input rilevante e' cambiato —
 * in entrambi i casi NESSUNA query a ferry_pickup_rules/hotels viene fatta.
 */
export async function recalculateDirectFormulaPickupForEdit(
  admin: SupabaseClient,
  current: FormulaPickupEditState,
  final: FormulaPickupEditState
): Promise<FormulaPickupRecalcFields | null> {
  if (final.direction !== "departure") return null;
  if (!isDirectFormulaKind(final.booking_service_kind)) return null;
  if (!directFormulaPickupInputsChanged(current, final)) return null;

  const time = effectiveTime(final);
  if (!time) return null;
  const date = effectiveDate(final);
  const hotelId = final.hotel_id ?? null;

  const [context, hotelZone, hotelRow] = await Promise.all([
    loadFerryConnectionContext(admin),
    resolveHotelZone(admin, hotelId),
    hotelId
      ? admin.from("hotels").select("name").eq("id", hotelId).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  const hotelName = (hotelRow.data as { name?: string | null } | null)?.name ?? null;

  const fields = applyPickupCalc({
    direction: "departure",
    booking_service_kind: final.booking_service_kind,
    time,
    billing_party_name: final.billing_party_name ?? null,
    hotel_zone: hotelZone.zone,
    hotel_name: hotelName,
    context: date
      ? {
          operationalRules: context.operationalRules,
          ferrySchedules: context.ferrySchedules,
          date,
          hotelId,
        }
      : undefined,
  });

  return {
    pickup_hotel: fields.pickup_hotel ?? null,
    pickup_alert: fields.pickup_alert ?? null,
  };
}
