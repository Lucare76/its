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

const pricingRulePayloadSchema = z.object({
  price_list_id: z.string().uuid(),
  route_id: z.string().uuid(),
  agency_id: z.string().uuid().nullable().optional(),
  bus_line_code: z.string().max(120).nullable().optional(),
  service_type: z.enum(["transfer", "bus_tour"]).nullable().optional(),
  direction: z.enum(["arrival", "departure"]).nullable().optional(),
  pax_min: z.number().int().min(1).default(1),
  pax_max: z.number().int().min(1).nullable().optional(),
  rule_kind: z.enum(["fixed", "per_pax"]).default("fixed"),
  internal_cost_cents: z.number().int().min(0),
  public_price_cents: z.number().int().min(0),
  agency_price_cents: z.number().int().min(0).nullable().optional(),
  priority: z.number().int().min(0).default(100),
  vehicle_type: z.string().max(80).nullable().optional(),
  time_from: z.string().max(8).nullable().optional(),
  time_to: z.string().max(8).nullable().optional(),
  season_from: z.string().max(10).nullable().optional(),
  season_to: z.string().max(10).nullable().optional(),
  needs_manual_review: z.boolean().default(false),
  active: z.boolean().default(true)
});

async function buildPayload(admin: any, tenantId: string, parsed: z.infer<typeof pricingRulePayloadSchema>) {
  const payload: Record<string, unknown> = {
    tenant_id: tenantId,
    price_list_id: parsed.price_list_id,
    route_id: parsed.route_id,
    agency_id: parsed.agency_id ?? null,
    pax_min: parsed.pax_min,
    pax_max: parsed.pax_max ?? null,
    rule_kind: parsed.rule_kind,
    internal_cost_cents: parsed.internal_cost_cents,
    public_price_cents: parsed.public_price_cents,
    agency_price_cents: parsed.agency_price_cents ?? null,
    priority: parsed.priority,
    active: parsed.active
  };

  if (await hasColumn(admin, "pricing_rules", "bus_line_code")) payload.bus_line_code = parsed.bus_line_code ?? null;
  if (await hasColumn(admin, "pricing_rules", "service_type")) payload.service_type = parsed.service_type ?? null;
  if (await hasColumn(admin, "pricing_rules", "direction")) payload.direction = parsed.direction ?? null;
  if (await hasColumn(admin, "pricing_rules", "vehicle_type")) payload.vehicle_type = parsed.vehicle_type ?? null;
  if (await hasColumn(admin, "pricing_rules", "time_from")) payload.time_from = parsed.time_from ?? null;
  if (await hasColumn(admin, "pricing_rules", "time_to")) payload.time_to = parsed.time_to ?? null;
  if (await hasColumn(admin, "pricing_rules", "season_from")) payload.season_from = parsed.season_from ?? null;
  if (await hasColumn(admin, "pricing_rules", "season_to")) payload.season_to = parsed.season_to ?? null;
  if (await hasColumn(admin, "pricing_rules", "needs_manual_review")) payload.needs_manual_review = parsed.needs_manual_review;

  return payload;
}

export async function POST(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;

    const body = await request.json();
    const parsed = pricingRulePayloadSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Regola non valida." }, { status: 400 });
    }

    if (parsed.data.bus_line_code && !(await hasColumn(auth.admin, "pricing_rules", "bus_line_code"))) {
      return NextResponse.json(
        { error: "Manca la colonna pricing_rules.bus_line_code. Esegui la migration 0028_pricing_rules_bus_line_code.sql." },
        { status: 400 }
      );
    }

    const payload = await buildPayload(auth.admin, auth.membership.tenant_id, parsed.data);
    const { data, error } = await auth.admin
      .from("pricing_rules")
      .insert(payload)
      .select("id")
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    return NextResponse.json({ ok: true, rule: { id: String(data?.id ?? "") } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Errore interno server." }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;

    const body = await request.json();
    const ruleId = typeof body?.rule_id === "string" ? body.rule_id : "";
    if (!ruleId) {
      return NextResponse.json({ error: "Rule ID mancante." }, { status: 400 });
    }

    const parsed = pricingRulePayloadSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Regola non valida." }, { status: 400 });
    }

    if (parsed.data.bus_line_code && !(await hasColumn(auth.admin, "pricing_rules", "bus_line_code"))) {
      return NextResponse.json(
        { error: "Manca la colonna pricing_rules.bus_line_code. Esegui la migration 0028_pricing_rules_bus_line_code.sql." },
        { status: 400 }
      );
    }

    const payload = await buildPayload(auth.admin, auth.membership.tenant_id, parsed.data);
    const { error } = await auth.admin
      .from("pricing_rules")
      .update(payload)
      .eq("id", ruleId)
      .eq("tenant_id", auth.membership.tenant_id);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Errore interno server." }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;

    const body = await request.json().catch(() => null);
    const ruleId = typeof body?.rule_id === "string" ? body.rule_id : "";
    if (!ruleId) {
      return NextResponse.json({ error: "Rule ID mancante." }, { status: 400 });
    }

    const { error } = await auth.admin
      .from("pricing_rules")
      .delete()
      .eq("id", ruleId)
      .eq("tenant_id", auth.membership.tenant_id);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Errore interno server." }, { status: 500 });
  }
}
