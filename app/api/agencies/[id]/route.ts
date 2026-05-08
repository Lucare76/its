/**
 * PATCH /api/agencies/[id]
 * Aggiorna le impostazioni di un'agenzia (incluse quelle estratto conto).
 * Protetto: admin / operator.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { type SupabaseClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

const patchSchema = z.object({
  name:                           z.string().min(1).max(200).optional(),
  billing_name:                   z.string().max(200).nullable().optional(),
  legal_name:                     z.string().max(200).nullable().optional(),
  contact_email:                  z.string().email().max(200).nullable().optional(),
  booking_email:                  z.string().email().max(200).nullable().optional(),
  phone:                          z.string().max(32).nullable().optional(),
  notes:                          z.string().max(2000).nullable().optional(),
  default_pricing_notes:          z.string().max(1000).nullable().optional(),
  parser_key_hint:                z.string().max(100).nullable().optional(),
  sender_domains:                 z.array(z.string().max(100)).nullable().optional(),
  default_enabled_booking_kinds:  z.array(z.string().max(60)).nullable().optional(),
  invoice_email:                  z.string().email().max(200).nullable().optional(),
  invoice_cadence:                z.string().max(20).nullable().optional(),
  invoice_send_day:               z.number().int().min(1).max(31).nullable().optional(),
  invoice_enabled:                z.boolean().optional(),
  vat_number:                     z.string().max(30).nullable().optional(),
  pec_email:                      z.string().email().max(200).nullable().optional(),
  sdi_code:                       z.string().max(10).nullable().optional(),
  active:                         z.boolean().optional(),
}).strict();

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorizePricingRequest(request, ["admin", "operator"]);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const tenantId = auth.membership.tenant_id;

  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: parsed.error.issues[0]?.message ?? "Payload non valido." }, { status: 400 });
  }

  const updates = parsed.data as Record<string, unknown>;

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ ok: false, error: "Nessun campo da aggiornare." }, { status: 400 });
  }

  const admin = auth.admin as SupabaseClient;
  const { error } = await admin
    .from("agencies")
    .update(updates)
    .eq("id", id)
    .eq("tenant_id", tenantId);

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
