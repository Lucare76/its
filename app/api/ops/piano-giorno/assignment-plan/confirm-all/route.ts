/**
 * Assegnazione Intelligente — conferma massiva degli item auto_safe.
 *
 * Scrive UNA assegnazione reale (assignServiceCore, stessa funzione usata
 * dalla route manuale e da its.assign_driver) per ogni item auto_safe non
 * ancora confermato. Sequenziale e non parallelo DI PROPOSITO: assignServiceCore
 * verifica overlap driver/mezzo leggendo lo stato live ad ogni chiamata — una
 * scrittura parallela vedrebbe uno stato non ancora aggiornato dalle scritture
 * sorelle e potrebbe mancare un overlap reale tra due item dello stesso batch.
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { listDriverRegistry } from "@/lib/server/driver-registry";
import { assignServiceCore } from "@/lib/server/assign-service-core";
import { auditLog } from "@/lib/server/ops-audit";

export const runtime = "nodejs";

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  const body = (await request.json().catch(() => ({}))) as { date?: string };
  const date = body.date ?? todayIso();
  const tenantId = auth.membership.tenant_id;

  const { data: plan, error: planError } = await auth.admin
    .from("assignment_plans")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("plan_date", date)
    .maybeSingle();
  if (planError) return NextResponse.json({ ok: false, error: planError.message }, { status: 500 });
  if (!plan) return NextResponse.json({ ok: false, error: "Nessun piano generato per questa data." }, { status: 404 });

  const { data: items, error: itemsError } = await auth.admin
    .from("assignment_plan_items")
    .select("id, service_id, proposed_driver_id, proposed_driver_name, proposed_vehicle_label, score, confirmed_at")
    .eq("tenant_id", tenantId)
    .eq("plan_id", plan.id)
    .eq("status", "auto_safe")
    .is("confirmed_at", null);
  if (itemsError) return NextResponse.json({ ok: false, error: itemsError.message }, { status: 500 });

  const pending = items ?? [];
  const drivers = await listDriverRegistry(auth.admin, tenantId, { activeOnly: false });
  const driverUserIdByProfileId = new Map(drivers.map((driver) => [driver.id, driver.user_id]));

  const confirmed: string[] = [];
  const failed: Array<{ service_id: string; error: string }> = [];

  for (const item of pending) {
    if (!item.proposed_driver_id) {
      failed.push({ service_id: item.service_id as string, error: "Nessun autista proposto." });
      continue;
    }
    const result = await assignServiceCore(auth.admin, {
      tenantId,
      userId: auth.user.id,
      serviceId: item.service_id as string,
      driverUserId: driverUserIdByProfileId.get(item.proposed_driver_id as string) ?? null,
      driverProfileId: item.proposed_driver_id as string,
      vehicleLabel: (item.proposed_vehicle_label as string | null) ?? null,
      action: "assign",
      source: "assignment_engine_confirm_all",
      proposalId: plan.id as string,
      candidateSnapshot: [{ driver_profile_id: item.proposed_driver_id as string, score: Number(item.score ?? 0), rank: 1, hard_ok: true }],
      chosenRank: 1,
    });

    if (result.status === 200) {
      confirmed.push(item.id as string);
      auditLog({
        event: "assignment_confirmed",
        level: "info",
        tenantId,
        userId: auth.user.id,
        serviceId: item.service_id as string,
        details: { plan_id: plan.id, driver_id: item.proposed_driver_id, source: "confirm_all" },
      });
    } else {
      failed.push({ service_id: item.service_id as string, error: String(result.body.message ?? result.body.error ?? "Errore assegnazione.") });
    }
  }

  if (confirmed.length > 0) {
    const now = new Date().toISOString();
    await auth.admin
      .from("assignment_plan_items")
      .update({ confirmed_at: now, confirmed_by: auth.user.id, updated_at: now })
      .in("id", confirmed)
      .eq("tenant_id", tenantId);
  }

  return NextResponse.json({ ok: true, confirmed_count: confirmed.length, failed });
}
