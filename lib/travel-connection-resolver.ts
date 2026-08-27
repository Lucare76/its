/**
 * resolveTravelConnection — collegamento nave/aliscafo canonico per i
 * transfer treno/aereo, sia in ARRIVO che in PARTENZA.
 *
 * Pipeline (in quest'ordine, mai al contrario):
 *   1. policy agenzia (tipi/compagnie nave ammessi)
 *   2. filtro corse non ammesse dalla policy
 *   3. compatibilità temporale (vincoli A/B)
 *   4. preferenza commerciale SNAV ±30min (solo tra corse già ammesse)
 *   5. proposta + motivazione
 *
 * Fonte dati nave: tabella reale `ferry_schedules` (mai valori statici di
 * calcPickupTime()). Margini: vedi commenti sotto — quelli non rintracciabili
 * nel repository sono etichettati esplicitamente come STIMA non confermata,
 * non vengono presentati come dato certo (non danno mai confidence ALTA).
 */

export type TravelDirection = "arrival" | "departure";
export type FerryType = "traghetto" | "aliscafo";
export type ContinentPlaceType = "station" | "airport";
export type ConnectionConfidence = "ALTA" | "MEDIA" | "BASSA" | "NESSUNA";

export type FerryScheduleRow = {
  id?: string;
  company: string;
  departure_port: string;
  arrival_port: string;
  departure_time: string;
  arrival_time?: string | null;
  direction: "ischia_to_mainland" | "mainland_to_ischia";
  days_of_week: number[] | null;
  valid_from: string | null;
  valid_to: string | null;
};

export type ResolveTravelConnectionInput = {
  direction: TravelDirection;
  bookingServiceKind: string;
  /** Orario treno/volo: partenza (departure) o arrivo (arrival), HH:MM. */
  transportTime: string;
  date: string; // YYYY-MM-DD
  ferrySchedules: FerryScheduleRow[];
  /** Nome agenzia (billing_party_name) — determina la policy applicata PRIMA di ogni ottimizzazione oraria. */
  agencyName?: string | null;
  /**
   * Pickup hotel già noto/confermato (departure). Se assente, il resolver
   * non calcola un pickup autonomo: manca nel repository una tabella
   * hotel-zona → minuti hotel→porto indipendente da lib/departure-pickup-rules.ts.
   */
  knownPickupTime?: string | null;
};

export type ExcludedCandidate = {
  company: string;
  departureTime: string;
  reason: "policy" | "time";
  detail: string;
};

export type ConnectionPolicyInfo = {
  agencyKey: string;
  source: "known" | "default";
  allowedFerryTypes: FerryType[];
};

export type ResolveTravelConnectionResult = {
  proposedPickupTime: string | null;
  proposedFerryScheduleId: string | null;
  proposedCompany: string | null;
  proposedFerryType: FerryType | null;
  proposedFerryDepartureTime: string | null;
  proposedFerryArrivalTime: string | null;
  proposedEmbarkPort: string | null;
  proposedArrivalPort: string | null;
  connectionMarginMinutes: number | null;
  confidence: ConnectionConfidence;
  reason: string;
  candidatesEvaluated: number;
  excludedByPolicy: ExcludedCandidate[];
  policy: ConnectionPolicyInfo;
  gaps: string[];
};

// ---------------------------------------------------------------------------
// Policy agenzia — CENTRALIZZATA. Verificata contro i naming reali visti nel
// repo (billing_party_name: "ALESTE VIAGGI", "ZIGOLOVIAGGI SRL",
// "SOSANDRA TOUR BY ROSSELLA VIAGGI S.r.L.", "ANGELINO TOUR & EVENTS SRL",
// agenzie non mappate es. "Sun & sea" per NIKOLAENKO -> default conservativo).
// Stesso criterio di normalizzazione già usato in
// lib/server/apply-pickup-calc.ts (billingToAgencyKey) e
// lib/departure-pickup-rules.ts (normalizeAgencyKey), riusato qui per
// coerenza col resto del codebase.
//
// Compagnie osservate in ferry_schedules.company: "medmar" | "snav" |
// "alilauro" | "caremar" (sempre minuscolo). SNAV/Alilauro sono aliscafo,
// Medmar/Caremar sono traghetto in questo dominio — nessun caso osservato di
// compagnia con entrambi i tipi, quindi il filtro per FerryType è già
// sufficiente; allowedCompanies e' lasciato disponibile per policy future
// più granulari (es. Sosandra che alterna Alilauro/Snav per fascia oraria,
// vedi calc-pickup-time.ts) ma non serve per i 3 casi di questo task.
// ---------------------------------------------------------------------------

type AgencyPolicyDefinition = {
  allowedFerryTypes: FerryType[];
  allowedCompanies: Set<string> | null;
};

/** Sosandra: unica agenzia autorizzata all'aliscafo secondo la regola operativa confermata. */
const SOSANDRA_POLICY: AgencyPolicyDefinition = { allowedFerryTypes: ["traghetto", "aliscafo"], allowedCompanies: null };
/** Tutte le altre agenzie note: solo traghetto, salvo override manuale esplicito (mai automatico). */
const STANDARD_POLICY: AgencyPolicyDefinition = { allowedFerryTypes: ["traghetto"], allowedCompanies: null };

const KNOWN_AGENCY_POLICIES: Record<string, AgencyPolicyDefinition> = {
  sosandra: SOSANDRA_POLICY,
  aleste: STANDARD_POLICY,
  zigolo: STANDARD_POLICY,
  angelino: STANDARD_POLICY,
};

export function resolveAgencyConnectionPolicy(agencyName: string | null | undefined): ConnectionPolicyInfo & { definition: AgencyPolicyDefinition } {
  const n = (agencyName ?? "").toLowerCase();
  if (n.includes("sosandra") || n.includes("dimhotel")) {
    return { agencyKey: "sosandra", source: "known", allowedFerryTypes: SOSANDRA_POLICY.allowedFerryTypes, definition: SOSANDRA_POLICY };
  }
  if (n.includes("aleste")) return { agencyKey: "aleste", source: "known", allowedFerryTypes: STANDARD_POLICY.allowedFerryTypes, definition: KNOWN_AGENCY_POLICIES.aleste };
  if (n.includes("zigolo")) return { agencyKey: "zigolo", source: "known", allowedFerryTypes: STANDARD_POLICY.allowedFerryTypes, definition: KNOWN_AGENCY_POLICIES.zigolo };
  if (n.includes("angelino")) return { agencyKey: "angelino", source: "known", allowedFerryTypes: STANDARD_POLICY.allowedFerryTypes, definition: KNOWN_AGENCY_POLICIES.angelino };
  // Agenzia non mappata (es. "Sun & sea", null, o qualunque altra): policy default conservativa,
  // MAI aliscafo automatico finché non esiste una regola operativa confermata per quell'agenzia.
  return { agencyKey: n || "sconosciuta", source: "default", allowedFerryTypes: STANDARD_POLICY.allowedFerryTypes, definition: STANDARD_POLICY };
}

// ---------------------------------------------------------------------------
// Porto continentale canonico per compagnia — PREFERENZA (non esclusione
// assoluta: se nessun candidato nel porto preferito è temporalmente valido,
// si ricade sugli altri porti della stessa compagnia).
//
// Fonte: lib/server/calc-pickup-time.ts — ALESTE_TRENO_TRAGHETTO,
// ALESTE_AEREO_TRAGHETTO, DIMHOTELS_TRENO_TRAGHETTO, DIMHOTELS_AEREO_TRAGHETTO
// usano SEMPRE "Napoli Beverello" per Medmar, MAI Pozzuoli (6 tabelle
// indipendenti, nessuna eccezione). Alilauro: sempre Napoli Beverello nelle
// tabelle aliscafo Dimhotels. SNAV non incluso qui: le tabelle aliscafo
// Dimhotels associano Snav a Pozzuoli, ma l'unico dato reale confermato per
// Snav (override BIRAGO) è invece Napoli Beverello — evidenza contraddittoria,
// quindi nessuna preferenza di porto applicata a Snav/Caremar.
// ---------------------------------------------------------------------------
const CANONICAL_MAINLAND_PORT_BY_COMPANY: Record<string, string> = {
  medmar: "napoli_beverello",
  alilauro: "napoli_beverello",
};

// ---------------------------------------------------------------------------
// Margini — fonti esplicite. Quelli senza fonte nel repo sono STIME, mai
// spacciate per dato confermato (confidence non sarà mai ALTA se usate).
// ---------------------------------------------------------------------------

/** STIMA non confermata nel repo: nessuna tabella porto↔stazione/aeroporto esistente per il lato continente. */
const MAINLAND_TRANSFER_MINUTES_ESTIMATE: Record<string, Partial<Record<ContinentPlaceType, number>>> = {
  napoli_beverello: { station: 25, airport: 40 },
  pozzuoli: { station: 20, airport: 35 },
  casamicciola: {},
  ischia_porto: {},
};

/** STIMA non confermata nel repo: margine di sicurezza generico oltre al transfer terraferma. */
const SAFETY_MARGIN_MINUTES_ESTIMATE = 15;

/** STIMA non confermata nel repo: tempo sbarco+ritiro bagagli aeroporto prima di poter partire verso il porto. */
const AIRPORT_BAGGAGE_MARGIN_MINUTES_ESTIMATE = 20;

/** Regola commerciale confermata dal task: preferenza SNAV entro questa finestra rispetto alla migliore alternativa, SOLO tra le corse già ammesse dalla policy agenzia. */
export const SNAV_PREFERENCE_WINDOW_MINUTES = 30;

const TRAIN_KINDS = new Set(["transfer_train_hotel", "transfer_train_hotel_exclusive", "transfer_train_hotel_aliscafo"]);
const AIRPORT_KINDS = new Set(["transfer_airport_hotel", "transfer_airport_hotel_exclusive", "transfer_airport_hotel_aliscafo"]);

function placeTypeFromKind(kind: string): ContinentPlaceType | null {
  if (TRAIN_KINDS.has(kind)) return "station";
  if (AIRPORT_KINDS.has(kind)) return "airport";
  return null;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.slice(0, 5).split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function fromMinutes(min: number): string {
  const normalized = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
}

function isActiveOnDate(row: FerryScheduleRow, isoDate: string): boolean {
  if (row.valid_from && isoDate < row.valid_from) return false;
  if (row.valid_to && isoDate > row.valid_to) return false;
  if (row.days_of_week?.length) {
    const dow = new Date(`${isoDate}T12:00:00`).getDay();
    if (!row.days_of_week.includes(dow)) return false;
  }
  return true;
}

function isSnav(company: string): boolean {
  return company.toLowerCase().includes("snav");
}

function ferryTypeFor(company: string): FerryType {
  const c = company.toLowerCase();
  if (c.includes("snav") || c.includes("alilauro")) return "aliscafo";
  return "traghetto";
}

/** Fallback durata traversata quando arrival_time manca nella riga (gap dati noto per Alilauro): fonte inferArrivalDurationMinutes() in lib/ferry-schedule-options.ts. */
function inferArrivalTime(row: FerryScheduleRow): string | null {
  if (row.arrival_time) return row.arrival_time.slice(0, 5);
  const company = row.company.toLowerCase();
  const minutes = company === "snav" ? 65
    : company === "alilauro" ? 45
    : company === "caremar" ? 85
    : company === "medmar" && row.departure_port === "napoli_beverello" ? 90
    : company === "medmar" && row.departure_port === "pozzuoli" ? 60
    : null;
  return minutes == null ? null : fromMinutes(toMinutes(row.departure_time) + minutes);
}

type Candidate = {
  row: FerryScheduleRow;
  ferryDeparture: number;
  ferryArrival: number;
};

function isAllowedByPolicy(row: FerryScheduleRow, policy: AgencyPolicyDefinition): boolean {
  if (!policy.allowedFerryTypes.includes(ferryTypeFor(row.company))) return false;
  if (policy.allowedCompanies && !policy.allowedCompanies.has(row.company.toLowerCase())) return false;
  return true;
}

function buildResult(
  candidate: Candidate | null,
  args: {
    proposedPickupTime: string | null;
    marginMinutes: number | null;
    reason: string;
    confidence: ConnectionConfidence;
    candidatesEvaluated: number;
    excludedByPolicy: ExcludedCandidate[];
    policy: ConnectionPolicyInfo;
    gaps: string[];
  }
): ResolveTravelConnectionResult {
  const base = {
    proposedPickupTime: args.proposedPickupTime,
    connectionMarginMinutes: args.marginMinutes,
    confidence: args.confidence,
    reason: args.reason,
    candidatesEvaluated: args.candidatesEvaluated,
    excludedByPolicy: args.excludedByPolicy,
    policy: args.policy,
    gaps: args.gaps,
  };
  if (!candidate) {
    return {
      ...base,
      proposedFerryScheduleId: null,
      proposedCompany: null,
      proposedFerryType: null,
      proposedFerryDepartureTime: null,
      proposedFerryArrivalTime: null,
      proposedEmbarkPort: null,
      proposedArrivalPort: null,
      confidence: "NESSUNA",
    };
  }
  return {
    ...base,
    proposedFerryScheduleId: candidate.row.id ?? null,
    proposedCompany: candidate.row.company,
    proposedFerryType: ferryTypeFor(candidate.row.company),
    proposedFerryDepartureTime: fromMinutes(candidate.ferryDeparture),
    proposedFerryArrivalTime: fromMinutes(candidate.ferryArrival),
    proposedEmbarkPort: candidate.row.departure_port,
    proposedArrivalPort: candidate.row.arrival_port,
  };
}

/** Applica la preferenza commerciale SNAV entro ±30min dalla migliore alternativa, SOLO tra i candidati già ammessi dalla policy e temporalmente validi. */
function applySnavPreference(best: Candidate, valid: Candidate[], rankKey: (c: Candidate) => number): Candidate {
  const snavCandidates = valid.filter((c) => isSnav(c.row.company));
  if (snavCandidates.length === 0) return best;
  const bestRank = rankKey(best);
  const snavWithinWindow = snavCandidates
    .filter((c) => Math.abs(rankKey(c) - bestRank) <= SNAV_PREFERENCE_WINDOW_MINUTES)
    .sort((a, b) => Math.abs(rankKey(a) - bestRank) - Math.abs(rankKey(b) - bestRank));
  return snavWithinWindow[0] ?? best;
}

function resolveDeparture(input: ResolveTravelConnectionInput, gaps: string[]): ResolveTravelConnectionResult {
  const policyResolved = resolveAgencyConnectionPolicy(input.agencyName);
  const policyInfo: ConnectionPolicyInfo = { agencyKey: policyResolved.agencyKey, source: policyResolved.source, allowedFerryTypes: policyResolved.allowedFerryTypes };
  const placeType = placeTypeFromKind(input.bookingServiceKind);
  const transportMin = toMinutes(input.transportTime);
  const proposedPickupTime = input.knownPickupTime ?? null;
  if (!input.knownPickupTime) {
    gaps.push("Nessun pickup noto in input: manca nel repo una tabella hotel-zona -> minuti hotel->porto indipendente da lib/departure-pickup-rules.ts; il resolver non calcola un pickup autonomo (usa getPickupRule() a monte per quello).");
  }
  if (!placeType) {
    return buildResult(null, { proposedPickupTime, marginMinutes: null, reason: `booking_service_kind '${input.bookingServiceKind}' non è treno/aereo: nessun collegamento nave da calcolare.`, confidence: "NESSUNA", candidatesEvaluated: 0, excludedByPolicy: [], policy: policyInfo, gaps });
  }

  const rows = input.ferrySchedules.filter((r) => r.direction === "ischia_to_mainland" && isActiveOnDate(r, input.date));
  const allCandidates: Candidate[] = rows
    .map((row) => {
      const arrivalStr = inferArrivalTime(row);
      if (!arrivalStr) return null;
      return { row, ferryDeparture: toMinutes(row.departure_time), ferryArrival: toMinutes(arrivalStr) };
    })
    .filter((c): c is Candidate => c !== null);

  // STEP 1-2: policy PRIMA di ogni ottimizzazione oraria.
  const excludedByPolicy: ExcludedCandidate[] = [];
  const policyAllowed = allCandidates.filter((c) => {
    if (isAllowedByPolicy(c.row, policyResolved.definition)) return true;
    excludedByPolicy.push({
      company: c.row.company,
      departureTime: c.row.departure_time.slice(0, 5),
      reason: "policy",
      detail: `Tipo '${ferryTypeFor(c.row.company)}' non ammesso dalla policy agenzia '${policyInfo.agencyKey}' (${policyInfo.source}).`,
    });
    return false;
  });

  // STEP 3: compatibilità temporale, solo tra le corse già ammesse dalla policy.
  const mainlandMinutesByPort = (port: string) => MAINLAND_TRANSFER_MINUTES_ESTIMATE[port]?.[placeType];
  const localGaps: string[] = [];

  const valid = policyAllowed.filter((c) => {
    const mainlandMin = mainlandMinutesByPort(c.row.arrival_port);
    if (mainlandMin == null) {
      localGaps.push(`Margine porto '${c.row.arrival_port}' -> ${placeType} non configurato (stima assente): corsa '${c.row.company} ${c.row.departure_time}' esclusa dal confronto per prudenza.`);
      return false;
    }
    const requiredArrivalBy = transportMin - mainlandMin - SAFETY_MARGIN_MINUTES_ESTIMATE;
    if (c.ferryArrival > requiredArrivalBy) return false; // Vincolo B
    if (proposedPickupTime != null && c.ferryDeparture < toMinutes(proposedPickupTime)) return false; // Vincolo A (nave non puo' partire prima del pickup)
    return true;
  });

  if (valid.length === 0) {
    return buildResult(null, {
      proposedPickupTime,
      marginMinutes: null,
      reason: excludedByPolicy.length === allCandidates.length && allCandidates.length > 0
        ? `Nessuna corsa ammessa dalla policy agenzia '${policyInfo.agencyKey}' è temporalmente valida (tutte le corse ammesse escluse dai vincoli).`
        : "Nessuna corsa ischia_to_mainland compatibile con l'orario treno/volo, i margini disponibili e la policy agenzia.",
      confidence: "NESSUNA",
      candidatesEvaluated: allCandidates.length,
      excludedByPolicy,
      policy: policyInfo,
      gaps: [...gaps, ...localGaps],
    });
  }

  // STEP 3b: preferenza porto continentale canonico per compagnia (fonte:
  // calc-pickup-time.ts). Preferenza, non esclusione: se nessun candidato nel
  // porto preferito è valido, si ricade sul pool completo.
  const preferredPort = (c: Candidate) => CANONICAL_MAINLAND_PORT_BY_COMPANY[c.row.company.toLowerCase()];
  const portPreferredPool = valid.filter((c) => {
    const p = preferredPort(c);
    return p == null || c.row.arrival_port === p;
  });
  const rankPool = portPreferredPool.length > 0 ? portPreferredPool : valid;
  const portPreferenceApplied = portPreferredPool.length > 0 && portPreferredPool.length < valid.length;

  // STEP 4: "migliore" = la corsa con maggior margine di sicurezza tra quelle valide
  // (arrivo più anticipato rispetto al limite) — non "l'ultima utile": a parità di
  // vincoli rispettati, privilegia il margine più ampio (comportamento osservato
  // nelle scelte operative confermate, es. SUORATO).
  const rankKey = (c: Candidate) => c.ferryArrival;
  const best = rankPool.reduce((a, b) => (rankKey(b) < rankKey(a) ? b : a));
  const chosen = applySnavPreference(best, valid, rankKey);

  const mainlandMin = mainlandMinutesByPort(chosen.row.arrival_port)!;
  const requiredArrivalBy = transportMin - mainlandMin - SAFETY_MARGIN_MINUTES_ESTIMATE;
  const margin = requiredArrivalBy - chosen.ferryArrival;
  const snavPreferred = chosen !== best;

  const reason = snavPreferred
    ? `SNAV ${chosen.row.departure_time.slice(0, 5)} preferita (regola commerciale, entro ±${SNAV_PREFERENCE_WINDOW_MINUTES}min dalla migliore alternativa ammessa ${best.row.company} ${best.row.departure_time.slice(0, 5)}), margine ${margin}min prima del limite per orario treno/volo ${input.transportTime}. Policy agenzia '${policyInfo.agencyKey}' (${policyInfo.source}).`
    : `Corsa con maggior margine${portPreferenceApplied ? ` nel porto continentale canonico per ${best.row.company} (fonte: calc-pickup-time.ts)` : ""} tra quelle ammesse dalla policy agenzia '${policyInfo.agencyKey}' (${policyInfo.source}) (nessuna SNAV ammessa entro ±${SNAV_PREFERENCE_WINDOW_MINUTES}min o già SNAV), margine ${margin}min prima del limite per orario treno/volo ${input.transportTime}.`;

  return buildResult(chosen, {
    proposedPickupTime,
    marginMinutes: margin,
    reason,
    confidence: policyInfo.source === "default" ? "BASSA" : (localGaps.length > 0 ? "MEDIA" : (margin >= 15 ? "ALTA" : "MEDIA")),
    candidatesEvaluated: allCandidates.length,
    excludedByPolicy,
    policy: policyInfo,
    gaps: [...gaps, ...localGaps],
  });
}

function resolveArrival(input: ResolveTravelConnectionInput, gaps: string[]): ResolveTravelConnectionResult {
  const policyResolved = resolveAgencyConnectionPolicy(input.agencyName);
  const policyInfo: ConnectionPolicyInfo = { agencyKey: policyResolved.agencyKey, source: policyResolved.source, allowedFerryTypes: policyResolved.allowedFerryTypes };
  const placeType = placeTypeFromKind(input.bookingServiceKind);
  const transportArrivalMin = toMinutes(input.transportTime);
  if (!placeType) {
    return buildResult(null, { proposedPickupTime: null, marginMinutes: null, reason: `booking_service_kind '${input.bookingServiceKind}' non è treno/aereo: nessun collegamento nave da calcolare.`, confidence: "NESSUNA", candidatesEvaluated: 0, excludedByPolicy: [], policy: policyInfo, gaps });
  }

  const localGaps: string[] = [];
  const baggageMin = placeType === "airport" ? AIRPORT_BAGGAGE_MARGIN_MINUTES_ESTIMATE : 0;
  if (placeType === "airport") localGaps.push(`Margine sbarco+bagagli aeroporto = ${AIRPORT_BAGGAGE_MARGIN_MINUTES_ESTIMATE}min: STIMA non confermata nel repo.`);

  const rows = input.ferrySchedules.filter((r) => r.direction === "mainland_to_ischia" && isActiveOnDate(r, input.date));
  const allCandidates: Candidate[] = rows
    .map((row) => {
      const arrivalStr = inferArrivalTime(row);
      if (!arrivalStr) return null;
      return { row, ferryDeparture: toMinutes(row.departure_time), ferryArrival: toMinutes(arrivalStr) };
    })
    .filter((c): c is Candidate => c !== null);

  const excludedByPolicy: ExcludedCandidate[] = [];
  const policyAllowed = allCandidates.filter((c) => {
    if (isAllowedByPolicy(c.row, policyResolved.definition)) return true;
    excludedByPolicy.push({
      company: c.row.company,
      departureTime: c.row.departure_time.slice(0, 5),
      reason: "policy",
      detail: `Tipo '${ferryTypeFor(c.row.company)}' non ammesso dalla policy agenzia '${policyInfo.agencyKey}' (${policyInfo.source}).`,
    });
    return false;
  });

  const mainlandMinutesByPort = (port: string) => MAINLAND_TRANSFER_MINUTES_ESTIMATE[port]?.[placeType];

  const valid = policyAllowed.filter((c) => {
    const mainlandMin = mainlandMinutesByPort(c.row.departure_port);
    if (mainlandMin == null) {
      localGaps.push(`Margine ${placeType} -> porto '${c.row.departure_port}' non configurato (stima assente): corsa '${c.row.company} ${c.row.departure_time}' esclusa dal confronto per prudenza.`);
      return false;
    }
    const earliestReachable = transportArrivalMin + baggageMin + mainlandMin; // Vincolo A
    return c.ferryDeparture >= earliestReachable;
  });

  if (valid.length === 0) {
    return buildResult(null, {
      proposedPickupTime: null,
      marginMinutes: null,
      reason: "Nessuna corsa mainland_to_ischia raggiungibile dopo l'arrivo del volo/treno con i margini disponibili e la policy agenzia.",
      confidence: "NESSUNA",
      candidatesEvaluated: allCandidates.length,
      excludedByPolicy,
      policy: policyInfo,
      gaps: [...gaps, ...localGaps],
    });
  }

  // "Migliore" = la corsa più vicina (prima raggiungibile) tra quelle valide (minimizza attesa in aeroporto/stazione).
  const rankKey = (c: Candidate) => c.ferryDeparture;
  const best = valid.reduce((a, b) => (rankKey(b) < rankKey(a) ? b : a));
  const chosen = applySnavPreference(best, valid, rankKey);

  const mainlandMin = mainlandMinutesByPort(chosen.row.departure_port)!;
  const earliestReachable = transportArrivalMin + baggageMin + mainlandMin;
  const margin = chosen.ferryDeparture - earliestReachable;
  const snavPreferred = chosen !== best;

  const reason = snavPreferred
    ? `SNAV ${chosen.row.departure_time.slice(0, 5)} preferita (regola commerciale, entro ±${SNAV_PREFERENCE_WINDOW_MINUTES}min dalla migliore alternativa ammessa ${best.row.company} ${best.row.departure_time.slice(0, 5)}), margine ${margin}min dopo l'orario minimo raggiungibile. Policy agenzia '${policyInfo.agencyKey}' (${policyInfo.source}).`
    : `Prima corsa raggiungibile dopo l'arrivo di ${input.transportTime} tra quelle ammesse dalla policy agenzia '${policyInfo.agencyKey}' (${policyInfo.source}) (nessuna SNAV ammessa entro ±${SNAV_PREFERENCE_WINDOW_MINUTES}min o già SNAV), margine ${margin}min.`;

  return buildResult(chosen, {
    proposedPickupTime: null,
    marginMinutes: margin,
    reason,
    confidence: policyInfo.source === "default" ? "BASSA" : (localGaps.length > 0 ? "MEDIA" : (margin >= 15 ? "ALTA" : "MEDIA")),
    candidatesEvaluated: allCandidates.length,
    excludedByPolicy,
    policy: policyInfo,
    gaps: [...gaps, ...localGaps],
  });
}

export function resolveTravelConnection(input: ResolveTravelConnectionInput): ResolveTravelConnectionResult {
  const gaps: string[] = [];
  return input.direction === "departure" ? resolveDeparture(input, gaps) : resolveArrival(input, gaps);
}

// ---------------------------------------------------------------------------
// Override manuale — funzioni pure, nessuna persistenza. Modellano la
// struttura ferry_details.connection proposta e la logica "il ricalcolo non
// sovrascrive un override confermato senza conferma esplicita".
// ---------------------------------------------------------------------------

export type ConnectionRecord = {
  schedule_id: string | null;
  company: string | null;
  ferry_type: FerryType | null;
  departure_time: string | null;
  arrival_time: string | null;
  embark_port: string | null;
  arrival_port: string | null;
  source: "auto" | "manual";
  manually_overridden: boolean;
};

export function connectionFromAutoResult(result: ResolveTravelConnectionResult): ConnectionRecord {
  return {
    schedule_id: result.proposedFerryScheduleId,
    company: result.proposedCompany,
    ferry_type: result.proposedFerryType,
    departure_time: result.proposedFerryDepartureTime,
    arrival_time: result.proposedFerryArrivalTime,
    embark_port: result.proposedEmbarkPort,
    arrival_port: result.proposedArrivalPort,
    source: "auto",
    manually_overridden: false,
  };
}

/**
 * Applica un ricalcolo automatico rispettando un eventuale override manuale
 * esistente: se `current.manually_overridden` è true, il ricalcolo NON viene
 * applicato automaticamente — viene restituito insieme alla proposta per un
 * confronto esplicito lato UI, ma `current` resta l'unico valore persistito
 * finché l'operatore non conferma.
 */
export function recalculateConnection(
  current: ConnectionRecord | null,
  freshAutoResult: ResolveTravelConnectionResult
): { applied: ConnectionRecord | null; newProposal: ConnectionRecord; overriddenPreserved: boolean } {
  const newProposal = connectionFromAutoResult(freshAutoResult);
  if (current?.manually_overridden) {
    return { applied: current, newProposal, overriddenPreserved: true };
  }
  return { applied: newProposal, newProposal, overriddenPreserved: false };
}
