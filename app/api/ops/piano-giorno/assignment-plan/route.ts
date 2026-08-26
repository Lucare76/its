/**
 * Assegnazione Intelligente — piano persistito del giorno.
 *
 * GET  → legge l'ultimo piano generato per la data (nessun ricalcolo).
 * POST → genera/ricalcola il piano (PREPARA PIANO AUTOMATICO / RICALCOLA PIANO)
 *        tramite buildAndPersistAssignmentPlan (lib/server/assignment-engine).
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { buildAndPersistAssignmentPlan } from "@/lib/server/assignment-engine/build-plan";

export const runtime = "nodejs";

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  const url = new URL(request.url);
  const date = url.searchParams.get("date") ?? todayIso();
  const tenantId = auth.membership.tenant_id;

  const { data: plan, error: planError } = await auth.admin
    .from("assignment_plans")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("plan_date", date)
    .maybeSingle();
  if (planError) return NextResponse.json({ ok: false, error: planError.message }, { status: 500 });
  if (!plan) return NextResponse.json({ ok: true, plan: null, items: [] });

  const { data: items, error: itemsError } = await auth.admin
    .from("assignment_plan_items")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("plan_id", plan.id);
  if (itemsError) return NextResponse.json({ ok: false, error: itemsError.message }, { status: 500 });

  return NextResponse.json({ ok: true, plan, items: items ?? [] });
}

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  const body = (await request.json().catch(() => ({}))) as { date?: string };
  const date = body.date ?? todayIso();

  try {
    const result = await buildAndPersistAssignmentPlan(auth.admin, {
      tenantId: auth.membership.tenant_id,
      date,
      userId: auth.user.id,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Errore generazione piano." }, { status: 500 });
  }
}
