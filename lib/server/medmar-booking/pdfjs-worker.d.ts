/**
 * `pdfjs-dist` non pubblica type declarations per il proprio entry point
 * `legacy/build/pdf.worker.mjs` (usato solo in pdfjs-node-polyfill.ts per
 * registrare `globalThis.pdfjsWorker` — vedi commento lì per il perché).
 * Il modulo esporta solo `WorkerMessageHandler`, mai usato direttamente dal
 * nostro codice (viene solo riassegnato as-is a `globalThis.pdfjsWorker`),
 * quindi `unknown` è sufficiente e non indebolisce alcun controllo di tipo
 * altrove.
 */
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: unknown;
}
