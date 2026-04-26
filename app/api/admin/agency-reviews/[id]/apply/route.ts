/**
 * POST /api/admin/agency-reviews/[id]/apply
 * Applica le modifiche segnalate dall'agenzia ai servizi corrispondenti.
 * Richiede ruolo admin/operator/supervisor.
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

// Mappa campo revisione → colonna DB services
const FIELD_MAP: Record<string, string> = {
  date:                 "date",
  time:                 "time",
  direction:            "direction",
  pax:                  "pax",
  customer_name:        "customer_name",
  phone:                "phone",
  transport_type:       "transport_mode",
  transport_time:       "outbound_time",
  hotel_or_destination: "meeting_point",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  const auth = await authorizePricingRequest(request, ["admin", "operator"]);
  if (auth instanceof NextResponse) return auth;

  const tenantId = auth.membership.tenant_id;

  // Legge la sessione (incluse le snapshot dei servizi per risolvere i fallback service_id)
  const { data: session, error: sessionErr } = await auth.admin
    .from("agency_review_sessions")
    .select("id, tenant_id, status, modifications, services")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (sessionErr || !session) return NextResponse.json({ error: "Sessione non trovata." }, { status: 404 });
  if (session.status !== "modified") return NextResponse.json({ error: "Nessuna modifica da applicare." }, { status: 409 });

  const modifications = (session.modifications ?? []) as Array<{
    service_id: string;
    field: string;
    original: string;
    modified: string;
  }>;

  // Snapshot servizi: usata per risolvere service_id fallback (row-N) → UUID reale
  const snapshots = (session.services ?? []) as Array<{
    service_id?: string;
    date?: string;
    time?: string;
    customer_name?: string;
  }>;

  // Risolve un service_id che potrebbe essere UUID o fallback "row-N"
  const resolveServiceId = (rawId: string): string | null => {
    if (UUID_RE.test(rawId)) return rawId;
    const m = rawId.match(/^row-(\d+)$/);
    if (!m) return null;
    const idx = parseInt(m[1], 10);
    const snap = snapshots[idx];
    if (!snap?.service_id || !UUID_RE.test(snap.service_id)) return null;
    return snap.service_id;
  };

  // Raggruppa per service_id per fare un update per servizio
  const byServiceId = new Map<string, Record<string, unknown>>();
  const skippedFields: string[] = [];
  const skippedNoId: string[] = [];

  for (const mod of modifications) {
    const dbField = FIELD_MAP[mod.field];
    if (!dbField) {
      skippedFields.push(mod.field);
      continue;
    }
    const resolvedId = resolveServiceId(mod.service_id);
    if (!resolvedId) {
      skippedNoId.push(mod.field);
      continue;
    }
    if (!byServiceId.has(resolvedId)) byServiceId.set(resolvedId, {});
    const patch = byServiceId.get(resolvedId)!;
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
    const { error: upErr } = await auth.admin
      .from("services")
      .update(patch)
      .eq("id", serviceId)
      .eq("tenant_id", tenantId);
    if (upErr) errors.push(`${serviceId}: ${upErr.message}`);
  }

  if (errors.length > 0) {
    return NextResponse.json({ error: "Errori in aggiornamento servizi.", details: errors }, { status: 500 });
  }

  if (byServiceId.size === 0 && skippedNoId.length > 0) {
    await auth.admin.from("agency_review_sessions").update({ status: "applied" } as never).eq("id", session.id);
    return NextResponse.json({ ok: true, applied: 0, skipped_fields: [...new Set([...skippedFields, ...skippedNoId])], warning: "I servizi non avevano un ID tracciabile: aggiornamento manuale necessario." });
  }

  // Marca la sessione come "applied"
  await auth.admin
    .from("agency_review_sessions")
    .update({ status: "applied" } as never)
    .eq("id", session.id);

  const allSkipped = [...new Set([...skippedFields, ...skippedNoId])];
  return NextResponse.json({
    ok: true,
    applied: byServiceId.size,
    skipped_fields: allSkipped.length > 0 ? allSkipped : undefined,
  });
}
