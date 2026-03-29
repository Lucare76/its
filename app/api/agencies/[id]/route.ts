/**
 * PATCH /api/agencies/[id]
 * Aggiorna le impostazioni di un'agenzia (incluse quelle estratto conto).
 * Protetto: admin / operator.
 */

import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorizePricingRequest(request, ["admin", "operator"]);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const tenantId = auth.membership.tenant_id;

  let body: Record<string, unknown>;
  try { body = (await request.json()) as Record<string, unknown>; }
  catch { return NextResponse.json({ ok: false, error: "Body JSON non valido." }, { status: 400 }); }

  // Campi aggiornabili
  const allowed = [
    "name", "billing_name", "legal_name", "contact_email", "booking_email",
    "phone", "notes", "default_pricing_notes",
    "invoice_email", "invoice_cadence", "invoice_send_day", "invoice_enabled",
    "vat_number", "pec_email", "sdi_code", "active"
  ];
  const updates: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in body) updates[key] = body[key];
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ ok: false, error: "Nessun campo da aggiornare." }, { status: 400 });
  }

  const { error } = await (auth.admin as any)
    .from("agencies")
    .update(updates)
    .eq("id", id)
    .eq("tenant_id", tenantId);

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
