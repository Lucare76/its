/**
 * POST /api/excel/import-escursioni
 *
 * Legge un file Excel con prenotazioni escursioni e restituisce le righe parsate.
 * Colonne attese (case-insensitive, in qualsiasi ordine):
 *   Cliente | Pax | Hotel | Agenzia | Telefono | Escursione | Data | Note
 *
 * Risponde con: { ok, rows: ParsedExcelRow[] }
 * Protetto: admin / operator
 */

import * as XLSX from "xlsx";
import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import type { ParsedEscursioneBooking } from "@/app/api/email/import-escursioni/route";

export const runtime = "nodejs";

// Mappa alias colonne → campo normalizzato
const COL_MAP: Record<string, keyof ParsedEscursioneBooking> = {
  cliente: "customer_name", nome: "customer_name", "nome cliente": "customer_name", nominativo: "customer_name",
  pax: "pax", passeggeri: "pax", persone: "pax",
  hotel: "hotel_name", albergo: "hotel_name", struttura: "hotel_name",
  agenzia: "agency_name", "nome agenzia": "agency_name",
  telefono: "phone", tel: "phone", cellulare: "phone",
  escursione: "excursion_name", "tipo escursione": "excursion_name", destinazione: "excursion_name",
  data: "excursion_date", "data escursione": "excursion_date",
  note: "notes", "note operative": "notes",
};

function normalizeHeader(h: unknown): string {
  return String(h ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function parseDate(v: unknown): string | null {
  if (!v) return null;
  if (typeof v === "number") {
    // Excel serial date
    const d = XLSX.SSF.parse_date_code(v);
    if (d) return `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
  }
  const s = String(v).trim();
  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // DD/MM/YYYY or DD-MM-YYYY
  const m = s.match(/^(\d{1,2})[\/\-](\d{2})[\/\-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
}

export async function POST(req: NextRequest) {
  const auth = await authorizePricingRequest(req, ["admin", "operator"]);
  if (auth instanceof NextResponse) return auth;

  let formData: FormData;
  try { formData = await req.formData(); }
  catch { return NextResponse.json({ ok: false, error: "Richiesta non valida." }, { status: 400 }); }

  const file = formData.get("file");
  if (!(file instanceof Blob)) {
    return NextResponse.json({ ok: false, error: "File Excel mancante." }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  let wb: XLSX.WorkBook;
  try { wb = XLSX.read(buffer, { type: "buffer", cellDates: false }); }
  catch { return NextResponse.json({ ok: false, error: "File Excel non leggibile." }, { status: 400 }); }

  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const raw: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });

  if (raw.length < 2) {
    return NextResponse.json({ ok: false, error: "File vuoto o senza dati." }, { status: 400 });
  }

  // Prima riga = intestazioni
  const headers = (raw[0] as unknown[]).map(normalizeHeader);
  const colIndex = new Map<keyof ParsedEscursioneBooking, number>();
  for (let i = 0; i < headers.length; i++) {
    const field = COL_MAP[headers[i]];
    if (field && !colIndex.has(field)) colIndex.set(field, i);
  }

  if (!colIndex.has("customer_name")) {
    return NextResponse.json({
      ok: false,
      error: `Colonna 'Cliente' non trovata. Intestazioni trovate: ${headers.filter(Boolean).join(", ")}`
    }, { status: 400 });
  }

  const rows: ParsedEscursioneBooking[] = [];
  for (let r = 1; r < raw.length; r++) {
    const row = raw[r] as unknown[];
    const get = (field: keyof ParsedEscursioneBooking): string =>
      String(row[colIndex.get(field) ?? -1] ?? "").trim();

    const customerName = get("customer_name");
    if (!customerName) continue; // salta righe vuote

    const paxRaw = Number(row[colIndex.get("pax") ?? -1]);
    const pax = Number.isFinite(paxRaw) && paxRaw > 0 ? Math.round(paxRaw) : 1;

    const dateRaw = colIndex.has("excursion_date") ? row[colIndex.get("excursion_date")!] : null;

    rows.push({
      customer_name: customerName,
      pax,
      hotel_name: get("hotel_name") || null,
      agency_name: get("agency_name") || null,
      phone: get("phone") || null,
      excursion_name: get("excursion_name") || null,
      excursion_date: parseDate(dateRaw),
      notes: get("notes") || null,
    });
  }

  if (rows.length === 0) {
    return NextResponse.json({ ok: false, error: "Nessuna riga valida trovata nel file." }, { status: 400 });
  }

  return NextResponse.json({ ok: true, rows, total: rows.length });
}
