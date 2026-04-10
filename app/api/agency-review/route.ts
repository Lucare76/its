/**
 * POST /api/agency-review
 * Crea una sessione di revisione per un'agenzia e restituisce il token.
 * Chiamato dall'operatore prima di inviare il riepilogo.
 */
import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";

const serviceSchema = z.object({
  service_id:           z.string().optional(),
  date:                 z.string(),
  time:                 z.string(),
  customer_name:        z.string(),
  phone:                z.string().nullable().optional(),
  pax:                  z.number(),
  hotel_or_destination: z.string().nullable(),
  direction:            z.enum(["arrival", "departure"]),
  transport_type:       z.string().nullable().optional(),
  transport_time:       z.string().nullable().optional(),
});

const bodySchema = z.object({
  agency_name: z.string().min(1),
  report_type: z.enum(["arrivals_48h","departures_48h","bus_monday","reminder_24h","reminder_48h"]),
  target_date: z.string(),
  services:    z.array(serviceSchema).min(1),
});

export async function POST(request: NextRequest) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const authHeader  = request.headers.get("authorization");
  if (!supabaseUrl || !serviceKey) return NextResponse.json({ error: "Config mancante." }, { status: 500 });
  if (!authHeader?.startsWith("Bearer ")) return NextResponse.json({ error: "Non autenticato." }, { status: 401 });

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: { user }, error: authErr } = await admin.auth.getUser(authHeader.slice(7));
  if (authErr || !user) return NextResponse.json({ error: "Sessione non valida." }, { status: 401 });

  const { data: membership } = await admin.from("memberships").select("tenant_id, role").eq("user_id", user.id).maybeSingle();
  if (!membership || !["admin","operator","supervisor"].includes(membership.role as string)) {
    return NextResponse.json({ error: "Non autorizzato." }, { status: 403 });
  }

  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: body.error.issues[0]?.message ?? "Dati non validi." }, { status: 400 });

  const { data, error } = await admin
    .from("agency_review_sessions")
    .insert({
      tenant_id:   membership.tenant_id,
      agency_name: body.data.agency_name,
      report_type: body.data.report_type,
      target_date: body.data.target_date,
      services:    body.data.services,
    })
    .select("id, token")
    .single();

  if (error || !data) return NextResponse.json({ error: error?.message ?? "Errore creazione sessione." }, { status: 500 });
  return NextResponse.json({ id: data.id, token: data.token });
}
