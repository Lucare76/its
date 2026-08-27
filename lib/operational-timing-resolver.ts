/**
 * resolveOperationalTiming — entry point unico per la situazione temporale
 * operativa di un servizio (pickup, nave/aliscafo, treno/volo).
 *
 * NON è un nuovo motore di calcolo. È un orchestratore che, per ogni
 * servizio, sceglie quale fonte già esistente interrogare e restituisce un
 * risultato uniforme con provenienza esplicita (persisted / canonical_rule /
 * legacy_fallback / manual_override / best_effort / missing) — vedi audit in
 * fondo al file per la mappa completa delle fonti pre-esistenti e perché non
 * sono state duplicate qui.
 *
 * Pipeline (in quest'ordine, mai al contrario):
 *   1. Se il servizio è un vero transfer treno/volo (booking_service_kind
 *      transfer_train_hotel / transfer_airport_hotel, incluse le varianti) E il chiamante passa un
 *      `context` con le regole/orari necessari (operationalRules +
 *      ferrySchedules) -> resolveOperationalConnection() (già esistente,
 *      lib/operational-connection-resolver.ts). È la fonte più autorevole
 *      quando disponibile: regola canonica DB (ferry_pickup_rules) o, in
 *      mancanza, motore commerciale legacy, con override manuale sempre
 *      preservato.
 *   2. Altrimenti (Formula SNAV/MEDMAR dirette, porto-porto puro, o nessun
 *      context passato) -> lettura dei dati già persistiti/derivabili dal
 *      servizio stesso, riusando ESATTAMENTE le funzioni già scritte e
 *      testate per la stampa Piano del Giorno (lib/piano-giorno-print.ts):
 *      resolveOperationalPickup (pickup_hotel -> pickup_time -> mancante),
 *      resolveCompany + parseVesselTime (compagnia/ora nave da vessel/kind),
 *      readablePort (porto, mai barca_compagnia interpretato come compagnia).
 *   3. Se nessuna fonte produce un pickup determinabile: pickupTime resta
 *      null, status 'warning' (o 'error' se il servizio richiede
 *      esplicitamente un pickup e non c'è alcun dato utilizzabile), mai un
 *      orario inventato — in particolare mai '00:00' come sostituto di un
 *      dato mancante.
 *
 * Cosa NON fa: non ricalcola le ferry_schedules, non duplica le tabelle
 * calc-pickup-time.ts/departure-pickup-rules.ts/ferry_pickup_rules, non
 * tocca la classificazione ARRIVI/PARTENZE/NAVETTE/ESCURSIONI
 * (getOperationalDayCategory / buildOperationalInstances restano invariati).
 */
import {
  resolveOperationalConnection,
  type OperationalConnectionInput,
  type OperationalConnectionResult,
} from "@/lib/operational-connection-resolver";
import {
  resolveOperationalPickup as readPersistedPickup,
  resolveCompany,
  parseVesselTime,
  readablePort,
  fmtTime,
  type PrintService,
} from "@/lib/piano-giorno-print";

export type OperationalTimingConnectionType = "flight" | "train" | "ferry" | null;

export type OperationalTimingPickupSource =
  | "pickup_hotel"
  | "pickup_time"
  | "canonical_rule"
  | "legacy_fallback"
  | "manual_override"
  | "missing";

export type OperationalTimingResult = {
  pickupTime: string | null;
  pickupSource: OperationalTimingPickupSource;
  ferryTime: string | null;
  ferryCompany: string | null;
  ferryPort: string | null;
  connectionTime: string | null;
  connectionType: OperationalTimingConnectionType;
  ruleSource: string | null;
  status: "ok" | "warning" | "error";
  warnings: string[];
};

/**
 * Contesto opzionale per il Livello 1 (resolveOperationalConnection). Se
 * omesso, il resolver salta direttamente al Livello 2 (dati persistiti) —
 * comportamento valido e atteso per porto-porto puro / Formula dirette, dove
 * questo contesto non ha senso (vedi docstring del file).
 */
export type OperationalTimingContext = Pick<
  OperationalConnectionInput,
  "operationalRules" | "ferrySchedules" | "hotelId" | "zone" | "zoneRecognized" | "agencyName" | "currentOverride"
>;

const TRAIN_KINDS = new Set(["transfer_train_hotel", "transfer_train_hotel_exclusive", "transfer_train_hotel_aliscafo"]);
const AIRPORT_KINDS = new Set(["transfer_airport_hotel", "transfer_airport_hotel_exclusive", "transfer_airport_hotel_aliscafo"]);

export function connectionTypeFromKind(kind: string | null | undefined): OperationalTimingConnectionType {
  if (!kind) return null;
  if (TRAIN_KINDS.has(kind)) return "train";
  if (AIRPORT_KINDS.has(kind)) return "flight";
  if (kind.startsWith("formula_") || kind === "transfer_port_hotel") return "ferry";
  return null;
}

function fromConnectionResult(
  result: OperationalConnectionResult,
  connectionType: OperationalTimingConnectionType,
  connectionTime: string | null
): OperationalTimingResult {
  const pickupSource: OperationalTimingPickupSource =
    result.source === "canonical_rule" ? "canonical_rule"
      : result.source === "manual_override" ? "manual_override"
      : result.pickupTime ? "legacy_fallback" : "missing";
  const ruleSource =
    result.source === "canonical_rule" ? "ferry_pickup_rules (regola canonica)"
      : result.source === "manual_override" ? "override manuale confermato"
      : "travel-connection-resolver (fallback legacy, nessuna regola canonica configurata)";
  const status: OperationalTimingResult["status"] =
    result.confidence === "NESSUNA" ? "warning" : result.warnings.length > 0 ? "warning" : "ok";
  return {
    pickupTime: result.pickupTime,
    pickupSource,
    ferryTime: result.ferryDepartureTime,
    ferryCompany: result.company,
    ferryPort: result.embarkPort,
    connectionTime,
    connectionType,
    ruleSource,
    status,
    warnings: result.warnings,
  };
}

/** Livello 2: nessun context — legge solo dati già persistiti/derivabili sul servizio stesso. */
function fromPersistedData(service: PrintService, connectionType: OperationalTimingConnectionType): OperationalTimingResult {
  const pickup = readPersistedPickup(service);
  const company = resolveCompany(service);
  const ferryTime =
    service.direction === "departure"
      ? fmtTime(service.orario_barca)
      : parseVesselTime(service.vessel);
  const ferryPort =
    service.direction === "departure"
      ? readablePort(service.barca_compagnia) ?? readablePort(service.meeting_point)
      : readablePort(service.porto_bruno) ?? readablePort(service.meeting_point);

  const warnings: string[] = [];
  if (pickup.source === "missing") {
    warnings.push("Pickup non determinabile dai dati persistiti (pickup_hotel/pickup_time assenti).");
  }

  return {
    pickupTime: pickup.source === "missing" ? null : pickup.value,
    pickupSource: pickup.source === "missing" ? "missing" : pickup.source,
    ferryTime,
    ferryCompany: company,
    ferryPort,
    connectionTime: null,
    connectionType,
    ruleSource: pickup.source === "missing" ? null : `services.${pickup.source} (dato persistito)`,
    status: pickup.source === "missing" ? "warning" : "ok",
    warnings,
  };
}

/**
 * Entry point unico. `service` accetta lo stesso shape già usato dalla
 * stampa Piano del Giorno (PrintService = Service & PianoDisplayService) —
 * nessun nuovo tipo di servizio introdotto. `context` è opzionale: se
 * fornito e il servizio è un vero transfer treno/volo, abilita il Livello 1
 * (resolveOperationalConnection); altrimenti si usa solo il Livello 2.
 */
export function resolveOperationalTiming(service: PrintService, context?: OperationalTimingContext): OperationalTimingResult {
  const connectionType = connectionTypeFromKind(service.booking_service_kind);
  const direction = service.direction === "arrival" ? "arrival" : "departure";

  if ((connectionType === "train" || connectionType === "flight") && context && direction === "departure") {
    const connectionTimeRaw = fmtTime(service.departure_time) ?? fmtTime(service.time);
    if (connectionTimeRaw) {
      const result = resolveOperationalConnection({
        direction: "from_ischia",
        bookingServiceKind: service.booking_service_kind ?? "",
        transportTime: connectionTimeRaw,
        date: service.date ?? "",
        hotelId: context.hotelId,
        zone: context.zone,
        zoneRecognized: context.zoneRecognized,
        agencyName: context.agencyName ?? service.billing_party_name,
        operationalRules: context.operationalRules,
        ferrySchedules: context.ferrySchedules,
        currentOverride: context.currentOverride,
      });
      return fromConnectionResult(result, connectionType, connectionTimeRaw);
    }
  }
  if ((connectionType === "train" || connectionType === "flight") && context && direction === "arrival") {
    const connectionTimeRaw = fmtTime(service.arrival_time) ?? fmtTime(service.time);
    if (connectionTimeRaw) {
      const result = resolveOperationalConnection({
        direction: "to_ischia",
        bookingServiceKind: service.booking_service_kind ?? "",
        transportTime: connectionTimeRaw,
        date: service.date ?? "",
        agencyName: context.agencyName ?? service.billing_party_name,
        operationalRules: context.operationalRules,
        ferrySchedules: context.ferrySchedules,
        currentOverride: context.currentOverride,
      });
      return fromConnectionResult(result, connectionType, connectionTimeRaw);
    }
  }

  return fromPersistedData(service, connectionType);
}
