import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { extractFuelInvoiceLines } from "@/lib/server/fuel-invoice-pdf";
import { fuelCanLink, proposeFuelMatch, type FuelInvoiceLine, type ManualFuelLine } from "@/lib/server/fuel-invoice-reconciliation";

export const runtime = "nodejs";
export const maxDuration = 60;

type InvoiceRow = { id: string; line_no: number; fuel_date: string; station: string; liters: number;
  amount: number; reference: string; matched_fuel_id: string | null };
const linkSchema = z.object({ action: z.literal("link"), line_id: z.string().uuid(), fuel_id: z.string().uuid() });

export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;
  const db = auth.admin as unknown as SupabaseClient;
  const { data: imports, error } = await db.from("fuel_invoice_imports").select("id, supplier, invoice_number, filename, created_at")
    .eq("tenant_id", auth.membership.tenant_id).order("created_at", { ascending: false }).limit(30);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const importId = new URL(request.url).searchParams.get("import_id") ?? imports?.[0]?.id;
  if (!importId || !imports?.some((row) => row.id === importId)) return NextResponse.json({ imports: imports ?? [], lines: [] });
  const chosen = imports.find((row) => row.id === importId)!;
  const { data: lines, error: linesError } = await db.from("fuel_invoice_lines")
    .select("id, line_no, fuel_date, station, liters, amount, reference, matched_fuel_id")
    .eq("tenant_id", auth.membership.tenant_id).eq("import_id", importId).order("line_no");
  if (linesError) return NextResponse.json({ error: linesError.message }, { status: 500 });
  const invoiceDates = (lines ?? []).map((line) => line.fuel_date as string).sort();
  const dateFrom = invoiceDates[0];
  const dateTo = invoiceDates.at(-1);
  let manualQuery = db.from("vehicle_fuel")
    .select("id, fuel_date, station, liters, cost, invoice_supplier, vehicle_id, km_at_fuel, fuel_type, notes")
    .eq("tenant_id", auth.membership.tenant_id).eq("invoice_supplier", chosen.supplier);
  if (dateFrom && dateTo) manualQuery = manualQuery.gte("fuel_date", dateFrom).lte("fuel_date", dateTo);
  const { data: manual, error: manualError } = await manualQuery.limit(3000);
  if (manualError) return NextResponse.json({ error: manualError.message }, { status: 500 });
  const { data: allLinks } = await db.from("fuel_invoice_lines").select("matched_fuel_id")
    .eq("tenant_id", auth.membership.tenant_id).not("matched_fuel_id", "is", null);
  const linked = new Set<string>((allLinks ?? []).map((row) => row.matched_fuel_id as string));
  const proposals = ((lines ?? []) as InvoiceRow[]).map((line) => ({
    ...line, manual_match: line.matched_fuel_id
      ? (manual ?? []).find((row) => row.id === line.matched_fuel_id) ?? null
      : null,
    proposal: line.matched_fuel_id ? null : proposeFuelMatch(
      { date: line.fuel_date, station: line.station, liters: Number(line.liters), amount: Number(line.amount), reference: line.reference },
      (manual ?? []) as ManualFuelLine[], chosen.supplier, linked,
    ),
  }));
  const unbilledManual = (manual ?? []).filter((row) =>
    !linked.has(row.id) && (!dateFrom || row.fuel_date >= dateFrom) && (!dateTo || row.fuel_date <= dateTo));
  return NextResponse.json({ imports, selected_import: chosen, lines: proposals, unbilled_manual: unbilledManual });
}

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;
  const db = auth.admin as unknown as SupabaseClient;
  const tenantId = auth.membership.tenant_id;
  if (request.headers.get("content-type")?.startsWith("multipart/form-data")) {
    const form = await request.formData();
    const pdf = form.get("pdf");
    const supplier = form.get("supplier");
    const invoiceNumber = String(form.get("invoice_number") ?? "").trim();
    if (!(pdf instanceof File) || !["ENI", "UTA"].includes(String(supplier)) || invoiceNumber.length < 2 || invoiceNumber.length > 80)
      return NextResponse.json({ error: "PDF, fornitore e numero fattura richiesti." }, { status: 400 });
    if (pdf.size > 6 * 1024 * 1024 || pdf.size < 100 || !pdf.name.toLowerCase().endsWith(".pdf"))
      return NextResponse.json({ error: "Carica un PDF di massimo 6 MB." }, { status: 400 });
    const bytes = new Uint8Array(await pdf.arrayBuffer());
    let parsed: Awaited<ReturnType<typeof extractFuelInvoiceLines>>;
    try { parsed = await extractFuelInvoiceLines(bytes, supplier as "ENI" | "UTA"); }
    catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "PDF non leggibile." }, { status: 422 }); }
    if (parsed.invoiceNumber && parsed.invoiceNumber.replace(/\W/g, "") !== invoiceNumber.replace(/\W/g, ""))
      return NextResponse.json({ error: `Il numero fattura inserito non coincide con quello letto nel PDF (${parsed.invoiceNumber}).` }, { status: 422 });
    const digest = createHash("sha256").update(bytes).digest("hex");
    const { data: existing } = await db.from("fuel_invoice_imports").select("id")
      .eq("tenant_id", tenantId).eq("supplier", supplier).eq("pdf_sha256", digest).maybeSingle();
    if (existing) return NextResponse.json({ ok: true, import_id: existing.id, already_imported: true });
    const { data: batch, error: batchError } = await db.from("fuel_invoice_imports").insert({
      tenant_id: tenantId, supplier, invoice_number: invoiceNumber, pdf_sha256: digest,
      filename: pdf.name.slice(0, 200), created_by: auth.user.id,
    }).select("id").single();
    if (batchError || !batch) return NextResponse.json({ error: batchError?.message ?? "Importazione fallita." }, { status: 500 });
    const { error } = await db.from("fuel_invoice_lines").insert(parsed.lines.map((line, index) => ({
      tenant_id: tenantId, import_id: batch.id, line_no: index + 1, fuel_date: line.date,
      station: line.station, liters: line.liters, amount: line.amount, reference: line.reference,
    })));
    if (error) {
      await db.from("fuel_invoice_imports").delete().eq("tenant_id", tenantId).eq("id", batch.id);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true, import_id: batch.id, count: parsed.lines.length });
  }

  const parsed = linkSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Collegamento non valido." }, { status: 400 });
  const { line_id, fuel_id } = parsed.data;
  const [{ data: line }, { data: fuel }] = await Promise.all([
    db.from("fuel_invoice_lines").select("id, import_id, fuel_date, station, liters, amount, matched_fuel_id")
      .eq("tenant_id", tenantId).eq("id", line_id).maybeSingle(),
    db.from("vehicle_fuel").select("id, fuel_date, station, liters, cost, invoice_supplier")
      .eq("tenant_id", tenantId).eq("id", fuel_id).maybeSingle(),
  ]);
  if (!line || !fuel || line.matched_fuel_id) return NextResponse.json({ error: "Operazione non disponibile." }, { status: 409 });
  const { data: batch } = await db.from("fuel_invoice_imports").select("supplier").eq("tenant_id", tenantId).eq("id", line.import_id).single();
  if (!batch || !fuelCanLink(
    { date: line.fuel_date, station: line.station, liters: Number(line.liters), amount: Number(line.amount), reference: "" },
    fuel as ManualFuelLine, batch.supplier,
  )) {
    return NextResponse.json({ error: "Fornitore, data o valori del rifornimento incompatibili: collegamento non consentito." }, { status: 409 });
  }
  const { data: changed, error } = await db.from("fuel_invoice_lines")
    .update({ matched_fuel_id: fuel.id, matched_at: new Date().toISOString(), matched_by: auth.user.id })
    .eq("tenant_id", tenantId).eq("id", line.id).is("matched_fuel_id", null).select("id").maybeSingle();
  if (error || !changed) return NextResponse.json({ error: error?.message ?? "Operazione già collegata." }, { status: 409 });
  return NextResponse.json({ ok: true,
    amount_difference: fuel.cost == null ? null : Number((Number(line.amount) - Number(fuel.cost)).toFixed(2)),
    liters_difference: fuel.liters == null ? null : Number((Number(line.liters) - Number(fuel.liters)).toFixed(2)),
  });
}
