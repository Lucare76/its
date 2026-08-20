/**
 * Fase 3 (delivery PDF) — redazione REALE a livello di content-stream dei
 * PDF biglietto Medmar, non un overlay visivo.
 *
 * Verificato leggendo il content-stream grezzo di un PDF Medmar reale
 * (Prenotazione736987.pdf, TCPDF): ogni riga di testo è disegnata con un
 * singolo operatore `Tj`/`TJ` isolato, es. `BT ... Td [(10.25)] TJ ET` o
 * `BT ... Td [(TOTALE)] TJ ET` — un token di testo per operatore, mai
 * concatenato con altro testo nello stesso operatore. Questo rende possibile
 * una redazione chirurgica: si individua l'operatore TJ/Tj la cui stringa
 * disegnata corrisponde esattamente a un prezzo/etichetta e si sostituisce
 * l'argomento con una stringa vuota, così l'operatore resta sintatticamente
 * valido (disegna "niente") ma il testo NON è più estraibile dal content
 * stream — non è un rettangolo bianco sopra al testo.
 *
 * QR code, barcode e loghi sono XObject immagine disegnati con l'operatore
 * `Do` (vedi `/I1 Do` nel content-stream reale): non vengono mai toccati da
 * questa funzione, che opera SOLO sugli operatori di testo Tj/TJ.
 */
import { PDFDocument } from "pdf-lib";
import { appendIncrementalPdfUpdate, buildContentStreamPatch, decodeAllPageContentStreams, redactShownText, shouldRedactMedmarPriceText, type ContentStreamPatch } from "./pdf-content-stream";

export class MedmarPdfCleanerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MedmarPdfCleanerError";
  }
}

/**
 * Pulisce un PDF biglietto Medmar rimuovendo dal content-stream (non solo
 * visivamente) le righe di prezzo unitario, il totale e le etichette
 * "Prezzo"/"TOTALE". Tutto il resto (tratte, date/orari, codice
 * prenotazione, numeri biglietto, QR/barcode/loghi, layout) resta intatto:
 * questa funzione tocca SOLO i content-stream di pagina, mai le immagini
 * XObject né altri oggetti del documento.
 *
 * Lancia MedmarPdfCleanerError se non trova ALMENO un'occorrenza da
 * redigere in tutto il documento — fail-closed: un PDF su cui la redazione
 * non ha toccato nulla è sospetto (struttura Medmar cambiata) e non va mai
 * inviato assumendo silenziosamente che fosse già "pulito".
 */
export async function cleanMedmarPdf(pdfBytes: Uint8Array): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(pdfBytes);
  let totalRedacted = 0;
  const patches: ContentStreamPatch[] = [];

  for (const { ref, text } of decodeAllPageContentStreams(pdfDoc)) {
    const { text: redactedText, redactedCount } = redactShownText(text, shouldRedactMedmarPriceText);
    if (redactedCount === 0) continue;
    const patch = buildContentStreamPatch(pdfDoc, ref, redactedText);
    if (!patch) continue;
    totalRedacted += redactedCount;
    patches.push(patch);
  }

  if (totalRedacted === 0) {
    throw new MedmarPdfCleanerError(
      "Nessuna occorrenza di prezzo/totale trovata da redigere nel PDF: struttura del documento inattesa, redazione non verificabile."
    );
  }

  // Aggiornamento incrementale (append-only), non pdfDoc.save(): vedi il
  // commento su appendIncrementalPdfUpdate in pdf-content-stream.ts — il
  // serializzatore di pdf-lib produce, su almeno un PDF Medmar reale, un
  // file che pdf-lib stesso non riesce a rileggere.
  return appendIncrementalPdfUpdate(pdfBytes, pdfDoc, patches);
}
