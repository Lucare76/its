/**
 * resolveTravelConnection — collegamento nave/aliscafo canonico per i
 * transfer treno/aereo, sia in ARRIVO che in PARTENZA.
 *
 * Pipeline (in quest'ordine, mai al contrario — gerarchia confermata da
 * Mario, audit 2026-08-28, vedi lib/server/mario-connection-policy.ts):
 *   1. policy agenzia (tipi/compagnie nave ammessi — aliscafo solo su
 *      richiesta esplicita, Sosandra inclusa)
 *   2. filtro corse non ammesse dalla policy
 *   3. compatibilità temporale (buffer CONFERMATI: treno<->nave 70/90min,
 *      nave->volo 160min; arrivo in volo = caso speciale, vedi resolveArrival)
 *   4. preferenza porto continentale Napoli > Pozzuoli (Pozzuoli solo
 *      fallback, solo pax <= pozzuoliMaxPax)
 *   5. preferenza commerciale SNAV ±30min — DISATTIVATA di default
 *      (MARIO_CONNECTION_POLICY.snavPreferenceEnabled), solo tra corse già
 *      ammesse quando riattivata
 *   6. proposta + motivazione
 *
 * Fonte dati nave: tabella reale `ferry_schedules` (mai valori statici di
 * calcPickupTime()). Margini: vedi commenti sotto — quelli non rintracciabili
 * nel repository sono etichettati esplicitamente come STIMA non confermata,
 * non vengono presentati come dato certo (non danno mai confidence ALTA).
 */

import { MARIO_CONNECTION_POLICY, type MainlandPort } from "@/lib/server/mario-connection-policy";

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
  /**
   * Pax totali del servizio/gruppo. Determina se Pozzuoli è ammessa come
   * fallback (vedi MARIO_CONNECTION_POLICY.pozzuoliMaxPax) — null/assente =
   * pax non noti, Pozzuoli NON viene proposta automaticamente per prudenza.
   */
  pax?: number | null;
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

/** Traghetto standard, per tutte le agenzie incluse Sosandra: l'aliscafo NON è più un privilegio automatico di agenzia (vedi ALISCAFO_POLICY sotto). */
const STANDARD_POLICY: AgencyPolicyDefinition = { allowedFerryTypes: ["traghetto"], allowedCompanies: null };
/** Aliscafo ammesso, usata solo quando la richiesta è esplicita (vedi explicitAliscafoRequest). */
const ALISCAFO_POLICY: AgencyPolicyDefinition = { allowedFerryTypes: ["traghetto", "aliscafo"], allowedCompanies: null };

const KNOWN_AGENCY_KEYS = ["sosandra", "aleste", "zigolo", "angelino"] as const;

/**
 * Regola confermata da Mario (audit 2026-08-28): "Sosandra → aliscafo se
 * richiesto", non più "Sosandra = aliscafo automatico". L'aliscafo è ammesso
 * SOLO quando la richiesta è esplicita al momento della prenotazione
 * (booking_service_kind con suffisso '_aliscafo', stesso segnale già usato
 * per le altre agenzie in lib/operational-connection-resolver.ts) — mai
 * dedotto automaticamente dal solo nome agenzia, Sosandra inclusa.
 */
export function resolveAgencyConnectionPolicy(
  agencyName: string | null | undefined,
  explicitAliscafoRequest = false
): ConnectionPolicyInfo & { definition: AgencyPolicyDefinition } {
  const n = (agencyName ?? "").toLowerCase();
  const definition = explicitAliscafoRequest ? ALISCAFO_POLICY : STANDARD_POLICY;
  const agencyKey: string = n.includes("sosandra") || n.includes("dimhotel") ? "sosandra"
    : n.includes("aleste") ? "aleste"
    : n.includes("zigolo") ? "zigolo"
    : n.includes("angelino") ? "angelino"
    : n || "sconosciuta";
  const source: "known" | "default" = (KNOWN_AGENCY_KEYS as readonly string[]).includes(agencyKey) ? "known" : "default";
  // Agenzia non mappata (es. "Sun & sea", null, o qualunque altra): policy
  // default conservativa, MAI aliscafo automatico anche con richiesta
  // esplicita finché non esiste una regola operativa confermata per
  // quell'agenzia — la richiesta esplicita da sola autorizza l'aliscafo solo
  // per le agenzie note.
  return {
    agencyKey,
    source,
    allowedFerryTypes: source === "known" ? definition.allowedFerryTypes : STANDARD_POLICY.allowedFerryTypes,
    definition: source === "known" ? definition : STANDARD_POLICY,
  };
}

// ---------------------------------------------------------------------------
// Porto continentale — PREFERENZA operativa confermata da Mario (audit
// 2026-08-28, vedi lib/server/mario-connection-policy.ts): Napoli è sempre
// tentata per prima, indipendentemente da compagnia/hotel/margine — Pozzuoli
// è vietata al bus per transito, quindi entra in gioco SOLO come fallback
// (nessuna corsa Napoli temporalmente valida) e solo sotto il limite pax
// (pozzuoliMaxPax). NON è più una preferenza per-compagnia né legata
// all'hotel: quella ipotesi (es. "Hotel Colella -> Ischia Porto/Napoli") non
// rappresentava la regola reale ed è stata rimossa.
// ---------------------------------------------------------------------------

type PortPreferenceCandidate = { row: Pick<FerryScheduleRow, "arrival_port" | "departure_port"> };

type PortPreferenceResult<C> = {
  pool: C[];
  appliedPort: MainlandPort | null;
  /** true se l'unico porto con candidati validi era Pozzuoli ma è stata esclusa per limite pax (nessuna soluzione automatica). */
  pozzuoliBlockedForPax: boolean;
};

/**
 * Applica la preferenza Napoli > Pozzuoli (fallback + limite pax) ai
 * candidati già temporalmente validi. `portField` seleziona il porto
 * continentale rilevante: 'arrival_port' per le partenze (Ischia -> mainland),
 * 'departure_port' per gli arrivi (mainland -> Ischia).
 */
function applyMainlandPortPreference<C extends PortPreferenceCandidate>(
  candidates: C[],
  pax: number | null,
  portField: "arrival_port" | "departure_port"
): PortPreferenceResult<C> {
  let pozzuoliBlockedForPax = false;
  for (const port of MARIO_CONNECTION_POLICY.mainlandPortPreference) {
    if (port === "pozzuoli") {
      const pozzuoliAllowed = pax != null && pax <= MARIO_CONNECTION_POLICY.pozzuoliMaxPax;
      if (!pozzuoliAllowed) {
        if (candidates.some((c) => c.row[portField] === "pozzuoli")) pozzuoliBlockedForPax = true;
        continue;
      }
    }
    const pool = candidates.filter((c) => c.row[portField] === port);
    if (pool.length > 0) return { pool, appliedPort: port, pozzuoliBlockedForPax };
  }
  // Nessun porto della lista preferenza ha candidati ammessi: eventuali
  // candidati residui su porti non censiti nella preferenza (nessuno oggi,
  // ma non si esclude a priori) restano disponibili; Pozzuoli bloccata per
  // pax non rientra mai qui.
  const pool = candidates.filter((c) => c.row[portField] !== "pozzuoli");
  return { pool, appliedPort: null, pozzuoliBlockedForPax };
}

// ---------------------------------------------------------------------------
// Margini — fonti esplicite. Quelli senza fonte nel repo sono STIME, mai
// spacciate per dato confermato (confidence non sarà mai ALTA se usate).
// ---------------------------------------------------------------------------

/** STIMA non confermata nel repo: nessuna tabella porto↔stazione/aeroporto esistente per il lato continente. Usata SOLO nel ramo arrivo-volo (nessun buffer confermato per quel caso, vedi resolveArrival). */
const MAINLAND_TRANSFER_MINUTES_ESTIMATE: Record<string, Partial<Record<ContinentPlaceType, number>>> = {
  napoli_beverello: { station: 25, airport: 40 },
  pozzuoli: { station: 20, airport: 35 },
  casamicciola: {},
  ischia_porto: {},
};

/** STIMA non confermata nel repo: tempo sbarco+ritiro bagagli aeroporto prima di poter partire verso il porto. Usata SOLO nel ramo arrivo-volo. */
const AIRPORT_BAGGAGE_MARGIN_MINUTES_ESTIMATE = 20;

/**
 * Preferenza commerciale SNAV entro questa finestra rispetto alla migliore
 * alternativa, SOLO tra le corse già ammesse dalla policy agenzia. NON
 * applicata automaticamente (vedi MARIO_CONNECTION_POLICY.snavPreferenceEnabled
 * = false): la conferma di Mario riguarda solo casi puntuali già gestiti via
 * override manuale (es. BIRAGO), non una regola commerciale globale.
 */
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

/** Applica la preferenza commerciale SNAV entro ±30min dalla migliore alternativa, SOLO tra i candidati già ammessi dalla policy e temporalmente validi. Chiamata solo se MARIO_CONNECTION_POLICY.snavPreferenceEnabled è true (oggi disattivata, vedi commento sulla costante). */
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
  const policyResolved = resolveAgencyConnectionPolicy(input.agencyName, input.bookingServiceKind.endsWith("_aliscafo"));
  const policyInfo: ConnectionPolicyInfo = { agencyKey: policyResolved.agencyKey, source: policyResolved.source, allowedFerryTypes: policyResolved.allowedFerryTypes };
  const placeType = placeTypeFromKind(input.bookingServiceKind);
  const transportMin = toMinutes(input.transportTime);
  const proposedPickupTime = input.knownPickupTime ?? null;
  const pax = input.pax ?? null;
  if (!input.knownPickupTime) {
    gaps.push("Nessun pickup noto in input: manca nel repo una tabella hotel-zona -> minuti hotel->porto indipendente da lib/departure-pickup-rules.ts; il resolver non calcola un pickup autonomo (usa getPickupRule() a monte per quello).");
  }
  if (!placeType) {
    return buildResult(null, { proposedPickupTime, marginMinutes: null, reason: `booking_service_kind '${input.bookingServiceKind}' non è treno/aereo: nessun collegamento nave da calcolare.`, confidence: "NESSUNA", candidatesEvaluated: 0, excludedByPolicy: [], policy: policyInfo, gaps });
  }

  // Buffer CONFERMATO da Mario (mario-connection-policy.ts): nave -> treno 90min, nave -> volo 160min.
  // Sostituisce interamente la vecchia stima port-specifica + margine di sicurezza generico.
  const requiredBufferMin = placeType === "station" ? MARIO_CONNECTION_POLICY.ferryToTrainMin : MARIO_CONNECTION_POLICY.ferryToFlightMin;

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

  // STEP 3: compatibilità temporale (buffer confermato), solo tra le corse già ammesse dalla policy.
  const localGaps: string[] = [];
  const requiredArrivalBy = transportMin - requiredBufferMin;
  const valid = policyAllowed.filter((c) => {
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
        : `Nessuna corsa ischia_to_mainland compatibile con l'orario treno/volo (buffer confermato ${requiredBufferMin}min) e la policy agenzia.`,
      confidence: "NESSUNA",
      candidatesEvaluated: allCandidates.length,
      excludedByPolicy,
      policy: policyInfo,
      gaps: [...gaps, ...localGaps],
    });
  }

  // STEP 3b: preferenza porto continentale Napoli > Pozzuoli (regola operativa
  // confermata: divieto transito bus a Pozzuoli). Pozzuoli ammessa solo come
  // fallback e solo con pax <= pozzuoliMaxPax.
  const { pool: rankPool, appliedPort, pozzuoliBlockedForPax } = applyMainlandPortPreference(valid, pax, "arrival_port");

  if (rankPool.length === 0) {
    return buildResult(null, {
      proposedPickupTime,
      marginMinutes: null,
      reason: pozzuoliBlockedForPax
        ? `Nessuna corsa Napoli disponibile; Pozzuoli sarebbe l'unico fallback ma esclusa perché pax ${pax ?? "non noti"} > ${MARIO_CONNECTION_POLICY.pozzuoliMaxPax} (o pax non noti): nessuna soluzione automatica, richiede verifica manuale.`
        : "Nessuna corsa compatibile con la preferenza porto continentale (Napoli/Pozzuoli).",
      confidence: "NESSUNA",
      candidatesEvaluated: allCandidates.length,
      excludedByPolicy,
      policy: policyInfo,
      gaps: [...gaps, ...localGaps],
    });
  }

  // STEP 4: "migliore" = la corsa più tardiva tra quelle valide nel pool
  // porto-preferito (arrivo più vicino al limite, margine minimo ma
  // sufficiente) — MAI la più mattutina/con margine massimo: su un orario
  // reale con corse distribuite su tutta la giornata (verificato contro
  // ferry_schedules live, caso SUORATO: scegliere la corsa con margine
  // assoluto massimo restituiva le 06:25 invece delle 10:35 attese),
  // "margine massimo" non è mai il criterio operativo giusto — si sceglie
  // sempre la corsa più a ridosso del buffer confermato, non la più libera.
  const rankKey = (c: Candidate) => c.ferryArrival;
  const best = rankPool.reduce((a, b) => (rankKey(b) > rankKey(a) ? b : a));
  const chosen = MARIO_CONNECTION_POLICY.snavPreferenceEnabled ? applySnavPreference(best, valid, rankKey) : best;

  const margin = requiredArrivalBy - chosen.ferryArrival;
  const snavPreferred = chosen !== best;

  const portLabel = appliedPort === "pozzuoli"
    ? `Pozzuoli (fallback: nessuna corsa Napoli valida, pax ${pax} <= ${MARIO_CONNECTION_POLICY.pozzuoliMaxPax})`
    : appliedPort === "napoli_beverello"
      ? "Napoli Beverello (porto continentale preferito, regola confermata)"
      : "porto continentale disponibile";
  const reason = snavPreferred
    ? `SNAV ${chosen.row.departure_time.slice(0, 5)} preferita (regola commerciale legacy, entro ±${SNAV_PREFERENCE_WINDOW_MINUTES}min dalla migliore alternativa ammessa ${best.row.company} ${best.row.departure_time.slice(0, 5)}), margine ${margin}min sul buffer confermato ${requiredBufferMin}min prima di ${input.transportTime}. Policy agenzia '${policyInfo.agencyKey}' (${policyInfo.source}).`
    : `Corsa più tardiva compatibile su ${portLabel} tra quelle ammesse dalla policy agenzia '${policyInfo.agencyKey}' (${policyInfo.source}), margine ${margin}min sul buffer confermato ${requiredBufferMin}min prima di ${input.transportTime}.`;

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
  const policyResolved = resolveAgencyConnectionPolicy(input.agencyName, input.bookingServiceKind.endsWith("_aliscafo"));
  const policyInfo: ConnectionPolicyInfo = { agencyKey: policyResolved.agencyKey, source: policyResolved.source, allowedFerryTypes: policyResolved.allowedFerryTypes };
  const placeType = placeTypeFromKind(input.bookingServiceKind);
  const transportArrivalMin = toMinutes(input.transportTime);
  const pax = input.pax ?? null;
  if (!placeType) {
    return buildResult(null, { proposedPickupTime: null, marginMinutes: null, reason: `booking_service_kind '${input.bookingServiceKind}' non è treno/aereo: nessun collegamento nave da calcolare.`, confidence: "NESSUNA", candidatesEvaluated: 0, excludedByPolicy: [], policy: policyInfo, gaps });
  }

  const localGaps: string[] = [];
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

  if (placeType === "airport") {
    // Regola confermata da Mario (nessun buffer fisso): solo corse MEDMAR da
    // Napoli, prima corsa realmente raggiungibile. Nessun fallback su
    // Pozzuoli o altre compagnie: se non esiste una Medmar/Napoli fattibile,
    // segnala "COLLEGAMENTO DA CONFERMARE" invece di inventare una soluzione.
    // La raggiungibilità usa comunque un margine STIMA (sbarco+bagagli+
    // trasferimento a Napoli): nessun numero confermato esiste per questa
    // tratta, ma senza un margine minimo la "prima corsa raggiungibile"
    // sarebbe indistinguibile da una fisicamente impossibile.
    localGaps.push(
      `Margine sbarco+bagagli+trasferimento aeroporto -> Napoli = ${AIRPORT_BAGGAGE_MARGIN_MINUTES_ESTIMATE + (MAINLAND_TRANSFER_MINUTES_ESTIMATE.napoli_beverello!.airport ?? 0)}min: STIMA non confermata nel repo (Mario non ha indicato un buffer fisso per questa tratta, solo la regola "prima Medmar da Napoli raggiungibile").`
    );
    const medmarNapoli = policyAllowed.filter(
      (c) => c.row.company.toLowerCase() === MARIO_CONNECTION_POLICY.airportArrivalPreferredCompany && c.row.departure_port === MARIO_CONNECTION_POLICY.airportArrivalPreferredPort
    );
    const earliestReachable = transportArrivalMin + AIRPORT_BAGGAGE_MARGIN_MINUTES_ESTIMATE + (MAINLAND_TRANSFER_MINUTES_ESTIMATE.napoli_beverello!.airport ?? 0);
    const valid = medmarNapoli.filter((c) => c.ferryDeparture >= earliestReachable);

    if (valid.length === 0) {
      return buildResult(null, {
        proposedPickupTime: null,
        marginMinutes: null,
        reason: "COLLEGAMENTO DA CONFERMARE — nessuna corsa MEDMAR da Napoli realmente raggiungibile dopo l'arrivo del volo (regola confermata: solo Medmar/Napoli per gli arrivi in volo, nessun fallback Pozzuoli/altra compagnia).",
        confidence: "NESSUNA",
        candidatesEvaluated: allCandidates.length,
        excludedByPolicy,
        policy: policyInfo,
        gaps: [...gaps, ...localGaps],
      });
    }

    const rankKey = (c: Candidate) => c.ferryDeparture;
    const chosen = valid.reduce((a, b) => (rankKey(b) < rankKey(a) ? b : a));
    const margin = chosen.ferryDeparture - earliestReachable;

    return buildResult(chosen, {
      proposedPickupTime: null,
      marginMinutes: margin,
      reason: `Prima corsa MEDMAR da Napoli Beverello realmente raggiungibile dopo l'arrivo volo ${input.transportTime} (regola confermata: solo Medmar/Napoli per gli arrivi in volo), margine ${margin}min sulla stima di raggiungibilità.`,
      confidence: "MEDIA", // mai ALTA: la raggiungibilità usa una stima, non un buffer confermato.
      candidatesEvaluated: allCandidates.length,
      excludedByPolicy,
      policy: policyInfo,
      gaps: [...gaps, ...localGaps],
    });
  }

  // Treno: buffer CONFERMATO da Mario (arrivo treno -> nave: 70min).
  const requiredBufferMin = MARIO_CONNECTION_POLICY.trainToFerryMin;
  const earliestReachable = transportArrivalMin + requiredBufferMin;
  const valid = policyAllowed.filter((c) => c.ferryDeparture >= earliestReachable);

  if (valid.length === 0) {
    return buildResult(null, {
      proposedPickupTime: null,
      marginMinutes: null,
      reason: `Nessuna corsa mainland_to_ischia raggiungibile dopo l'arrivo del treno (buffer confermato ${requiredBufferMin}min) con la policy agenzia.`,
      confidence: "NESSUNA",
      candidatesEvaluated: allCandidates.length,
      excludedByPolicy,
      policy: policyInfo,
      gaps: [...gaps, ...localGaps],
    });
  }

  const { pool: rankPool, appliedPort, pozzuoliBlockedForPax } = applyMainlandPortPreference(valid, pax, "departure_port");

  if (rankPool.length === 0) {
    return buildResult(null, {
      proposedPickupTime: null,
      marginMinutes: null,
      reason: pozzuoliBlockedForPax
        ? `Nessuna corsa da Napoli disponibile; Pozzuoli sarebbe l'unico fallback ma esclusa perché pax ${pax ?? "non noti"} > ${MARIO_CONNECTION_POLICY.pozzuoliMaxPax} (o pax non noti): nessuna soluzione automatica, richiede verifica manuale.`
        : "Nessuna corsa compatibile con la preferenza porto continentale (Napoli/Pozzuoli).",
      confidence: "NESSUNA",
      candidatesEvaluated: allCandidates.length,
      excludedByPolicy,
      policy: policyInfo,
      gaps: [...gaps, ...localGaps],
    });
  }

  // "Migliore" = la corsa più vicina (prima raggiungibile) tra quelle valide nel pool porto-preferito (minimizza attesa in stazione).
  const rankKey = (c: Candidate) => c.ferryDeparture;
  const best = rankPool.reduce((a, b) => (rankKey(b) < rankKey(a) ? b : a));
  const chosen = MARIO_CONNECTION_POLICY.snavPreferenceEnabled ? applySnavPreference(best, valid, rankKey) : best;

  const margin = chosen.ferryDeparture - earliestReachable;
  const snavPreferred = chosen !== best;
  const portLabel = appliedPort === "pozzuoli"
    ? `Pozzuoli (fallback: nessuna corsa da Napoli valida, pax ${pax} <= ${MARIO_CONNECTION_POLICY.pozzuoliMaxPax})`
    : appliedPort === "napoli_beverello"
      ? "Napoli Beverello (porto continentale preferito, regola confermata)"
      : "porto continentale disponibile";

  const reason = snavPreferred
    ? `SNAV ${chosen.row.departure_time.slice(0, 5)} preferita (regola commerciale legacy, entro ±${SNAV_PREFERENCE_WINDOW_MINUTES}min dalla migliore alternativa ammessa ${best.row.company} ${best.row.departure_time.slice(0, 5)}), margine ${margin}min dopo l'orario minimo raggiungibile (buffer confermato ${requiredBufferMin}min). Policy agenzia '${policyInfo.agencyKey}' (${policyInfo.source}).`
    : `Prima corsa raggiungibile da ${portLabel} dopo l'arrivo di ${input.transportTime} (buffer confermato ${requiredBufferMin}min) tra quelle ammesse dalla policy agenzia '${policyInfo.agencyKey}' (${policyInfo.source}), margine ${margin}min.`;

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
