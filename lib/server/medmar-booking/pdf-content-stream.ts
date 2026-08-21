/**
 * Fase 3 (delivery PDF) — helper condivisi di basso livello per leggere e
 * modificare i content-stream di pagina di un PDF via pdf-lib (operatori di
 * testo Tj/TJ). Usati sia dal cleaner (pdf-cleaner.ts, redazione) sia dal
 * validatore (pdf-validation.ts, estrazione testo) — stesso parser per
 * entrambi, per garantire che "quello che il validatore legge" sia
 * esattamente "quello che il cleaner ha scritto".
 *
 * Nota: `pdf-parse` (il pacchetto npm, pdfjs v1.10.100 bundlato) risulta
 * incompatibile con l'ambiente di test Vitest di questo progetto (fallisce
 * con "Invalid PDF structure" anche su PDF banali generati da pdf-lib, in
 * modo riproducibile e indipendente dal cleaner — verificato con un PDF di
 * prova senza alcuna redazione). Per questo la validazione del testo estratto
 * usa questo parser interno invece di pdf-parse.
 */
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, decodePDFRawStream } from "pdf-lib";
import { ensurePdfjsNodePolyfills, ensurePdfjsNodeWorkerPolyfill } from "./pdfjs-node-polyfill";

/** Etichette testuali da rimuovere sempre, confronto case-insensitive su stringa INTERA (trim). */
const REDACT_LABELS = new Set(["prezzo", "totale"]);

/** Importi in formato "10.25" / "10,25" / "41.00" — SOLO cifre + separatore decimale + esattamente 2 decimali, mai date (contengono "/"), orari (contengono ":") o codici (alfanumerici). */
const CURRENCY_PATTERN = /^\d+[.,]\d{2}$/;

/**
 * Predicato condiviso da cleaner (pdf-cleaner.ts, cosa redigere) e validatore
 * (pdf-validation.ts, cosa NON deve più essere estraibile) — stesso identico
 * confronto su stringa INTERA (trim), mai su sottostringa. Necessario perché
 * un PDF Medmar reale contiene le parole "prezzo"/"totale" anche nelle
 * clausole legali di pagina 2 (es. "rimborsare il prezzo del biglietto",
 * "rimborso totale del biglietto") che NON vanno mai redatte: un controllo a
 * sottostringa sul testo intero le farebbe rilevare come "etichetta vietata
 * ancora presente" anche quando il cleaner ha correttamente lasciato intatte
 * quelle frasi.
 */
export function shouldRedactMedmarPriceText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (REDACT_LABELS.has(trimmed.toLowerCase())) return true;
  if (CURRENCY_PATTERN.test(trimmed)) return true;
  return false;
}

/** Decodifica minimale delle sole escape sequence PDF rilevanti per il confronto testuale. */
export function decodeLiteralForComparison(raw: string): string {
  return raw.replace(/\\([()\\])/g, "$1").replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t");
}

/** Decodifica una stringa PDF in forma esadecimale `<48656C6C6F>` (usata da alcuni generatori, es. pdf-lib, in alternativa a `(...)`). */
export function hexToString(hex: string): string {
  const clean = hex.replace(/\s+/g, "");
  let out = "";
  for (let i = 0; i < clean.length; i += 2) {
    const byte = clean.slice(i, i + 2);
    if (byte.length === 2) out += String.fromCharCode(parseInt(byte, 16));
  }
  return out;
}

/** Estrae tutti i segmenti stringa `(...)` o `<HEX>` da un frammento di content-stream, li concatena (ignora i numeri di kerning tra le stringhe in un array TJ). */
export function extractStringSegments(fragment: string): string {
  const segmentRegex = /\(((?:[^()\\]|\\.)*)\)|<([0-9A-Fa-f\s]*)>/g;
  let combined = "";
  let seg: RegExpExecArray | null;
  while ((seg = segmentRegex.exec(fragment)) !== null) {
    combined += seg[1] !== undefined ? decodeLiteralForComparison(seg[1]) : hexToString(seg[2]!);
  }
  return combined;
}

const TJ_ARRAY_OPERATOR = /\[((?:[^\[\]])*)\]\s*TJ/g;
const TJ_SINGLE_OPERATOR = /(\((?:[^()\\]|\\.)*\)|<[0-9A-Fa-f\s]*>)\s*Tj/g;

/** Estrae, IN ORDINE, tutte le stringhe disegnate (Tj/TJ) da un content-stream già decodificato in Latin1 — usato dal validatore per ricostruire il testo "estraibile" dopo la redazione. */
export function extractAllShownText(streamText: string): string[] {
  const out: string[] = [];
  for (const m of streamText.matchAll(TJ_ARRAY_OPERATOR)) {
    const text = extractStringSegments(m[1]!);
    if (text) out.push(text);
  }
  for (const m of streamText.matchAll(TJ_SINGLE_OPERATOR)) {
    const operand = m[1]!;
    const text = operand.startsWith("(") ? decodeLiteralForComparison(operand.slice(1, -1)) : hexToString(operand.slice(1, -1));
    if (text) out.push(text);
  }
  return out;
}

/** Sostituisce, in un content-stream, ogni operatore Tj/TJ la cui stringa disegnata soddisfa `predicate` con un operatore equivalente ma "vuoto" (disegna nulla, non più estraibile). Ritorna il testo modificato e quante occorrenze sono state redatte. */
export function redactShownText(streamText: string, predicate: (text: string) => boolean): { text: string; redactedCount: number } {
  let redactedCount = 0;

  let out = streamText.replace(TJ_ARRAY_OPERATOR, (full, inner: string) => {
    const text = extractStringSegments(inner);
    if (predicate(text)) {
      redactedCount++;
      return "[] TJ";
    }
    return full;
  });

  out = out.replace(TJ_SINGLE_OPERATOR, (full, operand: string) => {
    const text = operand.startsWith("(") ? decodeLiteralForComparison(operand.slice(1, -1)) : hexToString(operand.slice(1, -1));
    if (predicate(text)) {
      redactedCount++;
      return "() Tj";
    }
    return full;
  });

  return { text: out, redactedCount };
}

/**
 * Legge il valore RAW (non dereferenziato) della entry `/Contents` della pagina.
 *
 * `page.node.Contents()` di pdf-lib DEREFERENZIA la entry (restituisce lo
 * stream risolto, non il `PDFRef`) — verificato su un PDF Medmar reale: usare
 * quel valore per un successivo `context.assign(ref, ...)` scrive su una
 * chiave-oggetto "fantasma" (lo stream stesso, non un `PDFRef`), quindi la
 * redazione non tocca mai l'oggetto realmente referenziato dalla pagina e il
 * testo "pulito" non viene mai scritto nel documento salvato. Per questo si
 * legge qui la entry grezza via `.get()` (che NON dereferenzia).
 */
function resolvePageContentRefs(page: ReturnType<PDFDocument["getPages"]>[number]): PDFRef[] {
  const raw = (page.node as unknown as PDFDict).get(PDFName.of("Contents"));
  if (!raw) return [];
  if (raw instanceof PDFArray) {
    return raw.asArray().filter((o): o is PDFRef => o instanceof PDFRef);
  }
  if (raw instanceof PDFRef) return [raw];
  return [];
}

/** Decodifica (Flate incluso) ogni content-stream di ogni pagina in una stringa Latin1, con il PDFRef originale per un'eventuale riscrittura. */
export function decodeAllPageContentStreams(pdfDoc: PDFDocument): Array<{ ref: PDFRef; text: string }> {
  const context = pdfDoc.context;
  const results: Array<{ ref: PDFRef; text: string }> = [];
  for (const page of pdfDoc.getPages()) {
    for (const ref of resolvePageContentRefs(page)) {
      const rawStream = context.lookup(ref);
      if (!(rawStream instanceof PDFRawStream)) continue;
      const decoded = decodePDFRawStream(rawStream).decode();
      results.push({ ref, text: Buffer.from(decoded).toString("latin1") });
    }
  }
  return results;
}

export type ContentStreamPatch = { ref: PDFRef; dict: PDFDict; bytes: Uint8Array };

/**
 * Prepara (senza scrivere nulla) la patch di un content-stream: nuovo
 * dizionario (non compresso: /Filter e /DecodeParms rimossi, /Length
 * aggiornata) e nuovi byte. Usata da `appendIncrementalPdfUpdate` per
 * costruire un aggiornamento incrementale — NON muta il `PDFContext` di
 * pdf-lib (vedi commento su `appendIncrementalPdfUpdate` sul perché non si
 * usa `pdfDoc.save()`).
 */
export function buildContentStreamPatch(pdfDoc: PDFDocument, ref: PDFRef, newText: string): ContentStreamPatch | undefined {
  const original = pdfDoc.context.lookup(ref);
  if (!(original instanceof PDFRawStream)) return undefined;
  const newBytes = Buffer.from(newText, "latin1");
  const newDict = original.dict.clone();
  newDict.delete(PDFName.of("Filter"));
  newDict.delete(PDFName.of("DecodeParms"));
  newDict.set(PDFName.of("Length"), PDFNumber.of(newBytes.length));
  return { ref, dict: newDict, bytes: newBytes };
}

/** Offset (byte) dell'ULTIMA occorrenza di `startxref` nel PDF originale — punto di aggancio (/Prev) per l'aggiornamento incrementale. */
function findLastStartXrefOffset(originalBytes: Uint8Array): number {
  const text = Buffer.from(originalBytes).toString("latin1");
  const idx = text.lastIndexOf("startxref");
  if (idx === -1) throw new Error("startxref non trovato nel PDF originale: struttura non supportata per l'aggiornamento incrementale.");
  const match = text.slice(idx + "startxref".length).match(/\d+/);
  if (!match) throw new Error("Offset numerico dopo 'startxref' non leggibile nel PDF originale.");
  return parseInt(match[0], 10);
}

/**
 * Applica una o più patch di content-stream tramite un AGGIORNAMENTO
 * INCREMENTALE PDF standard (append-only): i byte originali restano
 * intatti, i nuovi oggetti (content-stream redatti) vengono accodati in
 * fondo al file, seguiti da una nuova sezione xref (solo per gli oggetti
 * cambiati, con /Prev che punta alla xref precedente) e un nuovo trailer —
 * la stessa tecnica usata da Acrobat per ogni modifica incrementale di un
 * PDF firmato/esistente.
 *
 * Necessario perché il serializzatore `pdfDoc.save()` di pdf-lib produce, su
 * almeno un PDF Medmar reale (TCPDF, xref classica non compressa), una
 * cross-reference table non rileggibile nemmeno da pdf-lib stesso ("Failed
 * to parse number" nella sezione xref) sia con il salvataggio compresso di
 * default sia forzando `useObjectStreams: false` — bug del writer, non della
 * redazione (verificato: i pattern Tj/TJ vengono individuati e sostituiti
 * correttamente nel content-stream decodificato). L'aggiornamento
 * incrementale bypassa del tutto il serializzatore di pdf-lib.
 */
export function appendIncrementalPdfUpdate(originalBytes: Uint8Array, pdfDoc: PDFDocument, patches: ContentStreamPatch[]): Uint8Array {
  const rootRef = pdfDoc.context.trailerInfo.Root;
  if (!rootRef) throw new Error("Trailer /Root mancante nel PDF originale: impossibile costruire l'aggiornamento incrementale.");
  const prevXrefOffset = findLastStartXrefOffset(originalBytes);

  const chunks: Buffer[] = [Buffer.from(originalBytes)];
  let offset = originalBytes.length;
  const xrefEntries: Array<{ objectNumber: number; offset: number }> = [];

  for (const patch of patches) {
    const objectBytes = Buffer.concat([
      Buffer.from(`${patch.ref.objectNumber} ${patch.ref.generationNumber} obj\n`, "latin1"),
      Buffer.from(patch.dict.toString(), "latin1"),
      Buffer.from("\nstream\n", "latin1"),
      Buffer.from(patch.bytes),
      Buffer.from("\nendstream\nendobj\n", "latin1"),
    ]);
    xrefEntries.push({ objectNumber: patch.ref.objectNumber, offset });
    chunks.push(objectBytes);
    offset += objectBytes.length;
  }

  const xrefOffset = offset;
  xrefEntries.sort((a, b) => a.objectNumber - b.objectNumber);
  let xrefSection = "xref\n";
  for (const entry of xrefEntries) {
    xrefSection += `${entry.objectNumber} 1\n${String(entry.offset).padStart(10, "0")} 00000 n \n`;
  }
  const size = pdfDoc.context.largestObjectNumber + 1;
  const trailer = `trailer\n<< /Size ${size} /Root ${rootRef.toString()} /Prev ${prevXrefOffset} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  chunks.push(Buffer.from(xrefSection + trailer, "latin1"));

  return new Uint8Array(Buffer.concat(chunks));
}

/**
 * Estrae tutto il testo dell'intero documento (validazione post-redazione).
 *
 * Usa `pdfjs-dist` (già dipendenza del progetto) e NON il parser di
 * pdf-lib: verificato su un PDF Medmar reale (TCPDF, cross-reference stream
 * compressa) che pdf-lib ha un bug nel ri-leggere il proprio stesso output
 * dopo `save()` in questi casi ("Failed to parse number" nella xref table),
 * mentre pdfjs-dist legge correttamente lo stesso file byte-per-byte —
 * quindi si usa un parser indipendente per il round-trip di validazione,
 * mai lo stesso motore che ha scritto il file.
 */
export async function extractAllTextFromPdf(pdfBytes: Uint8Array): Promise<string> {
  const items = await extractTextItemsFromPdf(pdfBytes);
  return items.join("\n");
}

/**
 * Estrae i singoli frammenti di testo (un item pdfjs per operatore Tj/TJ
 * disegnato, senza concatenarli) — usato dal validatore per verificare che
 * NESSUN frammento corrisponda ESATTAMENTE a un'etichetta/importo vietato
 * (stesso confronto di `shouldRedactMedmarPriceText`, non una ricerca a
 * sottostringa sul testo intero: le clausole legali di pagina 2 contengono
 * legittimamente le parole "prezzo"/"totale" dentro frasi più lunghe, che
 * NON vanno mai considerate un residuo di redazione).
 */
export async function extractTextItemsFromPdf(pdfBytes: Uint8Array): Promise<string[]> {
  // Va chiamato PRIMA dell'import di pdfjs: il modulo controlla globalThis.DOMMatrix/Path2D/ImageData
  // al proprio caricamento (vedi pdfjs-node-polyfill.ts per il perche' e la sicurezza del polyfill).
  ensurePdfjsNodePolyfills();
  // Va chiamato PRIMA di getDocument(): evita che pdfjs tenti di importare a runtime
  // "./pdf.worker.mjs" (path che non esiste nel bundle serverless Vercel) — vedi
  // pdfjs-node-polyfill.ts per il meccanismo "main thread worker".
  await ensurePdfjsNodeWorkerPolyfill();
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = (pdfjsLib as unknown as { getDocument: (input: { data: Uint8Array }) => { promise: Promise<unknown> } }).getDocument({
    data: new Uint8Array(pdfBytes),
  });
  const doc = (await loadingTask.promise) as { numPages: number; getPage: (n: number) => Promise<{ getTextContent: () => Promise<{ items: Array<{ str?: string }> }> }> };
  const items: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    for (const item of content.items) {
      if (item.str) items.push(item.str);
    }
  }
  return items;
}
