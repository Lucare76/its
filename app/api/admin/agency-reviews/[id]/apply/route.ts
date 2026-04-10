/**
 * POST /api/admin/agency-reviews/[id]/apply
 * Applica le modifiche segnalate dall'agenzia ai servizi corrispondenti.
 * Richiede ruolo admin/operator/supervisor.
 */
import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

function adminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

// Mappa campo revisione → colonna DB services
const FIELD_MAP: Record<string, string> = {
  date:            "date",
  time:            "time",
  direction:       "direction",
  pax:             "pax",
  customer_name:   "customer_name",
  phone:           "phone",
  transport_type:  "transport_mode",   // train|hydrofoil|ferry|road_transfer|bus|unknown
  transport_time:  "outbound_time",    // orario mezzo
};

// Converti transport_type agenzia → TransportMode DB
function normalizeTransportMode(value: string): string {
  const map: Record<string, string> = {
    treno:      "train",
    volo:       "road_transfer", // non c'è "plane" — usiamo road_transfer come fallback
    traghetto:  "ferry",
    aliscafo:   "hydrofoil",
  };
  return map[value.toLowerCase()] ?? value;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const admin = adminClient();
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return NextResponse.json({ error: "Non autenticato." }, { status: 401 });

  const { data: { user }, error: authErr } = await admin.auth.getUser(authHeader.slice(7));
  if (authErr || !user) return NextResponse.json({ error: "Sessione non valida." }, { status: 401 });

  const { data: membership } = await admin
    .from("memberships")
    .select("tenant_id, role")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!membership || !["admin", "operator", "supervisor"].includes(membership.role as string)) {
    return NextResponse.json({ error: "Non autorizzato." }, { status: 403 });
  }

  // Legge la sessione
  const { data: session, error: sessionErr } = await admin
    .from("agency_review_sessions")
    .select("id, tenant_id, status, modifications")
    .eq("id", id)
    .eq("tenant_id", membership.tenant_id)
    .maybeSingle();

  if (sessionErr || !session) return NextResponse.json({ error: "Sessione non trovata." }, { status: 404 });
  if (session.status !== "modified") return NextResponse.json({ error: "Nessuna modifica da applicare." }, { status: 409 });

  const modifications = (session.modifications ?? []) as Array<{
    service_id: string;
    field: string;
    original: string;
    modified: string;
  }>;

  // Raggruppa per service_id per fare un update per servizio
  const byServiceId = new Map<string, Record<string, unknown>>();
  const skippedFields: string[] = [];

  for (const mod of modifications) {
    const dbField = FIELD_MAP[mod.field];
    if (!dbField) {
      skippedFields.push(mod.field);
      continue;
    }
    if (!byServiceId.has(mod.service_id)) byServiceId.set(mod.service_id, {});
    const patch = byServiceId.get(mod.service_id)!;
    if (dbField === "pax") {
      const n = parseInt(mod.modified, 10);
      if (!isNaN(n) && n > 0) patch[dbField] = n;
    } else if (dbField === "transport_mode") {
      patch[dbField] = normalizeTransportMode(mod.modified);
    } else {
      patch[dbField] = mod.modified;
    }
  }

  // Applica gli update
  const errors: string[] = [];
  for (const [serviceId, patch] of byServiceId) {
    if (Object.keys(patch).length === 0) continue;
    const { error: upErr } = await admin
      .from("services")
      .update(patch)
      .eq("id", serviceId)
      .eq("tenant_id", membership.tenant_id);
    if (upErr) errors.push(`${serviceId}: ${upErr.message}`);
  }

  if (errors.length > 0) {
    return NextResponse.json({ error: "Errori in aggiornamento servizi.", details: errors }, { status: 500 });
  }

  // Marca la sessione come "applied"
  await admin
    .from("agency_review_sessions")
    .update({ status: "applied" } as never)
    .eq("id", session.id);

  return NextResponse.json({
    ok: true,
    applied: byServiceId.size,
    skipped_fields: skippedFields.length > 0 ? [...new Set(skippedFields)] : undefined,
  });
}
