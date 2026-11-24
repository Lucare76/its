import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { extractFuelInvoiceLines } from "@/lib/server/fuel-invoice-pdf";
import { fuelCanLink, proposeFuelMatch, type FuelInvoiceLine, type ManualFuelLine } from "@/lib/server/fuel-invoice-reconciliation";
import { autoLinkExactMatches } from "@/lib/server/fuel-invoice-auto-link";
import {
  FUEL_INVOICE_CLOSE_FLAG, canCloseFuelInvoices, fuelInvoiceDocumentName, summarizeFuelInvoice,
  type SummaryFuel, type SummaryLine,
} from "@/lib/server/fuel-invoice-close";

export const runtime = "nodejs";
export const maxDuration = 60;

type InvoiceRow = { id: string; line_no: number; fuel_date: string; station: string; liters: number;
  amount: number; reference: string; matched_fuel_id: string | null; match_method: string | null };
const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("link"), line_id: z.string().uuid(), fuel_id: z.string().uuid() }),
  z.object({ action: z.literal("unlink"), line_id: z.string().uuid() }),
  z.object({ action: z.literal("close"), import_id: z.string().uuid(), note: z.string().trim().max(2000).optional() }),
  z.object({ action: z.literal("reopen"), import_id: z.string().uuid(), reason: z.string().trim().min(5).max(2000) }),
  z.object({ action: z.literal("set_closer"), user_id: z.string().uuid(), enabled: z.boolean() }),
]);

const CLOSED_ERROR = "Fattura chiusa: riaprila per modificare i collegamenti.";

async function loadInvoiceSummary(db: SupabaseClient, tenantId: string, importId: string, documentName: string) {
  const { data: lines, error } = await db.from("fuel_invoice_lines")
    .select("id, line_no, liters, amount, matched_fuel_id")
    .eq("tenant_id", tenantId).eq("import_id", importId).order("line_no");
  if (error) throw new Error(error.message);
  const fuelIds = (lines ?? []).map((line) => line.matched_fuel_id as string | null).filter((id): id is string => Boolean(id));
  let fuels: SummaryFuel[] = [];
  if (fuelIds.length) {
    const { data, error: fuelError } = await db.from("vehicle_fuel")
      .select("id, liters, cost, approval_status, fiscal_document_name, fiscal_document_url")
      .eq("tenant_id", tenantId).in("id", fuelIds);
    if (fuelError) throw new Error(fuelError.message);
    fuels = (data ?? []) as SummaryFuel[];
  }
  return { fuels, summary: summarizeFuelInvoice((lines ?? []) as SummaryLine[], fuels, documentName) };
}

export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;
  const db = auth.admin as unknown as SupabaseClient;
  const { data: imports, error } = await db.from("fuel_invoice_imports")
    .select("id, supplier, invoice_number, filename, created_at, status, closed_at, close_outcome, close_note")
    .eq("tenant_id", auth.membership.tenant_id).order("created_at", { ascending: false }).limit(30);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const importId = new URL(request.url).searchParams.get("import_id") ?? imports?.[0]?.id;
  const isAdmin = auth.membership.role === "admin";
  const permissions = { can_close: await canCloseFuelInvoices(auth), can_reopen: isAdmin, can_manage_closers: isAdmin };
  let closers: Array<{ user_id: string; full_name: string; enabled: boolean }> = [];
  if (isAdmin) {
    const [{ data: operators }, { data: flags }] = await Promise.all([
      db.from("memberships").select("user_id, full_name").eq("tenant_id", auth.membership.tenant_id)
        .eq("role", "operator").eq("suspended", false).order("full_name"),
      db.from("tenant_user_feature_flags").select("user_id, enabled")
        .eq("tenant_id", auth.membership.tenant_id).eq("feature_code", FUEL_INVOICE_CLOSE_FLAG),
    ]);
    const enabled = new Set((flags ?? []).filter((flag) => flag.enabled).map((flag) => flag.user_id as string));
    closers = (operators ?? []).map((row) => ({ user_id: row.user_id as string, full_name: row.full_name as string, enabled: enabled.has(row.user_id as string) }));
  }
  if (!importId || !imports?.some((row) => row.id === importId)) return NextResponse.json({ imports: imports ?? [], lines: [], permissions, closers });
  const chosen = imports.find((row) => row.id === importId)!;
  // Anche all'apertura: aggancia i rifornimenti registrati dopo l'importazione.
  // Una fattura chiusa non si tocca.
  const autoLinked = chosen.status === "closed" ? 0
    : await autoLinkExactMatches(db, auth.membership.tenant_id, chosen.id, chosen.supplier, auth.user.id);
  const { data: lines, error: linesError } = await db.from("fuel_invoice_lines")
    .select("id, line_no, fuel_date, station, liters, amount, reference, matched_fuel_id, match_method")
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
  const documentName = fuelInvoiceDocumentName(chosen.supplier, chosen.invoice_number);
  let summary;
  try { summary = (await loadInvoiceSummary(db, auth.membership.tenant_id, chosen.id, documentName)).summary; }
  catch (summaryError) { return NextResponse.json({ error: summaryError instanceof Error ? summaryError.message : "Riepilogo non disponibile." }, { status: 500 }); }
  const { data: reviews } = await db.from("fuel_invoice_reviews")
    .select("id, event, outcome, note, invoice_total, linked_total, lines_count, lines_linked, user_id, created_at")
    .eq("tenant_id", auth.membership.tenant_id).eq("import_id", chosen.id).order("created_at", { ascending: false });
  const reviewerIds = [...new Set((reviews ?? []).map((row) => row.user_id as string | null).filter((id): id is string => Boolean(id)))];
  const { data: reviewers } = reviewerIds.length
    ? await db.from("memberships").select("user_id, full_name").eq("tenant_id", auth.membership.tenant_id).in("user_id", reviewerIds)
    : { data: [] as Array<{ user_id: string; full_name: string }> };
  const names = new Map((reviewers ?? []).map((row) => [row.user_id as string, row.full_name as string]));
  return NextResponse.json({ imports, selected_import: chosen, lines: proposals, unbilled_manual: unbilledManual, auto_linked: autoLinked,
    summary, document_name: documentName, permissions, closers,
    reviews: (reviews ?? []).map((row) => ({ ...row, user_name: row.user_id ? names.get(row.user_id as string) ?? null : null })) });
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
    if (existing) {
      const autoLinked = await autoLinkExactMatches(db, tenantId, existing.id, String(supplier), auth.user.id);
      return NextResponse.json({ ok: true, import_id: existing.id, already_imported: true, auto_linked: autoLinked });
    }
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
    const autoLinked = await autoLinkExactMatches(db, tenantId, batch.id, String(supplier), auth.user.id);
    return NextResponse.json({ ok: true, import_id: batch.id, count: parsed.lines.length, auto_linked: autoLinked });
  }

  const parsed = actionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    const reopen = parsed.error.issues.some((issue) => issue.path[0] === "reason");
    return NextResponse.json({ error: reopen ? "Scrivi il motivo della riapertura (almeno 5 caratteri)." : "Richiesta non valida." }, { status: 400 });
  }
  const action = parsed.data;

  if (action.action === "set_closer") {
    if (auth.membership.role !== "admin") return NextResponse.json({ error: "Solo admin può abilitare la chiusura fatture." }, { status: 403 });
    const { data: member } = await db.from("memberships").select("user_id, role")
      .eq("tenant_id", tenantId).eq("user_id", action.user_id).maybeSingle();
    if (!member || member.role !== "operator") return NextResponse.json({ error: "Si possono abilitare solo gli operatori." }, { status: 400 });
    const { error } = await db.from("tenant_user_feature_flags").upsert(
      { tenant_id: tenantId, user_id: action.user_id, feature_code: FUEL_INVOICE_CLOSE_FLAG, enabled: action.enabled },
      { onConflict: "tenant_id,user_id,feature_code" },
    );
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  if (action.action === "close" || action.action === "reopen") {
    const { data: invoice } = await db.from("fuel_invoice_imports").select("id, supplier, invoice_number, status")
      .eq("tenant_id", tenantId).eq("id", action.import_id).maybeSingle();
    if (!invoice) return NextResponse.json({ error: "Fattura non trovata." }, { status: 404 });
    const documentName = fuelInvoiceDocumentName(invoice.supplier, invoice.invoice_number);

    if (action.action === "reopen") {
      if (auth.membership.role !== "admin") return NextResponse.json({ error: "Solo admin può riaprire una fattura." }, { status: 403 });
      if (invoice.status !== "closed") return NextResponse.json({ error: "La fattura è già aperta." }, { status: 409 });
      const { data: reopened, error } = await db.from("fuel_invoice_imports")
        .update({ status: "open", closed_at: null, closed_by: null, close_outcome: null, close_note: null })
        .eq("tenant_id", tenantId).eq("id", invoice.id).eq("status", "closed").select("id").maybeSingle();
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      if (!reopened) return NextResponse.json({ error: "La fattura è già aperta." }, { status: 409 });
      await db.from("fuel_invoice_reviews").insert({ tenant_id: tenantId, import_id: invoice.id, event: "reopened",
        note: action.reason, user_id: auth.user.id });
      return NextResponse.json({ ok: true });
    }

    if (!(await canCloseFuelInvoices(auth)))
      return NextResponse.json({ error: "Non sei abilitato a chiudere le fatture carburante: chiedi a un admin." }, { status: 403 });
    if (invoice.status === "closed") return NextResponse.json({ error: "Fattura già chiusa." }, { status: 409 });
    let loaded;
    try { loaded = await loadInvoiceSummary(db, tenantId, invoice.id, documentName); }
    catch (summaryError) { return NextResponse.json({ error: summaryError instanceof Error ? summaryError.message : "Riepilogo non disponibile." }, { status: 500 }); }
    const { summary, fuels } = loaded;
    if (summary.lines_count === 0) return NextResponse.json({ error: "La fattura non ha righe carburante." }, { status: 409 });
    const note = action.note?.trim() || null;
    if (!summary.all_match && !note) {
      return NextResponse.json({ error: "La fattura non torna del tutto: scrivi una nota che spieghi le differenze prima di chiuderla.", summary }, { status: 400 });
    }
    const outcome = summary.all_match ? "ok" : "with_notes";
    const { data: closed, error: closeError } = await db.from("fuel_invoice_imports")
      .update({ status: "closed", closed_at: new Date().toISOString(), closed_by: auth.user.id, close_outcome: outcome, close_note: note })
      .eq("tenant_id", tenantId).eq("id", invoice.id).eq("status", "open").select("id").maybeSingle();
    if (closeError) return NextResponse.json({ error: closeError.message }, { status: 500 });
    if (!closed) return NextResponse.json({ error: "Fattura già chiusa." }, { status: 409 });
    // Documento fiscale: solo sui rifornimenti che non ne hanno uno. Mai sovrascrivere.
    const withoutDocument = fuels.filter((fuel) => !(fuel.fiscal_document_name ?? "").trim() && !(fuel.fiscal_document_url ?? "").trim())
      .map((fuel) => fuel.id);
    let documentsWritten = 0;
    if (withoutDocument.length) {
      const { data: written, error: documentError } = await db.from("vehicle_fuel")
        .update({ fiscal_document_name: documentName, last_edited_by: auth.user.id })
        .eq("tenant_id", tenantId).in("id", withoutDocument).select("id");
      if (documentError) return NextResponse.json({ error: `Fattura chiusa, ma il documento fiscale non è stato scritto: ${documentError.message}` }, { status: 500 });
      documentsWritten = written?.length ?? 0;
    }
    await db.from("fuel_invoice_reviews").insert({ tenant_id: tenantId, import_id: invoice.id, event: "closed", outcome, note,
      invoice_total: summary.invoice_total, linked_total: summary.linked_total,
      lines_count: summary.lines_count, lines_linked: summary.lines_linked, user_id: auth.user.id });
    return NextResponse.json({ ok: true, outcome, summary, documents_written: documentsWritten,
      document_conflicts: summary.document_conflicts.length });
  }

  // link / unlink: mai su una fattura chiusa (il database lo impedisce comunque).
  const { data: lineInvoice } = await db.from("fuel_invoice_lines").select("import_id")
    .eq("tenant_id", tenantId).eq("id", action.line_id).maybeSingle();
  if (lineInvoice) {
    const { data: invoiceStatus } = await db.from("fuel_invoice_imports").select("status")
      .eq("tenant_id", tenantId).eq("id", lineInvoice.import_id).maybeSingle();
    if (invoiceStatus?.status === "closed") return NextResponse.json({ error: CLOSED_ERROR }, { status: 409 });
  }

  if (action.action === "unlink") {
    const { data: changed, error } = await db.from("fuel_invoice_lines")
      .update({ matched_fuel_id: null, matched_at: null, matched_by: auth.user.id, match_method: "unlinked" })
      .eq("tenant_id", tenantId).eq("id", action.line_id).not("matched_fuel_id", "is", null)
      .select("id").maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!changed) return NextResponse.json({ error: "Riga non collegata o non trovata." }, { status: 409 });
    return NextResponse.json({ ok: true });
  }
  const { line_id, fuel_id } = action;
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
    .update({ matched_fuel_id: fuel.id, matched_at: new Date().toISOString(), matched_by: auth.user.id, match_method: "manual" })
    .eq("tenant_id", tenantId).eq("id", line.id).is("matched_fuel_id", null).select("id").maybeSingle();
  if (error || !changed) return NextResponse.json({ error: error?.message ?? "Operazione già collegata." }, { status: 409 });
  return NextResponse.json({ ok: true,
    amount_difference: fuel.cost == null ? null : Number((Number(line.amount) - Number(fuel.cost)).toFixed(2)),
    liters_difference: fuel.liters == null ? null : Number((Number(line.liters) - Number(fuel.liters)).toFixed(2)),
  });
}
