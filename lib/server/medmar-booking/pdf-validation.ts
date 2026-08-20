/**
 * Fase 3 (delivery PDF) — validazione post-redazione: verifica sul TESTO
 * ESTRATTO (non solo sul PDF binario) che i prezzi siano davvero spariti e
 * che i dati identificativi essenziali siano ancora presenti. Fail-closed:
 * se anche un solo controllo fallisce, il PDF pulito non va mai inviato.
 *
 * Usa lo stesso parser interno di pdf-content-stream.ts (non `pdf-parse`,
 * risultato incompatibile con l'ambiente di test di questo progetto — vedi
 * commento in pdf-content-stream.ts) così il testo validato è esattamente
 * quello che il cleaner ha effettivamente scritto/rimosso.
 */
import { extractTextItemsFromPdf, shouldRedactMedmarPriceText } from "./pdf-content-stream";

export type MedmarPdfValidationInput = {
  medmarNumero: string;
  idPrenotazione: string;
  ticketNumbers: string[];
  requiredPortKeywords: string[];
};

export type MedmarPdfValidationResult =
  | { ok: true; extractedText: string }
  | { ok: false; reason: string; extractedText: string };

export async function validateCleanedMedmarPdf(
  pdfBytes: Uint8Array,
  input: MedmarPdfValidationInput
): Promise<MedmarPdfValidationResult> {
  const items = await extractTextItemsFromPdf(pdfBytes);
  const text = items.join("\n");

  // Stesso identico predicato del cleaner (shouldRedactMedmarPriceText),
  // applicato per SINGOLO frammento di testo (non a sottostringa sul testo
  // intero): evita falsi positivi sulle clausole legali di pagina 2 che
  // contengono legittimamente le parole "prezzo"/"totale" dentro frasi più
  // lunghe (es. "rimborsare il prezzo del biglietto").
  for (const item of items) {
    if (shouldRedactMedmarPriceText(item)) {
      return {
        ok: false,
        reason: `Etichetta o importo vietato ancora presente nel testo estratto: "${item.trim()}".`,
        extractedText: text,
      };
    }
  }

  const required = [input.medmarNumero, input.idPrenotazione, ...input.ticketNumbers, ...input.requiredPortKeywords];
  for (const needle of required) {
    if (!text.includes(needle)) {
      return { ok: false, reason: `Dato obbligatorio mancante nel testo estratto dopo la pulizia: "${needle}".`, extractedText: text };
    }
  }

  return { ok: true, extractedText: text };
}
