import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), label: z.string().trim().min(2).max(80), last_four: z.string().regex(/^\d{4}$/).nullable().optional(), supplier: z.string().trim().max(80).nullable().optional() }),
  z.object({ action: z.literal("assign"), card_id: z.string().uuid(), driver_id: z.string().uuid().nullable() }),
]);

export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;
  const db = auth.admin as unknown as SupabaseClient;
  const tenantId = auth.membership.tenant_id;
  const [cards, drivers, assignments] = await Promise.all([
    db.from("fuel_cards").select("id, label, last_four, supplier, assigned_driver_id").eq("tenant_id", tenantId).order("label"),
    db.from("driver_profiles").select("id, full_name").eq("tenant_id", tenantId).eq("active", true).order("full_name"),
    db.from("fuel_card_assignments").select("id, card_id, driver_id, assigned_at, returned_at")
      .eq("tenant_id", tenantId).order("assigned_at", { ascending: false }).limit(200),
  ]);
  const error = cards.error ?? drivers.error ?? assignments.error;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ cards: cards.data, drivers: drivers.data, assignments: assignments.data });
}

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Dati della carta non validi." }, { status: 400 });
  const db = auth.admin as unknown as SupabaseClient;
  if (parsed.data.action === "create") {
    const { error } = await db.from("fuel_cards").insert({ tenant_id: auth.membership.tenant_id,
      label: parsed.data.label, last_four: parsed.data.last_four ?? null, supplier: parsed.data.supplier ?? null });
    return error ? NextResponse.json({ error: error.message }, { status: 409 }) : NextResponse.json({ ok: true });
  }
  const { error } = await db.rpc("assign_fuel_card", { p_tenant_id: auth.membership.tenant_id,
    p_card_id: parsed.data.card_id, p_driver_id: parsed.data.driver_id, p_actor_id: auth.user.id });
  return error ? NextResponse.json({ error: error.message }, { status: 409 }) : NextResponse.json({ ok: true });
}
