/**
 * Porto di terraferma di ARRIVO del viaggio di ritorno, per le pratiche
 * transfer_port_hotel importate da PDF (modello single-row): l'andata ha il
 * suo porto in meeting_point, il ritorno no. Il valore viene letto SOLO dal
 * blocco ritorno del documento e salvato in
 * services.ferry_details.return_mainland_port.
 *
 * Valori ammessi: "napoli" | "pozzuoli". Qualunque altro testo (ambiguo,
 * Beverello, porto isolano, vuoto) -> null: la chiave non viene scritta e il
 * preflight Medmar resta in revisione manuale. Mai dedotto dal porto
 * dell'andata.
 */

export type MedmarReturnMainlandPort = "napoli" | "pozzuoli";

export function normalizeMedmarReturnMainlandPort(value: unknown): MedmarReturnMainlandPort | null {
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  if (!text) return null;
  // Beverello è il molo aliscafi (SNAV/Alilauro), non un porto Medmar.
  if (text.includes("beverello")) return null;
  const napoli = /\bnapoli\b/.test(text) || text.includes("porta di massa");
  const pozzuoli = /\bpozzuoli\b/.test(text);
  if (napoli && !pozzuoli) return "napoli";
  if (pozzuoli && !napoli) return "pozzuoli";
  return null;
}

/** Legge la chiave salvata; qualunque valore diverso da napoli/pozzuoli vale null. */
export function readReturnMainlandPort(ferryDetails: unknown): MedmarReturnMainlandPort | null {
  if (!ferryDetails || typeof ferryDetails !== "object" || Array.isArray(ferryDetails)) return null;
  const value = (ferryDetails as Record<string, unknown>).return_mainland_port;
  return value === "napoli" || value === "pozzuoli" ? value : null;
}

/**
 * ferry_details con return_mainland_port aggiunto, preservando tutte le chiavi
 * esistenti. Senza porto valido restituisce l'oggetto esistente invariato
 * (nessuna chiave scritta, nessun valore precedente cancellato).
 */
export function withReturnMainlandPort(
  existing: unknown,
  port: MedmarReturnMainlandPort | null
): Record<string, unknown> {
  const base = existing && typeof existing === "object" && !Array.isArray(existing) ? { ...(existing as Record<string, unknown>) } : {};
  if (port) base.return_mainland_port = port;
  return base;
}
