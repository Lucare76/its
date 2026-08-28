import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { normalizeE164 } from "@/lib/server/whatsapp";
import { auditLog } from "@/lib/server/ops-audit";

export const runtime = "nodejs";

const bodySchema = z.object({
  updates: z.array(z.object({
    rowId: z.string().uuid(),
    status: z.enum(["da_inviare", "escluso", "da_reinviare", "pronto"]).optional(),
    phoneRaw: z.string().max(40).optional(),
  })).min(1).max(5000),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ batchId: string }> }
) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  const { batchId } = await params;
  const tenantId = auth.membership.tenant_id;

  const { data: batch } = await auth.admin
    .from("snav_convocation_batches")
    .select("id")
    .eq("id", batchId)
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (!batch) {
    return NextResponse.json({ error: "Batch non trovato" }, { status: 404 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Dati non validi" }, { status: 400 });
  }

  const now = new Date().toISOString();
  let updated = 0;

  for (const update of parsed.data.updates) {
    const patch: Record<string, unknown> = { updated_at: now };

    if (update.phoneRaw != null) {
      patch.phone_raw = update.phoneRaw;
      try {
        patch.phone_e164 = normalizeE164(update.phoneRaw);
        if (!update.status) {
          patch.status = "pronto";
          patch.error_message = null;
        }
      } catch (err) {
        patch.phone_e164 = null;
        if (!update.status) {
          patch.status = "numero_non_valido";
          patch.error_message = err instanceof Error ? err.message : "Numero non valido";
        }
      }
      auditLog({
        event: "snav_convocation_row_phone_edited",
        tenantId,
        userId: auth.user.id,
        role: auth.membership.role,
        details: { batch_id: batchId, row_id: update.rowId },
      });
    }

    if (update.status) {
      patch.status = update.status;
      auditLog({
        event: "snav_convocation_row_status_changed",
        tenantId,
        userId: auth.user.id,
        role: auth.membership.role,
        details: { batch_id: batchId, row_id: update.rowId, new_status: update.status },
      });
    }

    const { error } = await auth.admin
      .from("snav_convocation_rows")
      .update(patch)
      .eq("id", update.rowId)
      .eq("batch_id", batchId)
      .eq("tenant_id", tenantId);

    if (!error) updated++;
  }

  return NextResponse.json({ ok: true, updated });
}
