import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

async function hasColumn(admin: any, table: string, column: string) {
  const { error } = await admin.from(table).select(column).limit(1);
  if (!error) return true;
  if ((error as { code?: string }).code === "42703") return false;
  throw new Error(`Schema probe failed for ${table}.${column}: ${error.message}`);
}

const routePayloadSchema = z.object({
  name: z.string().min(2).max(120),
  origin_label: z.string().min(2).max(120),
  destination_label: z.string().min(2).max(120)
});

async function buildRoutePayload(admin: any, tenantId: string, parsed: z.infer<typeof routePayloadSchema>) {
  const payload: Record<string, unknown> = {
    tenant_id: tenantId,
    name: parsed.name.trim(),
    active: true
  };

  if (await hasColumn(admin, "routes", "origin_type")) payload.origin_type = "custom";
  if (await hasColumn(admin, "routes", "destination_type")) payload.destination_type = "custom";
  if (await hasColumn(admin, "routes", "origin_label")) payload.origin_label = parsed.origin_label.trim();
  if (await hasColumn(admin, "routes", "destination_label")) payload.destination_label = parsed.destination_label.trim();
  if (await hasColumn(admin, "routes", "from_label")) payload.from_label = parsed.origin_label.trim();
  if (await hasColumn(admin, "routes", "to_label")) payload.to_label = parsed.destination_label.trim();

  return payload;
}

export async function POST(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;

    const body = await request.json();
    const parsed = routePayloadSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Tratta non valida." }, { status: 400 });
    }

    const payload = await buildRoutePayload(auth.admin, auth.membership.tenant_id, parsed.data);
    const { data: existing, error: existingError } = await auth.admin
      .from("routes")
      .select("id, name")
      .eq("tenant_id", auth.membership.tenant_id)
      .ilike("name", parsed.data.name.trim())
      .maybeSingle();

    if (existingError) {
      return NextResponse.json({ error: existingError.message }, { status: 400 });
    }

    if (existing?.id) {
      return NextResponse.json({ ok: true, route: { id: String(existing.id), name: String(existing.name ?? parsed.data.name) }, existed: true });
    }

    const { data, error } = await auth.admin
      .from("routes")
      .insert(payload)
      .select("id, name")
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    return NextResponse.json({ ok: true, route: { id: String(data?.id ?? ""), name: String(data?.name ?? parsed.data.name) } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Errore interno server." }, { status: 500 });
  }
}
