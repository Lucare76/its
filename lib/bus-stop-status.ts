// PROMPT "Fermate bus" — Fase 13: classificazione stato fermata, pura e
// condivisa (client + server), mai duplicata nel componente pagina.

export type BusStopStatus = "active" | "incomplete" | "unused" | "review" | "inactive";

export const BUS_STOP_STATUS_LABELS: Record<BusStopStatus, string> = {
  active: "Attiva",
  incomplete: "Da completare",
  unused: "Mai utilizzata",
  review: "Da verificare",
  inactive: "Disattivata"
};

// Nomi interi (non parte di un nome più descrittivo) troppo generici per
// essere una fermata affidabile senza revisione umana — visti nell'audit
// reale del catalogo (import storici mai rifiniti).
const GENERIC_STOP_NAME_TOKENS = new Set(["CASELLO", "AUTOSTRADALE", "STAZIONE", "PARCHEGGIO", "FERMATA"]);

function normalizeForCheck(value: string) {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

export function isGenericPlaceholderStopName(stopName: string) {
  const normalized = normalizeForCheck(stopName);
  return GENERIC_STOP_NAME_TOKENS.has(normalized);
}

export type BusStopClassificationInput = {
  active: boolean;
  stopName: string;
  city: string;
  pickupNote: string | null | undefined;
  serviceCount: number;
  hasDuplicateStopOrder?: boolean;
  hasNearDuplicateName?: boolean;
};

// Priorità: disattivata > da verificare (integrità nome/ordine sospetta) >
// mai utilizzata > da completare (manca il punto di carico) > attiva.
// Una fermata mai usata con nome generico resta "da verificare" (il
// problema è il dato stesso, non solo l'assenza di traffico).
export function classifyBusStopStatus(input: BusStopClassificationInput): BusStopStatus {
  if (!input.active) return "inactive";

  const nameOrCityMissing = !input.stopName?.trim() || !input.city?.trim();
  const genericName = isGenericPlaceholderStopName(input.stopName ?? "");
  if (nameOrCityMissing || genericName || input.hasDuplicateStopOrder || input.hasNearDuplicateName) {
    return "review";
  }

  if (input.serviceCount === 0) return "unused";

  const pickupNoteMissing = !input.pickupNote || !input.pickupNote.trim();
  if (pickupNoteMissing) return "incomplete";

  return "active";
}

export const BUS_STOP_STATUS_BADGE_CLASSNAME: Record<BusStopStatus, string> = {
  active: "bg-emerald-100 text-emerald-700",
  incomplete: "bg-amber-100 text-amber-700",
  unused: "bg-slate-100 text-slate-600",
  review: "bg-rose-100 text-rose-700",
  inactive: "bg-slate-200 text-slate-500"
};
