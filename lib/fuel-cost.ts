/** UTA: l'autista inserisce il prezzo pagato, il costo riconciliabile è al netto dell'IVA. */
export function utaNetFromGross(gross: number): number {
  return Math.round((gross / 1.22 + Number.EPSILON) * 10_000) / 10_000;
}
