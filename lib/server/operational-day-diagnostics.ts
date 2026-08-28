/**
 * diagnoseOperationalDay — "Diagnostica Giornata": livello di controllo
 * READ-ONLY sopra i dati gia' esistenti di una giornata operativa. Non e' una
 * nuova fonte di verita': ogni giudizio deriva da un resolver/helper gia'
 * esistente e testato altrove — questa funzione si limita a INTERPRETARE i
 * risultati (status/source/warnings) e a decidere severity/testo per
 * l'operatore. Nessun ricalcolo di pickup/ferry/agenzia/_aliscafo qui.
 *
 * Riusa (mai duplicato):
 *  - resolveOperationalTiming() / connectionTypeFromKind() — pickup, nave,
 *    fallback statico, regola canonica, _aliscafo (lib/operational-timing-resolver.ts).
 *  - buildBusUnitLoadSummary() — capienza bus rete (lib/server/bus-network.ts).
 *  - buildBusLotAggregates() — capienza lotti Linea Bus/Escursioni (lib/bus-lot-utils.ts).
 *  - EXCLUDED_STATUSES (lib/server/operational-health/operations-health.ts) —
 *    stessa nozione di "servizio cancellato" gia' usata da sla-check.
 *
 * Deliberatamente FUORI SCOPE (vedi report task): "confirmed senza
 * assignment = errore" — regola non valida per tutti i tipi servizio, e gia'
 * coperta da un controllo dedicato e piu' accurato in
 * lib/server/operational-health/operations-health.ts
 * (evaluateImminentUnassignedServices). Non duplicato qui.
 *
 * Zero query interne: riceve tutti i dati della giornata gia' caricati in
 * batch dal chiamante (vedi app/api/ops/diagnostics/route.ts) e lavora solo
 * con Map/Set in memoria — pensata per ~400 servizi/giorno senza N+1.
 */
import {
  resolveOperationalTiming,
  connectionTypeFromKind,
  type OperationalTimingContext,
  type OperationalTimingResult,
} from "@/lib/operational-timing-resolver";
import type { PrintService } from "@/lib/piano-giorno-print";
import type { OperationalPickupRule } from "@/lib/operational-connection-resolver";
import type { FerryScheduleRow } from "@/lib/travel-connection-resolver";
import { buildBusUnitLoadSummary, type RawBusUnit } from "@/lib/server/bus-network";
import { buildBusLotAggregates } from "@/lib/bus-lot-utils";
import type { BusLotConfig } from "@/lib/types";

export type DayDiagnosticSeverity = "info" | "warning" | "error";

export type DayDiagnosticIssue = {
  serviceId?: string;
  severity: DayDiagnosticSeverity;
  code: string;
  title: string;
  message: string;
  category: string;
  source?: string;
  /** Cause derivate/ridondanti raccolte sotto lo stesso issue principale (vedi §13 dedup) — mai issue duplicati per la stessa causa. */
  details?: string[];
};

export type DayDiagnosticResult = {
  totalServices: number;
  okServices: number;
  warningServices: number;
  errorServices: number;
  issues: DayDiagnosticIssue[];
};

export type DiagnosticsHotelRow = { id: string; name: string; zone: string | null };
export type DiagnosticsAssignmentRow = { service_id: string; driver_user_id: string | null };
/**
 * Riga minima di un servizio collegato (linked_service_id) FUORI dalla
 * giornata caricata (es. andata 28/08 -> ritorno 04/09). Caricata dal
 * chiamante con un'unica query batch IN(...) sui soli id esterni al giorno
 * (vedi app/api/ops/diagnostics/route.ts) — mai una query per riga. Sufficiente
 * per verificare esistenza + reciprocita' del legame senza considerare
 * anomala la sola differenza di data tra andata e ritorno.
 */
export type DiagnosticsLinkedServiceRef = {
  id: string;
  linked_service_id: string | null;
  date: string;
  direction: string | null;
  status: string;
};
export type DiagnosticsBusAllocationRow = {
  id: string;
  service_id: string;
  bus_line_id: string;
  bus_unit_id: string;
  stop_id: string | null;
  stop_name: string;
  direction: "arrival" | "departure";
  pax_assigned: number;
  notes: string | null;
};

const CANCELLED_STATUSES = new Set(["cancelled", "pending_cancellation"]);
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export type OperationalDayDiagnosticsInput = {
  date: string;
  services: PrintService[];
  hotelsById: Map<string, DiagnosticsHotelRow>;
  operationalRules: OperationalPickupRule[];
  ferrySchedules: FerryScheduleRow[];
  assignments: DiagnosticsAssignmentRow[];
  busUnits: RawBusUnit[];
  busAllocations: DiagnosticsBusAllocationRow[];
  busLotConfigs: BusLotConfig[];
  /**
   * Righe (thin) dei linked_service_id che puntano FUORI dalla giornata
   * caricata, gia' recuperate dal chiamante con un'unica query batch — mai
   * una query per riga. Un id richiesto ma assente da questo array e' un
   * linked_service_id inesistente (BROKEN_LINKED_SERVICE). Questo motore
   * resta puro e non tocca mai il DB.
   */
  externalLinkedServices?: DiagnosticsLinkedServiceRef[];
};

function normalizeName(value: string | null | undefined): string {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function requiresHotelLeg(kind: string | null | undefined): boolean {
  return kind !== "excursion" && kind != null;
}

function buildTimingContext(
  service: PrintService,
  hotelsById: Map<string, DiagnosticsHotelRow>,
  operationalRules: OperationalPickupRule[],
  ferrySchedules: FerryScheduleRow[]
): OperationalTimingContext {
  const hotel = service.hotel_id ? hotelsById.get(service.hotel_id) ?? null : null;
  const zoneRecognized = /forio|lacco|casamicciola|barano|ischia/.test((hotel?.zone ?? "").toLowerCase());
  return {
    operationalRules,
    ferrySchedules,
    hotelId: service.hotel_id ?? null,
    zone: hotel?.zone ?? null,
    zoneRecognized,
    agencyName: service.billing_party_name ?? null,
  };
}

function pushIssue(bucket: Map<string, DayDiagnosticIssue>, issue: DayDiagnosticIssue) {
  const key = `${issue.serviceId ?? "day"}:${issue.code}`;
  if (bucket.has(key)) return; // stessa causa/codice per lo stesso servizio: mai duplicato (§13)
  bucket.set(key, issue);
}

/** true se il servizio ha gia' un issue di dominio pickup (per evitare IMPORT_WARNING ridondanti, §13). */
function servicePickupCodes(issues: Map<string, DayDiagnosticIssue>, serviceId: string): boolean {
  const pickupCodes = ["MISSING_PICKUP", "HYDROFOIL_RULE_MISSING", "LEGACY_STATIC_PICKUP", "MISSING_CANONICAL_RULE"];
  return pickupCodes.some((code) => issues.has(`${serviceId}:${code}`));
}

function diagnosePickupAndFerry(
  service: PrintService,
  timing: OperationalTimingResult,
  connectionType: ReturnType<typeof connectionTypeFromKind>,
  bucket: Map<string, DayDiagnosticIssue>
) {
  if (connectionType == null) return;
  const isHydrofoilKind = (service.booking_service_kind ?? "").endsWith("_aliscafo");
  const label = service.practice_number ?? service.customer_name ?? service.id;

  if (!timing.pickupTime) {
    if (isHydrofoilKind && timing.status === "warning") {
      pushIssue(bucket, {
        serviceId: service.id,
        severity: "warning",
        code: "HYDROFOIL_RULE_MISSING",
        title: "Aliscafo richiesto senza regola disponibile",
        message: `${label}: aliscafo richiesto esplicitamente ma nessuna regola canonica ne' fallback statico applicabile. ${timing.warnings.join(" ")}`.trim(),
        category: "pickup",
        source: timing.ruleSource ?? undefined,
      });
      return;
    }
    pushIssue(bucket, {
      serviceId: service.id,
      severity: "error",
      code: "MISSING_PICKUP",
      title: "Pickup mancante",
      message: `${label}: pickup non determinabile (${timing.warnings.join(" ") || "nessuna fonte disponibile"}).`,
      category: "pickup",
      source: timing.ruleSource ?? undefined,
    });
    return;
  }

  if (timing.pickupSource === "legacy_static") {
    pushIssue(bucket, {
      serviceId: service.id,
      severity: "warning",
      code: "LEGACY_STATIC_PICKUP",
      title: "Pickup da fallback statico",
      message: "Pickup derivato dal fallback statico: nessuna regola canonica applicabile.",
      category: "pickup",
      source: timing.ruleSource ?? undefined,
    });
  } else if ((connectionType === "train" || connectionType === "flight") && timing.pickupSource === "legacy_fallback") {
    pushIssue(bucket, {
      serviceId: service.id,
      severity: "warning",
      code: "MISSING_CANONICAL_RULE",
      title: "Nessuna regola canonica",
      message: `${label}: connessione nave risolta dal motore commerciale legacy, nessuna regola ferry_pickup_rules configurata per questa fascia.`,
      category: "pickup",
      source: timing.ruleSource ?? undefined,
    });
  }

  // Nave/collegamento: sub-controlli solo quando la connessione risulta
  // effettivamente risolta (canonical_rule/manual_override/legacy_fallback) —
  // per legacy_static la tabella statica non ha mai dati nave reali (atteso,
  // gia' segnalato sopra), non e' un'anomalia aggiuntiva.
  if ((connectionType === "train" || connectionType === "flight") && ["canonical_rule", "manual_override", "legacy_fallback"].includes(timing.pickupSource)) {
    if (!timing.ferryCompany) {
      pushIssue(bucket, {
        serviceId: service.id,
        severity: "warning",
        code: "FERRY_COMPANY_MISSING",
        title: "Compagnia nave mancante",
        message: `${label}: connessione risolta ma senza compagnia nave associata.`,
        category: "ferry",
      });
    }
    if (!timing.ferryTime) {
      pushIssue(bucket, {
        serviceId: service.id,
        severity: "warning",
        code: "FERRY_TIME_MISSING",
        title: "Orario nave mancante",
        message: `${label}: connessione risolta ma senza orario nave.`,
        category: "ferry",
      });
    }
    if (!timing.ferryPort) {
      pushIssue(bucket, {
        serviceId: service.id,
        severity: "warning",
        code: "FERRY_PORT_MISSING",
        title: "Porto mancante",
        message: `${label}: connessione risolta ma senza porto di imbarco/sbarco.`,
        category: "ferry",
      });
    }
  }
}

function diagnoseHotel(service: PrintService, hotelsById: Map<string, DiagnosticsHotelRow>, connectionType: ReturnType<typeof connectionTypeFromKind>, bucket: Map<string, DayDiagnosticIssue>) {
  const label = service.practice_number ?? service.customer_name ?? service.id;
  if (!requiresHotelLeg(service.booking_service_kind)) return;
  if (!service.hotel_id) {
    pushIssue(bucket, {
      serviceId: service.id,
      severity: "warning",
      code: "MISSING_HOTEL",
      title: "Hotel mancante",
      message: `${label}: nessun hotel collegato al servizio.`,
      category: "hotel",
    });
    return;
  }
  const hotel = hotelsById.get(service.hotel_id);
  if (!hotel) {
    pushIssue(bucket, {
      serviceId: service.id,
      severity: "error",
      code: "HOTEL_NOT_FOUND",
      title: "Hotel non trovato",
      message: `${label}: hotel_id ${service.hotel_id} non presente nel catalogo hotel del tenant.`,
      category: "hotel",
    });
    return;
  }
  if (!hotel.zone && connectionType != null) {
    pushIssue(bucket, {
      serviceId: service.id,
      severity: "warning",
      code: "HOTEL_ZONE_MISSING",
      title: "Zona hotel mancante",
      message: `${label}: hotel "${hotel.name}" senza zona — necessaria per il calcolo pickup.`,
      category: "hotel",
    });
  }
}

function diagnoseTime(service: PrintService, connectionType: ReturnType<typeof connectionTypeFromKind>, bucket: Map<string, DayDiagnosticIssue>) {
  const label = service.practice_number ?? service.customer_name ?? service.id;
  const time = service.time;
  if (!time) {
    pushIssue(bucket, {
      serviceId: service.id,
      severity: "error",
      code: "INVALID_TIME",
      title: "Orario mancante",
      message: `${label}: campo orario obbligatorio assente.`,
      category: "time",
    });
    return;
  }
  if (!TIME_RE.test(time.slice(0, 5))) {
    pushIssue(bucket, {
      serviceId: service.id,
      severity: "warning",
      code: "INVALID_TIME",
      title: "Formato orario non valido",
      message: `${label}: orario "${time}" non in formato HH:MM.`,
      category: "time",
    });
    return;
  }
  // "00:00" e' un placeholder sospetto SOLO nel dominio treno/volo/nave, dove
  // il resolver non produce mai un orario inventato (vedi
  // operational-timing-resolver.ts) — per bus/escursioni un 00:00 reale non
  // e' verificabile qui senza inventare una regola, quindi non lo tocchiamo.
  if (connectionType != null && time.slice(0, 5) === "00:00") {
    pushIssue(bucket, {
      serviceId: service.id,
      severity: "warning",
      code: "INVALID_TIME",
      title: "Orario 00:00 sospetto",
      message: `${label}: orario 00:00 su un servizio treno/volo/nave — verificare se e' un placeholder.`,
      category: "time",
    });
  }
}

function diagnoseCancellation(
  service: PrintService,
  assignedServiceIds: Set<string>,
  allocatedServiceIds: Set<string>,
  bucket: Map<string, DayDiagnosticIssue>
) {
  if (!CANCELLED_STATUSES.has(service.status)) return;
  const label = service.practice_number ?? service.customer_name ?? service.id;
  if (assignedServiceIds.has(service.id)) {
    pushIssue(bucket, {
      serviceId: service.id,
      severity: "error",
      code: "CANCELLED_WITH_ASSIGNMENT",
      title: "Cancellato ma ancora assegnato",
      message: `${label}: servizio ${service.status} ma ha ancora un autista assegnato.`,
      category: "cancellation",
    });
  }
  if (allocatedServiceIds.has(service.id)) {
    pushIssue(bucket, {
      serviceId: service.id,
      severity: "error",
      code: "CANCELLED_WITH_BUS_ALLOCATION",
      title: "Cancellato ma ancora allocato su bus",
      message: `${label}: servizio ${service.status} ma ha ancora un'allocazione bus attiva.`,
      category: "cancellation",
    });
  }
}

function diagnoseBusCapacity(input: OperationalDayDiagnosticsInput, bucket: Map<string, DayDiagnosticIssue>) {
  // Rete bus (tenant_bus_units) — riusa buildBusUnitLoadSummary (pura, gia'
  // usata da rete-ischia): NON duplica l'aggregazione pax, la interpreta.
  const summary = buildBusUnitLoadSummary(input.busUnits, input.busAllocations);
  for (const unit of summary) {
    if (unit.pax_assigned > unit.capacity) {
      const affected = input.busAllocations.filter((a) => a.bus_unit_id === unit.id).map((a) => a.service_id);
      pushIssue(bucket, {
        severity: "error",
        code: "BUS_CAPACITY_EXCEEDED",
        title: "Bus sovraccarico",
        message: `Bus "${unit.label}": ${unit.pax_assigned} pax assegnati su ${unit.capacity} posti.`,
        category: "bus",
        details: affected,
      });
    }
  }

  // Lotti Linea Bus/Escursioni — riusa buildBusLotAggregates (pura, gia'
  // usata per l'header lotti bus): NON duplica soglie/alert, li interpreta.
  const lots = buildBusLotAggregates(
    input.services.filter((s) => !CANCELLED_STATUSES.has(s.status)),
    input.busLotConfigs
  );
  for (const lot of lots) {
    if (lot.remaining_seats !== null && lot.remaining_seats < 0) {
      pushIssue(bucket, {
        severity: "error",
        code: "BUS_CAPACITY_EXCEEDED",
        title: "Lotto bus sovraccarico",
        message: `${lot.title}: ${Math.abs(lot.remaining_seats)} pax oltre la capacita' (${lot.capacity}).`,
        category: "bus",
      });
    }
  }

  // Allocazioni orfane: bus_service_allocations che puntano a un service_id
  // non presente nel set servizi caricato per la giornata (riferimento rotto).
  const serviceIds = new Set(input.services.map((s) => s.id));
  const orphanServiceIds = new Set(
    input.busAllocations.filter((a) => !serviceIds.has(a.service_id)).map((a) => a.service_id)
  );
  if (orphanServiceIds.size > 0) {
    pushIssue(bucket, {
      severity: "warning",
      code: "ORPHAN_BUS_ALLOCATION",
      title: "Allocazioni bus orfane",
      message: `${orphanServiceIds.size} allocazione/i bus puntano a servizi non trovati nella giornata caricata.`,
      category: "bus",
      details: Array.from(orphanServiceIds),
    });
  }
}

function diagnoseDuplicates(services: PrintService[], bucket: Map<string, DayDiagnosticIssue>) {
  const groups = new Map<string, PrintService[]>();
  for (const service of services) {
    if (CANCELLED_STATUSES.has(service.status)) continue;
    const nameKey = normalizeName(service.customer_name);
    if (!nameKey) continue;
    const key = [service.date, service.direction, service.time, nameKey, service.hotel_id ?? ""].join("|");
    groups.set(key, [...(groups.get(key) ?? []), service]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const ids = group.map((s) => s.id);
    for (const service of group) {
      pushIssue(bucket, {
        serviceId: service.id,
        severity: "warning",
        code: "POSSIBLE_DUPLICATE",
        title: "Possibile duplicato",
        message: `${group.length} servizi identici per data/direzione/orario/cliente/hotel (${service.customer_name}).`,
        category: "duplicate",
        details: ids.filter((id) => id !== service.id),
      });
    }
  }
}

function diagnoseLinkedServices(input: OperationalDayDiagnosticsInput, servicesById: Map<string, PrintService>, bucket: Map<string, DayDiagnosticIssue>) {
  // Gambe collegate fuori dalla giornata caricata (es. andata 28/08 ->
  // ritorno 04/09): riusa le righe thin gia' caricate in batch dal chiamante
  // (una sola query IN(...), vedi app/api/ops/diagnostics/route.ts) — mai una
  // ricerca per riga. Un id esterno assente da questo array e' inesistente.
  const externalById = new Map((input.externalLinkedServices ?? []).map((row) => [row.id, row] as const));

  for (const service of input.services) {
    const linkedId = service.linked_service_id;
    if (!linkedId) continue;
    const label = service.practice_number ?? service.customer_name ?? service.id;

    const linked: Pick<PrintService, "linked_service_id" | "status"> | DiagnosticsLinkedServiceRef | undefined =
      servicesById.get(linkedId) ?? externalById.get(linkedId);

    if (!linked) {
      pushIssue(bucket, {
        serviceId: service.id,
        severity: "error",
        code: "BROKEN_LINKED_SERVICE",
        title: "Collegamento rotto",
        message: `${label}: linked_service_id punta a un servizio inesistente.`,
        category: "linked_service",
      });
      continue;
    }

    // La differenza di data tra andata e ritorno non e' mai di per se'
    // un'anomalia (round trip multi-giorno legittimo) — qui si verifica SOLO
    // esistenza e reciprocita' del legame, mai la coerenza delle date.
    if (linked.linked_service_id && linked.linked_service_id !== service.id) {
      pushIssue(bucket, {
        serviceId: service.id,
        severity: "warning",
        code: "INCONSISTENT_ROUND_TRIP",
        title: "Collegamento non reciproco",
        message: `${label}: il servizio collegato non punta a sua volta a questo servizio.`,
        category: "linked_service",
      });
    }

    const oneCancelled = CANCELLED_STATUSES.has(service.status);
    const otherCancelled = CANCELLED_STATUSES.has(linked.status);
    if (oneCancelled !== otherCancelled) {
      pushIssue(bucket, {
        serviceId: service.id,
        severity: "warning",
        code: "INCONSISTENT_ROUND_TRIP",
        title: "Andata/ritorno incoerenti",
        message: `${label}: una gamba e' cancellata e l'altra no — verificare.`,
        category: "linked_service",
      });
    }
  }
}

function diagnoseImportWarnings(service: PrintService, bucket: Map<string, DayDiagnosticIssue>) {
  if (CANCELLED_STATUSES.has(service.status)) return;
  if (!service.pickup_alert) return;
  if (servicePickupCodes(bucket, service.id)) return; // stessa causa gia' rappresentata da un issue pickup live (§13).
  const label = service.practice_number ?? service.customer_name ?? service.id;
  pushIssue(bucket, {
    serviceId: service.id,
    severity: "info",
    code: "IMPORT_WARNING",
    title: "Alert salvato all'import",
    message: `${label}: ${service.pickup_alert}`,
    category: "import",
    source: "pickup_alert",
  });
}

export function diagnoseOperationalDay(input: OperationalDayDiagnosticsInput): DayDiagnosticResult {
  const services = input.services.filter((s) => !s.is_draft);
  const servicesById = new Map(services.map((s) => [s.id, s]));
  const bucket = new Map<string, DayDiagnosticIssue>();

  const assignedServiceIds = new Set(
    input.assignments.filter((a) => a.driver_user_id != null).map((a) => a.service_id)
  );
  const allocatedServiceIds = new Set(input.busAllocations.map((a) => a.service_id));

  for (const service of services) {
    const connectionType = connectionTypeFromKind(service.booking_service_kind);
    diagnoseTime(service, connectionType, bucket);
    diagnoseHotel(service, input.hotelsById, connectionType, bucket);
    diagnoseCancellation(service, assignedServiceIds, allocatedServiceIds, bucket);

    if (!CANCELLED_STATUSES.has(service.status) && service.direction === "departure") {
      const context = buildTimingContext(service, input.hotelsById, input.operationalRules, input.ferrySchedules);
      const timing = resolveOperationalTiming(service, context);
      diagnosePickupAndFerry(service, timing, connectionType, bucket);
    }

    diagnoseImportWarnings(service, bucket);
  }

  diagnoseDuplicates(services, bucket);
  diagnoseLinkedServices({ ...input, services }, servicesById, bucket);
  diagnoseBusCapacity({ ...input, services }, bucket);

  const issues = Array.from(bucket.values()).sort((a, b) => {
    const rank = { error: 0, warning: 1, info: 2 } as const;
    return rank[a.severity] - rank[b.severity];
  });

  const issuesByService = new Map<string, DayDiagnosticSeverity>();
  for (const issue of issues) {
    if (!issue.serviceId) continue;
    const current = issuesByService.get(issue.serviceId);
    if (issue.severity === "error" || current === undefined || (issue.severity === "warning" && current === "info")) {
      if (current !== "error") issuesByService.set(issue.serviceId, issue.severity);
    }
  }

  let okServices = 0;
  let warningServices = 0;
  let errorServices = 0;
  for (const service of services) {
    const worst = issuesByService.get(service.id);
    if (worst === "error") errorServices += 1;
    else if (worst === "warning") warningServices += 1;
    else okServices += 1;
  }

  return {
    totalServices: services.length,
    okServices,
    warningServices,
    errorServices,
    issues,
  };
}
