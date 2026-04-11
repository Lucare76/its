import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { parseRole } from "@/lib/rbac";
import { BUS_LINES_2026 } from "@/lib/server/bus-lines-catalog";

export const runtime = "nodejs";

function makeAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function authorize(request: NextRequest, allowedRoles = ["admin", "operator"]) {
  const admin = makeAdmin();
  if (!admin) return null;
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  const { data: { user } } = await admin.auth.getUser(token);
  if (!user) return null;
  const { data: membership } = await admin
    .from("memberships")
    .select("tenant_id, role")
    .eq("user_id", user.id)
    .maybeSingle();
  const role = parseRole(membership?.role);
  if (!membership?.tenant_id || !role || !allowedRoles.includes(role)) return null;
  return { admin, tenantId: membership.tenant_id, role };
}

// Escursioni con costo pre-caricato (da programma 2026)
export const EXCURSION_DEFAULTS: Record<string, number> = {
  "excursion_giro_isola_motonave":    1500,
  "excursion_giro_isola_minibus":     1000,
  "excursion_capri_solo":             5000,
  "excursion_capri_guida":            7900,
  "excursion_capri_giro_mare":        7500,
  "excursion_castello_aragonese":     3000,
  "excursion_procida_solo":           1500,
  "excursion_procida_guida":          3000,
  "excursion_amalfi_positano":        5500,
  "excursion_sorrento":               5500,
  "excursion_mortella":               2500,
  "excursion_nitrodi":                2200,
  "excursion_cooking_class":          5300,
  "excursion_crateri":                2000,
  "excursion_napoli":                 4500,
  "excursion_pompei":                 5000,
  "excursion_caserta":                5000,
};

export const EXCURSION_LABELS: Record<string, string> = {
  "excursion_giro_isola_motonave":    "Giro Isola Motonave",
  "excursion_giro_isola_minibus":     "Giro Isola Minibus",
  "excursion_capri_solo":             "Capri Solo Motonave",
  "excursion_capri_guida":            "Capri con Guida",
  "excursion_capri_giro_mare":        "Capri con Giro Isola via Mare",
  "excursion_castello_aragonese":     "Castello Aragonese",
  "excursion_procida_solo":           "Procida Solo Motonave",
  "excursion_procida_guida":          "Procida con Guida",
  "excursion_amalfi_positano":        "Amalfi & Positano",
  "excursion_sorrento":               "Sorrento",
  "excursion_mortella":               "La Mortella",
  "excursion_nitrodi":                "Nitrodi",
  "excursion_cooking_class":          "Cooking Class Dolci Campani",
  "excursion_crateri":                "Escursione Crateri",
  "excursion_napoli":                 "Passeggiata a Napoli",
  "excursion_pompei":                 "Pompei",
  "excursion_caserta":                "Caserta",
};

// ---------------------------------------------------------------------------
// GET /api/agency/rates
// ---------------------------------------------------------------------------
export async function GET(request: NextRequest) {
  const ctx = await authorize(request);
  if (!ctx) return NextResponse.json({ error: "Non autorizzato." }, { status: 403 });

  const [{ data: rates }, { data: agencies }, { data: customKinds }] = await Promise.all([
    ctx.admin
      .from("agency_rates")
      .select("id, agency_id, hotel_id, booking_service_kind, line_code, price_cents, cost_cents, valid_from, valid_to, notes, active")
      .eq("tenant_id", ctx.tenantId)
      .eq("active", true)
      .order("booking_service_kind")
      .order("valid_from", { ascending: false }),
    ctx.admin
      .from("agencies")
      .select("id, name")
      .eq("tenant_id", ctx.tenantId)
      .eq("active", true)
      .order("name"),
    ctx.admin
      .from("agency_rate_kinds")
      .select("id, kind_key, label")
      .eq("tenant_id", ctx.tenantId)
      .eq("active", true)
      .order("label"),
  ]);

  // Bus lines dal catalogo statico
  const busLines = BUS_LINES_2026.map((l) => ({ code: l.code, name: l.name }));

  return NextResponse.json({
    rates: rates ?? [],
    agencies: agencies ?? [],
    customKinds: customKinds ?? [],
    busLines,
    excursionDefaults: EXCURSION_DEFAULTS,
    excursionLabels: EXCURSION_LABELS,
  });
}

// ---------------------------------------------------------------------------
// POST /api/agency/rates — upsert prezzo (crea nuova versione storico)
// ---------------------------------------------------------------------------
const upsertSchema = z.object({
  agency_id:            z.string().uuid().nullable().optional(),
  booking_service_kind: z.string().min(2).max(80),
  line_code:            z.string().max(80).nullable().optional(),
  price_cents:          z.number().int().min(0).max(9999900),
  cost_cents:           z.number().int().min(0).max(9999900).nullable().optional(),
  valid_from:           z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notes:                z.string().max(500).optional(),
});

const copySchema = z.object({
  copy_from_agency_id: z.string().uuid().nullable(),
  copy_to_agency_id:   z.string().uuid().nullable(),
});

const customKindSchema = z.object({
  create_kind: z.literal(true),
  kind_key:    z.string().min(2).max(80).regex(/^[a-z0-9_]+$/),
  label:       z.string().min(2).max(120),
});

export async function POST(request: NextRequest) {
  const ctx = await authorize(request);
  if (!ctx) return NextResponse.json({ error: "Non autorizzato." }, { status: 403 });

  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Body non valido." }, { status: 400 });

  // Crea voce custom
  if (body.create_kind) {
    const parsed = customKindSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });
    const { data: inserted, error } = await ctx.admin
      .from("agency_rate_kinds")
      .insert({ tenant_id: ctx.tenantId, kind_key: parsed.data.kind_key, label: parsed.data.label })
      .select("id, kind_key, label")
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, kind: inserted });
  }

  // Copia listino
  if ("copy_from_agency_id" in body) {
    const parsed = copySchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });
    const { copy_from_agency_id, copy_to_agency_id } = parsed.data;

    let srcQuery = ctx.admin
      .from("agency_rates")
      .select("booking_service_kind, line_code, price_cents, cost_cents, notes")
      .eq("tenant_id", ctx.tenantId)
      .eq("active", true);
    srcQuery = copy_from_agency_id ? srcQuery.eq("agency_id", copy_from_agency_id) : srcQuery.is("agency_id", null);
    const { data: srcRates } = await srcQuery;
    if (!srcRates?.length) return NextResponse.json({ error: "Nessun listino trovato." }, { status: 404 });

    const today = new Date().toISOString().slice(0, 10);
    const inserts = srcRates.map((r) => ({
      tenant_id: ctx.tenantId,
      agency_id: copy_to_agency_id ?? null,
      booking_service_kind: r.booking_service_kind,
      line_code: r.line_code ?? null,
      price_cents: r.price_cents,
      cost_cents: r.cost_cents ?? null,
      valid_from: today,
      notes: r.notes ?? "",
      active: true,
    }));
    const { error } = await ctx.admin.from("agency_rates").insert(inserts);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, copied: inserts.length });
  }

  // Upsert prezzo — crea SEMPRE nuova riga (storico), non aggiorna la vecchia
  const parsed = upsertSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });

  const { agency_id, booking_service_kind, line_code, price_cents, cost_cents, valid_from, notes } = parsed.data;

  // Chiude la versione precedente (valid_to = valid_from - 1 giorno)
  const prevValidTo = new Date(valid_from);
  prevValidTo.setDate(prevValidTo.getDate() - 1);
  const prevValidToStr = prevValidTo.toISOString().slice(0, 10);

  let closeQuery = ctx.admin
    .from("agency_rates")
    .update({ valid_to: prevValidToStr })
    .eq("tenant_id", ctx.tenantId)
    .eq("booking_service_kind", booking_service_kind)
    .eq("active", true)
    .is("valid_to", null);
  closeQuery = agency_id ? closeQuery.eq("agency_id", agency_id) : closeQuery.is("agency_id", null);
  if (line_code) closeQuery = closeQuery.eq("line_code", line_code);
  await closeQuery;

  // Inserisce nuova riga
  const { data: inserted, error } = await ctx.admin
    .from("agency_rates")
    .insert({
      tenant_id: ctx.tenantId,
      agency_id: agency_id ?? null,
      booking_service_kind,
      line_code: line_code ?? null,
      price_cents,
      cost_cents: cost_cents ?? null,
      valid_from,
      notes: notes ?? "",
      active: true,
    })
    .select("id")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, id: inserted.id });
}

// ---------------------------------------------------------------------------
// DELETE /api/agency/rates — disattiva una voce
// ---------------------------------------------------------------------------
export async function DELETE(request: NextRequest) {
  const ctx = await authorize(request);
  if (!ctx) return NextResponse.json({ error: "Non autorizzato." }, { status: 403 });
  const body = await request.json().catch(() => null) as { id?: string } | null;
  if (!body?.id) return NextResponse.json({ error: "id mancante." }, { status: 400 });
  const { error } = await ctx.admin
    .from("agency_rates")
    .update({ active: false })
    .eq("id", body.id)
    .eq("tenant_id", ctx.tenantId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
