import { FUEL_PAYMENT_METHODS } from "@/lib/fuel-payment";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { normalizeStation } from "@/lib/server/fuel-invoice-reconciliation";
import { fuelApprovalSchema } from "@/lib/server/fleet-schemas";
import { utaNetFromGross } from "@/lib/fuel-cost";

export const runtime = "nodejs";

// Stringa vuota o solo spazi = nessun autista indicato.
const driverNameSchema = z.string().trim().max(120)
  .transform((value) => value || null).nullable().optional();

const createFuelSchema = z.object({
  vehicle_id: z.string().uuid(),
  fuel_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  liters: z.number().min(0).nullable().optional(),
  cost: z.number().min(0).nullable().optional(),
  km_at_fuel: z.number().int().min(0).nullable().optional(),
  fuel_type: z.string().max(40).nullable().optional(),
  station: z.string().max(160).nullable().optional(),
  invoice_supplier: z.enum(FUEL_PAYMENT_METHODS).nullable().optional(),
  driver_name: driverNameSchema,
  notes: z.string().max(1000).nullable().optional(),
  submitted_via_qr: z.boolean().optional(),
});

const updateFuelDocumentSchema = fuelApprovalSchema.pick({
  fiscal_document_url: true,
  fiscal_document_name: true,
}).extend({
  id: z.string().uuid(),
});

const editFuelSchema = z.object({
  id:           z.string().uuid(),
  vehicle_id:   z.string().uuid(),
  fuel_date:    z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  liters:       z.number().min(0).nullable().optional(),
  cost:         z.number().min(0).nullable().optional(),
  km_at_fuel:   z.number().int().min(0).nullable().optional(),
  fuel_type:    z.string().max(40).nullable().optional(),
  station:      z.string().max(160).nullable().optional(),
  invoice_supplier: z.enum(FUEL_PAYMENT_METHODS).nullable().optional(),
  cost_input: z.enum(["net", "gross"]).optional(),
  driver_name:  driverNameSchema,
  notes:        z.string().max(1000).nullable().optional(),
});

const RECORDS_LIMIT = 250;

// Il blocco delle fatture carburante chiuse è un trigger nel database: il suo
// messaggio è già in italiano, va solo restituito come conflitto, non come 500.
function lockedStatus(message: string) {
  return message.toLowerCase().includes("fattura carburante chiusa") ? 409 : 500;
}
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)));

const deleteFuelSchema = z.object({ id: z.string().uuid() });
const assignSupplierSchema = z.object({ id: z.string().uuid(), invoice_supplier: z.enum(FUEL_PAYMENT_METHODS) });
const reimburseSchema = z.object({ id: z.string().uuid(), note: z.string().trim().max(500).optional() });

export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");
  const onlyCashToReimburse = searchParams.get("reimbursement") === "pending";
  const vehicleId = searchParams.get("vehicle_id");
  const rawFrom = searchParams.get("date_from");
  const rawTo = searchParams.get("date_to");
  const dateFrom = rawFrom ? isoDateSchema.safeParse(rawFrom) : null;
  const dateTo = rawTo ? isoDateSchema.safeParse(rawTo) : null;
  if ((dateFrom && !dateFrom.success) || (dateTo && !dateTo.success)) {
    return NextResponse.json({ error: "Date del filtro non valide (formato AAAA-MM-GG)." }, { status: 400 });
  }
  if (dateFrom?.success && dateTo?.success && dateFrom.data > dateTo.data) {
    return NextResponse.json({ error: "La data iniziale è successiva a quella finale." }, { status: 400 });
  }

  let query = auth.admin
    .from("vehicle_fuel")
    .select("id, vehicle_id, fuel_date, liters, cost, gross_cost, km_at_fuel, fuel_type, station, invoice_supplier, driver_name, notes, approval_status, fiscal_document_url, fiscal_document_name, submitted_via_qr, approved_at, created_at, reimbursed_at, reimbursed_by, reimbursement_note")
    .eq("tenant_id", auth.membership.tenant_id)
    .order("fuel_date", { ascending: false })
    .order("created_at", { ascending: false })
    // Uno in più del limite per sapere se l'elenco è stato troncato.
    .limit(RECORDS_LIMIT + 1);

  if (onlyCashToReimburse) {
    // Lista di cose da fare: tutti i contanti non rimborsati e non respinti,
    // qualunque stato di approvazione e periodo (come il riepilogo).
    query = query.eq("invoice_supplier", "CONTANTI").is("reimbursed_at", null).neq("approval_status", "rejected");
  } else {
    if (status && ["pending", "approved", "rejected"].includes(status)) query = query.eq("approval_status", status);
    if (dateFrom?.success) query = query.gte("fuel_date", dateFrom.data);
    if (dateTo?.success) query = query.lte("fuel_date", dateTo.data);
  }
  if (vehicleId) query = query.eq("vehicle_id", vehicleId);

  const countQuery = (approvalStatus: "pending" | "approved" | "rejected") => {
    let nextQuery = auth.admin
      .from("vehicle_fuel")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", auth.membership.tenant_id)
      .eq("approval_status", approvalStatus);

    if (vehicleId) nextQuery = nextQuery.eq("vehicle_id", vehicleId);
    if (dateFrom?.success) nextQuery = nextQuery.gte("fuel_date", dateFrom.data);
    if (dateTo?.success) nextQuery = nextQuery.lte("fuel_date", dateTo.data);
    return nextQuery;
  };

  const [
    { data: records, error },
    { data: vehicles, error: vehiclesError },
    { count: pendingCount, error: pendingCountError },
    { count: approvedCount, error: approvedCountError },
    { count: rejectedCount, error: rejectedCountError },
    { data: drivers },
    { data: cashToReimburse, error: cashError },
  ] = await Promise.all([
    query,
    auth.admin.from("vehicles").select("id, label, plate, license_number").eq("tenant_id", auth.membership.tenant_id),
    countQuery("pending"),
    countQuery("approved"),
    countQuery("rejected"),
    auth.admin.from("driver_profiles").select("id, full_name")
      .eq("tenant_id", auth.membership.tenant_id).eq("active", true).order("full_name"),
    // Contanti ancora da rimborsare: indipendente dai filtri, è una lista di cose da fare.
    auth.admin.from("vehicle_fuel").select("cost, driver_name")
      .eq("tenant_id", auth.membership.tenant_id).eq("invoice_supplier", "CONTANTI")
      .is("reimbursed_at", null).neq("approval_status", "rejected").limit(2000),
  ]);

  if (error || vehiclesError || pendingCountError || approvedCountError || rejectedCountError || cashError) {
    return NextResponse.json({
      error:
        error?.message
        ?? vehiclesError?.message
        ?? pendingCountError?.message
        ?? approvedCountError?.message
        ?? rejectedCountError?.message
        ?? cashError?.message
        ?? "Errore caricamento rifornimenti.",
    }, { status: 500 });
  }

  const vehicleMap = new Map((vehicles ?? []).map((vehicle) => [vehicle.id, vehicle]));
  const truncated = (records ?? []).length > RECORDS_LIMIT;
  const enriched = (records ?? []).slice(0, RECORDS_LIMIT).map((record) => ({
    ...record,
    vehicle: vehicleMap.get(record.vehicle_id) ?? null,
  }));

  // Somme in centesimi per non accumulare errori di virgola mobile.
  const byDriver = new Map<string, { count: number; cents: number }>();
  let cashCents = 0; let cashMissingAmount = 0;
  for (const row of cashToReimburse ?? []) {
    const key = (row.driver_name ?? "").trim() || "Autista non indicato";
    const entry = byDriver.get(key) ?? { count: 0, cents: 0 };
    entry.count += 1;
    if (row.cost == null) cashMissingAmount += 1;
    else { const cents = Math.round(Number(row.cost) * 100); entry.cents += cents; cashCents += cents; }
    byDriver.set(key, entry);
  }

  return NextResponse.json({
    ok: true,
    records: enriched,
    cash_to_reimburse: {
      count: (cashToReimburse ?? []).length,
      total: cashCents / 100,
      missing_amount: cashMissingAmount,
      by_driver: [...byDriver.entries()]
        .map(([driver_name, entry]) => ({ driver_name, count: entry.count, total: entry.cents / 100 }))
        .sort((a, b) => b.total - a.total),
    },
    vehicles: vehicles ?? [],
    drivers: drivers ?? [],
    truncated,
    counts: {
      pending: pendingCount ?? 0,
      approved: approvedCount ?? 0,
      rejected: rejectedCount ?? 0,
    },
    current_role: auth.membership.role,
  });
}

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  const body = await request.json().catch(() => null) as
    | { action: "create"; data: z.infer<typeof createFuelSchema> }
    | { action: "approve"; data: z.infer<typeof fuelApprovalSchema> }
    | { action: "update_document"; data: z.infer<typeof updateFuelDocumentSchema> }
    | { action: "edit"; data: z.infer<typeof editFuelSchema> }
    | { action: "assign_supplier"; data: z.infer<typeof assignSupplierSchema> }
    | { action: "delete"; data: z.infer<typeof deleteFuelSchema> }
    | { action: "reimburse" | "unreimburse"; data: z.infer<typeof reimburseSchema> }
    | null;

  if (!body?.action || !body.data) {
    return NextResponse.json({ error: "action e data richiesti." }, { status: 400 });
  }

  if (body.action === "reimburse" || body.action === "unreimburse") {
    const parsed = reimburseSchema.safeParse(body.data);
    if (!parsed.success) return NextResponse.json({ error: "Richiesta di rimborso non valida." }, { status: 400 });
    const { data: record, error: readError } = await auth.admin.from("vehicle_fuel")
      .select("id, invoice_supplier, cost, approval_status, reimbursed_at")
      .eq("tenant_id", auth.membership.tenant_id).eq("id", parsed.data.id).maybeSingle();
    if (readError) return NextResponse.json({ error: readError.message }, { status: 500 });
    if (!record) return NextResponse.json({ error: "Rifornimento non trovato." }, { status: 404 });
    if (record.invoice_supplier !== "CONTANTI") return NextResponse.json({ error: "Si rimborsano solo i rifornimenti pagati in contanti." }, { status: 409 });

    if (body.action === "unreimburse") {
      if (auth.membership.role !== "admin") return NextResponse.json({ error: "Solo admin può annullare un rimborso." }, { status: 403 });
      const { data: changed, error } = await auth.admin.from("vehicle_fuel")
        .update({ reimbursed_at: null, reimbursed_by: null, reimbursement_note: null, last_edited_by: auth.user.id })
        .eq("tenant_id", auth.membership.tenant_id).eq("id", record.id).not("reimbursed_at", "is", null)
        .select("id").maybeSingle();
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      if (!changed) return NextResponse.json({ error: "Il rifornimento non risulta rimborsato." }, { status: 409 });
      return NextResponse.json({ ok: true });
    }

    if (auth.membership.role !== "admin" && auth.membership.role !== "operator")
      return NextResponse.json({ error: "Solo admin e operatori possono registrare un rimborso." }, { status: 403 });
    if (record.approval_status === "rejected") return NextResponse.json({ error: "Rifornimento respinto: non si rimborsa." }, { status: 409 });
    if (record.cost == null || Number(record.cost) <= 0) return NextResponse.json({ error: "Inserisci prima l'importo pagato: serve per il rimborso." }, { status: 409 });
    const { data: changed, error } = await auth.admin.from("vehicle_fuel")
      .update({ reimbursed_at: new Date().toISOString(), reimbursed_by: auth.user.id,
        reimbursement_note: parsed.data.note || null, last_edited_by: auth.user.id })
      .eq("tenant_id", auth.membership.tenant_id).eq("id", record.id).is("reimbursed_at", null)
      .select("id").maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!changed) return NextResponse.json({ error: "Rifornimento già rimborsato." }, { status: 409 });
    return NextResponse.json({ ok: true });
  }

  if (body.action === "create") {
    const parsed = createFuelSchema.parse(body.data);
    const { data: vehicle } = await auth.admin.from("vehicles").select("id")
      .eq("tenant_id", auth.membership.tenant_id).eq("id", parsed.vehicle_id).maybeSingle();
    if (!vehicle) return NextResponse.json({ error: "Mezzo non disponibile per questo tenant." }, { status: 404 });
    const { error } = await auth.admin.from("vehicle_fuel").insert({
      tenant_id: auth.membership.tenant_id,
      vehicle_id: parsed.vehicle_id,
      fuel_date: parsed.fuel_date,
      liters: parsed.liters ?? null,
      cost: parsed.cost ?? null,
      km_at_fuel: parsed.km_at_fuel ?? null,
      fuel_type: parsed.fuel_type ?? null,
      station: parsed.station ?? null,
      invoice_supplier: parsed.invoice_supplier ?? null,
      driver_name: parsed.driver_name ?? null,
      notes: parsed.notes ?? null,
      approval_status: "approved",
      approved_at: new Date().toISOString(),
      approved_by: auth.user.id,
      submitted_via_qr: false,
      created_by: auth.user.id,
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  if (body.action === "edit") {
    const parsed = editFuelSchema.parse(body.data);
    const { data: original, error: originalError } = await auth.admin.from("vehicle_fuel")
      .select("id, submitted_via_qr, invoice_supplier, reimbursed_at")
      .eq("tenant_id", auth.membership.tenant_id).eq("id", parsed.id).maybeSingle();
    if (originalError) return NextResponse.json({ error: originalError.message }, { status: 500 });
    if (!original) return NextResponse.json({ error: "Rifornimento non trovato." }, { status: 404 });
    if (original.reimbursed_at && parsed.invoice_supplier !== "CONTANTI")
      return NextResponse.json({ error: "Rifornimento in contanti già rimborsato: un admin deve prima annullare il rimborso." }, { status: 409 });
    if (parsed.cost_input === "gross" && (!original.submitted_via_qr || parsed.invoice_supplier !== "UTA"))
      return NextResponse.json({ error: "Importo lordo consentito solo per un rifornimento QR UTA." }, { status: 400 });
    const { data: vehicle } = await auth.admin.from("vehicles").select("id")
      .eq("tenant_id", auth.membership.tenant_id).eq("id", parsed.vehicle_id).maybeSingle();
    if (!vehicle) return NextResponse.json({ error: "Mezzo non disponibile per questo tenant." }, { status: 404 });
    const { data: existingLink } = await (auth.admin as unknown as SupabaseClient).from("fuel_invoice_lines")
      .select("id, fuel_date, station").eq("tenant_id", auth.membership.tenant_id).eq("matched_fuel_id", parsed.id).maybeSingle();
    if (existingLink) {
      const { data: batch } = await auth.admin.from("vehicle_fuel").select("invoice_supplier")
        .eq("tenant_id", auth.membership.tenant_id).eq("id", parsed.id).maybeSingle();
      if (parsed.invoice_supplier !== batch?.invoice_supplier) return NextResponse.json({ error: "Scollega prima la fattura per cambiare fornitore." }, { status: 409 });
      if (parsed.fuel_date !== existingLink.fuel_date || !parsed.station || !normalizeStation(parsed.station) || !normalizeStation(existingLink.station) ||
        !(normalizeStation(parsed.station).includes(normalizeStation(existingLink.station)) ||
          normalizeStation(existingLink.station).includes(normalizeStation(parsed.station))))
        return NextResponse.json({ error: "La data o il distributore non coincidono più con la fattura collegata." }, { status: 409 });
    }
    const { error } = await auth.admin
      .from("vehicle_fuel")
      .update({
        vehicle_id: parsed.vehicle_id,
        fuel_date:  parsed.fuel_date,
        liters:     parsed.liters ?? null,
        cost:       parsed.cost_input === "gross" && parsed.cost != null ? utaNetFromGross(parsed.cost) : parsed.cost ?? null,
        ...(parsed.cost_input === "gross" ? { gross_cost: parsed.cost ?? null } : {}),
        km_at_fuel: parsed.km_at_fuel ?? null,
        fuel_type:  parsed.fuel_type ?? null,
        station:    parsed.station ?? null,
        invoice_supplier: parsed.invoice_supplier ?? null,
        // Assente = invariato (es. "Correggi" dal confronto fatture); vuoto = rimosso.
        ...(parsed.driver_name !== undefined ? { driver_name: parsed.driver_name } : {}),
        last_edited_by: auth.user.id,
        notes:      parsed.notes ?? null,
      })
      .eq("tenant_id", auth.membership.tenant_id)
      .eq("id", parsed.id);
    if (error) return NextResponse.json({ error: error.message }, { status: lockedStatus(error.message) });
    return NextResponse.json({ ok: true });
  }

  if (body.action === "assign_supplier") {
    const parsed = assignSupplierSchema.safeParse(body.data);
    if (!parsed.success) return NextResponse.json({ error: "Seleziona come è stato pagato: carta ENI, UTA, Q8 o contanti." }, { status: 400 });
    const { id, invoice_supplier } = parsed.data;
    const { data: original, error: readError } = await auth.admin.from("vehicle_fuel")
      .select("id, cost, submitted_via_qr, invoice_supplier")
      .eq("tenant_id", auth.membership.tenant_id).eq("id", id).maybeSingle();
    if (readError) return NextResponse.json({ error: readError.message }, { status: 500 });
    if (!original) return NextResponse.json({ error: "Rifornimento non trovato." }, { status: 404 });
    if (original.invoice_supplier) return NextResponse.json({ error: "Fornitore già associato: aggiorna la pagina." }, { status: 409 });
    const { data: existingLink, error: linkError } = await (auth.admin as unknown as SupabaseClient).from("fuel_invoice_lines")
      .select("id").eq("tenant_id", auth.membership.tenant_id).eq("matched_fuel_id", id).maybeSingle();
    if (linkError) return NextResponse.json({ error: linkError.message }, { status: 500 });
    if (existingLink) return NextResponse.json({ error: "Scollega prima la fattura per cambiare fornitore." }, { status: 409 });
    const isUtaQr = invoice_supplier === "UTA" && original.submitted_via_qr && original.cost != null;
    const { data: updated, error } = await auth.admin.from("vehicle_fuel")
      .update({
        invoice_supplier,
        ...(isUtaQr ? { gross_cost: original.cost, cost: utaNetFromGross(original.cost) } : {}),
        last_edited_by: auth.user.id,
      })
      .eq("tenant_id", auth.membership.tenant_id).eq("id", id).is("invoice_supplier", null)
      .select("id").maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!updated) return NextResponse.json({ error: "Il rifornimento è stato modificato: aggiorna la pagina." }, { status: 409 });
    return NextResponse.json({ ok: true });
  }

  if (body.action === "delete") {
    if (auth.membership.role !== "admin") return NextResponse.json({ error: "Solo admin può eliminare un rifornimento." }, { status: 403 });
    const parsed = deleteFuelSchema.parse(body.data);
    const { error } = await auth.admin
      .from("vehicle_fuel")
      .delete()
      .eq("tenant_id", auth.membership.tenant_id)
      .eq("id", parsed.id);
    if (error) return NextResponse.json({ error: error.message }, { status: lockedStatus(error.message) });
    return NextResponse.json({ ok: true });
  }

  if (body.action === "update_document") {
    const parsed = updateFuelDocumentSchema.parse(body.data);
    const { data: currentRecord, error: currentRecordError } = await auth.admin
      .from("vehicle_fuel")
      .select("id, fiscal_document_url, fiscal_document_name")
      .eq("tenant_id", auth.membership.tenant_id)
      .eq("id", parsed.id)
      .maybeSingle();

    if (currentRecordError) return NextResponse.json({ error: currentRecordError.message }, { status: 500 });
    if (!currentRecord?.id) return NextResponse.json({ error: "Rifornimento non trovato." }, { status: 404 });

    const hasExistingDocument = Boolean(currentRecord.fiscal_document_url || currentRecord.fiscal_document_name);
    const isChangingExistingDocument =
      (currentRecord.fiscal_document_url ?? null) !== (parsed.fiscal_document_url ?? null)
      || (currentRecord.fiscal_document_name ?? null) !== (parsed.fiscal_document_name ?? null);

    if (hasExistingDocument && isChangingExistingDocument && auth.membership.role !== "admin") {
      return NextResponse.json({ error: "Solo admin può modificare un documento fiscale già inserito." }, { status: 403 });
    }

    const { error } = await auth.admin
      .from("vehicle_fuel")
      .update({
        fiscal_document_url: parsed.fiscal_document_url ?? null,
        fiscal_document_name: parsed.fiscal_document_name ?? null,
      })
      .eq("tenant_id", auth.membership.tenant_id)
      .eq("id", parsed.id);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  const parsed = fuelApprovalSchema.parse(body.data);
  const { data: currentRecord, error: currentRecordError } = await auth.admin
    .from("vehicle_fuel")
    .select("id, fiscal_document_url, fiscal_document_name")
    .eq("tenant_id", auth.membership.tenant_id)
    .eq("id", parsed.id)
    .maybeSingle();

  if (currentRecordError) return NextResponse.json({ error: currentRecordError.message }, { status: 500 });
  if (!currentRecord?.id) return NextResponse.json({ error: "Rifornimento non trovato." }, { status: 404 });

  const hasExistingDocument = Boolean(currentRecord.fiscal_document_url || currentRecord.fiscal_document_name);
  const isChangingExistingDocument =
    (currentRecord.fiscal_document_url ?? null) !== (parsed.fiscal_document_url ?? null)
    || (currentRecord.fiscal_document_name ?? null) !== (parsed.fiscal_document_name ?? null);

  if (parsed.approval_status === "approved" && hasExistingDocument && isChangingExistingDocument && auth.membership.role !== "admin") {
    return NextResponse.json({ error: "Solo admin può modificare un documento fiscale già inserito." }, { status: 403 });
  }

  const { error } = await auth.admin
    .from("vehicle_fuel")
    .update({
      approval_status: parsed.approval_status,
      approved_at: new Date().toISOString(),
      approved_by: auth.user.id,
      fiscal_document_url: parsed.fiscal_document_url ?? null,
      fiscal_document_name: parsed.fiscal_document_name ?? null,
    })
    .eq("tenant_id", auth.membership.tenant_id)
    .eq("id", parsed.id);

  if (error) return NextResponse.json({ error: error.message }, { status: lockedStatus(error.message) });
  return NextResponse.json({ ok: true });
}
