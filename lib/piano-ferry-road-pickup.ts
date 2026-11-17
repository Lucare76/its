export const FERRY_PICKUP_DWELL_MINUTES = 5;
const PORT_LEAD_MINUTES = 15;

export type FerryRoadLeg = { betweenSeconds: number; toPortSeconds: number };
export type FerryRoadRouting = (previousServiceId: string, serviceId: string) => FerryRoadLeg | null;

export function scheduleFerryPickup(input: {
  first: number;
  nominal: number;
  sailing: number;
  mayShift: boolean;
  firstPax: number;
  secondPax: number;
  leg: FerryRoadLeg;
}) {
  const { first, nominal, sailing, mayShift, leg } = input;
  if (![first, nominal, sailing, leg.betweenSeconds, leg.toPortSeconds].every(Number.isFinite)) return null;
  if (nominal < first || leg.betweenSeconds < 0 || leg.toPortSeconds < 0) return null;
  const earliest = first + (input.firstPax <= 4 ? 4 : FERRY_PICKUP_DWELL_MINUTES) + Math.ceil(leg.betweenSeconds / 60);
  const pickup = Math.max(nominal, earliest);
  if (pickup > nominal && (!mayShift || pickup - nominal > 10)) return null;
  const portArrival = pickup + (input.secondPax <= 4 ? 4 : FERRY_PICKUP_DWELL_MINUTES) + Math.ceil(leg.toPortSeconds / 60);
  return portArrival <= sailing - PORT_LEAD_MINUTES ? { pickup, portArrival } : null;
}
