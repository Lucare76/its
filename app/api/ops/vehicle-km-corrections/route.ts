import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

const schema = z.object({
  vehicle_id: z.string().uuid(),
  log_id: z.string().uuid(),
  end_km: z.number().int().nonnegative(),
});

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Dati chilometrici non validi." }, { status: 400 });
  const { vehicle_id, log_id, end_km } = parsed.data;
  const tenantId = auth.membership.tenant_id;
  const { data: oldEndKm, error } = await (auth.admin as unknown as SupabaseClient).rpc("correct_vehicle_end_km", {
    p_tenant_id: tenantId, p_vehicle_id: vehicle_id, p_log_id: log_id,
    p_end_km: end_km, p_actor_id: auth.user.id,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 409 });
  return NextResponse.json({ ok: true, old_end_km: oldEndKm, new_end_km: end_km });
}
