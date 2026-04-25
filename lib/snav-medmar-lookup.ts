/**
 * Lookup client-side per porto e orario prelevamento SNAV / MEDMAR.
 * Fonte: departure-pickup-rules.ts (SNAV_DIRECT, MEDMAR_DIRECT) e ferry_schedules (DB seed).
 *
 * Usato nel form prenotazione /services/new per auto-fill senza API call.
 */

export type PickupZona = "ischia" | "lacco" | "casamicciola" | "barano" | "forio";

// Restrizione stagionale/giornaliera.
// from/to = "MM-DD" (anno non rilevante, solo mese e giorno)
// days = array getDay() JS: 0=Dom, 1=Lun, 2=Mar, 3=Mer, 4=Gio, 5=Ven, 6=Sab
// Se days è assente → valido tutti i giorni nel periodo
export interface ScheduleRestriction {
  from: string;   // "MM-DD"
  to:   string;   // "MM-DD"
  days?: number[];
}

export interface SnavMedmarRule {
  company: "snav" | "medmar";
  ferry_time: string;
  porto_ischia: string;
  porto_continente: string;
  pickup_by_zona: Record<PickupZona, string>;
  // Se assente → tutto l'anno tutti i giorni
  // Se presente → valido se la data ricade in ALMENO UNA delle restrizioni
  restrictions?: ScheduleRestriction[];
}

export interface FerryArrival {
  company: "snav" | "medmar";
  ferry_dep_time: string;   // ora partenza dal continente
  ferry_arr_time: string;   // ora arrivo a Ischia (porto_ischia)
  porto_ischia: string;
  restrictions?: ScheduleRestriction[];
}

// ── Helper disponibilità ──────────────────────────────────────────────────────

function mmdd(date: Date): string {
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${m}-${d}`;
}

export function isAvailableOnDate(restrictions: ScheduleRestriction[] | undefined, isoDate: string): boolean {
  if (!restrictions || restrictions.length === 0) return true;
  const d = new Date(isoDate + "T12:00:00");
  const md = mmdd(d);
  const dow = d.getDay();
  return restrictions.some((r) => {
    if (md < r.from || md > r.to) return false;
    if (r.days && !r.days.includes(dow)) return false;
    return true;
  });
}

// Shortcuts restrizioni frequenti
const VEN_SAB_DOM     = [5, 6, 0] as number[]; // Venerdì, Sabato, Domenica
const VEN_SAB_DOM_LUN = [5, 6, 0, 1] as number[]; // Venerdì, Sabato, Domenica, Lunedì
const VEN_DOM         = [5, 0] as number[];    // Venerdì, Domenica

// Dal 01/06 al 28/09 — Ven/Sab/Dom
const R_GIU_SET_FSD: ScheduleRestriction[] = [{ from: "06-01", to: "09-28", days: VEN_SAB_DOM }];

// Dal 06/06 al 13/09 — Ven/Sab/Dom/Lun
const R_GIU_SET_FSDL: ScheduleRestriction[] = [{ from: "06-06", to: "09-13", days: VEN_SAB_DOM_LUN }];

// Dal 02/05 al 30/05 Ven/Dom OPPURE dal 01/06 al 30/09 tutti i giorni
const R_MAG_SET_DOPPIO: ScheduleRestriction[] = [
  { from: "05-02", to: "05-30", days: VEN_DOM },
  { from: "06-01", to: "09-30" },
];

// ── Partenze Ischia → Continente ─────────────────────────────────────────────
export const DEPARTURE_RULES: SnavMedmarRule[] = [
  // SNAV — tutto l'anno, tutti i giorni
  { company: "snav", ferry_time: "07:10", porto_ischia: "CASAMICCIOLA", porto_continente: "NAPOLI", pickup_by_zona: { ischia: "06:30", lacco: "06:30", casamicciola: "06:30", barano: "06:15", forio: "06:20" } },
  { company: "snav", ferry_time: "09:45", porto_ischia: "CASAMICCIOLA", porto_continente: "NAPOLI", pickup_by_zona: { ischia: "08:40", lacco: "08:45", casamicciola: "08:45", barano: "08:15", forio: "08:30" } },
  { company: "snav", ferry_time: "14:00", porto_ischia: "CASAMICCIOLA", porto_continente: "NAPOLI", pickup_by_zona: { ischia: "12:30", lacco: "12:40", casamicciola: "12:50", barano: "12:00", forio: "12:30" } },
  { company: "snav", ferry_time: "17:40", porto_ischia: "CASAMICCIOLA", porto_continente: "NAPOLI", pickup_by_zona: { ischia: "16:45", lacco: "16:50", casamicciola: "16:50", barano: "16:30", forio: "16:45" } },
  { company: "snav", ferry_time: "20:00", porto_ischia: "CASAMICCIOLA", porto_continente: "NAPOLI", pickup_by_zona: { ischia: "19:00", lacco: "19:00", casamicciola: "19:00", barano: "19:00", forio: "19:00" } },

  // SNAV — 01/06–28/09, Ven/Sab/Dom
  { company: "snav", ferry_time: "10:30", porto_ischia: "CASAMICCIOLA", porto_continente: "NAPOLI", pickup_by_zona: { ischia: "08:40", lacco: "08:45", casamicciola: "08:45", barano: "08:15", forio: "08:30" }, restrictions: R_GIU_SET_FSD },
  { company: "snav", ferry_time: "12:50", porto_ischia: "CASAMICCIOLA", porto_continente: "NAPOLI", pickup_by_zona: { ischia: "11:50", lacco: "11:50", casamicciola: "11:50", barano: "11:30", forio: "11:45" }, restrictions: R_GIU_SET_FSD },
  { company: "snav", ferry_time: "18:30", porto_ischia: "CASAMICCIOLA", porto_continente: "NAPOLI", pickup_by_zona: { ischia: "17:15", lacco: "17:30", casamicciola: "17:30", barano: "17:00", forio: "16:45" }, restrictions: R_GIU_SET_FSD },

  // SNAV — 02/05–30/05 Ven/Dom | 01/06–30/09 tutti i giorni
  { company: "snav", ferry_time: "15:15", porto_ischia: "CASAMICCIOLA", porto_continente: "NAPOLI", pickup_by_zona: { ischia: "14:15", lacco: "14:15", casamicciola: "14:30", barano: "14:00", forio: "14:00" }, restrictions: R_MAG_SET_DOPPIO },

  // SNAV — 06/06–13/09, Ven/Sab/Dom/Lun
  { company: "snav", ferry_time: "13:15", porto_ischia: "CASAMICCIOLA", porto_continente: "NAPOLI", pickup_by_zona: { ischia: "11:50", lacco: "11:50", casamicciola: "11:50", barano: "11:30", forio: "11:45" }, restrictions: R_GIU_SET_FSDL },

  // MEDMAR — Napoli → Ischia Porto
  { company: "medmar", ferry_time: "06:25", porto_ischia: "ISCHIA PORTO", porto_continente: "NAPOLI",   pickup_by_zona: { ischia: "05:30", lacco: "05:20", casamicciola: "05:30", barano: "05:00", forio: "05:00" } },
  { company: "medmar", ferry_time: "10:35", porto_ischia: "ISCHIA PORTO", porto_continente: "NAPOLI",   pickup_by_zona: { ischia: "08:40", lacco: "08:45", casamicciola: "08:45", barano: "08:15", forio: "08:30" } },
  { company: "medmar", ferry_time: "17:00", porto_ischia: "ISCHIA PORTO", porto_continente: "NAPOLI",   pickup_by_zona: { ischia: "15:30", lacco: "15:30", casamicciola: "15:30", barano: "15:15", forio: "15:15" } },

  // MEDMAR — Pozzuoli → Casamicciola / Ischia Porto
  { company: "medmar", ferry_time: "06:20", porto_ischia: "CASAMICCIOLA", porto_continente: "POZZUOLI", pickup_by_zona: { ischia: "05:30", lacco: "05:20", casamicciola: "05:30", barano: "05:00", forio: "05:00" } },
  { company: "medmar", ferry_time: "08:10", porto_ischia: "ISCHIA PORTO",  porto_continente: "POZZUOLI", pickup_by_zona: { ischia: "06:40", lacco: "06:45", casamicciola: "06:45", barano: "06:15", forio: "06:30" } },
  { company: "medmar", ferry_time: "10:10", porto_ischia: "CASAMICCIOLA", porto_continente: "POZZUOLI", pickup_by_zona: { ischia: "08:40", lacco: "08:45", casamicciola: "08:45", barano: "08:15", forio: "08:30" } },
  { company: "medmar", ferry_time: "11:10", porto_ischia: "ISCHIA PORTO",  porto_continente: "POZZUOLI", pickup_by_zona: { ischia: "09:40", lacco: "09:45", casamicciola: "09:45", barano: "09:15", forio: "09:30" } },
  { company: "medmar", ferry_time: "13:35", porto_ischia: "CASAMICCIOLA", porto_continente: "POZZUOLI", pickup_by_zona: { ischia: "12:15", lacco: "12:15", casamicciola: "12:15", barano: "12:00", forio: "12:00" } },
  { company: "medmar", ferry_time: "15:00", porto_ischia: "ISCHIA PORTO",  porto_continente: "POZZUOLI", pickup_by_zona: { ischia: "13:30", lacco: "13:30", casamicciola: "13:30", barano: "13:15", forio: "13:15" } },
  { company: "medmar", ferry_time: "16:50", porto_ischia: "CASAMICCIOLA", porto_continente: "POZZUOLI", pickup_by_zona: { ischia: "15:30", lacco: "15:30", casamicciola: "15:30", barano: "15:15", forio: "15:15" } },
];

// ── Arrivi Continente → Ischia ────────────────────────────────────────────────
// ferry_dep_time = ora partenza dal continente
// ferry_arr_time = ora arrivo a Ischia (porto_ischia)
// SNAV: 65 min | MEDMAR Pozzuoli: 65 min | MEDMAR Napoli: 95 min
export const ARRIVAL_SCHEDULES: FerryArrival[] = [
  // SNAV — tutto l'anno, tutti i giorni (65 min)
  { company: "snav", ferry_dep_time: "08:30", ferry_arr_time: "09:35", porto_ischia: "CASAMICCIOLA" },
  { company: "snav", ferry_dep_time: "12:30", ferry_arr_time: "13:35", porto_ischia: "CASAMICCIOLA" },
  { company: "snav", ferry_dep_time: "16:20", ferry_arr_time: "17:25", porto_ischia: "CASAMICCIOLA" },
  { company: "snav", ferry_dep_time: "19:00", ferry_arr_time: "20:05", porto_ischia: "CASAMICCIOLA" },

  // SNAV — 06/06–13/09, Ven/Sab/Dom/Lun (65 min)
  { company: "snav", ferry_dep_time: "08:10", ferry_arr_time: "09:15", porto_ischia: "CASAMICCIOLA", restrictions: R_GIU_SET_FSDL },
  { company: "snav", ferry_dep_time: "15:10", ferry_arr_time: "16:15", porto_ischia: "CASAMICCIOLA", restrictions: R_GIU_SET_FSDL },

  // SNAV — 01/06–28/09, Ven/Sab/Dom (65 min)
  { company: "snav", ferry_dep_time: "09:20", ferry_arr_time: "10:25", porto_ischia: "CASAMICCIOLA", restrictions: R_GIU_SET_FSD },
  { company: "snav", ferry_dep_time: "13:55", ferry_arr_time: "15:00", porto_ischia: "CASAMICCIOLA", restrictions: R_GIU_SET_FSD },
  { company: "snav", ferry_dep_time: "17:10", ferry_arr_time: "18:15", porto_ischia: "CASAMICCIOLA", restrictions: R_GIU_SET_FSD },

  // MEDMAR — Pozzuoli → Ischia Porto (65 min)
  { company: "medmar", ferry_dep_time: "06:25", ferry_arr_time: "07:30", porto_ischia: "ISCHIA PORTO" },
  { company: "medmar", ferry_dep_time: "09:40", ferry_arr_time: "10:45", porto_ischia: "ISCHIA PORTO" },
  { company: "medmar", ferry_dep_time: "13:30", ferry_arr_time: "14:35", porto_ischia: "ISCHIA PORTO" },
  { company: "medmar", ferry_dep_time: "16:30", ferry_arr_time: "17:35", porto_ischia: "ISCHIA PORTO" },

  // MEDMAR — Pozzuoli → Casamicciola (65 min)
  { company: "medmar", ferry_dep_time: "08:15", ferry_arr_time: "09:20", porto_ischia: "CASAMICCIOLA" },
  { company: "medmar", ferry_dep_time: "12:00", ferry_arr_time: "13:05", porto_ischia: "CASAMICCIOLA" },
  { company: "medmar", ferry_dep_time: "15:00", ferry_arr_time: "16:05", porto_ischia: "CASAMICCIOLA" },
  { company: "medmar", ferry_dep_time: "18:30", ferry_arr_time: "19:35", porto_ischia: "CASAMICCIOLA" },

  // MEDMAR — Napoli → Ischia Porto (95 min)
  { company: "medmar", ferry_dep_time: "08:40", ferry_arr_time: "10:15", porto_ischia: "ISCHIA PORTO" },
  { company: "medmar", ferry_dep_time: "14:20", ferry_arr_time: "15:55", porto_ischia: "ISCHIA PORTO" },
  { company: "medmar", ferry_dep_time: "19:00", ferry_arr_time: "20:35", porto_ischia: "ISCHIA PORTO" },
];

// ── Funzioni di lookup ────────────────────────────────────────────────────────

export function getArrivalPorto(company: "snav" | "medmar", depTime: string): string | null {
  const match = ARRIVAL_SCHEDULES.find((s) => s.company === company && s.ferry_dep_time === depTime);
  return match?.porto_ischia ?? null;
}

export function getFerryArrivalAtIschia(depTime: string | null, bookingKind: string | null): string | null {
  if (!depTime || !bookingKind) return null;
  const t = depTime.slice(0, 5);
  let company: "snav" | "medmar" | null = null;
  if (bookingKind === "formula_snav") company = "snav";
  else if (bookingKind === "formula_medmar_napoli" || bookingKind === "formula_medmar_pozzuoli") company = "medmar";
  if (!company) return null;
  const match = ARRIVAL_SCHEDULES.find((s) => s.company === company && s.ferry_dep_time === t);
  return match?.ferry_arr_time ?? null;
}

export function getDepartureRule(company: "snav" | "medmar", ferryTime: string): SnavMedmarRule | null {
  return DEPARTURE_RULES.find((r) => r.company === company && r.ferry_time === ferryTime) ?? null;
}

export function getDeparturePickupTime(company: "snav" | "medmar", ferryTime: string, zona: PickupZona): string | null {
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

// Tutti gli orari (statici, senza filtro data)
export const SNAV_ARRIVAL_TIMES   = ARRIVAL_SCHEDULES.filter((s) => s.company === "snav").map((s) => s.ferry_dep_time);
export const MEDMAR_ARRIVAL_TIMES = ARRIVAL_SCHEDULES.filter((s) => s.company === "medmar").map((s) => s.ferry_dep_time);
export const SNAV_DEPARTURE_TIMES   = DEPARTURE_RULES.filter((r) => r.company === "snav").map((r) => r.ferry_time);
export const MEDMAR_DEPARTURE_TIMES = DEPARTURE_RULES.filter((r) => r.company === "medmar").map((r) => r.ferry_time);

// Orari MEDMAR suddivisi per porto continente
export const MEDMAR_NAPOLI_ARRIVAL_TIMES   = ARRIVAL_SCHEDULES.filter((s) => s.company === "medmar" && s.porto_ischia === "ISCHIA PORTO" && ["08:40","14:20","19:00"].includes(s.ferry_dep_time)).map((s) => s.ferry_dep_time);
export const MEDMAR_POZZUOLI_ARRIVAL_TIMES = ARRIVAL_SCHEDULES.filter((s) => s.company === "medmar" && !["08:40","14:20","19:00"].includes(s.ferry_dep_time)).map((s) => s.ferry_dep_time);
export const MEDMAR_NAPOLI_DEPARTURE_TIMES   = DEPARTURE_RULES.filter((r) => r.company === "medmar" && r.porto_continente === "NAPOLI").map((r) => r.ferry_time);
export const MEDMAR_POZZUOLI_DEPARTURE_TIMES = DEPARTURE_RULES.filter((r) => r.company === "medmar" && r.porto_continente === "POZZUOLI").map((r) => r.ferry_time);

// Orari MEDMAR con porto ischia (per label nei select)
export const MEDMAR_NAPOLI_ARRIVALS_WITH_PORTO = ARRIVAL_SCHEDULES
  .filter((s) => s.company === "medmar" && ["08:40","14:20","19:00"].includes(s.ferry_dep_time))
  .map((s) => ({ time: s.ferry_dep_time, porto: s.porto_ischia }));

export const MEDMAR_POZZUOLI_ARRIVALS_WITH_PORTO = ARRIVAL_SCHEDULES
  .filter((s) => s.company === "medmar" && !["08:40","14:20","19:00"].includes(s.ferry_dep_time))
  .sort((a, b) => a.ferry_dep_time.localeCompare(b.ferry_dep_time))
  .map((s) => ({ time: s.ferry_dep_time, porto: s.porto_ischia }));

export const MEDMAR_NAPOLI_DEPARTURES_WITH_PORTO = DEPARTURE_RULES
  .filter((r) => r.company === "medmar" && r.porto_continente === "NAPOLI")
  .map((r) => ({ time: r.ferry_time, porto: r.porto_ischia }));

export const MEDMAR_POZZUOLI_DEPARTURES_WITH_PORTO = DEPARTURE_RULES
  .filter((r) => r.company === "medmar" && r.porto_continente === "POZZUOLI")
  .map((r) => ({ time: r.ferry_time, porto: r.porto_ischia }));

// Orari filtrati per data specifica
export function getAvailableSnavArrivalTimes(isoDate: string): string[] {
  return ARRIVAL_SCHEDULES
    .filter((s) => s.company === "snav" && isAvailableOnDate(s.restrictions, isoDate))
    .map((s) => s.ferry_dep_time);
}

export function getAvailableSnavDepartureTimes(isoDate: string): string[] {
  return DEPARTURE_RULES
    .filter((r) => r.company === "snav" && isAvailableOnDate(r.restrictions, isoDate))
    .map((r) => r.ferry_time);
}
