/**
 * Polyfill minimo, solo Node/server, per `pdfjs-dist` (usato in
 * pdf-content-stream.ts per l'estrazione testo di validazione, MAI per il
 * rendering — non chiamiamo mai `page.render()`).
 *
 * Causa dell'errore "DOMMatrix is not defined": pdfjs-dist v5.x, al proprio
 * import in ambiente Node, prova a recuperare `DOMMatrix`/`Path2D`/`ImageData`
 * dal pacchetto opzionale `@napi-rs/canvas` (non installato in questo
 * progetto — dipendenza nativa pesante, non necessaria per la sola
 * estrazione testo). Se assente, pdfjs-dist si limita a un warning e
 * prosegue — ma alcuni PDF (font embedded Type3: i loro glifi sono
 * mini-content-stream interpretati anche durante `getTextContent()`, non
 * solo nel rendering) finiscono comunque per costruire `new DOMMatrix(...)`,
 * che lancia `ReferenceError: DOMMatrix is not defined` a runtime.
 *
 * Perche' un polyfill "non perfetto" e' comunque sicuro qui:
 * `extractTextItemsFromPdf` (pdf-content-stream.ts) legge SOLO `item.str`
 * (il testo estratto) — mai `item.transform`/geometria dei glifi. Un
 * `DOMMatrix`/`Path2D` che fa davvero l'algebra 2D di base (non e' un mock
 * vuoto) evita il crash e non altera in alcun modo le stringhe estratte,
 * quindi non indebolisce la validazione (che confronta solo testo).
 */

class NodeDOMMatrixPolyfill {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;

  constructor(init?: number[] | Float32Array | Float64Array | string) {
    if (init && typeof init !== "string" && init.length >= 6) {
      [this.a, this.b, this.c, this.d, this.e, this.f] = init as number[];
    } else {
      this.a = 1;
      this.b = 0;
      this.c = 0;
      this.d = 1;
      this.e = 0;
      this.f = 0;
    }
  }

  private clone(): NodeDOMMatrixPolyfill {
    return new NodeDOMMatrixPolyfill([this.a, this.b, this.c, this.d, this.e, this.f]);
  }

  /** this = this * other (composizione matriciale 2D standard, ordine DOMMatrix). */
  multiplySelf(other: NodeDOMMatrixPolyfill): this {
    const { a, b, c, d, e, f } = this;
    this.a = a * other.a + c * other.b;
    this.b = b * other.a + d * other.b;
    this.c = a * other.c + c * other.d;
    this.d = b * other.c + d * other.d;
    this.e = a * other.e + c * other.f + e;
    this.f = b * other.e + d * other.f + f;
    return this;
  }

  multiply(other: NodeDOMMatrixPolyfill): NodeDOMMatrixPolyfill {
    return this.clone().multiplySelf(other);
  }

  /** this = other * this. */
  preMultiplySelf(other: NodeDOMMatrixPolyfill): this {
    const result = other.multiply(this);
    this.a = result.a;
    this.b = result.b;
    this.c = result.c;
    this.d = result.d;
    this.e = result.e;
    this.f = result.f;
    return this;
  }

  invertSelf(): this {
    const { a, b, c, d, e, f } = this;
    const det = a * d - b * c;
    if (det === 0) {
      this.a = this.b = this.c = this.d = NaN;
      this.e = this.f = NaN;
      return this;
    }
    this.a = d / det;
    this.b = -b / det;
    this.c = -c / det;
    this.d = a / det;
    this.e = (c * f - d * e) / det;
    this.f = (b * e - a * f) / det;
    return this;
  }

  translateSelf(tx = 0, ty = 0): this {
    this.e += this.a * tx + this.c * ty;
    this.f += this.b * tx + this.d * ty;
    return this;
  }

  translate(tx = 0, ty = 0): NodeDOMMatrixPolyfill {
    return this.clone().translateSelf(tx, ty);
  }

  scaleSelf(sx = 1, sy = sx): this {
    this.a *= sx;
    this.b *= sx;
    this.c *= sy;
    this.d *= sy;
    return this;
  }

  scale(sx = 1, sy = sx): NodeDOMMatrixPolyfill {
    return this.clone().scaleSelf(sx, sy);
  }
}

/** Path2D minimale: mai usato per disegnare davvero (nessun rendering in questo progetto), solo per non far crashare le API che lo costruiscono/richiamano durante l'interpretazione dei glifi Type3. */
class NodePath2DPolyfill {
  addPath(): void {}
  moveTo(): void {}
  lineTo(): void {}
  bezierCurveTo(): void {}
  quadraticCurveTo(): void {}
  closePath(): void {}
  rect(): void {}
  arc(): void {}
  ellipse(): void {}
}

/** Registra i polyfill su `globalThis` solo se assenti (mai sovrascrive un vero DOMMatrix/Path2D/ImageData, es. in test con jsdom) e solo lato server. */
export function ensurePdfjsNodePolyfills(): void {
  if (typeof window !== "undefined") return; // mai lato browser
  const g = globalThis as Record<string, unknown>;
  if (typeof g.DOMMatrix === "undefined") g.DOMMatrix = NodeDOMMatrixPolyfill;
  if (typeof g.Path2D === "undefined") g.Path2D = NodePath2DPolyfill;
  if (typeof g.ImageData === "undefined") {
    g.ImageData = class NodeImageDataPolyfill {
      data: Uint8ClampedArray;
      width: number;
      height: number;
      constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
        this.data = new Uint8ClampedArray(width * height * 4);
      }
    };
  }
}

/**
 * Registra il `WorkerMessageHandler` di pdfjs-dist su `globalThis.pdfjsWorker`
 * PRIMA di chiamare `getDocument()`.
 *
 * Causa dell'errore "Setting up fake worker failed: Cannot find module
 * '.../pdf.worker.mjs'" in produzione Vercel: `pdfjs-dist` v5.x, in Node,
 * disabilita SEMPRE il worker reale (`PDFWorker.#isWorkerDisabled = true`,
 * hardcoded per `isNodeJS`) e passa al "fake worker", che però deve comunque
 * caricare la classe `WorkerMessageHandler` da qualche parte: se
 * `globalThis.pdfjsWorker` non è già popolato, pdfjs esegue un
 * `import(GlobalWorkerOptions.workerSrc)` A RUNTIME con lo specifier
 * `"./pdf.worker.mjs"` (relativo al chunk bundlato). Nel bundle serverless di
 * Next.js/Vercel quel file non esiste più a quel path (la struttura di
 * `node_modules/pdfjs-dist` non viene preservata), quindi l'import fallisce.
 *
 * Fix: importare qui `pdf.worker.mjs` con uno specifier STATICO (letterale),
 * cosa che permette a webpack/Next di includerlo regolarmente nel bundle
 * invece di risolverlo a runtime — e assegnarlo a `globalThis.pdfjsWorker`
 * PRIMA di `getDocument()`. pdfjs, trovando già pronto
 * `globalThis.pdfjsWorker.WorkerMessageHandler`, salta del tutto l'import
 * runtime di `workerSrc` (vedi `PDFWorker.#mainThreadWorkerMessageHandler` in
 * pdf.mjs) — questo è il meccanismo "main thread worker" già previsto da
 * pdfjs-dist per gli ambienti Node/bundler, non un workaround fragile. Non
 * introduce dipendenze nuove (pdfjs-dist è già una dipendenza) né richiede di
 * copiare `pdf.worker.mjs` in `public/`. `pdf.worker.mjs` non fa rendering
 * canvas: interpreta solo il contenuto PDF (parsing/font), quindi è sicuro da
 * eseguire sul thread principale per la sola estrazione testo (mai per il
 * rendering, che qui non usiamo).
 */
export async function ensurePdfjsNodeWorkerPolyfill(): Promise<void> {
  if (typeof window !== "undefined") return; // mai lato browser
  const g = globalThis as Record<string, unknown>;
  const existing = g.pdfjsWorker as { WorkerMessageHandler?: unknown } | undefined;
  if (existing?.WorkerMessageHandler) return; // idempotente: mai re-importare se già pronto
  const workerModule = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  g.pdfjsWorker = workerModule;
}
