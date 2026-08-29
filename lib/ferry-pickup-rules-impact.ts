/**
 * Logica pura di matching per l'impact preview di ferry_pickup_rules
 * (GET /api/ferry-pickup-rules/[id]/impact). Estratta dal route handler per
 * essere testabile senza mock di Supabase — stesso pattern di
 * lib/ferry-pickup-rules.ts (findConflictingRule) e lib/medmar-delivery-card.ts.
 *
 * BUG CORRETTO (segnalazione 2026-08-30, regola "SNAV 07:10 zona Ischia"):
 * hotels.zone contiene testo libero capitalizzato ("Forio", "Ischia Porto",
 * "Lacco Ameno", "Ischia Ponte"...), NON la chiave canonica minuscola usata
 * da ferry_pickup_rules.zone ("forio", "ischia", ...). Il confronto diretto
 * (prima versione dell'endpoint) non normalizzava mai hotels.zone, quindi
 * NESSUNA regola zona-scoped poteva mai trovare un match reale — l'impact
 * preview restituiva sempre 0 per queste regole, a prescindere dal campo
 * modificato. Verificato con query dirette sul DB reale: la regola MEDMAR
 * zone='ischia' (id ccf47250-a950-4cd3-9e4a-a091e7c60e12) ha un servizio
 * futuro reale con hotels.zone='Ischia Porto' che il confronto non normalizzato
 * scartava. Fix: normalizeZonaIschia() prima del confronto (stessa funzione
 * già usata da apply-pickup-calc.ts per lo stesso identico problema).
 */
import { normalizeZonaIschia, derivePortCarrier } from "@/lib/departure-pickup-rules";
import type { FerryPickupRule } from "@/lib/ferry-pickup-rules";

export type ImpactRule = Pick<
  FerryPickupRule,
  | "direction"
  | "transport_type"
  | "company"
  | "departure_time"
  | "transport_from"
  | "transport_to"
  | "zone"
  | "hotel_id"
  | "agency_logic"
>;

export type ImpactServiceCandidate = {
  id: string;
  time: string | null;
  hotel_id: string | null;
  booking_service_kind: string | null;
  billing_party_name: string | null;
  vessel: string | null;
  /** Valore grezzo di hotels.zone (testo libero, non normalizzato). */
  hotel_zone_raw: string | null;
};

// Stessa tabella di FORMULA_CARRIER in lib/server/apply-pickup-calc.ts e
// DIRECT_CARRIER_BY_KIND in lib/operational-connection-resolver.ts —
// duplicata volutamente (modulo puro, nessuna dipendenza da moduli server).
const FORMULA_CARRIER: Record<string, "snav" | "medmar"> = {
  formula_snav: "snav",
  formula_medmar_napoli: "medmar",
  formula_medmar_pozzuoli: "medmar",
};

export function kindMatchesTransportType(kind: string, transportType: "train" | "flight" | "direct"): boolean {
  const k = kind.toLowerCase();
  if (transportType === "train") return k.includes("train");
  if (transportType === "flight") return k.includes("flight") || k.includes("airport");
  return Boolean(FORMULA_CARRIER[k]) || k === "transfer_port_hotel";
}

export function resolveAgencyLogicFromName(name: string | null | undefined): "aleste" | "sosandra" {
  return (name ?? "").toLowerCase().includes("sosandra") ? "sosandra" : "aleste";
}

/**
 * true se il servizio è potenzialmente interessato da `rule` (o dalla sua
 * versione modificata, se il chiamante passa un draft con gli override già
 * applicati — vedi mergeRuleOverride). Match best-effort, non è il matcher
 * esatto di resolveOperationalConnection ma una stima per decidere se serve
 * conferma prima di salvare.
 */
export function serviceMatchesRuleForImpact(rule: ImpactRule, s: ImpactServiceCandidate): boolean {
  if (!s.booking_service_kind || !kindMatchesTransportType(s.booking_service_kind, rule.transport_type)) return false;
  if (resolveAgencyLogicFromName(s.billing_party_name) !== rule.agency_logic) return false;
  if (!s.time) return false;
  const time = s.time.slice(0, 5);

  if (rule.transport_type === "direct") {
    if (time !== rule.departure_time.slice(0, 5)) return false;
    // Compagnia: implicita nel kind per i Formula (formula_snav -> solo
    // snav), letta dal vessel per transfer_port_hotel (generico). Senza
    // questo controllo un cambio "SNAV 07:10 -> MEDMAR 07:10" nel draft non
    // faceva sparire il match sui servizi formula_snav alla stessa ora (bug
    // trovato dal test 7 di tests/unit/ferry-pickup-rules-impact.test.ts).
    const kind = s.booking_service_kind.toLowerCase();
    const carrierFromKind = FORMULA_CARRIER[kind] ?? (kind === "transfer_port_hotel" ? derivePortCarrier(s.vessel) : null);
    if (carrierFromKind !== rule.company.toLowerCase()) return false;
  } else {
    if (!rule.transport_from || !rule.transport_to) return false;
    if (time < rule.transport_from.slice(0, 5) || time > rule.transport_to.slice(0, 5)) return false;
  }

  if (rule.direction === "from_ischia") {
    if (rule.hotel_id) {
      if (s.hotel_id !== rule.hotel_id) return false;
    } else if (rule.zone) {
      const normalizedHotelZone = s.hotel_zone_raw ? normalizeZonaIschia(s.hotel_zone_raw) : null;
      if (normalizedHotelZone !== rule.zone) return false;
    }
  }

  return true;
}

/**
 * Applica un draft di modifiche (dalla UI, prima del salvataggio) sopra la
 * regola salvata — l'impact preview deve valutare la modifica PROPOSTA, non
 * solo quella già persistita. Solo i campi effettivamente rilevanti per il
 * matching sono accettati come override (whitelist esplicita, nessun campo
 * arbitrario iniettabile dalla query string).
 */
const OVERRIDABLE_FIELDS = [
  "direction",
  "transport_type",
  "boat_type",
  "company",
  "departure_time",
  "transport_from",
  "transport_to",
  "zone",
  "hotel_id",
  "agency_logic",
] as const;

export function mergeRuleOverride<T extends ImpactRule>(
  base: T,
  overrides: Partial<Record<(typeof OVERRIDABLE_FIELDS)[number], string | null>>
): T {
  const merged = { ...base };
  for (const key of OVERRIDABLE_FIELDS) {
    if (key in overrides) {
      (merged as Record<string, unknown>)[key] = overrides[key];
    }
  }
  return merged;
}

export const IMPACT_OVERRIDABLE_FIELDS = OVERRIDABLE_FIELDS;
