import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizeServiceRoleRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

const ruleSchema = z.object({
  agency_logic: z.enum(["aleste", "sosandra"]),
  transport_type: z.enum(["train", "flight"]),
  boat_type: z.enum(["traghetto", "aliscafo"]).default("traghetto"),
  transport_from: z.string().regex(/^\d{2}:\d{2}$/),
  transport_to: z.string().regex(/^\d{2}:\d{2}$/),
  company: z.string().min(1).max(60),
  departure_time: z.string().regex(/^\d{2}:\d{2}$/),
  arrival_port: z.string().min(1).max(60),
  arrival_time: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  valid_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  valid_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  days_of_week: z.array(z.number().int().min(0).max(6)).nullable().optional(),
  season_notes: z.string().max(200).nullable().optional(),
});

export async function GET(request: NextRequest) {
  const auth = await authorizeServiceRoleRequest(request, {
    roles: ["admin", "operator"],
    auditPrefix: "ferry_pickup_rules_list",
  });
  if (auth instanceof NextResponse) return auth;

  const { data, error } = await auth.admin
    .from("ferry_pickup_rules")
    .select("*")
    .order("agency_logic")
    .order("transport_type")
    .order("boat_type")
    .order("transport_from");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, rules: data });
}

export async function POST(request: NextRequest) {
  const auth = await authorizeServiceRoleRequest(request, {
    roles: ["admin", "operator"],
    auditPrefix: "ferry_pickup_rules_create",
  });
  if (auth instanceof NextResponse) return auth;

  const parsed = ruleSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Dati non validi." },
      { status: 400 }
    );
  }

  const { data, error } = await auth.admin
    .from("ferry_pickup_rules")
    .insert({ ...parsed.data, updated_at: new Date().toISOString() })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, rule: data }, { status: 201 });
}
