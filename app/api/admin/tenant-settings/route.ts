/**
 * GET  /api/admin/tenant-settings  — legge i dati aziendali del tenant
 * PATCH /api/admin/tenant-settings  — aggiorna i dati aziendali del tenant
 * Solo admin e supervisor.
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { z } from "zod";

export const runtime = "nodejs";

const patchSchema = z.object({
  name:           z.string().min(1).max(120).optional(),
  legal_name:     z.string().max(200).optional().nullable(),
  address:        z.string().max(300).optional().nullable(),
  vat_number:     z.string().max(30).optional().nullable(),
  contact_email:  z.string().email().max(120).optional().nullable(),
  contact_phone:  z.string().max(30).optional().nullable(),
  website_url:    z.string().url().max(200).optional().nullable().or(z.literal("")),
});

export async function GET(request: NextRequest) {
  // Solo admin (supervisor auto-aggiunto dal wrapper, operator escluso)
  const auth = await authorizePricingRequest(request, ["admin"]);
  if (auth instanceof NextResponse) return auth;

  const { data, error } = await auth.admin
    .from("tenants")
    .select("id, name, legal_name, address, vat_number, contact_email, contact_phone, website_url")
    .eq("id", auth.membership.tenant_id)
    .maybeSingle();

  if (error || !data) return NextResponse.json({ error: "Tenant non trovato." }, { status: 404 });
  return NextResponse.json(data);
}

export async function PATCH(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin"]);
  if (auth instanceof NextResponse) return auth;

  const body = patchSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: body.error.issues[0]?.message ?? "Dati non validi." }, { status: 400 });
  }

  const updates: Record<string, unknown> = { ...body.data, updated_at: new Date().toISOString() };
  if (updates.website_url === "") updates.website_url = null;

  const { error } = await auth.admin
    .from("tenants")
    .update(updates)
    .eq("id", auth.membership.tenant_id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
