/**
 * Assegnazione Intelligente — ricalcolo incrementale del piano.
 * changedServiceIds opzionale: se presente, limita la SCRITTURA agli item
 * coinvolti (vedi expandIncrementalScope in build-plan.ts). Senza
 * changedServiceIds equivale a un ricalcolo completo (stesso comportamento
 * di POST /assignment-plan).
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { buildAndPersistAssignmentPlan } from "@/lib/server/assignment-engine/build-plan";

export const runtime = "nodejs";

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  const body = (await request.json().catch(() => ({}))) as { date?: string; changedServiceIds?: string[] };
  const date = body.date ?? todayIso();

  try {
    const result = await buildAndPersistAssignmentPlan(auth.admin, {
      tenantId: auth.membership.tenant_id,
      date,
      userId: auth.user.id,
      scope: body.changedServiceIds?.length ? { changedServiceIds: body.changedServiceIds } : undefined,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Errore ricalcolo piano." }, { status: 500 });
  }
}
