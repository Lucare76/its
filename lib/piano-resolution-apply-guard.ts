import {
  buildResolutionPreview,
  canApplyResolutionPreview,
  canConfirmMultiDropPreview,
} from "@/lib/piano-conflict-resolution-preview";
import type { ConflictResolutionSuggestion } from "@/lib/piano-conflict-resolution-suggestions";

export type ResolutionApplyDecision =
  | {
      ok: true;
      apply_status: "eligible";
      message: string;
      suggestion: ConflictResolutionSuggestion;
    }
  | {
      ok: false;
      apply_status: "stale" | "not_supported" | "not_safe" | "locked";
      message: string;
      suggestion?: ConflictResolutionSuggestion;
    };

export function findResolutionSuggestion(
  suggestions: ConflictResolutionSuggestion[],
  input: { suggestion_id: string; group_id: string; action: string }
) {
  return suggestions.find((suggestion) =>
    suggestion.conflict_id === input.suggestion_id
    && suggestion.group_id === input.group_id
    && suggestion.recommended_action === input.action
  ) ?? null;
}

export function validateResolutionSuggestionApply(input: {
  suggestions: ConflictResolutionSuggestion[];
  suggestion_id: string;
  group_id: string;
  action: string;
  locked_service_ids?: Set<string>;
}): ResolutionApplyDecision {
  const suggestion = findResolutionSuggestion(input.suggestions, input);
  if (!suggestion) {
    return {
      ok: false,
      apply_status: "stale",
      message: "Suggerimento non piu valido, aggiorna il Piano.",
    };
  }

  const supportedAction = suggestion.recommended_action === "ACCORPARE_CON_CONFERMA"
    || suggestion.recommended_action === "MULTI_DROP";
  if (!supportedAction) {
    return {
      ok: false,
      apply_status: "not_supported",
      message: "Applicazione non supportata per questa azione.",
      suggestion,
    };
  }

  const lockedServiceIds = input.locked_service_ids ?? new Set<string>();
  const locked = suggestion.involved_services.some((service) => lockedServiceIds.has(service.service_id));
  if (locked) {
    return {
      ok: false,
      apply_status: "locked",
      message: "Suggerimento non applicabile: contiene servizi bloccati manualmente.",
      suggestion,
    };
  }

  const preview = buildResolutionPreview(suggestion);
  const safeToPersist = suggestion.recommended_action === "ACCORPARE_CON_CONFERMA"
    ? canApplyResolutionPreview(preview)
    : canConfirmMultiDropPreview(preview, suggestion);
  if (!safeToPersist) {
    return {
      ok: false,
      apply_status: "not_safe",
      message: "Suggerimento non confermabile: simulazione, warning o dati operativi non rispettano la guardia.",
      suggestion,
    };
  }

  return {
    ok: true,
    apply_status: "eligible",
    message: "Suggerimento validato: puo essere salvato come decisione operatore.",
    suggestion,
  };
}
