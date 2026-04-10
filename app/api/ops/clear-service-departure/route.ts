/**
 * POST /api/ops/clear-service-departure
 * Rimuove la tratta di ritorno da un servizio esistente (departure_date = null, departure_time = null).
 * Non elimina il record — l'arrivo rimane intatto.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

const bodySchema = z.object({ id: z.string().uuid() });

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator"]);
  if (auth instanceof NextResponse) return auth;

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Payload non valido." }, { status: 400 });

  const tenantId = auth.membership.tenant_id;
  const { id } = parsed.data;

  // Verifica che il servizio esista e appartenga al tenant
  const { data: service } = await auth.admin
    .from("services")
    .select("id, arrival_date, departure_date")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (!service?.id) return NextResponse.json({ error: "Servizio non trovato." }, { status: 404 });

  const { error } = await auth.admin
    .from("services")
    .update({ departure_date: null, departure_time: null })
    .eq("id", id)
    .eq("tenant_id", tenantId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
