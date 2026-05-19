import type { ConflictResolutionSuggestion } from "@/lib/piano-conflict-resolution-suggestions";

export type ResolutionPreviewLine = {
  label: string;
  detail: string;
};

export type ResolutionPreview = {
  suggestion_id: string;
  group_id: string;
  action: ConflictResolutionSuggestion["recommended_action"] | "SEPARARE_SE_NON_CONFERMATO";
  before: ResolutionPreviewLine[];
  after: ResolutionPreviewLine[];
  simulated_status: "OK" | "WARNING" | "NON_OPERATIVO";
  residual_conflicts: number;
  residual_warnings: number;
  total_pax: number;
  final_stops: ResolutionPreviewLine[];
  warnings: string[];
  requires_operator_confirmation: boolean;
};

function clean(value?: string | number | null) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function prettyPlace(value?: string | null) {
  const normalized = clean(value) ?? "";
  const key = normalized.toUpperCase();
  const known: Record<string, string> = {
    "LA VILLA": "La Villa",
    MORTELLA: "Mortella",
    CRISTALLO: "Cristallo",
    "RE FERDINANDO": "Re Ferdinando",
    "ISCHIA PORTO": "Ischia Porto",
    CASAMICCIOLA: "Casamicciola",
  };
  return known[key] ?? normalized;
}

function timeRange(suggestion: ConflictResolutionSuggestion) {
  const times = Array.from(new Set(
    suggestion.involved_services.map((service) => service.operational_time).filter(Boolean) as string[]
  )).sort();
  if (times.length === 0) return "orario da verificare";
  if (times.length === 1) return times[0]!;
  return `${times[0]}–${times[times.length - 1]}`;
}

function serviceLine(service: ConflictResolutionSuggestion["involved_services"][number]) {
  return {
    label: `${service.operational_time ?? "--:--"} · ${service.customer_name ?? service.service_id}`,
    detail: `${prettyPlace(service.pickup_label)} → ${prettyPlace(service.destination_label)} · ${service.pax ?? "?"} pax`,
  };
}

function totalPax(suggestion: ConflictResolutionSuggestion) {
  return suggestion.involved_services.reduce((sum, service) => sum + (service.pax ?? 0), 0);
}

function pickupLabel(suggestion: ConflictResolutionSuggestion) {
  return prettyPlace(suggestion.involved_services.find((service) => service.pickup_label)?.pickup_label);
}

function destinationOrder(suggestion: ConflictResolutionSuggestion) {
  const order = suggestion.suggested_order.length > 0
    ? suggestion.suggested_order
    : suggestion.involved_services.map((service) => service.destination_label).filter(Boolean) as string[];
  return Array.from(new Set(order.map(prettyPlace).filter(Boolean)));
}

function buildMultiDropPreview(suggestion: ConflictResolutionSuggestion): ResolutionPreview {
  const order = destinationOrder(suggestion);
  const pickup = pickupLabel(suggestion);
  const finalStop = {
    label: `${timeRange(suggestion)} · pickup unico`,
    detail: `${pickup} → ${order.join(" → ")} · ${totalPax(suggestion)} pax totali`,
  };
  return {
    suggestion_id: suggestion.conflict_id,
    group_id: suggestion.group_id,
    action: "MULTI_DROP",
    before: suggestion.involved_services.map(serviceLine),
    after: [finalStop],
    simulated_status: "WARNING",
    residual_conflicts: 0,
    residual_warnings: 1,
    total_pax: totalPax(suggestion),
    final_stops: [finalStop],
    warnings: [
      "Nessuna modifica verra applicata in questo step.",
      "Confermare percorso, tempi e capienza con operatore prima di applicare.",
      ...(suggestion.alternative_action ? ["Alternativa: separare se il multi-drop non viene confermato."] : []),
    ],
    requires_operator_confirmation: suggestion.operator_confirmation_required,
  };
}

function buildMergePreview(suggestion: ConflictResolutionSuggestion): ResolutionPreview {
  const pickup = pickupLabel(suggestion);
  const destinations = destinationOrder(suggestion);
  const finalStop = {
    label: `${timeRange(suggestion)} · stop unico proposto`,
    detail: `${pickup} → ${destinations[0] ?? "destinazione da verificare"} · ${totalPax(suggestion)} pax totali`,
  };
  return {
    suggestion_id: suggestion.conflict_id,
    group_id: suggestion.group_id,
    action: "ACCORPARE_CON_CONFERMA",
    before: suggestion.involved_services.map(serviceLine),
    after: [finalStop],
    simulated_status: "OK",
    residual_conflicts: 0,
    residual_warnings: 0,
    total_pax: totalPax(suggestion),
    final_stops: [finalStop],
    warnings: [
      "Nessuna modifica verra applicata in questo step.",
      "Accorpare solo se l'operatore conferma che i clienti possono partire insieme.",
    ],
    requires_operator_confirmation: true,
  };
}

function buildSeparateAlternativePreview(suggestion: ConflictResolutionSuggestion): ResolutionPreview {
  const move = suggestion.candidate_moves[0] ?? null;
  const service = move
    ? suggestion.involved_services.find((item) => item.service_id === move.service_id)
    : null;
  return {
    suggestion_id: suggestion.conflict_id,
    group_id: suggestion.group_id,
    action: "SEPARARE_SE_NON_CONFERMATO",
    before: suggestion.involved_services.map(serviceLine),
    after: [
      {
        label: service ? `Spostare ${service.customer_name ?? service.service_id}` : "Separare servizio",
        detail: move
          ? `Verso ${move.to_driver ?? "giro candidato"} · confidenza ${move.confidence}`
          : "Nessun giro candidato disponibile: valutare nuovo giro.",
      },
    ],
    simulated_status: move ? "OK" : "WARNING",
    residual_conflicts: 0,
    residual_warnings: move ? 0 : 1,
    total_pax: service?.pax ?? totalPax(suggestion),
    final_stops: [
      {
        label: service ? `Servizio separato: ${service.customer_name ?? service.service_id}` : "Separazione da definire",
        detail: move ? `Giro candidato ${move.to_driver ?? move.to_group_id}` : "Serve nuovo giro o assegnazione manuale.",
      },
    ],
    warnings: [
      "Nessuna modifica verra applicata in questo step.",
      "Questa e solo l'alternativa se il multi-drop non viene confermato.",
    ],
    requires_operator_confirmation: true,
  };
}

export function buildResolutionPreview(
  suggestion: ConflictResolutionSuggestion,
  options?: { alternative?: boolean }
): ResolutionPreview {
  if (options?.alternative && suggestion.alternative_action === "SEPARARE_SE_NON_CONFERMATO") {
    return buildSeparateAlternativePreview(suggestion);
  }

  if (suggestion.recommended_action === "MULTI_DROP") return buildMultiDropPreview(suggestion);
  if (suggestion.recommended_action === "ACCORPARE_CON_CONFERMA") return buildMergePreview(suggestion);

  return {
    suggestion_id: suggestion.conflict_id,
    group_id: suggestion.group_id,
    action: suggestion.recommended_action,
    before: suggestion.involved_services.map(serviceLine),
    after: suggestion.candidate_moves.length > 0
      ? suggestion.candidate_moves.slice(0, 1).map((move) => ({
          label: "Spostamento proposto",
          detail: `Servizio ${move.service_id} verso ${move.to_driver ?? move.to_group_id} · confidenza ${move.confidence}`,
        }))
      : [{ label: "Nuovo giro", detail: "Preparare un giro separato senza applicare modifiche." }],
    simulated_status: suggestion.candidate_moves.length > 0 ? "OK" : "WARNING",
    residual_conflicts: 0,
    residual_warnings: suggestion.candidate_moves.length > 0 ? 0 : 1,
    total_pax: totalPax(suggestion),
    final_stops: suggestion.candidate_moves.length > 0
      ? [{ label: "Spostamento candidato", detail: `Confidenza ${suggestion.candidate_moves[0]?.confidence ?? "n/d"}` }]
      : [{ label: "Nuovo giro", detail: "Da costruire manualmente." }],
    warnings: ["Nessuna modifica verra applicata in questo step."],
    requires_operator_confirmation: suggestion.operator_confirmation_required,
  };
}

export function canApplyResolutionPreview(preview: ResolutionPreview) {
  return preview.action === "ACCORPARE_CON_CONFERMA"
    && preview.simulated_status === "OK"
    && preview.residual_conflicts === 0
    && preview.residual_warnings === 0
    && preview.requires_operator_confirmation;
}

export function canConfirmMultiDropPreview(
  preview: ResolutionPreview,
  suggestion?: ConflictResolutionSuggestion
) {
  const hasSuggestedOrder = !suggestion || suggestion.suggested_order.length > 0;
  const hasUniquePickup = !suggestion || new Set(
    suggestion.involved_services
      .map((service) => clean(service.pickup_label)?.toLowerCase())
      .filter(Boolean)
  ).size === 1;
  const hasEnoughServices = !suggestion || suggestion.involved_services.length >= 2;
  const hasCompleteServices = !suggestion || suggestion.involved_services.every((service) =>
    Boolean(clean(service.service_id))
    && Boolean(clean(service.pickup_label))
    && Boolean(clean(service.destination_label))
  );

  return preview.action === "MULTI_DROP"
    && preview.simulated_status === "WARNING"
    && preview.residual_conflicts === 0
    && preview.residual_warnings >= 1
    && preview.requires_operator_confirmation
    && preview.final_stops.length > 0
    && hasSuggestedOrder
    && hasUniquePickup
    && hasEnoughServices
    && hasCompleteServices;
}

export function canConfirmResolutionPreview(
  preview: ResolutionPreview,
  suggestion?: ConflictResolutionSuggestion
) {
  return canApplyResolutionPreview(preview) || canConfirmMultiDropPreview(preview, suggestion);
}

export function resolutionConfirmationLabel(preview: ResolutionPreview) {
  if (canApplyResolutionPreview(preview)) return "Conferma e applica";
  if (canConfirmMultiDropPreview(preview)) return "Conferma multi-drop";
  return null;
}
