import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

const bodySchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(5000)
});

function chunkIds(ids: string[], size = 500) {
  const chunks: string[][] = [];
  for (let index = 0; index < ids.length; index += size) {
    chunks.push(ids.slice(index, index + size));
  }
  return chunks;
}

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator"]);
  if (auth instanceof NextResponse) return auth;

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Payload non valido." }, { status: 400 });
  }

  const { ids } = parsed.data;
  const tenantId = auth.membership.tenant_id;
  const idChunks = chunkIds(ids);

  // Prima elimina status_events e assignments collegati (FK constraint)
  for (const chunk of idChunks) {
    const { error: statusEventsError } = await auth.admin
      .from("status_events")
      .delete()
      .in("service_id", chunk)
      .eq("tenant_id", tenantId);
    if (statusEventsError) {
      return NextResponse.json({ error: statusEventsError.message }, { status: 500 });
    }

    const { error: assignmentsError } = await auth.admin
      .from("assignments")
      .delete()
      .in("service_id", chunk)
      .eq("tenant_id", tenantId);
    if (assignmentsError) {
      return NextResponse.json({ error: assignmentsError.message }, { status: 500 });
    }
  }

  let deleted = 0;
  for (const chunk of idChunks) {
    const { error, count } = await auth.admin
      .from("services")
      .delete({ count: "exact" })
      .in("id", chunk)
      .eq("tenant_id", tenantId);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    deleted += count ?? 0;
  }

  return NextResponse.json({ ok: true, deleted: deleted || ids.length });
}
