/**
 * Assegnazione Intelligente — classificazione del piano giornaliero.
 *
 * Questo modulo NON ricalcola vincoli/scoring/missioni: li legge da
 * lib/piano-assignable-service.ts (resolveAssignableService/buildAutoAssignPreview)
 * e lib/piano-auto-assign-planner.ts (planAutoAssignPreview), gia' responsabili
 * di vincoli duri, missioni e score spiegabile. Il suo unico compito e'
 * mappare quell'output — pensato per una preview read-only — sullo stato
 * richiesto per un piano persistito e su cui Mario lavora solo per eccezione:
 *
 *   auto_safe  → proposta ad alta confidenza, nessun warning
 *   review     → proposta con score/confidenza non dominante, o dato da verificare
 *   unresolved → nessun candidato valido trovato dal planner
 *   manual     → il servizio ha gia' un'assegnazione reale (locked_by_operator
 *                vale true per QUALSIASI scrittura manuale/MCP, vedi
 *                lib/server/assign-service-core.ts — qui non e' un lock
 *                esplicito del piano, e' "gia' deciso da un umano")
 *   locked     → SOLO items bloccati esplicitamente in precedenza tramite
 *                its.lock_assignment (previousItemsByServiceId[...].locked),
 *                preservati identici e mai sovrascritti da un ricalcolo
 *
 * Pure/testabile senza DB: chi chiama (build-plan.ts) inietta gia' i dati
 * caricati e un ranking opzionale di alternative (che invece richiede la
 * pool live di autisti/mezzi).
 */
import type { AutoAssignPreviewResult, AutoAssignPreviewServiceRow } from "@/lib/piano-assignable-preview";
import type { PlannerResult } from "@/lib/piano-auto-assign-planner";

export type PlanItemStatus = "auto_safe" | "review" | "unresolved" | "locked" | "manual";

export type PlanItemAlternative = {
  driver_id: string;
  driver_name: string;
  vehicle_id: string | null;
  vehicle_label: string | null;
  score: number;
  reason: string[];
};

export type PlanItemReason = {
  summary: string[];
  details: Record<string, unknown>;
};

export type PlanItemDraft = {
  service_id: string;
  status: PlanItemStatus;
  proposed_driver_id: string | null;
  proposed_driver_name: string | null;
  proposed_vehicle_id: string | null;
  proposed_vehicle_label: string | null;
  mission_group_key: string | null;
  score: number | null;
  confidence: number | null;
  reason: PlanItemReason;
  alternatives: PlanItemAlternative[];
  warnings: string[];
  suggested_fix: unknown | null;
  locked: boolean;
};

export type PlanItemAssignmentInfo = {
  driver_id: string | null;
  driver_name: string | null;
  vehicle_id: string | null;
  vehicle_label: string | null;
  locked_by_operator: boolean;
};

/** Soglie per auto_safe — allineate alle soglie gia' in uso dal planner esistente:
 * confidence_score>=80 e' gia' il gate per entrare tra i "candidates" in
 * planAutoAssignPreview; score>=80 richiede una missione con evidenze solide
 * (continuita' di percorso/stesso pickup/zona), non solo "accettabile" (>=50,
 * soglia di merge in evaluateAppend). Nessun warning: un solo warning euristico
 * (es. buffer stimato su zona sconosciuta) declassa sempre a review. */
export const AUTO_SAFE_SCORE_THRESHOLD = 80;
export const AUTO_SAFE_CONFIDENCE_THRESHOLD = 80;

export type ClassifyPlanArgs = {
  preview: AutoAssignPreviewResult;
  planning: PlannerResult;
  assignmentByServiceId: Map<string, PlanItemAssignmentInfo>;
  rankAlternatives?: (row: AutoAssignPreviewServiceRow) => PlanItemAlternative[];
  previousItemsByServiceId?: Map<string, PlanItemDraft>;
};

function manualItem(serviceId: string, assignment: PlanItemAssignmentInfo): PlanItemDraft {
  return {
    service_id: serviceId,
    status: "manual",
    proposed_driver_id: assignment.driver_id,
    proposed_driver_name: assignment.driver_name,
    proposed_vehicle_id: assignment.vehicle_id,
    proposed_vehicle_label: assignment.vehicle_label,
    mission_group_key: null,
    score: null,
    confidence: null,
    reason: { summary: ["Assegnazione gia' presente (manuale o applicata in precedenza)"], details: {} },
    alternatives: [],
    warnings: [],
    suggested_fix: null,
    locked: false,
  };
}

function reviewItemFromDataIssue(row: AutoAssignPreviewServiceRow, alternatives: PlanItemAlternative[]): PlanItemDraft {
  return {
    service_id: row.service_id,
    status: "review",
    proposed_driver_id: null,
    proposed_driver_name: null,
    proposed_vehicle_id: null,
    proposed_vehicle_label: null,
    mission_group_key: null,
    score: null,
    confidence: row.confidence_score,
    reason: { summary: row.review_reasons, details: { hard_constraints: row.hard_constraints } },
    alternatives,
    warnings: [],
    suggested_fix: null,
    locked: false,
  };
}

function unresolvedItem(row: AutoAssignPreviewServiceRow, reasonSummary: string, conflictType: string | null): PlanItemDraft {
  return {
    service_id: row.service_id,
    status: "unresolved",
    proposed_driver_id: null,
    proposed_driver_name: null,
    proposed_vehicle_id: null,
    proposed_vehicle_label: null,
    mission_group_key: null,
    score: null,
    confidence: null,
    reason: { summary: [reasonSummary], details: { conflict_type: conflictType } },
    alternatives: [],
    warnings: [],
    suggested_fix: null,
    locked: false,
  };
}

export function classifyPlanItems(args: ClassifyPlanArgs): PlanItemDraft[] {
  const items: PlanItemDraft[] = [];

  const groupByServiceId = new Map<string, PlannerResult["proposed_groups"][number]>();
  for (const group of args.planning.proposed_groups) {
    for (const service of group.services) groupByServiceId.set(service.service_id, group);
  }
  const unplannedByServiceId = new Map(args.planning.unplanned.map((entry) => [entry.service_id, entry]));
  const conflictByServiceId = new Map(args.planning.conflicts.map((entry) => [entry.service_id, entry]));

  for (const row of args.preview.services) {
    const serviceId = row.service_id;

    // Caso 8/14: un item bloccato esplicitamente in precedenza (its.lock_assignment)
    // resta identico, indipendentemente da cosa proporrebbe ora il planner.
    const previous = args.previousItemsByServiceId?.get(serviceId);
    if (previous?.locked) {
      items.push({ ...previous, status: "locked" });
      continue;
    }

    const assignment = args.assignmentByServiceId.get(serviceId) ?? null;
    if (assignment && (assignment.locked_by_operator || row.already_assigned)) {
      items.push(manualItem(serviceId, assignment));
      continue;
    }

    if (row.needs_review) {
      items.push(reviewItemFromDataIssue(row, args.rankAlternatives?.(row) ?? []));
      continue;
    }

    const group = groupByServiceId.get(serviceId);
    if (group) {
      const isAutoSafe =
        group.score >= AUTO_SAFE_SCORE_THRESHOLD &&
        group.confidence >= AUTO_SAFE_CONFIDENCE_THRESHOLD &&
        group.warnings.length === 0;
      items.push({
        service_id: serviceId,
        status: isAutoSafe ? "auto_safe" : "review",
        proposed_driver_id: group.driver_id,
        proposed_driver_name: group.driver_name,
        proposed_vehicle_id: group.vehicle_id,
        proposed_vehicle_label: group.vehicle_label,
        mission_group_key: group.temp_group_id,
        score: group.score,
        confidence: group.confidence,
        reason: { summary: group.explanation, details: { services_in_mission: group.services.length } },
        alternatives: isAutoSafe ? [] : args.rankAlternatives?.(row) ?? [],
        warnings: group.warnings,
        suggested_fix: null,
        locked: false,
      });
      continue;
    }

    const unplanned = unplannedByServiceId.get(serviceId);
    const conflict = conflictByServiceId.get(serviceId);
    if (unplanned || conflict) {
      items.push(unresolvedItem(row, unplanned?.reason ?? conflict?.reason ?? "Nessun candidato disponibile", conflict?.conflict_type ?? null));
      continue;
    }

    // Servizio presente nella preview ma mai valutato dal planner (es.
    // disponibilita' del giorno non confermata): mai scartato in silenzio.
    items.push(unresolvedItem(row, "Servizio non elaborato dal planner (disponibilita' del giorno non confermata o candidato escluso)", null));
  }

  return items;
}
