export const MEDMAR_SCHEDULE = {
  napoliToIschia: ["08:40", "14:20", "19:00"],
  ischiaToNapoli: ["06:20", "10:35", "17:00"],
  pozzuoliToIschia: ["09:40", "13:30", "16:30"],
  ischiaToPozzuoli: ["08:10", "11:10", "15:00"],
  casamicciolaToPozzuoli: ["06:20", "10:10", "13:35", "16:50"],
  pozzuoliToCasamicciola: ["08:15", "12:00", "15:00", "18:30"]
} as const;

export function findKnownMedmarRouteByTime(value?: string | null) {
  if (!value) return null;

  if (MEDMAR_SCHEDULE.napoliToIschia.includes(value as (typeof MEDMAR_SCHEDULE.napoliToIschia)[number])) {
    return { from: "NAPOLI", to: "ISCHIA" } as const;
  }

  if (MEDMAR_SCHEDULE.ischiaToNapoli.includes(value as (typeof MEDMAR_SCHEDULE.ischiaToNapoli)[number])) {
    return { from: "ISCHIA", to: "NAPOLI" } as const;
  }

  if (MEDMAR_SCHEDULE.pozzuoliToIschia.includes(value as (typeof MEDMAR_SCHEDULE.pozzuoliToIschia)[number])) {
    return { from: "POZZUOLI", to: "ISCHIA" } as const;
  }

  if (MEDMAR_SCHEDULE.ischiaToPozzuoli.includes(value as (typeof MEDMAR_SCHEDULE.ischiaToPozzuoli)[number])) {
    return { from: "ISCHIA", to: "POZZUOLI" } as const;
  }

  if (MEDMAR_SCHEDULE.casamicciolaToPozzuoli.includes(value as (typeof MEDMAR_SCHEDULE.casamicciolaToPozzuoli)[number])) {
    return { from: "CASAMICCIOLA", to: "POZZUOLI" } as const;
  }

  if (MEDMAR_SCHEDULE.pozzuoliToCasamicciola.includes(value as (typeof MEDMAR_SCHEDULE.pozzuoliToCasamicciola)[number])) {
    return { from: "POZZUOLI", to: "CASAMICCIOLA" } as const;
  }

  return null;
}

