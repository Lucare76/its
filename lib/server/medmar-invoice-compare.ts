import { ensurePdfjsNodePolyfills, ensurePdfjsNodeWorkerPolyfill } from "@/lib/server/medmar-booking/pdfjs-node-polyfill";

export type MedmarInvoiceTicket = { number: string; date: string; itinerary: string; amount: number };
export const ticketNumbers = (text: string) => [...new Set((text.match(/\bMe\d{2}[A-Z]{2}\d{9}\b/gi) ?? []).map(value => value.toUpperCase()))];

export async function extractMedmarInvoice(bytes: Uint8Array): Promise<MedmarInvoiceTicket[]> {
  ensurePdfjsNodePolyfills(); await ensurePdfjsNodeWorkerPolyfill();
  const pdf = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await pdf.getDocument({ data: new Uint8Array(bytes) }).promise;
  if (document.numPages > 30) throw new Error("Fattura troppo lunga.");
  const lines: MedmarInvoiceTicket[] = [];
  let header = "";
  for (let index = 1; index <= document.numPages; index++) {
    const page = await document.getPage(index);
    const content = await page.getTextContent();
    const groups = new Map<number, Array<{ str: string; transform: number[] }>>();
    for (const item of content.items) {
      if (!("str" in item) || !("transform" in item)) continue;
      const key = Math.round(item.transform[5] * 2) / 2;
      groups.set(key, [...groups.get(key) ?? [], item]);
    }
    for (const group of groups.values()) {
      const text = group.sort((a, b) => a.transform[4] - b.transform[4]).map(item => item.str).join(" ").trim();
      header += ` ${text}`;
      const number = ticketNumbers(text)[0];
      const date = text.match(/\b\d{2}-\d{2}-\d{4}\b/)?.[0];
      const amount = text.match(/\b\d{1,5}\.\d{2}\s*$/)?.[0];
      if (number && date && amount) lines.push({ number, date,
        itinerary: text.slice(text.indexOf(date) + date.length, text.toUpperCase().indexOf(number)).trim(),
        amount: Number(amount) });
    }
  }
  if (!/MEDMAR NAVI/i.test(header) || !/Fattura N\./i.test(header)) throw new Error("Il documento non sembra una fattura Medmar dettagliata.");
  if (!lines.length) throw new Error("Nessun numero biglietto leggibile nella fattura.");
  return lines;
}
