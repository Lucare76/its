import { resolveOperationalTiming, connectionTypeFromKind, type OperationalTimingContext } from "@/lib/operational-timing-resolver";
import type { PrintService } from "@/lib/piano-giorno-print";

export type DeparturePickupHint = { pickup: string; label: string } | null;

/**
 * Decide se un booking_service_kind va instradato sul resolver treno/volo di
 * /departures. Riusa il classificatore canonico gia' esistente
 * (connectionTypeFromKind, lib/operational-timing-resolver.ts) invece di un
 * elenco di kind hardcoded nella pagina — che in precedenza copriva solo
 * 'transfer_train_hotel'/'transfer_airport_hotel' ESATTI, escludendo per
 * errore le varianti '_aliscafo' (la richiesta esplicita di aliscafo) e
 * '_exclusive'. 'transfer_port_hotel'/'formula_*' restano fuori (classificati
 * "ferry" dal classificatore, non "train"/"flight") e continuano sul percorso
 * Formula/porto-porto esistente in /departures.
 */
export function shouldUseTrainOrFlightResolver(kind: string | null | undefined): boolean {
  const type = connectionTypeFromKind(kind);
  return type === "train" || type === "flight";
}

/**
 * Hint di pickup per la pagina /departures, per un servizio con collegamento
 * treno/volo -> nave (transfer_train_hotel / transfer_airport_hotel, incluse
 * le varianti _aliscafo/_exclusive — vedi shouldUseTrainOrFlightResolver).
 * Unica fonte: resolveOperationalTiming — nessuna logica locale duplicata.
 * Ritorna null quando il pickup non e' determinabile (mai un pickup
 * inventato, mai '00:00'): l'UI di /departures gia' gestisce correttamente un
 * hint assente.
 */
export function buildTrainOrFlightPickupHint(
  service: PrintService,
  context: OperationalTimingContext
): DeparturePickupHint {
  const timing = resolveOperationalTiming(service, context);
  if (!timing.pickupTime) return null;
  const label = [timing.ferryCompany, timing.ferryTime, timing.ferryPort].filter(Boolean).join(" · ");
  return { pickup: timing.pickupTime, label: label || (timing.ruleSource ?? "") };
}
