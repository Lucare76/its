/**
 * detectExplicitHydrofoilIntent — unico punto che decide se una riga import
 * Excel (dominio transfer treno/aereo: transfer_train_hotel /
 * transfer_airport_hotel) contiene un segnale ESPLICITO e affidabile di
 * aliscafo, tale da giustificare la variante `_aliscafo` del
 * booking_service_kind.
 *
 * Segnale confermato nei dati reali del progetto (vedi
 * tests/pdfs/aleste-viaggi/attesi/001717_N_26_004250_formula_snav.md e
 * tests/pdfs/dimhotels-snav/attesi/valentino_salvatore_04042026_snav_voucher.md):
 * la parola "ALISCAFO" compare per esteso nelle etichette quando il servizio
 * e' realmente un aliscafo. Nessuna abbreviazione ("ALISC.", "SUPPL. ALISC.",
 * ecc.) e' confermata nei fixture/test esistenti: se un domani comparisse un
 * caso reale con un'abbreviazione, va aggiunta qui con la fonte del dato,
 * mai per supposizione.
 *
 * "hydrofoil" (inglese) e' incluso perche' e' gia' un valore riconosciuto nel
 * dominio PDF (agency-pdf-import.ts, transport_mode: "hydrofoil"), quindi un
 * termine univoco anche se raro in un Excel italiano.
 *
 * Deliberatamente NON un segnale: nomi di compagnia (SNAV, Alilauro, ecc.).
 * Nei dati reali (fixture Aleste sopra) SNAV compare anche per "Formula
 * SNAV" (dominio porto-porto, booking_service_kind completamente diverso da
 * transfer_train_hotel/transfer_airport_hotel) — non e' un'implicazione
 * affidabile di "_aliscafo" per queste due kind. Le agenzie non-Sosandra
 * restano di default traghetto salvo questo segnale esplicito.
 */
export function detectExplicitHydrofoilIntent(...texts: Array<string | null | undefined>): boolean {
  const joined = texts.filter((t): t is string => Boolean(t && t.trim())).join(" ");
  if (!joined) return false;
  const normalized = joined
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
  return /\baliscaf\w*\b/.test(normalized) || /\bhydrofoil\b/.test(normalized);
}
