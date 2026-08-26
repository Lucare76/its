/**
 * Assegnazione Intelligente — blocca/sblocca un item del piano.
 * Un item locked=true viene sempre preservato identico da un ricalcolo
 * (vedi lib/server/assignment-engine/classify-plan.ts, previousItemsByServiceId).
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { auditLog } from "@/lib/server/ops-audit";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  const body = (await request.json().catch(() => ({}))) as { itemId?: string; locked?: boolean };
  if (!body.itemId || typeof body.locked !== "boolean") {
    return NextResponse.json({ ok: false, error: "itemId e locked sono richiesti." }, { status: 400 });
  }
  const tenantId = auth.membership.tenant_id;

  const { data: item, error: itemError } = await auth.admin
    .from("assignment_plan_items")
    .select("id, service_id, status")
    .eq("id", body.itemId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (itemError) return NextResponse.json({ ok: false, error: itemError.message }, { status: 500 });
  if (!item) return NextResponse.json({ ok: false, error: "Item non trovato." }, { status: 404 });

  const nextStatus = body.locked ? "locked" : item.status === "locked" ? "review" : item.status;
  const { error: updateError } = await auth.admin
    .from("assignment_plan_items")
    .update({ locked: body.locked, status: nextStatus, updated_at: new Date().toISOString() })
    .eq("id", body.itemId)
    .eq("tenant_id", tenantId);
  if (updateError) return NextResponse.json({ ok: false, error: updateError.message }, { status: 500 });

  auditLog({
    event: "assignment_locked",
    level: "info",
    tenantId,
    userId: auth.user.id,
    serviceId: item.service_id as string,
    details: { item_id: body.itemId, locked: body.locked },
  });

  return NextResponse.json({ ok: true });
}
