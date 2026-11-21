import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { loadCollectiveConvocations } from "@/lib/server/collective-convocations";
import { buildArrivalConvocations, type ConvocationArrival } from "@/lib/piano-arrival-convocations";
import { collectiveConvocationSchema, timeMinutes } from "@/lib/piano-collective-convocations";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;
  const date = z.string().date().safeParse(request.nextUrl.searchParams.get("date"));
  if (!date.success) return NextResponse.json({ ok: false, error: "Data non valida" }, { status: 400 });
  try {
    return NextResponse.json({ ok: true, convocations: await loadCollectiveConvocations(auth.admin, auth.membership.tenant_id, date.data) });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Errore lettura convocazioni" }, { status: 500 });
  }
}
export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;
  const parsed = collectiveConvocationSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, error: "Convocazione non valida" }, { status: 400 });
  const config = parsed.data;
  const tenantId = auth.membership.tenant_id;
  if (config.active) {
    const { data, error } = await auth.admin.from("services")
      .select("id, direction, status, time, pax, vessel, meeting_point, origin_place_type, origin_place_id, hotel_id, destination_place_id, orario_barca, ferry_details")
      .eq("tenant_id", tenantId).eq("date", config.date).eq("direction", "arrival").neq("status", "cancelled").neq("is_draft", true).limit(3000);
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    const event = buildArrivalConvocations((data ?? []) as ConvocationArrival[], new Map()).find((entry) => entry.id === config.event_key);
    if (!event || timeMinutes(config.last_departure) < timeMinutes(event.time) || timeMinutes(config.last_departure) + config.margin_max >= 1440)
      return NextResponse.json({ ok: false, error: "Traghetto o orario di ultima partenza non valido per questa giornata" }, { status: 400 });
  }
  const { error } = await auth.admin.from("collective_ferry_convocations").upsert({ ...config, tenant_id: tenantId, updated_by: auth.user.id, updated_at: new Date().toISOString() }, { onConflict: "tenant_id,date,event_key" });
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
