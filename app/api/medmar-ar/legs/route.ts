/**
 * PATCH /api/medmar-ar/legs  — aggiorna stato di una tratta
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

const updateLegSchema = z.object({
  leg_id: z.string().uuid(),
  status: z.enum(["used", "available_for_reassignment", "reassigned", "lost", "not_applicable"]),
  reassigned_booking_id: z.string().uuid().nullable().optional(),
});

export async function PATCH(request: NextRequest) {
  const auth = await authorizePricingRequest(request);
  if (auth instanceof NextResponse) return auth;
  const { admin, membership, user } = auth;

  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ ok: false, error: "JSON non valido." }, { status: 400 }); }

  const parsed = updateLegSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ ok: false, error: parsed.error.issues[0]?.message ?? "Dati non validi." }, { status: 400 });

  const { data: existing } = await admin
    .from("medmar_ar_ticket_legs")
    .select("id, tenant_id")
    .eq("id", parsed.data.leg_id)
    .eq("tenant_id", membership.tenant_id)
    .maybeSingle();

  if (!existing) return NextResponse.json({ ok: false, error: "Tratta non trovata." }, { status: 404 });

  const { data, error } = await admin
    .from("medmar_ar_ticket_legs")
    .update({
      status: parsed.data.status,
      reassigned_booking_id: parsed.data.reassigned_booking_id ?? null,
      status_changed_at: new Date().toISOString(),
      status_changed_by: user.id,
    })
    .eq("id", parsed.data.leg_id)
    .eq("tenant_id", membership.tenant_id)
    .select()
    .single();

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, leg: data });
}
