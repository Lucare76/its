/**
 * GET  /api/medmar-ar/prices  — tariffe attive per data
 * POST /api/medmar-ar/prices  — crea nuova tariffa (storicizzazione)
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { DEFAULT_PRICES_CENTS, type PriceType } from "@/lib/medmar-ar/types";
import { type SupabaseClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

const PRICE_TYPES: PriceType[] = [
  "round_trip_per_leg",
  "single_trip_under_12",
  "single_trip_12_or_more",
];

async function ensureDefaultPrices(admin: SupabaseClient, tenantId: string, userId: string) {
  const today = new Date().toISOString().slice(0, 10);
  for (const priceType of PRICE_TYPES) {
    const { data: existing } = await admin
      .from("medmar_ar_prices")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("price_type", priceType)
      .lte("valid_from", today)
      .or(`valid_to.is.null,valid_to.gte.${today}`)
      .limit(1)
      .maybeSingle();
    if (!existing) {
      await admin.from("medmar_ar_prices").insert({
        tenant_id: tenantId,
        price_type: priceType,
        price_cents: DEFAULT_PRICES_CENTS[priceType],
        valid_from: "2025-01-01",
        valid_to: null,
        created_by: userId,
      });
    }
  }
}

export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor", "autista"]);
  if (auth instanceof NextResponse) return auth;
  const { admin, membership, user } = auth;
  const tenantId = membership.tenant_id;

  const dateParam = new URL(request.url).searchParams.get("date") ?? new Date().toISOString().slice(0, 10);

  // Auto-seed tariffe di default se assenti
  await ensureDefaultPrices(admin, tenantId, user.id);

  const { data, error } = await admin
    .from("medmar_ar_prices")
    .select("*")
    .eq("tenant_id", tenantId)
    .lte("valid_from", dateParam)
    .or(`valid_to.is.null,valid_to.gte.${dateParam}`)
    .order("price_type")
    .order("valid_from", { ascending: false });

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  // Un record per tipo (il più recente)
  const latest: Record<string, typeof data[number]> = {};
  for (const row of data ?? []) {
    if (!latest[row.price_type]) latest[row.price_type] = row;
  }

  return NextResponse.json({ ok: true, prices: Object.values(latest), all: data });
}

const createPriceSchema = z.object({
  price_type: z.enum(["round_trip_per_leg", "single_trip_under_12", "single_trip_12_or_more"]),
  price_cents: z.number().int().positive(),
  valid_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  valid_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin"]);
  if (auth instanceof NextResponse) return auth;
  const { admin, membership, user } = auth;

  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ ok: false, error: "JSON non valido." }, { status: 400 }); }

  const parsed = createPriceSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ ok: false, error: parsed.error.issues[0]?.message ?? "Dati non validi." }, { status: 400 });

  const { data, error } = await admin
    .from("medmar_ar_prices")
    .insert({
      tenant_id: membership.tenant_id,
      price_type: parsed.data.price_type,
      price_cents: parsed.data.price_cents,
      valid_from: parsed.data.valid_from,
      valid_to: parsed.data.valid_to ?? null,
      created_by: user.id,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, price: data });
}
