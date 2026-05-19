import { analyzeGiro } from "@/lib/piano-conflict-classifier";
import type { MergedStop } from "@/lib/piano-same-stop-merge";
import type { RealGiroDiagnosticGroup } from "@/lib/piano-real-giro-diagnostics";

export type ConflictRootCause =
  | "different_ports_same_time"
  | "multi_drop_candidate"
  | "insufficient_buffer_same_pickup"
  | "true_overlap"
  | "locked_manual"
  | "unknown";

export type ConflictResolutionAction =
  | "SEPARARE"
  | "SPOSTARE"
  | "CREARE_NUOVO_GIRO"
  | "MULTI_DROP"
  | "ACCORPARE_CON_CONFERMA"
  | "DA_VERIFICARE_OPERATORE"
  | "OK_NON_INTERVENIRE";

export interface ConflictResolutionCandidateMove {
  service_id: string;
  from_driver: string | null;
  to_driver: string | null;
  to_group_id: string;
  confidence: number;
  reason: string;
  risks: string[];
}

export interface ConflictResolutionSuggestion {
  conflict_id: string;
  group_id: string;
  driver_name: string | null;
  vehicle_label: string | null;
  conflict_type: "CONFLICT_REAL" | "OVERLAP";
  severity: "alta" | "media" | "bassa";
  involved_services: Array<{
    service_id: string;
    customer_name: string | null;
    macro_category: string;
    operational_time: string | null;
    pickup_label: string | null;
    destination_label: string | null;
    pax: number | null;
  }>;
  root_cause: ConflictRootCause;
  recommended_action: ConflictResolutionAction;
  explanation: string[];
  suggested_order: string[];
  alternative_action: "SEPARARE_SE_NON_CONFERMATO" | null;
  candidate_moves: ConflictResolutionCandidateMove[];
  operator_confirmation_required: boolean;
  operator_confirmed?: boolean;
  operator_decision_id?: string | null;
  operator_decision_type?: string | null;
  operator_confirmed_by?: string | null;
  operator_confirmed_at?: string | null;
  operator_confirmed_severity?: "info" | "confirmed_warning";
}

function clean(value?: string | number | null) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function normalize(value?: string | null) {
  return clean(value)
    ?.toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[_-]+/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim() ?? "";
}

function sameText(left?: string | null, right?: string | null) {
  const a = normalize(left);
  const b = normalize(right);
  return Boolean(a && b && a === b);
}

function stopLabel(stop: MergedStop) {
  const destination = stop.destination_labels.length > 0 ? stop.destination_labels.join(" / ") : "destinazione da verificare";
  return `${stop.operational_time} ${stop.macro_category} ${stop.pickup_label ?? "pickup da verificare"} -> ${destination}`;
}

function stopForLabel(group: RealGiroDiagnosticGroup, label: string) {
  return group.stops.find((stop) => stopLabel(stop) === label) ?? null;
}

function stopKey(stop: MergedStop) {
  return stop.services.map((service) => service.service_id).sort().join("+") || stop.stop_id;
}

function clusterKey(stops: MergedStop[]) {
  return stops.map(stopKey).sort().join("|");
}

function hasLockedService(stop: MergedStop) {
  return stop.services.some((service) => (service as { locked_by_operator?: boolean }).locked_by_operator === true);
}

function serviceRows(stops: MergedStop[]): ConflictResolutionSuggestion["involved_services"] {
  return stops.flatMap((stop) =>
    stop.services.map((service) => ({
      service_id: service.service_id,
      customer_name: service.customer_name ?? null,
      macro_category: service.macro_category,
      operational_time: service.operational_time,
      pickup_label: service.pickup_label,
      destination_label: service.destination_label,
      pax: service.pax,
    }))
  );
}

function distinctDestinationLabels(stops: MergedStop[]) {
  return new Set(stops.flatMap((stop) => stop.destination_labels.map(normalize)).filter(Boolean));
}

function sameOperationalCluster(left: MergedStop, right: MergedStop) {
  return sameText(left.pickup_label, right.pickup_label)
    && Boolean(left.operational_time && left.operational_time === right.operational_time)
    && !hasLockedService(right)
    && right.services.every((service) => !service.needs_review)
    && right.destination_labels.some((label) => normalize(label));
}

function expandMultiDropCluster(group: RealGiroDiagnosticGroup, stops: MergedStop[]) {
  if (classifyRootCause(stops) !== "multi_drop_candidate") return stops;
  const reference = stops[0];
  if (!reference) return stops;
  const expanded = group.stops.filter((stop) => sameOperationalCluster(reference, stop));
  if (expanded.length < stops.length || distinctDestinationLabels(expanded).size <= 1) return stops;
  return expanded;
}

function classifyRootCause(stops: MergedStop[]): ConflictRootCause {
  if (stops.some(hasLockedService)) return "locked_manual";
  if (stops.some((stop) => stop.services.some((service) => service.needs_review))) return "unknown";
  if (stops.length < 2) return "unknown";
  const [first, second] = stops;
  const samePickup = sameText(first?.pickup_label, second?.pickup_label);
  const sameTime = Boolean(first?.operational_time && first.operational_time === second?.operational_time);

  if (samePickup && sameTime && distinctDestinationLabels(stops).size > 1) {
    return "multi_drop_candidate";
  }

  if (samePickup && distinctDestinationLabels(stops).size === 1) {
    return "insufficient_buffer_same_pickup";
  }

  return sameTime ? "true_overlap" : "unknown";
}

function severityFor(rootCause: ConflictRootCause, worstMargin: number) {
  if (rootCause === "locked_manual") return "alta";
  if (worstMargin <= -25 || rootCause === "true_overlap") return "alta";
  if (worstMargin < 0) return "media";
  return "bassa";
}

function movableStop(stops: MergedStop[]) {
  return [...stops].sort((left, right) => left.total_pax - right.total_pax)[0] ?? null;
}

function findCandidateMoves(args: {
  groups: RealGiroDiagnosticGroup[];
  sourceGroup: RealGiroDiagnosticGroup;
  stop: MergedStop | null;
}): ConflictResolutionCandidateMove[] {
  if (!args.stop || hasLockedService(args.stop)) return [];
  const moves: ConflictResolutionCandidateMove[] = [];

  for (const group of args.groups) {
    if (group.group_id === args.sourceGroup.group_id) continue;
    if (group.driver_name && args.sourceGroup.driver_name && group.driver_name === args.sourceGroup.driver_name) continue;
    if (group.status !== "OK") continue;
    if (group.needs_review_count > 0) continue;

    const simulated = analyzeGiro(group.group_id, group.driver_name, [...group.stops, args.stop]);
    if (simulated.conflict_count > 0 || simulated.overlap_count > 0) continue;

    const service = args.stop.services[0];
    if (!service) continue;
    moves.push({
      service_id: service.service_id,
      from_driver: args.sourceGroup.driver_name,
      to_driver: group.driver_name,
      to_group_id: group.group_id,
      confidence: simulated.warning_count > 0 ? 65 : 85,
      reason: simulated.warning_count > 0
        ? "Inserimento simulato senza conflitti reali, ma con warning da verificare"
        : "Inserimento simulato senza nuovi conflitti",
      risks: simulated.warning_count > 0 ? ["Margine stretto nel giro candidato"] : [],
    });
  }

  return moves.sort((left, right) => right.confidence - left.confidence).slice(0, 5);
}

function actionFor(rootCause: ConflictRootCause, candidateMoves: ConflictResolutionCandidateMove[]) {
  if (rootCause === "locked_manual") return "DA_VERIFICARE_OPERATORE";
  if (rootCause === "different_ports_same_time") return "SEPARARE";
  if (rootCause === "multi_drop_candidate") return "MULTI_DROP";
  if (rootCause === "insufficient_buffer_same_pickup") return "ACCORPARE_CON_CONFERMA";
  if (candidateMoves.length > 0) return "SPOSTARE";
  return "CREARE_NUOVO_GIRO";
}

function destinationRank(label?: string | null) {
  const text = normalize(label);
  if (/(casamicciola|cristallo|lacco|forio|citara|panza|cuotto)/.test(text)) return 10;
  if (/(sant angelo|serrara|fontana)/.test(text)) return 20;
  if (/(ischia porto|ischia|re ferdinando|barano|testaccio|fiaiano|cartaromana)/.test(text)) return 30;
  return 99;
}

function suggestedOrderFor(rootCause: ConflictRootCause, stops: MergedStop[]) {
  if (rootCause !== "multi_drop_candidate") return [];
  const labels = new Map<string, string>();
  for (const stop of stops) {
    for (const label of stop.destination_labels) {
      const cleaned = clean(label);
      if (!cleaned) continue;
      labels.set(normalize(cleaned), cleaned);
    }
  }
  return Array.from(labels.values()).sort((left, right) =>
    destinationRank(left) - destinationRank(right) || left.localeCompare(right)
  );
}

function pickupLabelFor(stops: MergedStop[]) {
  return stops.map((stop) => clean(stop.pickup_label)).find(Boolean) ?? "pickup";
}

function exceedsKnownCapacity(group: RealGiroDiagnosticGroup, stops: MergedStop[]) {
  const capacity = (group as RealGiroDiagnosticGroup & { vehicle_capacity?: number | null }).vehicle_capacity;
  if (!capacity || capacity <= 0) return false;
  const totalPax = stops.reduce((sum, stop) => sum + stop.total_pax, 0);
  return totalPax > capacity;
}

function explanationFor(rootCause: ConflictRootCause, stops: MergedStop[], hasCandidates: boolean) {
  if (rootCause === "different_ports_same_time") {
    return [
      "Stesso pickup e stesso orario, ma porti operativi diversi.",
      "Il giro va separato: un autista non puo servire due porti nello stesso minuto.",
      hasCandidates ? "Esiste almeno un giro candidato per simulare lo spostamento." : "Nessun giro candidato compatibile trovato: valutare nuovo giro.",
    ];
  }
  if (rootCause === "multi_drop_candidate") {
    const pickup = pickupLabelFor(stops);
    const order = suggestedOrderFor(rootCause, stops);
    return [
      `Pickup unico da ${pickup}. Possibile multi-drop: ${order.join(" -> ") || "ordine fermate da confermare"}.`,
      "Confermare percorso, capienza e tempi con operatore prima di applicare modifiche.",
    ];
  }
  if (rootCause === "insufficient_buffer_same_pickup") {
    return [
      "Stesso pickup e stessa destinazione operativa, ma i due stop sono troppo ravvicinati.",
      "Si puo accorpare solo con conferma operatore sugli orari reali dei clienti.",
    ];
  }
  if (rootCause === "locked_manual") {
    return ["Almeno un servizio e bloccato manualmente: serve intervento operatore."];
  }
  return [
    "Conflitto operativo reale non riconducibile a same-stop o shuttle-pair.",
    hasCandidates ? "Esiste un giro candidato compatibile." : "Nessun giro candidato compatibile trovato.",
    stops.length > 0 ? `Stop coinvolti: ${stops.map(stopLabel).join(" | ")}` : "Stop coinvolti non determinati.",
  ];
}

function capacityExplanation(stops: MergedStop[]) {
  const totalPax = stops.reduce((sum, stop) => sum + stop.total_pax, 0);
  return [
    `Pax totale ${totalPax} oltre la capienza nota del mezzo.`,
    "Non proporre multi-drop automatico: serve verifica operatore o cambio mezzo/giro.",
  ];
}

export function generateConflictResolutionSuggestions(groups: RealGiroDiagnosticGroup[]): ConflictResolutionSuggestion[] {
  const suggestions: ConflictResolutionSuggestion[] = [];

  for (const group of groups) {
    const groupedTransitions = new Map<string, {
      transitions: typeof group.transitions;
      stops: MergedStop[];
    }>();

    for (const transition of group.transitions) {
      if (transition.type !== "CONFLICT_REAL" && transition.type !== "OVERLAP") continue;
      const transitionStops = [stopForLabel(group, transition.from_stop_label), stopForLabel(group, transition.to_stop_label)]
        .filter((stop): stop is MergedStop => Boolean(stop));
      const stops = expandMultiDropCluster(group, transitionStops);
      const key = clusterKey(stops) || `${transition.from_stop_label}|${transition.to_stop_label}`;
      const existing = groupedTransitions.get(key) ?? { transitions: [], stops };
      existing.transitions.push(transition);
      groupedTransitions.set(key, existing);
    }

    for (const [key, conflict] of groupedTransitions) {
      const rootCause = classifyRootCause(conflict.stops);
      const capacityBlocked = rootCause === "multi_drop_candidate" && exceedsKnownCapacity(group, conflict.stops);
      const moveStop = rootCause === "different_ports_same_time" || rootCause === "true_overlap" || rootCause === "unknown"
        ? movableStop(conflict.stops)
        : null;
      const candidateMoves = findCandidateMoves({ groups, sourceGroup: group, stop: moveStop });
      const worstMargin = Math.min(...conflict.transitions.map((transition) => transition.margin));
      const recommendedAction = capacityBlocked ? "DA_VERIFICARE_OPERATORE" : actionFor(rootCause, candidateMoves);
      const suggestedOrder = capacityBlocked ? [] : suggestedOrderFor(rootCause, conflict.stops);

      suggestions.push({
        conflict_id: `${group.group_id}:${key}`,
        group_id: group.group_id,
        driver_name: group.driver_name,
        vehicle_label: group.vehicle_label,
        conflict_type: conflict.transitions.some((transition) => transition.type === "OVERLAP") ? "OVERLAP" : "CONFLICT_REAL",
        severity: severityFor(rootCause, worstMargin),
        involved_services: serviceRows(conflict.stops),
        root_cause: capacityBlocked ? "unknown" : rootCause,
        recommended_action: recommendedAction,
        explanation: capacityBlocked ? capacityExplanation(conflict.stops) : explanationFor(rootCause, conflict.stops, candidateMoves.length > 0),
        suggested_order: suggestedOrder,
        alternative_action: recommendedAction === "MULTI_DROP" ? "SEPARARE_SE_NON_CONFERMATO" : null,
        candidate_moves: candidateMoves,
        operator_confirmation_required: capacityBlocked
          || rootCause === "multi_drop_candidate"
          || rootCause === "insufficient_buffer_same_pickup"
          || rootCause === "locked_manual"
          || candidateMoves.length === 0,
      });
    }
  }

  return suggestions.sort((left, right) => {
    const severityRank = { alta: 0, media: 1, bassa: 2 };
    return severityRank[left.severity] - severityRank[right.severity]
      || left.group_id.localeCompare(right.group_id)
      || left.conflict_id.localeCompare(right.conflict_id);
  });
}
