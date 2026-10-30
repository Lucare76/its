/** Stored formula arrival times refer to the estimated landing on Ischia. */
export function isFerryFormula(kind: string | null | undefined): boolean {
  return ["formula_snav", "formula_medmar_napoli", "formula_medmar_pozzuoli", "formula_alilauro", "formula_caremar"].includes(kind ?? "");
}
export function agencyArrivalLabel(kind: string | null | undefined): string {
  return isFerryFormula(kind) ? "Arrivo stimato a Ischia" : "Arrivo";
}
export function agencyReturnLabel(kind: string | null | undefined): string {
  return isFerryFormula(kind) ? "Partenza nave da Ischia" : "Rientro";
}
export function ferryDepartureLabel(kind: string | null | undefined): string {
  return kind === "formula_medmar_pozzuoli" || kind === "formula_caremar"
    ? "Partenza nave da Pozzuoli" : "Partenza nave da Napoli";
}
