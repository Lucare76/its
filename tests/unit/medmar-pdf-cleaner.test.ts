import { describe, it, expect } from "vitest";
import { PDFDocument, PDFName, StandardFonts } from "pdf-lib";
import { cleanMedmarPdf, MedmarPdfCleanerError } from "@/lib/server/medmar-booking/pdf-cleaner";
import { validateCleanedMedmarPdf } from "@/lib/server/medmar-booking/pdf-validation";

/**
 * Costruisce un PDF sintetico che replica la struttura testuale osservata
 * realmente in un biglietto Medmar (righe di testo isolate, un
 * Tj/TJ per riga) — deterministico, nessuna dipendenza dalla mailbox reale.
 */
async function buildSyntheticMedmarPdf(): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const page = pdfDoc.addPage([600, 800]);
  const lines = [
    "Prenotazione AG1908926B000438457",
    "Id. 736987",
    "LUCIANO SENESE",
    "Pozzuoli - Casamicciola 23-08-2026 08:15",
    "Ischia - Pozzuoli 26-08-2026 15:00",
    "Me26AG190004415",
    "PASSAGGIO PONTE ADULTO - TARIFFA",
    "10.25",
    "TASSA DI SBARCO",
    "Me26AG190004416",
    "PASSAGGIO PONTE ADULTO - TARIFFA",
    "10.25",
    "Me26AG190004417",
    "10.25",
    "Me26AG190004418",
    "10.25",
    "Prezzo",
    "TOTALE",
    "41.00",
  ];
  let y = 760;
  for (const line of lines) {
    page.drawText(line, { x: 40, y, size: 10, font });
    y -= 20;
  }
  return pdfDoc.save();
}

const VALIDATION_INPUT = {
  medmarNumero: "AG1908926B000438457",
  idPrenotazione: "736987",
  ticketNumbers: ["Me26AG190004415", "Me26AG190004416", "Me26AG190004417", "Me26AG190004418"],
  requiredPortKeywords: ["Pozzuoli", "Casamicciola", "Ischia"],
};

/**
 * Clausole legali (pagina 2) osservate realmente in un biglietto Medmar:
 * contengono legittimamente le parole "prezzo"/"totale" DENTRO frasi più
 * lunghe (mai come riga isolata) — non vanno mai redatte né segnalate dal
 * validatore come "etichetta vietata ancora presente".
 */
const LEGAL_BOILERPLATE_LINES = [
  "Ai sensi del Codice della Navigazione, il passeggero non ha diritto al rimborso del prezzo del biglietto.",
  "In tal caso la Società sarà tenuta a rimborsare soltanto il prezzo versato.",
  "Sarà possibile richiedere il rimborso totale del biglietto entro sette giorni.",
];

/**
 * Riproduce la struttura REALE osservata in Prenotazione736987.pdf (TCPDF):
 * la entry /Contents della pagina è un PDFRef SINGOLO (non un array).
 *
 * L'API alto-livello di pdf-lib (`addPage` + `drawText`) inserisce SEMPRE i
 * content-stream come ARRAY di ref (vedi PDFPageLeaf.addContentStream), mai
 * come ref singolo — quindi il fixture sintetico "semplice" (vedi sopra) non
 * riesce a riprodurre il bug reale: `page.node.Contents()` dereferenzia
 * comunque a un PDFStream, ma il ramo "array" del vecchio
 * `resolvePageContentRefs` intercettava correttamente il caso perché
 * `.asArray()` esiste solo su un vero PDFArray di PDFRef (mai dereferenziato
 * da `.lookup()`, dato che l'array non è esso stesso un ref). Il caso che
 * innescava il bug — un singolo PDFRef "spacchettato" — va quindi costruito
 * a mano riscrivendo /Contents dopo la creazione della pagina.
 */
async function buildSyntheticMedmarPdfWithBareContentsRef(): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

  const page1 = pdfDoc.addPage([600, 800]);
  const page1Lines = [
    "Prenotazione AG1908926B000438457",
    "Id. 736987",
    "LUCIANO SENESE",
    "Pozzuoli - Casamicciola 23-08-2026 08:15",
    "Ischia - Pozzuoli 26-08-2026 15:00",
    "Me26AG190004415",
    "10.25",
    "Me26AG190004416",
    "10.25",
    "Me26AG190004417",
    "10.25",
    "Me26AG190004418",
    "10.25",
    "Prezzo",
    "TOTALE",
    "41.00",
  ];
  let y1 = 760;
  for (const line of page1Lines) {
    page1.drawText(line, { x: 40, y: y1, size: 10, font });
    y1 -= 20;
  }

  const page2 = pdfDoc.addPage([600, 800]);
  let y2 = 760;
  for (const line of LEGAL_BOILERPLATE_LINES) {
    page2.drawText(line, { x: 40, y: y2, size: 8, font });
    y2 -= 20;
  }

  // "Spacchetta" /Contents da array-di-un-ref a ref singolo, per pagina,
  // replicando la struttura reale osservata nel PDF Medmar (TCPDF).
  for (const page of pdfDoc.getPages()) {
    const contentsArray = page.node.get(PDFName.of("Contents"));
    const asArray = (contentsArray as { asArray?: () => unknown[] })?.asArray?.();
    if (asArray && asArray.length === 1) {
      page.node.set(PDFName.of("Contents"), asArray[0] as never);
    }
  }

  return pdfDoc.save();
}

describe("pdf-cleaner — cleanMedmarPdf (redazione reale a livello di content-stream)", () => {
  it("1. preserva il codice di prenotazione (id_prenotazione) nel testo estratto dopo la pulizia", async () => {
    const original = await buildSyntheticMedmarPdf();
    const cleaned = await cleanMedmarPdf(original);
    const result = await validateCleanedMedmarPdf(cleaned, VALIDATION_INPUT);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.extractedText).toContain("736987");
  });

  it("2. preserva i numeri biglietto nel testo estratto dopo la pulizia", async () => {
    const original = await buildSyntheticMedmarPdf();
    const cleaned = await cleanMedmarPdf(original);
    const result = await validateCleanedMedmarPdf(cleaned, VALIDATION_INPUT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      for (const n of VALIDATION_INPUT.ticketNumbers) expect(result.extractedText).toContain(n);
    }
  });

  it("3. preserva tratte/orari nel testo estratto dopo la pulizia", async () => {
    const original = await buildSyntheticMedmarPdf();
    const cleaned = await cleanMedmarPdf(original);
    const result = await validateCleanedMedmarPdf(cleaned, VALIDATION_INPUT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.extractedText).toContain("08:15");
      expect(result.extractedText).toContain("15:00");
      expect(result.extractedText).toContain("Pozzuoli");
      expect(result.extractedText).toContain("Casamicciola");
      expect(result.extractedText).toContain("Ischia");
    }
  });

  it("4. rimuove l'etichetta 'Prezzo' dal testo estratto", async () => {
    const original = await buildSyntheticMedmarPdf();
    const cleaned = await cleanMedmarPdf(original);
    const result = await validateCleanedMedmarPdf(cleaned, VALIDATION_INPUT);
    expect(result.ok).toBe(true);
    if (result.ok) expect(/prezzo/i.test(result.extractedText)).toBe(false);
  });

  it("5. rimuove l'etichetta 'TOTALE' dal testo estratto", async () => {
    const original = await buildSyntheticMedmarPdf();
    const cleaned = await cleanMedmarPdf(original);
    const result = await validateCleanedMedmarPdf(cleaned, VALIDATION_INPUT);
    expect(result.ok).toBe(true);
    if (result.ok) expect(/totale/i.test(result.extractedText)).toBe(false);
  });

  it("6. rimuove gli importi unitari e il totale (nessun formato N.NN/N,NN estraibile)", async () => {
    const original = await buildSyntheticMedmarPdf();
    const cleaned = await cleanMedmarPdf(original);
    const result = await validateCleanedMedmarPdf(cleaned, VALIDATION_INPUT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.extractedText).not.toContain("10.25");
      expect(result.extractedText).not.toContain("41.00");
    }
  });

  it("7. FALLISCE se gli importi restano estraibili: validateCleanedMedmarPdf rileva il PDF ORIGINALE (non pulito) come non valido", async () => {
    const original = await buildSyntheticMedmarPdf();
    const result = await validateCleanedMedmarPdf(original, VALIDATION_INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/prezzo|totale|importo/i);
  });

  it("8. la redazione è chirurgica: il testo NON price/label resta invariato (nessuna sovra-redazione)", async () => {
    const original = await buildSyntheticMedmarPdf();
    const cleaned = await cleanMedmarPdf(original);
    const result = await validateCleanedMedmarPdf(cleaned, VALIDATION_INPUT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.extractedText).toContain("LUCIANO SENESE");
      expect(result.extractedText).toContain("PASSAGGIO PONTE ADULTO - TARIFFA");
      expect(result.extractedText).toContain("TASSA DI SBARCO");
      expect(result.extractedText).toContain("AG1908926B000438457");
    }
  });

  it("9. fail-closed: PDF senza alcuna occorrenza prezzo/totale -> MedmarPdfCleanerError, mai un 'pulito' silenzioso", async () => {
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const page = pdfDoc.addPage([300, 300]);
    page.drawText("Documento senza alcun prezzo", { x: 20, y: 250, size: 10, font });
    const bytes = await pdfDoc.save();
    await expect(cleanMedmarPdf(bytes)).rejects.toThrow(MedmarPdfCleanerError);
  });

  it("10. struttura reale (Contents come PDFRef singolo, non array): rimuove prezzo/totale/importi e la validazione passa — riproduce il bug osservato sul PDF reale Senese (Prenotazione736987.pdf), dove il vecchio resolvePageContentRefs dereferenziava /Contents invece di restituire il PDFRef e la redazione non veniva mai scritta nell'oggetto realmente referenziato dalla pagina", async () => {
    const original = await buildSyntheticMedmarPdfWithBareContentsRef();
    const cleaned = await cleanMedmarPdf(original);
    const result = await validateCleanedMedmarPdf(cleaned, VALIDATION_INPUT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.extractedText).not.toContain("10.25");
      expect(result.extractedText).not.toContain("41.00");
      expect(result.extractedText).toContain("736987");
      for (const n of VALIDATION_INPUT.ticketNumbers) expect(result.extractedText).toContain(n);
    }
  });

  it("11. non segnala come 'ancora presente' le occorrenze legittime di 'prezzo'/'totale' dentro frasi più lunghe (clausole legali di pagina 2) — evita il falso positivo del validatore su un PDF già correttamente redatto", async () => {
    const original = await buildSyntheticMedmarPdfWithBareContentsRef();
    const cleaned = await cleanMedmarPdf(original);
    const result = await validateCleanedMedmarPdf(cleaned, VALIDATION_INPUT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      for (const line of LEGAL_BOILERPLATE_LINES) {
        expect(result.extractedText).toContain(line);
      }
    }
  });

  it("12. bug reale 'DOMMatrix is not defined' (prenotazione 738742): la validazione non esplode anche se globalThis.DOMMatrix/Path2D/ImageData sono assenti come su Vercel/Node senza @napi-rs/canvas", async () => {
    const g = globalThis as Record<string, unknown>;
    const saved = { DOMMatrix: g.DOMMatrix, Path2D: g.Path2D, ImageData: g.ImageData };
    delete g.DOMMatrix;
    delete g.Path2D;
    delete g.ImageData;
    try {
      const original = await buildSyntheticMedmarPdf();
      const cleaned = await cleanMedmarPdf(original);
      const result = await validateCleanedMedmarPdf(cleaned, VALIDATION_INPUT);
      expect(result.ok).toBe(true);
    } finally {
      // Non lasciare lo stato globale alterato per gli altri test del file/della suite.
      if (saved.DOMMatrix === undefined) delete g.DOMMatrix; else g.DOMMatrix = saved.DOMMatrix;
      if (saved.Path2D === undefined) delete g.Path2D; else g.Path2D = saved.Path2D;
      if (saved.ImageData === undefined) delete g.ImageData; else g.ImageData = saved.ImageData;
    }
  });
});
