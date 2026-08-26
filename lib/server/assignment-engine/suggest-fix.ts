/**
 * Suggerimento di manovra operativa per un item "unresolved" (nessun
 * candidato valido trovato dal planner). Cerca UNA sola mossa: spostare un
 * servizio gia' assegnato ad un altro autista compatibile per liberare quel
 * driver+mezzo per il servizio bloccato.
 *
 * Vincoli espliciti dal requisito ("NON applicare automaticamente una
 * soluzione che modifica altre assegnazioni manuali/locked"):
 * - il servizio da spostare NON puo' essere 'manual' o 'locked';
 * - il driver di destinazione per il servizio spostato deve rispettare gli
 *   stessi vincoli duri (turno, capienza mezzo) di rank-candidates.ts;
 * - profondita' 1 (una sola mossa): non e' un risolutore generale, e' un
 *   suggerimento ispezionabile che Mario applica esplicitamente
 *   (APPLICA SOLUZIONE), mai automatico.
 */
import { canDriverCoverInterval } from "@/lib/piano-driver-availability";
import { canDriverUseVehicle } from "@/lib/piano-driver-vehicle-eligibility";
import type { PlanItemDraft } from "@/lib/server/assignment-engine/classify-plan";
import type { RankableDriver, RankableVehicle } from "@/lib/server/assignment-engine/rank-candidates";

export type SuggestedFixAction = {
  type: "move_service";
  service_id: string;
  from_driver_id: string;
  from_driver_name: string;
  to_driver_id: string;
  to_driver_name: string;
};

export type SuggestedFix = {
  description: string;
  actions: SuggestedFixAction[];
  frees_driver_id: string;
  frees_driver_name: string;
  frees_at: string | null;
};

export type UnresolvedServiceInput = {
  service_id: string;
  operational_time: string | null;
  pax: number | null;
};

function minutes(value?: string | null) {
  const match = String(value ?? "").match(/(\d{1,2}):(\d{2})/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

export function suggestOperationalFix(args: {
  blockedService: UnresolvedServiceInput;
  /** Item del piano gia' classificati per la giornata (per trovare servizi spostabili). */
  planItems: PlanItemDraft[];
  /** Info operativa (orario/pax) di ogni servizio nel piano, per rivalutare i vincoli dopo lo spostamento ipotetico. */
  serviceInfoById: Map<string, UnresolvedServiceInput>;
  drivers: RankableDriver[];
  vehicles: RankableVehicle[];
}): SuggestedFix | null {
  if (!args.blockedService.operational_time) return null;
  const blockedStart = minutes(args.blockedService.operational_time);
  if (blockedStart == null) return null;

  const movableItems = args.planItems.filter(
    (item) => item.status !== "manual" && item.status !== "locked" && item.proposed_driver_id
  );

  for (const item of movableItems) {
    const info = args.serviceInfoById.get(item.service_id);
    if (!info?.operational_time) continue;
    const itemStart = minutes(info.operational_time);
    if (itemStart == null) continue;
    // Considera solo servizi "vicini" nel tempo al servizio bloccato: uno
    // spostamento che libera un driver occupato lontano dall'orario del
    // servizio bloccato non lo aiuterebbe comunque.
    if (Math.abs(itemStart - blockedStart) > 120) continue;

    const currentDriverId = item.proposed_driver_id!;
    const currentDriver = args.drivers.find((driver) => driver.id === currentDriverId);
    if (!currentDriver) continue;

    // Il driver liberato deve poter coprire il servizio bloccato.
    const canCoverBlocked = canDriverCoverInterval(
      { available: currentDriver.available, available_from: currentDriver.available_from, available_to: currentDriver.available_to },
      { start_time: args.blockedService.operational_time },
      { missingAvailability: "blocker", missingBounds: "warning" }
    );
    if (!canCoverBlocked.allowed) continue;

    // Cerca un altro autista disponibile per il servizio da spostare.
    const alternativeDriver = args.drivers.find((driver) => {
      if (driver.id === currentDriverId) return false;
      const availability = canDriverCoverInterval(
        { available: driver.available, available_from: driver.available_from, available_to: driver.available_to },
        { start_time: info.operational_time },
        { missingAvailability: "blocker", missingBounds: "warning" }
      );
      if (!availability.allowed) return false;
      const vehicle = args.vehicles.find(
        (candidate) => candidate.available !== false && (candidate.capacity ?? 0) >= (info.pax ?? 0) && canDriverUseVehicle(driver, candidate).allowed
      );
      return Boolean(vehicle);
    });
    if (!alternativeDriver) continue;

    return {
      description: `Spostando il servizio delle ${info.operational_time} da ${currentDriver.name} a ${alternativeDriver.name}, ${currentDriver.name} diventa disponibile per il servizio delle ${args.blockedService.operational_time}.`,
      actions: [
        {
          type: "move_service",
          service_id: item.service_id,
          from_driver_id: currentDriverId,
          from_driver_name: currentDriver.name,
          to_driver_id: alternativeDriver.id,
          to_driver_name: alternativeDriver.name,
        },
      ],
      frees_driver_id: currentDriverId,
      frees_driver_name: currentDriver.name,
      frees_at: args.blockedService.operational_time,
    };
  }

  return null;
}
