/**
 * GET  /api/admin/tenant-settings  — legge i dati aziendali del tenant
 * PATCH /api/admin/tenant-settings  — aggiorna i dati aziendali del tenant
 * Solo admin e supervisor.
 */

import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
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

async function resolveAdmin(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/^["']|["']$/g, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim().replace(/^["']|["']$/g, "");
  const auth = request.headers.get("authorization");
  if (!url || !key) return { error: "Configurazione server mancante.", status: 500 } as const;
  if (!auth?.startsWith("Bearer ")) return { error: "Non autenticato.", status: 401 } as const;

  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: { user }, error } = await admin.auth.getUser(auth.slice(7));
  if (error || !user) return { error: "Sessione non valida.", status: 401 } as const;

  const { data: membership } = await admin
    .from("memberships")
    .select("tenant_id, role")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!membership) return { error: "Membership non trovata.", status: 403 } as const;
  if (membership.role !== "admin" && membership.role !== "supervisor") {
    return { error: "Ruolo non autorizzato.", status: 403 } as const;
  }

  return { admin, tenantId: membership.tenant_id as string };
}

export async function GET(request: NextRequest) {
  const ctx = await resolveAdmin(request);
  if ("error" in ctx) return NextResponse.json({ error: ctx.error }, { status: ctx.status });

  const { data, error } = await ctx.admin
    .from("tenants")
    .select("id, name, legal_name, address, vat_number, contact_email, contact_phone, website_url")
    .eq("id", ctx.tenantId)
    .maybeSingle();

  if (error || !data) return NextResponse.json({ error: "Tenant non trovato." }, { status: 404 });
  return NextResponse.json(data);
}

export async function PATCH(request: NextRequest) {
  const ctx = await resolveAdmin(request);
  if ("error" in ctx) return NextResponse.json({ error: ctx.error }, { status: ctx.status });

  const body = patchSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: body.error.issues[0]?.message ?? "Dati non validi." }, { status: 400 });
  }

  const updates: Record<string, unknown> = { ...body.data, updated_at: new Date().toISOString() };
  // Converti stringa vuota in null per website_url
  if (updates.website_url === "") updates.website_url = null;

  const { error } = await ctx.admin
    .from("tenants")
    .update(updates)
    .eq("id", ctx.tenantId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
