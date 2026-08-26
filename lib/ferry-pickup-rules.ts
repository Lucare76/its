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

export function normalizeTime(t: string): string {
  return t.slice(0, 5);
}

function normalizeRuleDate(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.slice(0, 10);
  const match = normalized.match(/^(\d{4})-\d{2}-\d{2}$/);
  if (!match) return null;
  const year = Number(match[1]);
  return year >= 2000 ? normalized : null;
}

/**
 * Verifica solo la validità stagionale (valid_from/valid_to), senza guardare
 * i giorni della settimana. valid_from/valid_to in questo schema sono sempre
 * date complete con anno (mai pattern ricorrenti "mese/giorno" senza anno):
 * un periodo che attraversa il capodanno (es. 2026-09-16 → 2027-04-30) è già
 * gestito correttamente da un semplice confronto stringa, senza bisogno di
 * logica di "wrap-around".
 */
export function isRuleWithinValidityPeriod(
  rule: Pick<FerryPickupRule, "valid_from" | "valid_to">,
  isoDate: string
): boolean {
  if (!isoDate) return true;
  const validFrom = normalizeRuleDate(rule.valid_from);
  const validTo = normalizeRuleDate(rule.valid_to);
  if (validFrom && isoDate < validFrom) return false;
  if (validTo && isoDate > validTo) return false;
  return true;
}

/** Verifica solo il giorno della settimana (days_of_week nullo/vuoto = tutti i giorni). */
export function isRuleDayOfWeekAllowed(
  rule: Pick<FerryPickupRule, "days_of_week">,
  isoDate: string
): boolean {
  if (!isoDate) return true;
  if (rule.days_of_week?.length) {
    // T12:00:00 (nessun suffisso "Z") evita che l'orario locale sposti la
    // data attraverso la mezzanotte per via del fuso orario di esecuzione.
    const dow = new Date(`${isoDate}T12:00:00`).getDay();
    if (!rule.days_of_week.includes(dow)) return false;
  }
  return true;
}

function isRuleActiveOnDate(rule: FerryPickupRule, isoDate: string): boolean {
  return isRuleWithinValidityPeriod(rule, isoDate) && isRuleDayOfWeekAllowed(rule, isoDate);
}

export type RuleActivityStatus = "active_today" | "off_season" | "inactive_today";

/**
 * Stato della regola rispetto a una data di riferimento (tipicamente oggi),
 * per il badge mostrato in tabella:
 * - "off_season": la data non rientra nel periodo valid_from/valid_to.
 * - "inactive_today": la stagione è valida ma il giorno della settimana no.
 * - "active_today": la regola si applicherebbe oggi.
 */
export function getRuleActivityStatus(
  rule: Pick<FerryPickupRule, "valid_from" | "valid_to" | "days_of_week">,
  isoDate: string
): RuleActivityStatus {
  if (!isRuleWithinValidityPeriod(rule, isoDate)) return "off_season";
  if (!isRuleDayOfWeekAllowed(rule, isoDate)) return "inactive_today";
  return "active_today";
}

const ROME_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Rome",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Data odierna (YYYY-MM-DD) nel fuso Europe/Rome, stabile rispetto a UTC/DST. */
export function todayIsoDateRome(now: Date = new Date()): string {
  return ROME_DATE_FORMATTER.format(now);
}

/** true se l'intervallo di arrivo del mezzo è valido (from < to, nessun attraversamento mezzanotte). */
export function isTransportWindowValid(from: string, to: string): boolean {
  return normalizeTime(from) < normalizeTime(to);
}

function timeRangesOverlap(aFrom: string, aTo: string, bFrom: string, bTo: string): boolean {
  return normalizeTime(aFrom) < normalizeTime(bTo) && normalizeTime(bFrom) < normalizeTime(aTo);
}

function dateRangesOverlap(
  aFrom: string | null,
  aTo: string | null,
  bFrom: string | null,
  bTo: string | null
): boolean {
  const aStart = normalizeRuleDate(aFrom) ?? "0000-01-01";
  const aEnd = normalizeRuleDate(aTo) ?? "9999-12-31";
  const bStart = normalizeRuleDate(bFrom) ?? "0000-01-01";
  const bEnd = normalizeRuleDate(bTo) ?? "9999-12-31";
  return aStart <= bEnd && bStart <= aEnd;
}

function daysOfWeekOverlap(a: number[] | null | undefined, b: number[] | null | undefined): boolean {
  // Nessuna lista (o vuota) = "tutti i giorni": è un jolly che si sovrappone a qualunque altro insieme.
  if (!a?.length || !b?.length) return true;
  return a.some((d) => b.includes(d));
}

export type FerryPickupRuleCandidate = Pick<
  FerryPickupRule,
  "agency_logic" | "transport_type" | "boat_type" | "transport_from" | "transport_to" | "valid_from" | "valid_to" | "days_of_week"
>;

/**
 * Trova, tra `rules`, la prima regola che potrebbe competere realmente con
 * `candidate` per lo stesso servizio secondo il matcher reale
 * (findFerryPickupRule): stessa terna agency_logic/transport_type/boat_type
 * (l'unico filtro di uguaglianza che il matcher applica), finestra oraria di
 * arrivo del mezzo sovrapposta, e periodo di validità (stagione + giorni
 * della settimana) potenzialmente sovrapposto.
 *
 * Compagnia, porto e orario di sbarco NON sono discriminator del matcher: due
 * regole con compagnie diverse (es. una SNAV e una CAREMAR) competono lo
 * stesso se il resto coincide — è esattamente il caso ambiguo che il matcher
 * risolverebbe in modo implicito/fragile via tie-break su valid_from.
 * Viceversa, `agency_logic` non è "SNAV vs non-SNAV": è 'aleste' (tutte le
 * agenzie tranne Sosandra) oppure 'sosandra' — la compagnia SNAV può in
 * teoria comparire in entrambi i gruppi, quindi non viene mai usata come
 * criterio di esclusione qui.
 */
export function findConflictingRule(
  rules: FerryPickupRule[],
  candidate: FerryPickupRuleCandidate,
  excludeId?: string | null
): FerryPickupRule | null {
  return (
    rules.find((r) => {
      if (excludeId && r.id === excludeId) return false;
      if (r.agency_logic !== candidate.agency_logic) return false;
      if (r.transport_type !== candidate.transport_type) return false;
      if (r.boat_type !== candidate.boat_type) return false;
      if (!timeRangesOverlap(r.transport_from, r.transport_to, candidate.transport_from, candidate.transport_to)) return false;
      if (!dateRangesOverlap(r.valid_from, r.valid_to, candidate.valid_from ?? null, candidate.valid_to ?? null)) return false;
      if (!daysOfWeekOverlap(r.days_of_week, candidate.days_of_week)) return false;
      return true;
    }) ?? null
  );
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
