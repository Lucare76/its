import { afterEach, describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { ensurePdfjsNodeWorkerPolyfill } from "@/lib/server/medmar-booking/pdfjs-node-polyfill";
import { extractTextItemsFromPdf } from "@/lib/server/medmar-booking/pdf-content-stream";

/**
 * Verifica il fix del bug produzione Vercel: "Setting up fake worker failed:
 * Cannot find module '/var/task/.next/server/chunks/pdf.worker.mjs'".
 *
 * Causa: pdfjs-dist v5.x, in Node, disabilita sempre il worker reale e usa il
 * "fake worker", che senza `globalThis.pdfjsWorker` già pronto tenta un
 * `import(GlobalWorkerOptions.workerSrc)` A RUNTIME (default
 * "./pdf.worker.mjs", path che nel bundle serverless Vercel non esiste più).
 * `ensurePdfjsNodeWorkerPolyfill` deve registrare `globalThis.pdfjsWorker`
 * PRIMA di `getDocument()`, così quell'import runtime non viene mai
 * eseguito — anche se `GlobalWorkerOptions.workerSrc` punta a un path
 * inesistente (riprodotto qui esplicitamente).
 */
async function buildSimplePdf(text: string): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const page = pdfDoc.addPage([300, 200]);
  page.drawText(text, { x: 40, y: 150, size: 12, font });
  return pdfDoc.save();
}

function resetGlobalPdfjsWorker(): void {
  delete (globalThis as Record<string, unknown>).pdfjsWorker;
}

describe("ensurePdfjsNodeWorkerPolyfill — evita l'import runtime di pdf.worker.mjs in Node/Vercel serverless", () => {
  afterEach(() => {
    resetGlobalPdfjsWorker();
  });

  it("1. popola globalThis.pdfjsWorker.WorkerMessageHandler quando assente", async () => {
    resetGlobalPdfjsWorker();
    await ensurePdfjsNodeWorkerPolyfill();
    const worker = (globalThis as Record<string, unknown>).pdfjsWorker as { WorkerMessageHandler?: unknown } | undefined;
    expect(worker?.WorkerMessageHandler).toBeDefined();
  });

  it("2. e' idempotente: non re-importa il modulo se globalThis.pdfjsWorker.WorkerMessageHandler e' gia' presente", async () => {
    const sentinel = { WorkerMessageHandler: () => "sentinel" };
    (globalThis as Record<string, unknown>).pdfjsWorker = sentinel;
    await ensurePdfjsNodeWorkerPolyfill();
    expect((globalThis as Record<string, unknown>).pdfjsWorker).toBe(sentinel);
  });

  it("3. extractTextItemsFromPdf funziona anche con GlobalWorkerOptions.workerSrc impostato su un path inesistente (riproduce esattamente il bug Vercel: nessun import runtime di quel path)", async () => {
    resetGlobalPdfjsWorker();
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const originalWorkerSrc = (pdfjsLib as unknown as { GlobalWorkerOptions: { workerSrc?: string } }).GlobalWorkerOptions.workerSrc;
    (pdfjsLib as unknown as { GlobalWorkerOptions: { workerSrc?: string } }).GlobalWorkerOptions.workerSrc =
      "/var/task/.next/server/chunks/pdf.worker.mjs";
    try {
      const pdfBytes = await buildSimplePdf("Ciao Medmar");
      const items = await extractTextItemsFromPdf(pdfBytes);
      expect(items.join(" ")).toContain("Ciao Medmar");
    } finally {
      (pdfjsLib as unknown as { GlobalWorkerOptions: { workerSrc?: string } }).GlobalWorkerOptions.workerSrc = originalWorkerSrc;
    }
  });

  it("4. extractTextItemsFromPdf non tenta mai l'import runtime del path rotto: chiamate ripetute restano stabili (nessun errore intermittente da reimport)", async () => {
    resetGlobalPdfjsWorker();
    const pdfBytes = await buildSimplePdf("Estrazione ripetuta");
    const first = await extractTextItemsFromPdf(pdfBytes);
    const second = await extractTextItemsFromPdf(pdfBytes);
    expect(first.join(" ")).toContain("Estrazione ripetuta");
    expect(second.join(" ")).toContain("Estrazione ripetuta");
  });
});
