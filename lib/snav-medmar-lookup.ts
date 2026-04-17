/**
 * Lookup client-side per porto e orario prelevamento SNAV / MEDMAR.
 * Fonte: departure-pickup-rules.ts (SNAV_DIRECT, MEDMAR_DIRECT) e ferry_schedules (DB seed).
 *
 * Usato nel form prenotazione /services/new per auto-fill senza API call.
 */

export type PickupZona = "ischia" | "lacco" | "casamicciola" | "barano" | "forio";

export interface SnavMedmarRule {
  company: "snav" | "medmar";
  ferry_time: string;        // HH:MM — orario traghetto da Ischia
  porto_ischia: string;      // "CASAMICCIOLA" | "ISCHIA PORTO"
  porto_continente: string;  // "NAPOLI" | "POZZUOLI"
  pickup_by_zona: Record<PickupZona, string>; // zona → orario prelievo hotel
}

export interface FerryArrival {
  company: "snav" | "medmar";
  ferry_dep_time: string; // HH:MM — ora partenza dal continente
  porto_ischia: string;   // porto di arrivo a Ischia
}

// ── Partenze Ischia → Continente ─────────────────────────────────────────────
// Fonte: SNAV_DIRECT e MEDMAR_DIRECT in departure-pickup-rules.ts
export const DEPARTURE_RULES: SnavMedmarRule[] = [
  // SNAV
  { company: "snav", ferry_time: "07:10", porto_ischia: "CASAMICCIOLA", porto_continente: "NAPOLI",   pickup_by_zona: { ischia: "06:30", lacco: "06:30", casamicciola: "06:30", barano: "06:15", forio: "06:20" } },
  { company: "snav", ferry_time: "09:45", porto_ischia: "CASAMICCIOLA", porto_continente: "NAPOLI",   pickup_by_zona: { ischia: "08:40", lacco: "08:45", casamicciola: "08:45", barano: "08:15", forio: "08:30" } },
  { company: "snav", ferry_time: "10:30", porto_ischia: "CASAMICCIOLA", porto_continente: "NAPOLI",   pickup_by_zona: { ischia: "08:40", lacco: "08:45", casamicciola: "08:45", barano: "08:15", forio: "08:30" } },
  { company: "snav", ferry_time: "12:50", porto_ischia: "CASAMICCIOLA", porto_continente: "NAPOLI",   pickup_by_zona: { ischia: "11:50", lacco: "11:50", casamicciola: "11:50", barano: "11:30", forio: "11:45" } },
  { company: "snav", ferry_time: "13:15", porto_ischia: "CASAMICCIOLA", porto_continente: "NAPOLI",   pickup_by_zona: { ischia: "11:50", lacco: "11:50", casamicciola: "11:50", barano: "11:30", forio: "11:45" } },
  { company: "snav", ferry_time: "14:00", porto_ischia: "CASAMICCIOLA", porto_continente: "NAPOLI",   pickup_by_zona: { ischia: "12:30", lacco: "12:40", casamicciola: "12:50", barano: "12:00", forio: "12:30" } },
  { company: "snav", ferry_time: "15:15", porto_ischia: "CASAMICCIOLA", porto_continente: "NAPOLI",   pickup_by_zona: { ischia: "14:15", lacco: "14:15", casamicciola: "14:30", barano: "14:00", forio: "14:00" } },
  { company: "snav", ferry_time: "17:40", porto_ischia: "CASAMICCIOLA", porto_continente: "NAPOLI",   pickup_by_zona: { ischia: "16:45", lacco: "16:50", casamicciola: "16:50", barano: "16:30", forio: "16:45" } },
  { company: "snav", ferry_time: "18:30", porto_ischia: "CASAMICCIOLA", porto_continente: "NAPOLI",   pickup_by_zona: { ischia: "17:15", lacco: "17:30", casamicciola: "17:30", barano: "17:00", forio: "16:45" } },
  { company: "snav", ferry_time: "20:00", porto_ischia: "CASAMICCIOLA", porto_continente: "NAPOLI",   pickup_by_zona: { ischia: "19:00", lacco: "19:00", casamicciola: "19:00", barano: "19:00", forio: "19:00" } },

  // MEDMAR — Napoli → Ischia Porto (partenze da Ischia Porto)
  { company: "medmar", ferry_time: "06:25", porto_ischia: "ISCHIA PORTO", porto_continente: "NAPOLI",   pickup_by_zona: { ischia: "05:30", lacco: "05:20", casamicciola: "05:30", barano: "05:00", forio: "05:00" } },
  { company: "medmar", ferry_time: "10:35", porto_ischia: "ISCHIA PORTO", porto_continente: "NAPOLI",   pickup_by_zona: { ischia: "08:40", lacco: "08:45", casamicciola: "08:45", barano: "08:15", forio: "08:30" } },
  { company: "medmar", ferry_time: "17:00", porto_ischia: "ISCHIA PORTO", porto_continente: "NAPOLI",   pickup_by_zona: { ischia: "15:30", lacco: "15:30", casamicciola: "15:30", barano: "15:15", forio: "15:15" } },

  // MEDMAR — Pozzuoli → Casamicciola (partenze da Casamicciola)
  { company: "medmar", ferry_time: "06:20", porto_ischia: "CASAMICCIOLA", porto_continente: "POZZUOLI", pickup_by_zona: { ischia: "05:30", lacco: "05:20", casamicciola: "05:30", barano: "05:00", forio: "05:00" } },
  { company: "medmar", ferry_time: "08:10", porto_ischia: "ISCHIA PORTO", porto_continente: "POZZUOLI", pickup_by_zona: { ischia: "06:40", lacco: "06:45", casamicciola: "06:45", barano: "06:15", forio: "06:30" } },
  { company: "medmar", ferry_time: "10:10", porto_ischia: "CASAMICCIOLA", porto_continente: "POZZUOLI", pickup_by_zona: { ischia: "08:40", lacco: "08:45", casamicciola: "08:45", barano: "08:15", forio: "08:30" } },
  { company: "medmar", ferry_time: "11:10", porto_ischia: "ISCHIA PORTO", porto_continente: "POZZUOLI", pickup_by_zona: { ischia: "09:40", lacco: "09:45", casamicciola: "09:45", barano: "09:15", forio: "09:30" } },
  { company: "medmar", ferry_time: "13:35", porto_ischia: "CASAMICCIOLA", porto_continente: "POZZUOLI", pickup_by_zona: { ischia: "12:15", lacco: "12:15", casamicciola: "12:15", barano: "12:00", forio: "12:00" } },
  { company: "medmar", ferry_time: "15:00", porto_ischia: "ISCHIA PORTO", porto_continente: "POZZUOLI", pickup_by_zona: { ischia: "13:30", lacco: "13:30", casamicciola: "13:30", barano: "13:15", forio: "13:15" } },
  { company: "medmar", ferry_time: "16:50", porto_ischia: "CASAMICCIOLA", porto_continente: "POZZUOLI", pickup_by_zona: { ischia: "15:30", lacco: "15:30", casamicciola: "15:30", barano: "15:15", forio: "15:15" } },
];

// ── Arrivi Continente → Ischia ────────────────────────────────────────────────
// Fonte: ferry_schedules (migration 0089) — arrivi (mainland_to_ischia)
export const ARRIVAL_SCHEDULES: FerryArrival[] = [
  // SNAV — Napoli → Casamicciola
  { company: "snav", ferry_dep_time: "08:10", porto_ischia: "CASAMICCIOLA" },
  { company: "snav", ferry_dep_time: "08:30", porto_ischia: "CASAMICCIOLA" },
  { company: "snav", ferry_dep_time: "09:20", porto_ischia: "CASAMICCIOLA" },
  { company: "snav", ferry_dep_time: "11:30", porto_ischia: "CASAMICCIOLA" },
  { company: "snav", ferry_dep_time: "12:30", porto_ischia: "CASAMICCIOLA" },
  { company: "snav", ferry_dep_time: "13:55", porto_ischia: "CASAMICCIOLA" },
  { company: "snav", ferry_dep_time: "15:10", porto_ischia: "CASAMICCIOLA" },
  { company: "snav", ferry_dep_time: "16:20", porto_ischia: "CASAMICCIOLA" },
  { company: "snav", ferry_dep_time: "17:10", porto_ischia: "CASAMICCIOLA" },
  { company: "snav", ferry_dep_time: "19:00", porto_ischia: "CASAMICCIOLA" },

  // MEDMAR — Pozzuoli → Ischia Porto
  { company: "medmar", ferry_dep_time: "06:25", porto_ischia: "ISCHIA PORTO" },
  { company: "medmar", ferry_dep_time: "09:40", porto_ischia: "ISCHIA PORTO" },
  { company: "medmar", ferry_dep_time: "13:30", porto_ischia: "ISCHIA PORTO" },
  { company: "medmar", ferry_dep_time: "16:30", porto_ischia: "ISCHIA PORTO" },

  // MEDMAR — Pozzuoli → Casamicciola
  { company: "medmar", ferry_dep_time: "08:15", porto_ischia: "CASAMICCIOLA" },
  { company: "medmar", ferry_dep_time: "12:00", porto_ischia: "CASAMICCIOLA" },
  { company: "medmar", ferry_dep_time: "15:00", porto_ischia: "CASAMICCIOLA" },
  { company: "medmar", ferry_dep_time: "18:30", porto_ischia: "CASAMICCIOLA" },

  // MEDMAR — Napoli → Ischia Porto
  { company: "medmar", ferry_dep_time: "08:40", porto_ischia: "ISCHIA PORTO" },
  { company: "medmar", ferry_dep_time: "14:20", porto_ischia: "ISCHIA PORTO" },
  { company: "medmar", ferry_dep_time: "19:00", porto_ischia: "ISCHIA PORTO" },
];

// ── Funzioni di lookup ────────────────────────────────────────────────────────

export function getArrivalPorto(company: "snav" | "medmar", depTime: string): string | null {
  const match = ARRIVAL_SCHEDULES.find((s) => s.company === company && s.ferry_dep_time === depTime);
  return match?.porto_ischia ?? null;
}

export function getDepartureRule(
  company: "snav" | "medmar",
  ferryTime: string
): SnavMedmarRule | null {
  return DEPARTURE_RULES.find((r) => r.company === company && r.ferry_time === ferryTime) ?? null;
}

export function getDeparturePickupTime(
  company: "snav" | "medmar",
  ferryTime: string,
  zona: PickupZona
): string | null {
  const rule = getDepartureRule(company, ferryTime);
  return rule?.pickup_by_zona[zona] ?? null;
}

export function normalizeZonaToPickup(rawZone: string | null): PickupZona {
  const z = (rawZone ?? "").toLowerCase().trim();
  if (z.includes("forio")) return "forio";
  if (z.includes("lacco")) return "lacco";
  if (z.includes("casamicciola")) return "casamicciola";
  if (z.includes("barano")) return "barano";
  return "ischia";
}

export const SNAV_ARRIVAL_TIMES = ARRIVAL_SCHEDULES.filter((s) => s.company === "snav").map((s) => s.ferry_dep_time);
export const MEDMAR_ARRIVAL_TIMES = ARRIVAL_SCHEDULES.filter((s) => s.company === "medmar").map((s) => s.ferry_dep_time);
export const SNAV_DEPARTURE_TIMES = DEPARTURE_RULES.filter((r) => r.company === "snav").map((r) => r.ferry_time);
export const MEDMAR_DEPARTURE_TIMES = DEPARTURE_RULES.filter((r) => r.company === "medmar").map((r) => r.ferry_time);
