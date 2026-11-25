import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { maintenanceRecordSchema } from "@/lib/server/fleet-schemas";
import {
  MAINTENANCE_INVOICE_BUCKET, MAINTENANCE_INVOICE_MAX_BYTES, isAllowedInvoiceType,
  maintenanceInvoiceFolder, maintenanceInvoicePath,
} from "@/lib/server/maintenance-invoice";

export const runtime = "nodejs";

const RECORDS_LIMIT = 250;

const createMaintenanceSchema = maintenanceRecordSchema.extend({
  vehicle_id: z.string().uuid(),
});

const idSchema = z.object({ id: z.string().uuid() });
const uploadUrlSchema = idSchema.extend({
  file_name: z.string().trim().min(1).max(240),
  content_type: z.string().trim().max(100),
  size: z.number().int().positive(),
});
const attachSchema = idSchema.extend({
  path: z.string().trim().min(1).max(500),
  file_name: z.string().trim().min(1).max(240),
});

type Auth = Exclude<Awaited<ReturnType<typeof authorizePricingRequest>>, NextResponse>;

async function loadRecord(auth: Auth, id: string) {
  const { data, error } = await auth.admin.from("vehicle_maintenance")
    .select("id, invoice_document_path")
    .eq("tenant_id", auth.membership.tenant_id).eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  return data as { id: string; invoice_document_path: string | null } | null;
}

export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  const { searchParams } = new URL(request.url);
  const vehicleId = searchParams.get("vehicle_id");
  const kind = searchParams.get("kind");
  const rawYear = searchParams.get("year");
  const year = rawYear ? Number(rawYear) : null;
  if (vehicleId && !z.string().uuid().safeParse(vehicleId).success) {
    return NextResponse.json({ error: "Mezzo non valido." }, { status: 400 });
  }
  if (year !== null && (!Number.isInteger(year) || year < 2000 || year > 2100)) {
    return NextResponse.json({ error: "Anno non valido." }, { status: 400 });
  }

  let query = auth.admin
    .from("vehicle_maintenance")
    .select("id, vehicle_id, maintenance_date, description, cost, km_at_service, provider, notes, maintenance_kind, execution_mode, replaced_parts, created_at, invoice_document_name, invoice_uploaded_at")
    .eq("tenant_id", auth.membership.tenant_id)
    .order("maintenance_date", { ascending: false })
    .order("created_at", { ascending: false })
    // Uno in più del limite per sapere se l'elenco è troncato.
    .limit(RECORDS_LIMIT + 1);

  if (vehicleId) query = query.eq("vehicle_id", vehicleId);
  if (kind && ["ordinary", "extraordinary"].includes(kind)) query = query.eq("maintenance_kind", kind);
  if (year !== null) query = query.gte("maintenance_date", `${year}-01-01`).lte("maintenance_date", `${year}-12-31`);

  const [{ data: records, error }, { data: vehicles, error: vehiclesError }, { data: oldest }] = await Promise.all([
    query,
    auth.admin.from("vehicles").select("id, label, plate").eq("tenant_id", auth.membership.tenant_id),
    // Anno del primo intervento registrato: serve per l'elenco degli anni nel filtro.
    auth.admin.from("vehicle_maintenance").select("maintenance_date")
      .eq("tenant_id", auth.membership.tenant_id).order("maintenance_date", { ascending: true }).limit(1).maybeSingle(),
  ]);

  if (error || vehiclesError) {
    return NextResponse.json({ error: error?.message ?? vehiclesError?.message ?? "Errore caricamento manutenzioni." }, { status: 500 });
  }

  const currentYear = new Date().getFullYear();
  const firstYear = oldest?.maintenance_date ? Math.min(Number(String(oldest.maintenance_date).slice(0, 4)), currentYear) : currentYear;
  const years = Array.from({ length: currentYear - firstYear + 1 }, (_, index) => currentYear - index);

  const vehicleMap = new Map((vehicles ?? []).map((vehicle) => [vehicle.id, vehicle]));
  const truncated = (records ?? []).length > RECORDS_LIMIT;
  const enriched = (records ?? []).slice(0, RECORDS_LIMIT).map((record) => ({
    ...record,
    vehicle: vehicleMap.get(record.vehicle_id) ?? null,
  }));

  return NextResponse.json({ ok: true, records: enriched, vehicles: vehicles ?? [], years, truncated });
}

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;
  const tenantId = auth.membership.tenant_id;
  const storage = auth.admin.storage.from(MAINTENANCE_INVOICE_BUCKET);

  const body = await request.json().catch(() => null) as { action?: string; id?: string; data?: unknown } | null;
  if (!body?.action) return NextResponse.json({ error: "action richiesto." }, { status: 400 });

  try {
    if (body.action === "delete") {
      const parsed = idSchema.safeParse({ id: body.id });
      if (!parsed.success) return NextResponse.json({ error: "id richiesto." }, { status: 400 });
      const record = await loadRecord(auth, parsed.data.id);
      const { error } = await auth.admin.from("vehicle_maintenance").delete().eq("tenant_id", tenantId).eq("id", parsed.data.id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      // La fattura dell'intervento eliminato non deve restare orfana nello storage.
      if (record?.invoice_document_path) await storage.remove([record.invoice_document_path]);
      return NextResponse.json({ ok: true });
    }

    if (body.action === "invoice_upload_url") {
      const parsed = uploadUrlSchema.safeParse(body.data);
      if (!parsed.success) return NextResponse.json({ error: "File non valido." }, { status: 400 });
      if (!isAllowedInvoiceType(parsed.data.content_type)) {
        return NextResponse.json({ error: "Formato non supportato: carica un PDF o una foto (JPG, PNG, WEBP)." }, { status: 400 });
      }
      if (parsed.data.size > MAINTENANCE_INVOICE_MAX_BYTES) {
        return NextResponse.json({ error: "File troppo grande (massimo 10 MB)." }, { status: 400 });
      }
      if (!(await loadRecord(auth, parsed.data.id))) return NextResponse.json({ error: "Manutenzione non trovata." }, { status: 404 });
      const path = maintenanceInvoicePath(tenantId, parsed.data.id, parsed.data.file_name);
      const { data, error } = await storage.createSignedUploadUrl(path);
      if (error || !data) return NextResponse.json({ error: error?.message ?? "Caricamento non disponibile." }, { status: 500 });
      return NextResponse.json({ ok: true, path: data.path, token: data.token });
    }

    if (body.action === "invoice_attach") {
      const parsed = attachSchema.safeParse(body.data);
      if (!parsed.success) return NextResponse.json({ error: "Allegato non valido." }, { status: 400 });
      const { id, path, file_name } = parsed.data;
      const folder = maintenanceInvoiceFolder(tenantId, id);
      // Solo un file caricato nella cartella di QUESTO intervento di QUESTO tenant.
      if (!path.startsWith(`${folder}/`) || path.slice(folder.length + 1).includes("/")) {
        return NextResponse.json({ error: "Percorso del file non valido." }, { status: 400 });
      }
      const record = await loadRecord(auth, id);
      if (!record) return NextResponse.json({ error: "Manutenzione non trovata." }, { status: 404 });
      const { data: listed, error: listError } = await storage.list(folder, { limit: 100 });
      if (listError) return NextResponse.json({ error: listError.message }, { status: 500 });
      if (!(listed ?? []).some((object) => `${folder}/${object.name}` === path)) {
        return NextResponse.json({ error: "Il file non risulta caricato: riprova." }, { status: 409 });
      }
      const { error } = await auth.admin.from("vehicle_maintenance")
        .update({ invoice_document_path: path, invoice_document_name: file_name,
          invoice_uploaded_at: new Date().toISOString(), invoice_uploaded_by: auth.user.id })
        .eq("tenant_id", tenantId).eq("id", id);
      if (error) {
        await storage.remove([path]);
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
      // Sostituzione: il file precedente non serve più.
      if (record.invoice_document_path && record.invoice_document_path !== path) await storage.remove([record.invoice_document_path]);
      return NextResponse.json({ ok: true });
    }

    if (body.action === "invoice_open" || body.action === "invoice_remove") {
      const parsed = idSchema.safeParse({ id: body.id });
      if (!parsed.success) return NextResponse.json({ error: "id richiesto." }, { status: 400 });
      const record = await loadRecord(auth, parsed.data.id);
      if (!record) return NextResponse.json({ error: "Manutenzione non trovata." }, { status: 404 });
      if (!record.invoice_document_path) return NextResponse.json({ error: "Nessuna fattura allegata." }, { status: 404 });

      if (body.action === "invoice_open") {
        const { data, error } = await storage.createSignedUrl(record.invoice_document_path, 300);
        if (error || !data) return NextResponse.json({ error: error?.message ?? "File non disponibile." }, { status: 500 });
        return NextResponse.json({ ok: true, url: data.signedUrl });
      }

      const { error } = await auth.admin.from("vehicle_maintenance")
        .update({ invoice_document_path: null, invoice_document_name: null, invoice_uploaded_at: null, invoice_uploaded_by: null })
        .eq("tenant_id", tenantId).eq("id", record.id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      await storage.remove([record.invoice_document_path]);
      return NextResponse.json({ ok: true });
    }

    if (body.action !== "create") return NextResponse.json({ error: "Azione non valida." }, { status: 400 });

    const parsed = createMaintenanceSchema.safeParse(body.data);
    if (!parsed.success) return NextResponse.json({ error: "Dati manutenzione non validi." }, { status: 400 });
    const { data: vehicle } = await auth.admin.from("vehicles").select("id")
      .eq("tenant_id", tenantId).eq("id", parsed.data.vehicle_id).maybeSingle();
    if (!vehicle) return NextResponse.json({ error: "Mezzo non trovato." }, { status: 404 });
    const { data: created, error } = await auth.admin.from("vehicle_maintenance").insert({
      tenant_id: tenantId,
      vehicle_id: parsed.data.vehicle_id,
      maintenance_date: parsed.data.maintenance_date,
      description: parsed.data.description,
      cost: parsed.data.cost ?? null,
      km_at_service: parsed.data.km_at_service ?? null,
      provider: parsed.data.provider ?? null,
      notes: parsed.data.notes ?? null,
      maintenance_kind: parsed.data.maintenance_kind,
      execution_mode: parsed.data.execution_mode,
      replaced_parts: parsed.data.replaced_parts,
      created_by: auth.user.id,
    }).select("id").single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, id: created?.id ?? null });
  } catch (unexpected) {
    return NextResponse.json({ error: unexpected instanceof Error ? unexpected.message : "Errore manutenzioni." }, { status: 500 });
  }
}
