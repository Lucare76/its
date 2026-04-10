import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

const bodySchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500)
});

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator"]);
  if (auth instanceof NextResponse) return auth;

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Payload non valido." }, { status: 400 });
  }

  const { ids } = parsed.data;
  const tenantId = auth.membership.tenant_id;

  // Prima elimina status_events e assignments collegati (FK constraint)
  await auth.admin.from("status_events").delete().in("service_id", ids).eq("tenant_id", tenantId);
  await auth.admin.from("assignments").delete().in("service_id", ids).eq("tenant_id", tenantId);

  const { error, count } = await auth.admin
    .from("services")
    .delete({ count: "exact" })
    .in("id", ids)
    .eq("tenant_id", tenantId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, deleted: count ?? ids.length });
}
