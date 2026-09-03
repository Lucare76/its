export type FerryPickupRuleDirection = "to_ischia" | "from_ischia";

export interface FerryPickupRule {
  id: string;
  agency_logic: "aleste" | "sosandra";
  transport_type: "train" | "flight" | "direct";
  /**
   * to_ischia = ARRIVO (default legacy, tutte le 60 righe seed 0187 sono così).
   * from_ischia = PARTENZA (nuovo, hotel/zona-based). Vedi findFerryPickupRule
   * (solo to_ischia) e resolveOperationalConnection in
   * lib/operational-connection-resolver.ts (entrambe le direzioni).
   */
  direction: FerryPickupRuleDirection;
  boat_type: "traghetto" | "aliscafo";
  /** Solo from_ischia: FK verso hotels.id. Regola hotel-specifica, batte zone/generale. */
  hotel_id: string | null;
  /** Solo from_ischia: null = jolly (zona qualunque, o generale se hotel_id è anche null). */
  zone: string | null;
  /** null solo per transport_type='direct' (nessun mezzo di collegamento da attendere). */
  transport_from: string | null;
  transport_to: string | null;
  company: string;
  departure_time: string;
  /** Solo from_ischia: porto di partenza barca da Ischia. */
  embark_port: string | null;
  arrival_port: string;
  arrival_time: string | null;
  /** Solo from_ischia: orario di prelievo hotel. */
  pickup_time: string | null;
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
  | "agency_logic"
  | "transport_type"
  | "boat_type"
  | "transport_from"
  | "transport_to"
  | "departure_time"
  | "valid_from"
  | "valid_to"
  | "days_of_week"
> &
  Partial<Pick<FerryPickupRule, "direction" | "hotel_id" | "zone">>;

/** Livello di specificità di una regola: HOTEL (1) > ZONA (2) > GENERALE (3). Solo from_ischia. */
type RuleScope = { level: 1 | 2 | 3; hotelId: string | null; zone: string | null };

function scopeOf(rule: Pick<FerryPickupRule, "hotel_id" | "zone">): RuleScope {
  if (rule.hotel_id != null) return { level: 1, hotelId: rule.hotel_id, zone: null };
  if (rule.zone != null) return { level: 2, hotelId: null, zone: rule.zone };
  return { level: 3, hotelId: null, zone: null };
}

/** Due scope competono realmente solo se sono lo STESSO livello con lo STESSO valore (stesso hotel, o stessa zona, o entrambi generali). Un hotel non è mai in conflitto con una zona: è un override lecito (vedi report). */
function scopesCompete(a: RuleScope, b: RuleScope): boolean {
  if (a.level !== b.level) return false;
  if (a.level === 1) return a.hotelId === b.hotelId;
  if (a.level === 2) return a.zone === b.zone;
  return true; // entrambi generali (livello 3): stesso scope per definizione
}

/**
 * Trova, tra `rules`, la prima regola che potrebbe competere realmente con
 * `candidate` per lo stesso servizio secondo il matcher reale
 * (findFerryPickupRule per to_ischia, resolveOperationalConnection per
 * from_ischia): stessa terna agency_logic/transport_type/boat_type, stessa
 * direction, stesso scope effettivo (hotel/zona/generale — vedi scopesCompete),
 * finestra oraria sovrapposta, e periodo di validità (stagione + giorni della
 * settimana) potenzialmente sovrapposto.
 *
 * Compagnia, porto e orario di sbarco NON sono discriminator del matcher: due
 * regole con compagnie diverse (es. una SNAV e una CAREMAR) competono lo
 * stesso se il resto coincide — è esattamente il caso ambiguo che il matcher
 * risolverebbe in modo implicito/fragile via tie-break su valid_from.
 * Viceversa, `agency_logic` non è "SNAV vs non-SNAV": è 'aleste' (tutte le
 * agenzie tranne Sosandra) oppure 'sosandra' — la compagnia SNAV può in
 * teoria comparire in entrambi i gruppi, quindi non viene mai usata come
 * criterio di esclusione qui.
 *
 * Una regola HOTEL non è MAI conflitto con una regola ZONA o GENERALE per lo
 * stesso hotel/zona: è la gerarchia di specificità voluta (override lecito),
 * non un'ambiguità da segnalare all'operatore.
 */
export function findConflictingRule(
  rules: FerryPickupRule[],
  candidate: FerryPickupRuleCandidate,
  excludeId?: string | null
): FerryPickupRule | null {
  const candidateDirection = candidate.direction ?? "to_ischia";
  const candidateScope = scopeOf({ hotel_id: candidate.hotel_id ?? null, zone: candidate.zone ?? null });
  return (
    rules.find((r) => {
      if (excludeId && r.id === excludeId) return false;
      if (r.agency_logic !== candidate.agency_logic) return false;
      if ((r.direction ?? "to_ischia") !== candidateDirection) return false;
      if (r.transport_type !== candidate.transport_type) return false;
      if (r.boat_type !== candidate.boat_type) return false;
      if (!scopesCompete(scopeOf(r), candidateScope)) return false;
      // Le regole 'direct' (SNAV/MEDMAR diretto) non hanno transport_from/to
      // (nessun mezzo di collegamento da attendere): il match/conflitto
      // avviene sull'orario esatto della nave (departure_time), non su una
      // finestra oraria. r.transport_type === candidate.transport_type è già
      // garantito dal check sopra, quindi se uno dei due è 'direct' lo sono
      // entrambi.
      if (candidate.transport_type === "direct") {
        if (normalizeTime(r.departure_time) !== normalizeTime(candidate.departure_time)) return false;
      } else {
        if (!timeRangesOverlap(r.transport_from!, r.transport_to!, candidate.transport_from!, candidate.transport_to!)) return false;
      }
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

function toMinutesForWindow(hhmm: string): number {
  const [h, m] = hhmm.slice(0, 5).split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * Risolve UNA regola da un insieme di candidate GIÀ filtrate per contesto
 * (agency_logic/transport_type/boat_type/direction/stagione/giorno/hotel-
 * zona — tutto tranne la finestra oraria), gestendo esplicitamente i gap
 * VOLUTI tra fasce consecutive (audit 2026-09-03: `ferry_pickup_rules` è
 * configurata di proposito con piccoli vuoti tra una fascia e la successiva,
 * es. 12:15-13:30 / 13:35-13:55 / 14:00-14:15 — non sono errori di seed).
 *
 * Passo 1 — match diretto: T dentro [from, to] di una o più candidate
 * (tie-break demandato al chiamante via `pickBest`, invariato rispetto a
 * prima — questa funzione non introduce alcuna differenza quando esiste già
 * un match diretto).
 * Passo 2 — SOLO se il passo 1 non produce nulla, "gap -> fascia
 * successiva": se tra le candidate esiste almeno una fascia che finisce
 * PRIMA di T e almeno una che inizia DOPO T, si usa la candidata con
 * transport_from più vicino (più basso) tra quelle successive. Se T precede
 * la primissima fascia, o segue l'ultima, il comportamento resta invariato
 * (null: nessuna fascia "successiva" da usare, mai un'invenzione).
 *
 * Generico e riusabile da entrambi i motori (ARRIVI in questo file,
 * PARTENZE in lib/operational-connection-resolver.ts) — la nozione di "gap
 * tra fasce" è unica, non va duplicata per ogni resolver.
 */
export function resolveTimeWindowRule<T>(
  candidates: T[],
  getFrom: (rule: T) => string,
  getTo: (rule: T) => string,
  time: string,
  pickBest: (matches: T[]) => T | null
): T | null {
  const t = toMinutesForWindow(time);

  const direct = candidates.filter((c) => {
    const from = toMinutesForWindow(getFrom(c));
    const to = toMinutesForWindow(getTo(c));
    return t >= from && t <= to;
  });
  if (direct.length > 0) return pickBest(direct);

  const hasEarlierWindow = candidates.some((c) => toMinutesForWindow(getTo(c)) < t);
  if (!hasEarlierWindow) return null; // T precede la prima fascia: comportamento invariato

  const laterCandidates = candidates.filter((c) => toMinutesForWindow(getFrom(c)) > t);
  if (laterCandidates.length === 0) return null; // T segue l'ultima fascia: comportamento invariato

  const minFrom = Math.min(...laterCandidates.map((c) => toMinutesForWindow(getFrom(c))));
  const nextWindowCandidates = laterCandidates.filter((c) => toMinutesForWindow(getFrom(c)) === minFrom);
  return pickBest(nextWindowCandidates);
}

/**
 * Trova la corsa nave per un cliente che arriva con treno o volo (ARRIVO,
 * mainland -> Ischia). Filtra sempre `direction === 'to_ischia'` in modo
 * esplicito: questa funzione ha un contratto arrivi-only per definizione,
 * anche dopo l'introduzione delle regole PARTENZA (from_ischia) nella stessa
 * tabella — le righe legacy senza `direction` esplicita sono trattate come
 * 'to_ischia' (default di migrazione). Per le PARTENZE usare
 * resolveOperationalConnection() in lib/operational-connection-resolver.ts.
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

  // Candidate di contesto: tutto tranne la finestra oraria (from/to), che è
  // demandata a resolveTimeWindowRule (match diretto + gap -> fascia
  // successiva).
  const contextCandidates = rules.filter((r) => {
    if ((r.direction ?? "to_ischia") !== "to_ischia") return false;
    if (r.agency_logic !== agencyLogic) return false;
    if (r.transport_type !== transportType) return false;
    if (r.boat_type !== boatType) return false;
    // Contratto arrivi-only: to_ischia non include mai regole 'direct'
    // (introdotte solo per direction='from_ischia'), quindi transport_from/to
    // sono sempre presenti qui — la guardia serve solo a soddisfare i tipi.
    if (r.transport_from == null || r.transport_to == null) return false;
    return isRuleActiveOnDate(r, bookingDate);
  });

  // Se ci sono più match sovrapposti per date stagionali, vince il più specifico
  // (valid_from più recente = regola più specifica) — tie-break invariato.
  const best = resolveTimeWindowRule(
    contextCandidates,
    (r) => normalizeTime(r.transport_from!),
    (r) => normalizeTime(r.transport_to!),
    time,
    (matches) =>
      matches.sort((a, b) => {
        const af = a.valid_from ?? "0000-00-00";
        const bf = b.valid_from ?? "0000-00-00";
        return bf.localeCompare(af);
      })[0] ?? null
  );

  if (!best) return null;

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
