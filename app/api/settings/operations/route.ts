import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { STATEMENT_AGENCY_NAMES } from "@/lib/server/statement-agencies";

export const runtime = "nodejs";

const payloadSchema = z.object({
  arrival_summary_hours: z.number().int().min(1).max(168),
  departure_summary_hours: z.number().int().min(1).max(168),
  monday_bus_enabled: z.boolean(),
  monday_bus_scope: z.string().min(3).max(120),
  statement_agencies: z.array(z.string().min(1).max(160)).max(50)
});

const fallbackSettings = {
  arrival_summary_hours: 48,
  departure_summary_hours: 48,
  monday_bus_enabled: true,
  monday_bus_scope: "next_sunday_by_agency",
  statement_agencies: STATEMENT_AGENCY_NAMES
};

export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator"]);
  if (auth instanceof NextResponse) return auth;

  const { data, error } = await auth.admin
    .from("tenant_operational_settings")
    .select("arrival_summary_hours, departure_summary_hours, monday_bus_enabled, monday_bus_scope, statement_agencies")
    .eq("tenant_id", auth.membership.tenant_id)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ ok: true, settings: fallbackSettings });
  }

  return NextResponse.json({ ok: true, settings: data ?? fallbackSettings });
}

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator"]);
  if (auth instanceof NextResponse) return auth;

  const parsed = payloadSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Payload non valido." }, { status: 400 });
  }

  const toSave = {
    tenant_id: auth.membership.tenant_id,
    ...parsed.data,
    updated_at: new Date().toISOString()
  };

  const { error } = await auth.admin.from("tenant_operational_settings").upsert(toSave, { onConflict: "tenant_id" });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, settings: toSave });
}
