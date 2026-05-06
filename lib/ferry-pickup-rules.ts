export interface FerryPickupRule {
  id: string;
  agency_logic: "aleste" | "sosandra";
  transport_type: "train" | "flight";
  boat_type: "traghetto" | "aliscafo";
  transport_from: string;
  transport_to: string;
  company: string;
  departure_time: string;
  arrival_port: string;
  arrival_time: string | null;
  valid_from: string | null;
  valid_to: string | null;
  days_of_week: number[] | null;
  season_notes: string | null;
  created_at: string;
  updated_at: string;
}

function normalizeTime(t: string): string {
  return t.slice(0, 5);
}

function isRuleActiveOnDate(rule: FerryPickupRule, isoDate: string): boolean {
  if (!isoDate) return true;
  if (rule.valid_from && isoDate < rule.valid_from) return false;
  if (rule.valid_to && isoDate > rule.valid_to) return false;
  if (rule.days_of_week?.length) {
    const dow = new Date(`${isoDate}T12:00:00`).getDay();
    if (!rule.days_of_week.includes(dow)) return false;
  }
  return true;
}

export interface FerryPickupMatch {
  rule: FerryPickupRule;
  company: string;
  departureTime: string;
  arrivalPort: string;
  arrivalTime: string | null;
}

/**
 * Trova la corsa nave per un cliente che arriva con treno o volo.
 *
 * @param agencyLogic  'aleste' per tutte le agenzie eccetto Sosandra
 * @param transportType  'train' | 'flight'
 * @param boatType  'traghetto' | 'aliscafo' (rilevante solo per Sosandra treno)
 * @param transportArrivalTime  orario arrivo del mezzo (HH:MM)
 * @param bookingDate  data della prenotazione (YYYY-MM-DD)
 */
export function findFerryPickupRule(
  rules: FerryPickupRule[],
  agencyLogic: "aleste" | "sosandra",
  transportType: "train" | "flight",
  boatType: "traghetto" | "aliscafo",
  transportArrivalTime: string,
  bookingDate: string
): FerryPickupMatch | null {
  const time = normalizeTime(transportArrivalTime);

  const matches = rules.filter((r) => {
    if (r.agency_logic !== agencyLogic) return false;
    if (r.transport_type !== transportType) return false;
    if (r.boat_type !== boatType) return false;
    if (time < normalizeTime(r.transport_from)) return false;
    if (time > normalizeTime(r.transport_to)) return false;
    return isRuleActiveOnDate(r, bookingDate);
  });

  if (matches.length === 0) return null;

  // Se ci sono più match sovrapposti per date stagionali, vince il più specifico
  // (valid_from più recente = regola più specifica)
  const best = matches.sort((a, b) => {
    const af = a.valid_from ?? "0000-00-00";
    const bf = b.valid_from ?? "0000-00-00";
    return bf.localeCompare(af);
  })[0]!;

  return {
    rule: best,
    company: best.company,
    departureTime: normalizeTime(best.departure_time),
    arrivalPort: best.arrival_port,
    arrivalTime: best.arrival_time ? normalizeTime(best.arrival_time) : null,
  };
}

/**
 * Determina la agency_logic da usare in base al nome/chiave dell'agenzia.
 * Sosandra ha la sua logica separata; tutte le altre usano 'aleste'.
 */
export function resolveAgencyLogic(agencyKey: string | null | undefined): "aleste" | "sosandra" {
  if (!agencyKey) return "aleste";
  return agencyKey.toLowerCase().includes("sosandra") ? "sosandra" : "aleste";
}
