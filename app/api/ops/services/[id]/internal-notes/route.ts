import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { auditLog } from "@/lib/server/ops-audit";

export const runtime = "nodejs";

const patchSchema = z.object({
  internal_notes: z.string().max(5000).nullable(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;

    const { id: serviceId } = await params;
    const tenantId = auth.membership.tenant_id;

    const body = await request.json().catch(() => null);
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Dati non validi." }, { status: 400 });
    }

    const { error } = await auth.admin
      .from("services")
      .update({
        internal_notes: parsed.data.internal_notes ?? null,
        internal_notes_updated_at: new Date().toISOString(),
        internal_notes_updated_by: auth.user.id,
      })
      .eq("id", serviceId)
      .eq("tenant_id", tenantId);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    auditLog({
      event: "service_internal_notes_updated",
      tenantId,
      userId: auth.user.id,
      role: auth.membership.role,
      serviceId,
      outcome: "updated",
      details: { length: parsed.data.internal_notes?.length ?? 0 },
    });

    return NextResponse.json({ ok: true, updated_at: new Date().toISOString() });
  } catch {
    return NextResponse.json({ error: "Errore interno." }, { status: 500 });
  }
}
