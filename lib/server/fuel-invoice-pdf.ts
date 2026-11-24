import { ensurePdfjsNodePolyfills, ensurePdfjsNodeWorkerPolyfill } from "@/lib/server/medmar-booking/pdfjs-node-polyfill";
import { parseFuelInvoiceRows, type FuelInvoiceLine } from "@/lib/server/fuel-invoice-reconciliation";

export async function extractFuelInvoiceLines(pdfBytes: Uint8Array, supplier: "ENI" | "UTA"):
  Promise<{ invoiceNumber: string; lines: FuelInvoiceLine[] }> {
  ensurePdfjsNodePolyfills();
  await ensurePdfjsNodeWorkerPolyfill();
  const pdf = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await pdf.getDocument({ data: new Uint8Array(pdfBytes) }).promise;
  if (document.numPages > 30) throw new Error("Fattura troppo lunga (massimo 30 pagine).");
  const rows: string[][] = [];
  const allText: string[] = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const items = content.items.filter((item): item is typeof item & { str: string; transform: number[] } =>
      "str" in item && typeof item.str === "string" && "transform" in item);
    allText.push(...items.map((item) => item.str));
    // ENI's landscape page stores text rotated; UTA's page is horizontal.
    const rotated = items.some((item) => item.str.includes("Data Acquisto") && Math.abs(item.transform[1] ?? 0) > 1);
    const axis = rotated ? 4 : 5;
    const across = rotated ? 5 : 4;
    const groups = new Map<number, typeof items>();
    for (const item of items) {
      const key = Math.round((item.transform[axis] ?? 0) * 2) / 2;
      const group = groups.get(key) ?? [];
      group.push(item);
      groups.set(key, group);
    }
    for (const group of groups.values()) rows.push(group.sort((a, b) => (a.transform[across] ?? 0) - (b.transform[across] ?? 0)).map((item) => item.str));
  }
  const text = allText.join(" ");
  if (supplier === "ENI" && !/Enilive|Multicard/i.test(text)) throw new Error("Il PDF non sembra una fattura ENI.");
  if (supplier === "UTA" && !/UNION TANK|UTA Mobility/i.test(text)) throw new Error("Il PDF non sembra un dettaglio UTA.");
  const invoiceNumber = supplier === "ENI" ? text.match(/Nr Documento:\s*(\d{6,})/i)?.[1]
    : text.match(/(?:Serie fattura|Rechnungsnummer)\s*(\d{6,})/i)?.[1];
  const lines = parseFuelInvoiceRows(rows, supplier);
  if (!lines.length) throw new Error("Nessuna operazione carburante leggibile. Carica la fattura dettagliata, non solo il riepilogo.");
  return { invoiceNumber: invoiceNumber ?? "", lines };
}
