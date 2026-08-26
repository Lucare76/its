/**
 * Assegnazione Intelligente — riassegnazione manuale di un item del piano
 * (review "SCEGLI [autista]", o correzione di un auto_safe/unresolved).
 *
 * Riusa assignServiceCore esattamente come confirm-all/l'assegnazione
 * manuale storica: overlap driver/mezzo, disponibilita' giorno, e — per
 * l'apprendimento ML — extractFeatures/logAssignmentChange/updateLearnedPatterns
 * gia' cablati dentro assignServiceCore (was_override calcolato li' in base
 * al driver precedente): nessuna logica ML duplicata qui.
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { listDriverRegistry } from "@/lib/server/driver-registry";
import { loadOperationalVehicles } from "@/lib/server/vehicle-catalog";
import { assignServiceCore } from "@/lib/server/assign-service-core";
import { auditLog } from "@/lib/server/ops-audit";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  const body = (await request.json().catch(() => ({}))) as { itemId?: string; driverId?: string; vehicleId?: string | null };
  if (!body.itemId || !body.driverId) {
    return NextResponse.json({ ok: false, error: "itemId e driverId sono richiesti." }, { status: 400 });
  }
  const tenantId = auth.membership.tenant_id;

  const { data: item, error: itemError } = await auth.admin
    .from("assignment_plan_items")
    .select("id, plan_id, service_id, proposed_driver_id, score, locked")
    .eq("id", body.itemId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (itemError) return NextResponse.json({ ok: false, error: itemError.message }, { status: 500 });
  if (!item) return NextResponse.json({ ok: false, error: "Item non trovato." }, { status: 404 });
  if (item.locked) return NextResponse.json({ ok: false, error: "Item bloccato: sblocca prima di riassegnare." }, { status: 409 });

  const [drivers, vehicles] = await Promise.all([
    listDriverRegistry(auth.admin, tenantId, { activeOnly: false }),
    loadOperationalVehicles(auth.admin, tenantId, { activeOnly: false }),
  ]);
  const driver = drivers.find((entry) => entry.id === body.driverId);
  if (!driver) return NextResponse.json({ ok: false, error: "Autista non trovato." }, { status: 404 });
  const vehicle = body.vehicleId ? vehicles.find((entry) => entry.id === body.vehicleId) ?? null : null;

  const wasOverride = Boolean(item.proposed_driver_id && item.proposed_driver_id !== body.driverId);
  const result = await assignServiceCore(auth.admin, {
    tenantId,
    userId: auth.user.id,
    serviceId: item.service_id as string,
    driverUserId: driver.user_id,
    driverProfileId: driver.id,
    vehicleLabel: vehicle?.label ?? null,
    action: "assign",
    source: "assignment_engine_manual_reassign",
    proposalId: item.plan_id as string,
    candidateSnapshot: item.proposed_driver_id
      ? [{ driver_profile_id: item.proposed_driver_id as string, score: Number(item.score ?? 0), rank: 1, hard_ok: true }]
      : null,
    chosenRank: wasOverride ? 2 : 1,
  });

  if (result.status !== 200) {
    return NextResponse.json({ ok: false, error: result.body.message ?? result.body.error ?? "Errore assegnazione." }, { status: result.status });
  }

  const now = new Date().toISOString();
  await auth.admin
    .from("assignment_plan_items")
    .update({
      status: "manual",
      proposed_driver_id: driver.id,
      proposed_driver_name: driver.full_name,
      proposed_vehicle_id: vehicle?.id ?? null,
      proposed_vehicle_label: vehicle?.label ?? null,
      confirmed_at: now,
      confirmed_by: auth.user.id,
      updated_at: now,
    })
    .eq("id", body.itemId)
    .eq("tenant_id", tenantId);

  auditLog({
    event: "assignment_changed",
    level: "info",
    tenantId,
    userId: auth.user.id,
    serviceId: item.service_id as string,
    details: { item_id: body.itemId, from_driver_id: item.proposed_driver_id, to_driver_id: driver.id, was_override: wasOverride },
  });

  return NextResponse.json({ ok: true, group_id: result.body.group_id ?? null });
}
