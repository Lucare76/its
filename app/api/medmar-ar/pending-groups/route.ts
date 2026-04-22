/**
 * GET  /api/medmar-ar/pending-groups  — lista gruppi pending
 * POST /api/medmar-ar/pending-groups  — crea gruppo pending
 * PATCH /api/medmar-ar/pending-groups — aggiorna stato
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor", "autista"]);
  if (auth instanceof NextResponse) return auth;
  const { admin, membership } = auth;

  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? "pending";

  const { data, error } = await admin
    .from("medmar_ar_pending_groups")
    .select("*")
    .eq("tenant_id", membership.tenant_id)
    .eq("status", status)
    .order("expires_at");

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, groups: data ?? [] });
}

const createGroupSchema = z.object({
  travel_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  route: z.enum(["pozzuoli_ischia", "pozzuoli_casamicciola", "napoli_ischia", "napoli_casamicciola"]),
  outbound_time: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  current_pax_count: z.number().int().min(1),
  booking_ids: z.array(z.string().uuid()).optional().default([]),
});

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor", "autista"]);
  if (auth instanceof NextResponse) return auth;
  const { admin, membership, user } = auth;

  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ ok: false, error: "JSON non valido." }, { status: 400 }); }

  const parsed = createGroupSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ ok: false, error: parsed.error.issues[0]?.message ?? "Dati non validi." }, { status: 400 });

  const d = parsed.data;
  // Scadenza: 24h prima del viaggio
  const travelDt = new Date(`${d.travel_date}T00:00:00Z`);
  travelDt.setUTCHours(travelDt.getUTCHours() - 24);
  const expiresAt = travelDt.toISOString();

  const { data, error } = await admin
    .from("medmar_ar_pending_groups")
    .insert({
      tenant_id: membership.tenant_id,
      travel_date: d.travel_date,
      route: d.route,
      outbound_time: d.outbound_time ?? null,
      current_pax_count: d.current_pax_count,
      target_threshold: 12,
      booking_ids: d.booking_ids,
      status: "pending",
      expires_at: expiresAt,
      created_by: user.id,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, group: data });
}

const updateGroupSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["pending", "reached_threshold", "expired", "converted_to_ticket"]).optional(),
  current_pax_count: z.number().int().min(1).optional(),
  booking_ids: z.array(z.string().uuid()).optional(),
  converted_ticket_id: z.string().uuid().nullable().optional(),
});

export async function PATCH(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor", "autista"]);
  if (auth instanceof NextResponse) return auth;
  const { admin, membership } = auth;

  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ ok: false, error: "JSON non valido." }, { status: 400 }); }

  const parsed = updateGroupSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ ok: false, error: parsed.error.issues[0]?.message ?? "Dati non validi." }, { status: 400 });

  const { id, ...rest } = parsed.data;

  const { data: existing } = await admin
    .from("medmar_ar_pending_groups")
    .select("id")
    .eq("id", id)
    .eq("tenant_id", membership.tenant_id)
    .maybeSingle();

  if (!existing) return NextResponse.json({ ok: false, error: "Gruppo non trovato." }, { status: 404 });

  const { data, error } = await admin
    .from("medmar_ar_pending_groups")
    .update(rest)
    .eq("id", id)
    .eq("tenant_id", membership.tenant_id)
    .select()
    .single();

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, group: data });
}
