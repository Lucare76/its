export const SNAV_SCHEDULE = {
  napoliBeverelloToCasamicciola: ["08:30", "12:30", "16:20", "19:00"],
  casamicciolaToNapoliBeverello: ["07:10", "09:45", "14:00", "17:40"]
} as const;

export function isKnownSnavTime(value?: string | null) {
  if (!value) return false;
  return (
    SNAV_SCHEDULE.napoliBeverelloToCasamicciola.includes(value as (typeof SNAV_SCHEDULE.napoliBeverelloToCasamicciola)[number]) ||
    SNAV_SCHEDULE.casamicciolaToNapoliBeverello.includes(value as (typeof SNAV_SCHEDULE.casamicciolaToNapoliBeverello)[number])
  );
}

