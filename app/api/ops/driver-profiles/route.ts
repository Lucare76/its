/**
 * GET  /api/ops/driver-profiles
 *   Elenca tutti i profili autisti del tenant (anche inattivi se ?all=1).
 *
 * POST /api/ops/driver-profiles
 *   Crea un nuovo profilo autista senza account utente.
 *   Body: { full_name, phone?, max_vehicle_capacity? }
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

const createSchema = z.object({
  full_name: z.string().min(2).max(100).transform((s) => s.trim().toUpperCase()),
  phone: z.string().max(30).nullable().optional(),
});

export async function GET(req: NextRequest) {
  try {
    const auth = await authorizePricingRequest(req, ["admin", "operator", "supervisor"]);
    if (auth instanceof NextResponse) return auth;
    const tenantId = auth.membership.tenant_id;
    const all = req.nextUrl.searchParams.get("all") === "1";

    let query = auth.admin
      .from("driver_profiles")
      .select("id, full_name, phone, active, user_id, created_at")
      .eq("tenant_id", tenantId)
      .order("full_name");

    if (!all) query = query.eq("active", true);

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    return NextResponse.json({ ok: true, profiles: data ?? [] });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Errore" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await authorizePricingRequest(req, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;
    const tenantId = auth.membership.tenant_id;

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const p = createSchema.safeParse(body);
    if (!p.success) {
      return NextResponse.json({ ok: false, error: p.error.issues[0]?.message }, { status: 400 });
    }

    // Controlla duplicati (nome uguale, stesso tenant, attivo)
    const existing = await auth.admin
      .from("driver_profiles")
      .select("id, active")
      .eq("tenant_id", tenantId)
      .ilike("full_name", p.data.full_name)
      .maybeSingle();

    if (existing.data?.id) {
      if (existing.data.active) {
        return NextResponse.json({ ok: false, error: `Autista "${p.data.full_name}" esiste già.` }, { status: 409 });
      }
      // Riattiva profilo disattivato
      const { error: reactivateErr } = await auth.admin
        .from("driver_profiles")
        .update({ active: true, phone: p.data.phone ?? null })
        .eq("id", existing.data.id)
        .eq("tenant_id", tenantId);
      if (reactivateErr) throw new Error(reactivateErr.message);
      return NextResponse.json({ ok: true, id: existing.data.id, reactivated: true });
    }

    const { data, error } = await auth.admin
      .from("driver_profiles")
      .insert({
        tenant_id: tenantId,
        full_name: p.data.full_name,
        phone: p.data.phone?.trim() || null,
        active: true,
      })
      .select("id")
      .single();

    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true, id: data.id, reactivated: false });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Errore" }, { status: 500 });
  }
}
