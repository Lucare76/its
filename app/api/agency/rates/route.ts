import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { parseRole } from "@/lib/rbac";

export const runtime = "nodejs";

function makeAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function authorize(request: NextRequest) {
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
  if (!membership?.tenant_id || !role || !["admin", "operator"].includes(role)) return null;
  return { admin, tenantId: membership.tenant_id, role };
}

// ---------------------------------------------------------------------------
// GET /api/agency/rates
// Restituisce tutti i listini del tenant (agenzie, hotel, kind, prezzo)
// ---------------------------------------------------------------------------
export async function GET(request: NextRequest) {
  const ctx = await authorize(request);
  if (!ctx) return NextResponse.json({ error: "Non autorizzato." }, { status: 403 });

  // Rates
  const { data: rates, error } = await ctx.admin
    .from("agency_rates")
    .select("id, agency_id, hotel_id, booking_service_kind, price_cents, notes, active")
    .eq("tenant_id", ctx.tenantId)
    .eq("active", true)
    .order("booking_service_kind")
    .order("agency_id");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Agenzie
  const { data: agencies } = await ctx.admin
    .from("agencies")
    .select("id, name")
    .eq("tenant_id", ctx.tenantId)
    .eq("active", true)
    .order("name");

  // Hotel
  const { data: hotels } = await ctx.admin
    .from("hotels")
    .select("id, name, zone")
    .eq("tenant_id", ctx.tenantId)
    .order("name");

  return NextResponse.json({ rates: rates ?? [], agencies: agencies ?? [], hotels: hotels ?? [] });
}

// ---------------------------------------------------------------------------
// POST /api/agency/rates
// Upsert: crea o aggiorna un singolo prezzo (agency_id + hotel_id + kind)
// Se si passa copy_from_agency_id, clona tutto il listino di quell'agenzia
// ---------------------------------------------------------------------------
const upsertSchema = z.object({
  agency_id: z.string().uuid().nullable().optional(),
  hotel_id: z.string().uuid().nullable().optional(),
  booking_service_kind: z.string().min(2).max(80),
  price_cents: z.number().int().min(0).max(9999900),
  notes: z.string().max(500).optional()
});

const copySchema = z.object({
  copy_from_agency_id: z.string().uuid().nullable(),
  copy_to_agency_id: z.string().uuid().nullable()
});

export async function POST(request: NextRequest) {
  const ctx = await authorize(request);
  if (!ctx) return NextResponse.json({ error: "Non autorizzato." }, { status: 403 });

  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Body non valido." }, { status: 400 });

  // Modalità COPIA listino
  if ("copy_from_agency_id" in body) {
    const parsed = copySchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });
    const { copy_from_agency_id, copy_to_agency_id } = parsed.data;

    // Leggi sorgente
    let srcQuery = ctx.admin
      .from("agency_rates")
      .select("booking_service_kind, hotel_id, price_cents, notes")
      .eq("tenant_id", ctx.tenantId)
      .eq("active", true);
    if (copy_from_agency_id) {
      srcQuery = srcQuery.eq("agency_id", copy_from_agency_id);
    } else {
      srcQuery = srcQuery.is("agency_id", null);
    }
    const { data: srcRates } = await srcQuery;
    if (!srcRates?.length) return NextResponse.json({ error: "Nessun listino trovato da copiare." }, { status: 404 });

    // Disattiva precedenti per la destinazione
    let deactivateQuery = ctx.admin
      .from("agency_rates")
      .update({ active: false })
      .eq("tenant_id", ctx.tenantId);
    if (copy_to_agency_id) {
      deactivateQuery = deactivateQuery.eq("agency_id", copy_to_agency_id);
    } else {
      deactivateQuery = deactivateQuery.is("agency_id", null);
    }
    await deactivateQuery;

    // Inserisci copie
    const inserts = srcRates.map((r) => ({
      tenant_id: ctx.tenantId,
      agency_id: copy_to_agency_id ?? null,
      hotel_id: r.hotel_id ?? null,
      booking_service_kind: r.booking_service_kind,
      price_cents: r.price_cents,
      notes: r.notes ?? "",
      active: true
    }));
    const { error: insertErr } = await ctx.admin.from("agency_rates").insert(inserts);
    if (insertErr) return NextResponse.json({ error: insertErr.message }, { status: 500 });

    return NextResponse.json({ ok: true, copied: inserts.length });
  }

  // Modalità UPSERT singolo prezzo
  const parsed = upsertSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });

  const { agency_id, hotel_id, booking_service_kind, price_cents, notes } = parsed.data;

  // Cerca esistente
  let existingQuery = ctx.admin
    .from("agency_rates")
    .select("id")
    .eq("tenant_id", ctx.tenantId)
    .eq("booking_service_kind", booking_service_kind)
    .eq("active", true);
  if (agency_id) {
    existingQuery = existingQuery.eq("agency_id", agency_id);
  } else {
    existingQuery = existingQuery.is("agency_id", null);
  }
  if (hotel_id) {
    existingQuery = existingQuery.eq("hotel_id", hotel_id);
  } else {
    existingQuery = existingQuery.is("hotel_id", null);
  }
  const { data: existing } = await existingQuery.maybeSingle();

  if (existing?.id) {
    await ctx.admin
      .from("agency_rates")
      .update({ price_cents, notes: notes ?? "", updated_at: new Date().toISOString() })
      .eq("id", existing.id);
    return NextResponse.json({ ok: true, id: existing.id, action: "updated" });
  }

  const { data: inserted, error: insertErr } = await ctx.admin
    .from("agency_rates")
    .insert({
      tenant_id: ctx.tenantId,
      agency_id: agency_id ?? null,
      hotel_id: hotel_id ?? null,
      booking_service_kind,
      price_cents,
      notes: notes ?? "",
      active: true
    })
    .select("id")
    .single();

  if (insertErr) return NextResponse.json({ error: insertErr.message }, { status: 500 });
  return NextResponse.json({ ok: true, id: inserted.id, action: "created" });
}
