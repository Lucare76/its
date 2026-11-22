import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { extractMedmarInvoice, ticketNumbers } from "@/lib/server/medmar-invoice-compare";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;
  const form = await request.formData();
  const invoice = form.get("invoice");
  const tickets = form.getAll("ticket_pdf");
  const typed = String(form.get("numbers") ?? "");
  if (!(invoice instanceof File) || invoice.size < 100 || invoice.size > 10 * 1024 * 1024 ||
    !invoice.name.toLowerCase().endsWith(".pdf") || tickets.length > 20 || typed.length > 10000 ||
    tickets.some(ticket => !(ticket instanceof File) || ticket.size > 5 * 1024 * 1024 || !ticket.name.toLowerCase().endsWith(".pdf"))) {
    return NextResponse.json({ error: "Carica una fattura PDF valida e fino a 20 PDF di biglietti." }, { status: 400 });
  }
  try {
    const lines = await extractMedmarInvoice(new Uint8Array(await invoice.arrayBuffer()));
    const supplied = new Set(ticketNumbers(typed));
    for (const ticket of tickets) {
      const pdf = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const doc = await pdf.getDocument({ data: new Uint8Array(await (ticket as File).arrayBuffer()) }).promise;
      if (doc.numPages > 10) throw new Error("PDF biglietto troppo lungo.");
      for (let pageNo = 1; pageNo <= doc.numPages; pageNo++) {
        const page = await doc.getPage(pageNo); const content = await page.getTextContent();
        for (const number of ticketNumbers(content.items.filter(item => "str" in item).map(item => item.str).join(" "))) supplied.add(number);
      }
    }
    const invoiceNumbers = new Set(lines.map(line => line.number));
    return NextResponse.json({ lines: lines.map(line => ({ ...line, found: supplied.has(line.number) })),
      missing_from_invoice: [...supplied].filter(number => !invoiceNumbers.has(number)),
      supplied_count: supplied.size });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "PDF non leggibile." }, { status: 422 });
  }
}
