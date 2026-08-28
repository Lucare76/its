/**
 * resolveOperationalConnection — entry point unico proposto per pickup +
 * collegamento nave/aliscafo, sia in ARRIVO che in PARTENZA.
 *
 * Sostituisce, come punto di ingresso, la competizione diretta tra:
 *   - lib/server/calc-pickup-time.ts        (tabelle TS hardcoded, no zona)
 *   - lib/departure-pickup-rules.ts         (tabelle TS hardcoded, zona-based)
 *   - lib/ferry-pickup-rules.ts + tabella DB ferry_pickup_rules (solo ARRIVO oggi)
 *   - lib/travel-connection-resolver.ts     (motore commerciale, nessuna fonte pickup propria)
 *
 * Pipeline (in quest'ordine, mai al contrario):
 *   1. regola operativa canonica (OperationalPickupRule — shape proposta per
 *      l'estensione di ferry_pickup_rules, vedi tipo sotto) per
 *      agenzia/policy + direzione + mezzo + zona + finestra oraria;
 *   2. se non c'è nessuna regola canonica -> fallback esplicito al motore
 *      legacy (resolveTravelConnection), mai una proposta "inventata";
 *   3. verifica che la corsa proposta esista realmente in ferry_schedules
 *      per la data richiesta — se manca, la proposta resta ma con warning
 *      esplicito, mai una sostituzione silenziosa;
 *   4. override manuale (Mario) sempre preservato — mai sovrascritto da un
 *      ricalcolo automatico senza conferma esplicita.
 *
 * NB: questo file non scrive né legge dal DB. I chiamanti passano le righe
 * già caricate (stesso pattern già usato da resolveTravelConnection), così
 * la funzione resta pura e testabile senza mock di rete/DB.
 */

import {
  resolveAgencyConnectionPolicy,
  resolveTravelConnection,
  connectionFromAutoResult,
  type FerryScheduleRow,
  type ConnectionRecord,
  type FerryType,
  type ConnectionConfidence,
} from "@/lib/travel-connection-resolver";

export type OperationalDirection = "to_ischia" | "from_ischia";

/**
 * Shape PROPOSTA per l'estensione della tabella DB ferry_pickup_rules
 * (oggi copre solo ARRIVO / to_ischia — vedi report). Aggiunge rispetto allo
 * schema attuale: `direction`, `zone` (nullable = tutte le zone), `pickup_time`
 * (nullable, ha senso solo per from_ischia), `embark_port` (nullable, ha senso
 * solo per from_ischia — il porto di partenza barca da Ischia).
 */
export type OperationalPickupRule = {
  id?: string;
  agency_logic: "aleste" | "sosandra";
  transport_type: "train" | "flight";
  direction: OperationalDirection;
  boat_type: "traghetto" | "aliscafo";
  /**
   * null = non specifica per hotel (regola di zona o generale). Se valorizzato,
   * batte sempre una regola di zona/generale per lo stesso hotel (vedi
   * findCanonicalRule). FK verso hotels.id nello schema DB proposto.
   */
  hotel_id: string | null;
  /** null = si applica a qualunque zona hotel (jolly). Ignorato se hotel_id e' valorizzato e fa match diretto. */
  zone: string | null;
  /** Finestra oraria del treno/volo entro cui la regola si applica. */
  transport_from: string;
  transport_to: string;
  company: string;
  /** Orario di partenza della nave. */
  departure_time: string;
  /** Porto di imbarco su Ischia — significativo solo per direction='from_ischia'. */
  embark_port: string | null;
  /** Porto di arrivo della nave (Ischia per to_ischia, continente per from_ischia). */
  arrival_port: string;
  arrival_time: string | null;
  /** Orario di prelievo hotel — significativo solo per direction='from_ischia'. */
  pickup_time: string | null;
  valid_from: string | null;
  valid_to: string | null;
  days_of_week: number[] | null;
};

export type OperationalConnectionInput = {
  direction: OperationalDirection;
  bookingServiceKind: string;
  /** Orario treno/volo (partenza per from_ischia, arrivo per to_ischia), HH:MM. */
  transportTime: string;
  date: string; // YYYY-MM-DD
  /** ID hotel (hotels.id), quando noto. Abilita il match di Livello 1 (hotel-specifico). Solo from_ischia. */
  hotelId?: string | null;
  /**
   * Zona hotel normalizzata (ischia | forio | lacco | casamicciola). Solo from_ischia.
   * Se `zoneRecognized` e' false, il valore qui e' comunque quello grezzo/derivato ma
   * NON viene usato per il match di Livello 2 (vedi sotto) — il caller deve calcolare
   * la normalizzazione a monte e dichiarare esplicitamente se e' affidabile.
   */
  zone?: string | null;
  /**
   * false quando la zona hotel non è tra i valori canonici riconosciuti
   * (es. "Serrara Fontana", stringa vuota, valore non mappato). Se false, il
   * resolver NON esegue mai un fallback silenzioso su "ischia": salta il
   * Livello 2 (zona) e prova solo Livello 1 (hotel) e Livello 3 (generale),
   * segnalando sempre UNKNOWN_HOTEL_ZONE nei warning. Default true per
   * compatibilità con chi non passa ancora questo campo.
   */
  zoneRecognized?: boolean;
  agencyName?: string | null;
  operationalRules: OperationalPickupRule[];
  ferrySchedules: FerryScheduleRow[];
  /** Override manuale già confermato per questo servizio, se presente. */
  currentOverride?: ConnectionRecord | null;
  /** Pax totali del servizio/gruppo — usato dal fallback legacy per il limite Pozzuoli (vedi mario-connection-policy.ts). */
  pax?: number | null;
};

export type OperationalConnectionSource = "canonical_rule" | "legacy_fallback" | "manual_override";

export type OperationalConnectionResult = {
  pickupTime: string | null;
  ferryScheduleId: string | null;
  company: string | null;
  ferryType: FerryType | null;
  ferryDepartureTime: string | null;
  ferryArrivalTime: string | null;
  embarkPort: string | null;
  arrivalPort: string | null;
  source: OperationalConnectionSource;
  confidence: ConnectionConfidence;
  warnings: string[];
  /** Presente solo se un ricalcolo produce una proposta diversa dall'override applicato. */
  newProposal?: OperationalConnectionResult;
};

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.slice(0, 5).split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function isRuleActiveOnDate(rule: OperationalPickupRule, isoDate: string): boolean {
  if (rule.valid_from && isoDate < rule.valid_from) return false;
  if (rule.valid_to && isoDate > rule.valid_to) return false;
  if (rule.days_of_week?.length) {
    const dow = new Date(`${isoDate}T12:00:00`).getDay();
    if (!rule.days_of_week.includes(dow)) return false;
  }
  return true;
}

function placeTypeFromKind(kind: string): "train" | "flight" | null {
  if (kind.includes("train")) return "train";
  if (kind.includes("flight") || kind.includes("airport")) return "flight";
  return null;
}

function ferryTypeFor(boatType: "traghetto" | "aliscafo"): FerryType {
  return boatType;
}

/**
 * Trova la regola canonica per lo scenario. Match: agency_logic + direction +
 * transport_type + boat_type ammesso + orario nel range + attiva alla data,
 * più la gerarchia a 3 livelli hotel > zona > generale:
 *
 *   Livello 1 — HOTEL:   r.hotel_id === args.hotelId (match esatto, richiede hotelId noto)
 *   Livello 2 — ZONA:    r.hotel_id === null && r.zone === args.zone
 *                         (mai considerato se args.zoneRecognized === false: niente
 *                         fallback silenzioso su una zona non canonica)
 *   Livello 3 — GENERALE: r.hotel_id === null && r.zone === null (jolly)
 *
 * Una regola di Livello 1 batte SEMPRE una di Livello 2/3 per lo stesso
 * scenario, indipendentemente da valid_from — la specificità hotel ha
 * priorità sulla recency. A parità di livello, vince valid_from più recente
 * (stessa logica di findFerryPickupRule), poi la fascia oraria più stretta.
 */
function findCanonicalRule(
  rules: OperationalPickupRule[],
  args: {
    agencyLogic: "aleste" | "sosandra";
    direction: OperationalDirection;
    transportType: "train" | "flight";
    allowedBoatTypes: Array<"traghetto" | "aliscafo">;
    hotelId: string | null;
    zone: string | null;
    zoneRecognized: boolean;
    transportTime: string;
    date: string;
  }
): OperationalPickupRule | null {
  const t = toMinutes(args.transportTime);
  const baseMatch = (r: OperationalPickupRule) => {
    if (r.agency_logic !== args.agencyLogic) return false;
    if (r.direction !== args.direction) return false;
    if (r.transport_type !== args.transportType) return false;
    if (!args.allowedBoatTypes.includes(r.boat_type)) return false;
    if (t < toMinutes(r.transport_from) || t > toMinutes(r.transport_to)) return false;
    return isRuleActiveOnDate(r, args.date);
  };

  const specificity = (r: OperationalPickupRule): 1 | 2 | 3 | 0 => {
    if (r.hotel_id != null) return r.hotel_id === args.hotelId ? 1 : 0;
    if (r.zone != null) return args.zoneRecognized && r.zone === args.zone ? 2 : 0;
    return 3; // hotel_id null + zone null = generale, jolly universale
  };

  const matches = rules
    .filter(baseMatch)
    .map((r) => ({ r, level: specificity(r) }))
    .filter((m) => m.level !== 0);

  if (matches.length === 0) return null;

  const bestLevel = Math.min(...matches.map((m) => m.level));
  const atBestLevel = matches.filter((m) => m.level === bestLevel);

  return atBestLevel.sort((a, b) => {
    const widthA = toMinutes(a.r.transport_to) - toMinutes(a.r.transport_from);
    const widthB = toMinutes(b.r.transport_to) - toMinutes(b.r.transport_from);
    if (widthA !== widthB) return widthA - widthB; // fascia più stretta vince
    const af = a.r.valid_from ?? "0000-00-00";
    const bf = b.r.valid_from ?? "0000-00-00";
    return bf.localeCompare(af);
  })[0]!.r;
}

/** Verifica che la corsa proposta esista davvero in ferry_schedules per la data. */
function verifyScheduleExists(
  rule: OperationalPickupRule,
  direction: OperationalDirection,
  ferrySchedules: FerryScheduleRow[],
  date: string
): FerryScheduleRow | null {
  const expectedDirection = direction === "from_ischia" ? "ischia_to_mainland" : "mainland_to_ischia";
  return (
    ferrySchedules.find((s) => {
      if (s.direction !== expectedDirection) return false;
      if (s.company.toLowerCase() !== rule.company.toLowerCase()) return false;
      if (s.departure_time.slice(0, 5) !== rule.departure_time.slice(0, 5)) return false;
      if (rule.embark_port && s.departure_port !== rule.embark_port) return false;
      if (s.arrival_port !== rule.arrival_port) return false;
      if (s.valid_from && date < s.valid_from) return false;
      if (s.valid_to && date > s.valid_to) return false;
      if (s.days_of_week?.length) {
        const dow = new Date(`${date}T12:00:00`).getDay();
        if (!s.days_of_week.includes(dow)) return false;
      }
      return true;
    }) ?? null
  );
}

function fromCanonicalRule(
  rule: OperationalPickupRule,
  matchedSchedule: FerryScheduleRow | null
): OperationalConnectionResult {
  const warnings: string[] = [];
  if (!matchedSchedule) {
    warnings.push(
      `⚠ CORSA CONFIGURATA NON DISPONIBILE: ${rule.company.toUpperCase()} ${rule.departure_time.slice(0, 5)} ` +
        `${rule.embark_port ?? "?"} → ${rule.arrival_port} non risulta in ferry_schedules per questa data. ` +
        `Proposta mantenuta dalla regola configurata, nessuna sostituzione automatica.`
    );
  }
  return {
    pickupTime: rule.pickup_time,
    ferryScheduleId: matchedSchedule?.id ?? null,
    company: rule.company,
    ferryType: ferryTypeFor(rule.boat_type),
    ferryDepartureTime: rule.departure_time.slice(0, 5),
    ferryArrivalTime: (matchedSchedule?.arrival_time ?? rule.arrival_time)?.slice(0, 5) ?? null,
    embarkPort: rule.embark_port ?? matchedSchedule?.departure_port ?? null,
    arrivalPort: rule.arrival_port,
    source: "canonical_rule",
    confidence: matchedSchedule ? "ALTA" : "BASSA",
    warnings,
  };
}

function fromLegacyFallback(
  input: OperationalConnectionInput,
  agencyLogic: "aleste" | "sosandra"
): OperationalConnectionResult {
  const legacy = resolveTravelConnection({
    direction: input.direction === "from_ischia" ? "departure" : "arrival",
    bookingServiceKind: input.bookingServiceKind,
    transportTime: input.transportTime,
    date: input.date,
    ferrySchedules: input.ferrySchedules,
    agencyName: input.agencyName,
    knownPickupTime: null,
    pax: input.pax ?? null,
  });
  const warnings = [
    `⚠ Nessuna regola canonica configurata per questa fascia (agency_logic='${agencyLogic}', ` +
      `direction='${input.direction}', zona='${input.zone ?? "?"}', orario='${input.transportTime}'). ` +
      `Proposta calcolata dal motore legacy (preferenze commerciali su ferry_schedules), pickup non disponibile finché la regola non viene configurata.`,
    ...legacy.gaps,
  ];
  return {
    pickupTime: legacy.proposedPickupTime,
    ferryScheduleId: legacy.proposedFerryScheduleId,
    company: legacy.proposedCompany,
    ferryType: legacy.proposedFerryType,
    ferryDepartureTime: legacy.proposedFerryDepartureTime,
    ferryArrivalTime: legacy.proposedFerryArrivalTime,
    embarkPort: legacy.proposedEmbarkPort,
    arrivalPort: legacy.proposedArrivalPort,
    source: "legacy_fallback",
    confidence: legacy.confidence === "NESSUNA" ? "NESSUNA" : "BASSA",
    warnings,
  };
}

export function resolveOperationalConnection(input: OperationalConnectionInput): OperationalConnectionResult {
  const policy = resolveAgencyConnectionPolicy(input.agencyName);
  const agencyLogic: "aleste" | "sosandra" = policy.agencyKey === "sosandra" ? "sosandra" : "aleste";
  const transportType = placeTypeFromKind(input.bookingServiceKind);

  let proposal: OperationalConnectionResult;
  if (!transportType) {
    proposal = {
      pickupTime: null,
      ferryScheduleId: null,
      company: null,
      ferryType: null,
      ferryDepartureTime: null,
      ferryArrivalTime: null,
      embarkPort: null,
      arrivalPort: null,
      source: "legacy_fallback",
      confidence: "NESSUNA",
      warnings: [`booking_service_kind '${input.bookingServiceKind}' non è treno/aereo: nessun collegamento da calcolare.`],
    };
  } else {
    // La regola canonica (DB, ferry_pickup_rules) porta gia' il proprio
    // agency_logic ed e' gia' filtrata su quello in findCanonicalRule
    // (baseMatch: r.agency_logic !== args.agencyLogic -> scartata) — ma
    // "esiste una regola configurata" NON basta da sola ad autorizzare
    // l'aliscafo, Sosandra inclusa (regola confermata da Mario, audit
    // 2026-08-28: "Sosandra → aliscafo SE richiesto", non più automatico per
    // agenzia — vedi lib/server/mario-connection-policy.ts). Serve un segnale
    // esplicito di richiesta al momento della prenotazione. Fonte verificata
    // nel modello dati: booking_service_kind con suffisso '_aliscafo'
    // (transfer_train_hotel_aliscafo / transfer_airport_hotel_aliscafo) —
    // opzione selezionabile esplicitamente sia nel form agenzia
    // (agency/new-booking/page.tsx) sia in quello operatore (services/new/
    // page.tsx), distinta dal kind generico (default traghetto). Nessun altro
    // campo strutturato equivalente esiste (transport_code/notes sono testo
    // libero). L'aliscafo entra tra i tipi ammessi SOLO se il servizio lo
    // richiede esplicitamente, per qualunque agenzia — la regola canonica
    // resta comunque necessaria (una richiesta esplicita senza regola
    // configurata cade nel fallback legacy, mai un'invenzione).
    const explicitAliscafoRequest = input.bookingServiceKind.endsWith("_aliscafo");
    const allowedBoatTypes: Array<"traghetto" | "aliscafo"> =
      explicitAliscafoRequest ? ["traghetto", "aliscafo"] : ["traghetto"];

    const zoneRecognized = input.zoneRecognized ?? true;
    const rule = findCanonicalRule(input.operationalRules, {
      agencyLogic,
      direction: input.direction,
      transportType,
      allowedBoatTypes,
      hotelId: input.hotelId ?? null,
      zone: input.zone ?? null,
      zoneRecognized,
      transportTime: input.transportTime,
      date: input.date,
    });

    if (rule) {
      const matchedSchedule = verifyScheduleExists(rule, input.direction, input.ferrySchedules, input.date);
      proposal = fromCanonicalRule(rule, matchedSchedule);
    } else {
      proposal = fromLegacyFallback(input, agencyLogic);
    }
    if (!zoneRecognized) {
      proposal = {
        ...proposal,
        warnings: [
          `⚠ UNKNOWN_HOTEL_ZONE: zona '${input.zone ?? "(vuota)"}' non è tra i valori canonici riconosciuti ` +
            `(ischia | forio | lacco | casamicciola). Nessun fallback silenzioso su 'ischia': sono state valutate ` +
            `solo regole hotel-specifiche o generali (senza zona).`,
          ...proposal.warnings,
        ],
      };
    }
  }

  if (input.currentOverride?.manually_overridden) {
    const override = input.currentOverride;
    return {
      pickupTime: proposal.pickupTime, // il pickup non fa parte di ConnectionRecord: resta quello ricalcolato
      ferryScheduleId: override.schedule_id,
      company: override.company,
      ferryType: override.ferry_type,
      ferryDepartureTime: override.departure_time,
      ferryArrivalTime: override.arrival_time,
      embarkPort: override.embark_port,
      arrivalPort: override.arrival_port,
      source: "manual_override",
      confidence: "ALTA",
      warnings: [`Override manuale confermato: il ricalcolo automatico non lo sovrascrive. Nuova proposta disponibile in 'newProposal' per confronto esplicito.`],
      newProposal: proposal,
    };
  }

  return proposal;
}

/** Costruisce un ConnectionRecord persistibile da una proposta canonica, per riuso con recalculateConnection(). */
export function operationalResultToConnectionRecord(result: OperationalConnectionResult): ConnectionRecord {
  return {
    schedule_id: result.ferryScheduleId,
    company: result.company,
    ferry_type: result.ferryType,
    departure_time: result.ferryDepartureTime,
    arrival_time: result.ferryArrivalTime,
    embark_port: result.embarkPort,
    arrival_port: result.arrivalPort,
    source: result.source === "manual_override" ? "manual" : "auto",
    manually_overridden: result.source === "manual_override",
  };
}

// re-export per comodità dei call-site che migrano dal motore legacy
export { connectionFromAutoResult };
