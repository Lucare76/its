/**
 * Ranking di candidati (autista+mezzo) per UN singolo servizio — usato per
 * popolare le "alternative" mostrate a Mario su un item in stato review
 * (lib/server/assignment-engine/classify-plan.ts non lo calcola da solo:
 * lo riceve iniettato da build-plan.ts perche' richiede la pool live di
 * autisti/mezzi/impegni del giorno).
 *
 * Riusa gli stessi vincoli duri gia' in uso dal planner missioni
 * (lib/piano-driver-availability.ts canDriverCoverInterval,
 * lib/piano-driver-vehicle-eligibility.ts canDriverUseVehicle): un candidato
 * che viola un vincolo duro non entra mai in classifica, non riceve un
 * punteggio penalizzato — coerente con "candidate = INVALID" del principio
 * architetturale (mai convertire un vincolo duro in penalita').
 */
import { canDriverCoverInterval } from "@/lib/piano-driver-availability";
import { canDriverUseVehicle } from "@/lib/piano-driver-vehicle-eligibility";
import type { PlanItemAlternative } from "@/lib/server/assignment-engine/classify-plan";

export type RankableDriver = {
  id: string;
  name: string;
  available?: boolean | null;
  available_from?: string | null;
  available_to?: string | null;
  max_vehicle_capacity?: number | null;
};

export type RankableVehicle = {
  id: string;
  label: string;
  capacity: number | null;
  available?: boolean | null;
};

export type RankServiceInput = {
  operational_time: string | null;
  pax: number | null;
};

function minutes(value?: string | null) {
  const match = String(value ?? "").match(/(\d{1,2}):(\d{2})/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/**
 * Ordina i driver per numero di servizi gia' assegnati oggi (crescente): a
 * parita' di vincoli, preferisce chi ha meno impegni — stesso principio di
 * bilanciamento del carico gia' usato da planAutoAssignPreview
 * (driverEvents.length come tie-break).
 */
export function rankCandidatesForService(args: {
  service: RankServiceInput;
  drivers: RankableDriver[];
  vehicles: RankableVehicle[];
  assignmentsCountByDriverId: Map<string, number>;
  excludeDriverIds?: Set<string>;
  limit?: number;
}): PlanItemAlternative[] {
  const limit = args.limit ?? 2;
  if (!args.service.operational_time) return [];
  const startMinutes = minutes(args.service.operational_time);
  if (startMinutes == null) return [];

  const requiredPax = args.service.pax ?? 0;
  const eligibleVehicles = args.vehicles.filter((vehicle) => vehicle.available !== false && (vehicle.capacity ?? 0) >= requiredPax);
  if (eligibleVehicles.length === 0) return [];
  const smallestVehicle = [...eligibleVehicles].sort((a, b) => (a.capacity ?? 0) - (b.capacity ?? 0))[0];

  const candidates: PlanItemAlternative[] = [];

  for (const driver of args.drivers) {
    if (args.excludeDriverIds?.has(driver.id)) continue;

    const availability = canDriverCoverInterval(
      { available: driver.available, available_from: driver.available_from, available_to: driver.available_to },
      { start_time: args.service.operational_time },
      { missingAvailability: "blocker", missingBounds: "warning" }
    );
    if (!availability.allowed) continue;

    const vehicleForDriver = eligibleVehicles.find((vehicle) => canDriverUseVehicle(driver, vehicle).allowed) ?? null;
    if (!vehicleForDriver) continue;
    const eligibility = canDriverUseVehicle(driver, vehicleForDriver);

    const reason: string[] = [];
    let score = 60;

    const currentLoad = args.assignmentsCountByDriverId.get(driver.id) ?? 0;
    if (currentLoad === 0) {
      score += 20;
      reason.push("Autista senza altri servizi assegnati oggi");
    } else {
      score += Math.max(0, 10 - currentLoad * 2);
      reason.push(`Autista con ${currentLoad} servizi gia' assegnati oggi`);
    }

    if (vehicleForDriver.id === smallestVehicle.id) {
      score += 10;
      reason.push(`Mezzo capienza ${vehicleForDriver.capacity ?? "?"} adeguata senza sovradimensionamento`);
    }

    if (availability.severity === "warning") {
      score -= 15;
      reason.push(availability.reason ?? "Disponibilita' autista non completamente dichiarata");
    }
    if (eligibility.severity === "warning") {
      score -= 5;
      reason.push(eligibility.reason ?? "Compatibilita' mezzo non verificabile");
    }

    candidates.push({
      driver_id: driver.id,
      driver_name: driver.name,
      vehicle_id: vehicleForDriver.id,
      vehicle_label: vehicleForDriver.label,
      score: Math.max(0, Math.min(100, score)),
      reason,
    });
  }

  return candidates.sort((a, b) => b.score - a.score).slice(0, limit);
}
