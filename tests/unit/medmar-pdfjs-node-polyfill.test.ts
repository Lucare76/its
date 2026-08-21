import { describe, expect, it } from "vitest";
import { ensurePdfjsNodePolyfills } from "@/lib/server/medmar-booking/pdfjs-node-polyfill";

describe("ensurePdfjsNodePolyfills — polyfill DOMMatrix/Path2D/ImageData per pdfjs in Node", () => {
  it("1. registra DOMMatrix/Path2D/ImageData su globalThis quando assenti", () => {
    const g = globalThis as Record<string, unknown>;
    const saved = { DOMMatrix: g.DOMMatrix, Path2D: g.Path2D, ImageData: g.ImageData };
    delete g.DOMMatrix;
    delete g.Path2D;
    delete g.ImageData;
    try {
      ensurePdfjsNodePolyfills();
      expect(typeof g.DOMMatrix).toBe("function");
      expect(typeof g.Path2D).toBe("function");
      expect(typeof g.ImageData).toBe("function");
    } finally {
      if (saved.DOMMatrix === undefined) delete g.DOMMatrix; else g.DOMMatrix = saved.DOMMatrix;
      if (saved.Path2D === undefined) delete g.Path2D; else g.Path2D = saved.Path2D;
      if (saved.ImageData === undefined) delete g.ImageData; else g.ImageData = saved.ImageData;
    }
  });

  it("2. non sovrascrive un DOMMatrix gia' presente (es. ambiente con un vero DOMMatrix, mai perdere quello reale)", () => {
    const g = globalThis as Record<string, unknown>;
    const saved = g.DOMMatrix;
    class RealDOMMatrixMarker {}
    g.DOMMatrix = RealDOMMatrixMarker;
    try {
      ensurePdfjsNodePolyfills();
      expect(g.DOMMatrix).toBe(RealDOMMatrixMarker);
    } finally {
      if (saved === undefined) delete g.DOMMatrix; else g.DOMMatrix = saved;
    }
  });

  it("3. il DOMMatrix polyfillato fa davvero l'algebra 2D (translate/scale non sono no-op) — non deve corrompere silenziosamente calcoli, solo evitare il crash", () => {
    const g = globalThis as Record<string, unknown>;
    const saved = { DOMMatrix: g.DOMMatrix };
    delete g.DOMMatrix;
    try {
      ensurePdfjsNodePolyfills();
      const DOMMatrixCtor = g.DOMMatrix as new (init?: number[]) => {
        a: number; b: number; c: number; d: number; e: number; f: number;
        translate(tx?: number, ty?: number): { e: number; f: number };
        scale(sx?: number, sy?: number): { a: number; d: number };
      };
      const m = new DOMMatrixCtor();
      const translated = m.translate(10, 20);
      expect(translated.e).toBe(10);
      expect(translated.f).toBe(20);
      const scaled = new DOMMatrixCtor().scale(2, 3);
      expect(scaled.a).toBe(2);
      expect(scaled.d).toBe(3);
    } finally {
      if (saved.DOMMatrix === undefined) delete g.DOMMatrix; else g.DOMMatrix = saved.DOMMatrix;
    }
  });
});
