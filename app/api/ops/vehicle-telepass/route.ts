import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import {
  TELEPASS_INVOICE_BUCKET, TELEPASS_INVOICE_MAX_BYTES, isAllowedInvoiceType,
  isTelepassInvoicePathOf, telepassInvoiceFolder, telepassInvoicePath,
} from "@/lib/server/telepass-invoice";

export const runtime = "nodejs";

const ROLES = ["admin", "operator", "supervisor"];
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)));
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional().transform((value) => value || null);
const uuid = z.string().uuid();

const schemas = {
  device_add: z.object({
    vehicle_id: uuid,
    device_code: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9 -]{2,38}[A-Za-z0-9]$/),
    contract_ref: optionalText(80),
    assigned_on: isoDate,
    note: optionalText(500),
  }),
  device_remove: z.object({ id: uuid, removed_on: isoDate }),
  invoice_create: z.object({
    vehicle_id: uuid,
    device_id: uuid.nullable().optional(),
    invoice_number: z.string().trim().min(1).max(60),
    invoice_date: isoDate,
    period_from: isoDate.nullable().optional(),
    period_to: isoDate.nullable().optional(),
    amount: z.number().min(0).max(99_999_999).nullable().optional(),
    note: optionalText(500),
  }),
  invoice_upload_url: z.object({ id: uuid, file_name: z.string().trim().min(1).max(240), content_type: z.string().max(120), size: z.number().int().min(1) }),
  invoice_attach: z.object({ id: uuid, path: z.string().max(500), file_name: z.string().trim().min(1).max(240) }),
  invoice_open: z.object({ id: uuid }),
  invoice_delete: z.object({ id: uuid }),
  card_assign: z.object({ card_id: uuid, vehicle_id: uuid.nullable() }),
  card_create: z.object({
    vehicle_id: uuid,
    label: z.string().trim().min(2).max(80),
    supplier: z.enum(["ENI", "UTA", "Q8"]),
    last_four: z.string().regex(/^\d{4}$/).nullable().optional(),
  }),
} as const;
type Action = keyof typeof schemas;

const INVOICE_FIELDS = "id, vehicle_id, device_id, invoice_number, invoice_date, period_from, period_to, amount, note, document_path, document_name, document_uploaded_at, created_at";

function isUniqueViolation(error: { code?: string } | null | undefined) {
  return error?.code === "23505";
}

export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ROLES);
  if (auth instanceof NextResponse) return auth;
  const vehicleId = request.nextUrl.searchParams.get("vehicle_id") ?? "";
  if (!uuid.safeParse(vehicleId).success) return NextResponse.json({ error: "vehicle_id richiesto." }, { status: 400 });
  const db = auth.admin as unknown as SupabaseClient;
  const tenantId = auth.membership.tenant_id;
  const { data: vehicle, error: vehicleError } = await db.from("vehicles").select("id, decommissioned_at")
    .eq("tenant_id", tenantId).eq("id", vehicleId).maybeSingle();
  if (vehicleError) return NextResponse.json({ error: vehicleError.message }, { status: 500 });
  if (!vehicle) return NextResponse.json({ error: "Mezzo non trovato." }, { status: 404 });

  const [devices, invoices, cards, cardHistory, vehicles] = await Promise.all([
    db.from("vehicle_telepass_devices").select("id, device_code, contract_ref, assigned_on, removed_on, note, created_at")
      .eq("tenant_id", tenantId).eq("vehicle_id", vehicleId).order("assigned_on", { ascending: false }),
    db.from("vehicle_telepass_invoices").select(INVOICE_FIELDS)
      .eq("tenant_id", tenantId).eq("vehicle_id", vehicleId).order("invoice_date", { ascending: false }).limit(500),
    db.from("fuel_cards").select("id, label, last_four, supplier, assigned_vehicle_id")
      .eq("tenant_id", tenantId).order("label"),
    db.from("fuel_card_vehicle_assignments").select("id, card_id, assigned_at, returned_at")
      .eq("tenant_id", tenantId).eq("vehicle_id", vehicleId).order("assigned_at", { ascending: false }).limit(100),
    db.from("vehicles").select("id, label, plate").eq("tenant_id", tenantId),
  ]);
  const error = devices.error ?? invoices.error ?? cards.error ?? cardHistory.error ?? vehicles.error;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({
    decommissioned: Boolean(vehicle.decommissioned_at),
    devices: devices.data ?? [],
    invoices: invoices.data ?? [],
    cards: cards.data ?? [],
    card_history: cardHistory.data ?? [],
    vehicles: vehicles.data ?? [],
  });
}

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ROLES);
  if (auth instanceof NextResponse) return auth;
  const body = await request.json().catch(() => null) as { action?: string; data?: unknown } | null;
  const action = body?.action as Action | undefined;
  if (!action || !(action in schemas)) return NextResponse.json({ error: "Azione non valida." }, { status: 400 });
  const parsed = schemas[action].safeParse(body?.data);
  if (!parsed.success) return NextResponse.json({ error: "Dati non validi: controlla i campi." }, { status: 400 });
  const data = parsed.data as Record<string, unknown>;
  const db = auth.admin as unknown as SupabaseClient;
  const tenantId = auth.membership.tenant_id;
  const storage = auth.admin.storage.from(TELEPASS_INVOICE_BUCKET);

  async function activeVehicle(vehicleId: string) {
    const { data: row } = await db.from("vehicles").select("id, decommissioned_at")
      .eq("tenant_id", tenantId).eq("id", vehicleId).maybeSingle();
    return row as { id: string; decommissioned_at: string | null } | null;
  }
  async function loadInvoice(id: string) {
    const { data: row } = await db.from("vehicle_telepass_invoices").select(INVOICE_FIELDS)
      .eq("tenant_id", tenantId).eq("id", id).maybeSingle();
    return row as { id: string; vehicle_id: string; document_path: string | null } | null;
  }

  if (action === "device_add") {
    const vehicle = await activeVehicle(String(data.vehicle_id));
    if (!vehicle) return NextResponse.json({ error: "Mezzo non trovato." }, { status: 404 });
    if (vehicle.decommissioned_at) return NextResponse.json({ error: "Mezzo dismesso: non si possono aggiungere dispositivi." }, { status: 409 });
    const { error } = await db.from("vehicle_telepass_devices").insert({
      tenant_id: tenantId, vehicle_id: vehicle.id, device_code: String(data.device_code).replace(/\s+/g, " "),
      contract_ref: data.contract_ref, assigned_on: data.assigned_on, note: data.note, created_by: auth.user.id,
    });
    if (isUniqueViolation(error)) return NextResponse.json({ error: "Questo Telepass è già attivo su un mezzo: toglilo prima da lì." }, { status: 409 });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  if (action === "device_remove") {
    const { data: device } = await db.from("vehicle_telepass_devices").select("id, assigned_on, removed_on")
      .eq("tenant_id", tenantId).eq("id", data.id).maybeSingle();
    if (!device) return NextResponse.json({ error: "Dispositivo non trovato." }, { status: 404 });
    if (device.removed_on) return NextResponse.json({ error: "Dispositivo già tolto." }, { status: 409 });
    if (String(data.removed_on) < String(device.assigned_on)) return NextResponse.json({ error: "La data di rimozione è prima dell'installazione." }, { status: 400 });
    const { error } = await db.from("vehicle_telepass_devices").update({ removed_on: data.removed_on })
      .eq("tenant_id", tenantId).eq("id", device.id).is("removed_on", null);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  if (action === "invoice_create") {
    const vehicle = await activeVehicle(String(data.vehicle_id));
    if (!vehicle) return NextResponse.json({ error: "Mezzo non trovato." }, { status: 404 });
    if (data.period_from && data.period_to && String(data.period_to) < String(data.period_from)) {
      return NextResponse.json({ error: "Il periodo finisce prima di iniziare." }, { status: 400 });
    }
    if (data.device_id) {
      const { data: device } = await db.from("vehicle_telepass_devices").select("id")
        .eq("tenant_id", tenantId).eq("vehicle_id", vehicle.id).eq("id", data.device_id).maybeSingle();
      if (!device) return NextResponse.json({ error: "Dispositivo non di questo mezzo." }, { status: 400 });
    }
    const { data: created, error } = await db.from("vehicle_telepass_invoices").insert({
      tenant_id: tenantId, vehicle_id: vehicle.id, device_id: data.device_id ?? null,
      invoice_number: data.invoice_number, invoice_date: data.invoice_date,
      period_from: data.period_from ?? null, period_to: data.period_to ?? null,
      amount: data.amount ?? null, note: data.note, created_by: auth.user.id,
    }).select("id").maybeSingle();
    if (isUniqueViolation(error)) return NextResponse.json({ error: "Fattura già registrata per questo mezzo." }, { status: 409 });
    if (error || !created) return NextResponse.json({ error: error?.message ?? "Fattura non salvata." }, { status: 500 });
    return NextResponse.json({ ok: true, id: created.id });
  }

  if (action === "invoice_upload_url") {
    if (!isAllowedInvoiceType(String(data.content_type))) {
      return NextResponse.json({ error: "Formato non supportato: carica un PDF o una foto (JPG, PNG, WEBP)." }, { status: 400 });
    }
    if (Number(data.size) > TELEPASS_INVOICE_MAX_BYTES) return NextResponse.json({ error: "File troppo grande (massimo 10 MB)." }, { status: 400 });
    const invoice = await loadInvoice(String(data.id));
    if (!invoice) return NextResponse.json({ error: "Fattura non trovata." }, { status: 404 });
    const { data: signed, error } = await storage.createSignedUploadUrl(telepassInvoicePath(tenantId, invoice.id, String(data.file_name)));
    if (error || !signed) return NextResponse.json({ error: error?.message ?? "Caricamento non disponibile." }, { status: 500 });
    return NextResponse.json({ ok: true, path: signed.path, token: signed.token });
  }

  if (action === "invoice_attach") {
    const id = String(data.id); const path = String(data.path);
    if (!isTelepassInvoicePathOf(path, tenantId, id)) return NextResponse.json({ error: "Percorso del file non valido." }, { status: 400 });
    const invoice = await loadInvoice(id);
    if (!invoice) return NextResponse.json({ error: "Fattura non trovata." }, { status: 404 });
    const folder = telepassInvoiceFolder(tenantId, id);
    const { data: listed, error: listError } = await storage.list(folder, { limit: 100 });
    if (listError) return NextResponse.json({ error: listError.message }, { status: 500 });
    if (!(listed ?? []).some((object) => `${folder}/${object.name}` === path)) {
      return NextResponse.json({ error: "Il file non risulta caricato: riprova." }, { status: 409 });
    }
    const { error } = await db.from("vehicle_telepass_invoices")
      .update({ document_path: path, document_name: data.file_name, document_uploaded_at: new Date().toISOString() })
      .eq("tenant_id", tenantId).eq("id", id);
    if (error) {
      await storage.remove([path]);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (invoice.document_path && invoice.document_path !== path) await storage.remove([invoice.document_path]);
    return NextResponse.json({ ok: true });
  }

  if (action === "invoice_open") {
    const invoice = await loadInvoice(String(data.id));
    if (!invoice) return NextResponse.json({ error: "Fattura non trovata." }, { status: 404 });
    if (!invoice.document_path) return NextResponse.json({ error: "Nessun file allegato." }, { status: 404 });
    const { data: signed, error } = await storage.createSignedUrl(invoice.document_path, 300);
    if (error || !signed) return NextResponse.json({ error: error?.message ?? "File non disponibile." }, { status: 500 });
    return NextResponse.json({ ok: true, url: signed.signedUrl });
  }

  if (action === "invoice_delete") {
    const invoice = await loadInvoice(String(data.id));
    if (!invoice) return NextResponse.json({ error: "Fattura non trovata." }, { status: 404 });
    const { error } = await db.from("vehicle_telepass_invoices").delete().eq("tenant_id", tenantId).eq("id", invoice.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (invoice.document_path) await storage.remove([invoice.document_path]);
    return NextResponse.json({ ok: true });
  }

  if (action === "card_assign") {
    if (data.vehicle_id) {
      const vehicle = await activeVehicle(String(data.vehicle_id));
      if (!vehicle || vehicle.decommissioned_at) return NextResponse.json({ error: "Mezzo non trovato o dismesso." }, { status: 404 });
    }
    const { error } = await db.rpc("assign_fuel_card_vehicle", {
      p_tenant_id: tenantId, p_card_id: data.card_id, p_vehicle_id: data.vehicle_id, p_actor_id: auth.user.id,
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 409 });
    return NextResponse.json({ ok: true });
  }

  // card_create: nuova carta già abbinata a questo mezzo.
  const vehicle = await activeVehicle(String(data.vehicle_id));
  if (!vehicle || vehicle.decommissioned_at) return NextResponse.json({ error: "Mezzo non trovato o dismesso." }, { status: 404 });
  const { data: card, error: cardError } = await db.from("fuel_cards").insert({
    tenant_id: tenantId, label: data.label, supplier: data.supplier, last_four: data.last_four ?? null,
  }).select("id").maybeSingle();
  if (isUniqueViolation(cardError)) return NextResponse.json({ error: "Esiste già una carta con questo nome." }, { status: 409 });
  if (cardError || !card) return NextResponse.json({ error: cardError?.message ?? "Carta non salvata." }, { status: 500 });
  const { error } = await db.rpc("assign_fuel_card_vehicle", {
    p_tenant_id: tenantId, p_card_id: card.id, p_vehicle_id: vehicle.id, p_actor_id: auth.user.id,
  });
  if (error) return NextResponse.json({ error: `Carta creata ma non abbinata: ${error.message}` }, { status: 500 });
  return NextResponse.json({ ok: true, id: card.id });
}
