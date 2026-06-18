import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

const bodySchema = z.object({
  updates: z.array(z.object({
    rowId: z.string().uuid(),
    status: z.enum(["da_inviare", "escluso", "da_reinviare", "pronto"]),
  })).min(1).max(5000),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ batchId: string }> }
) {
  const auth = await authorizePricingRequest(request, ["admin", "operator"]);
  if (auth instanceof NextResponse) return auth;

  const { batchId } = await params;
  const tenantId = auth.membership.tenant_id;

  const { data: batch } = await auth.admin
    .from("bus_convocation_batches")
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
    const { error } = await auth.admin
      .from("bus_convocation_rows")
      .update({ status: update.status, updated_at: now })
      .eq("id", update.rowId)
      .eq("batch_id", batchId)
      .eq("tenant_id", tenantId);

    if (!error) updated++;
  }

  return NextResponse.json({ ok: true, updated });
}
