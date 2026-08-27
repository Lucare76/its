import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizeServiceRoleRequest } from "@/lib/server/pricing-auth";
import { auditLog } from "@/lib/server/ops-audit";
import { findConflictingRule, isTransportWindowValid, type FerryPickupRule } from "@/lib/ferry-pickup-rules";
import { conflictErrorResponse } from "@/lib/server/ferry-pickup-rules-conflict";

export const runtime = "nodejs";

const ruleSchema = z
  .object({
    agency_logic: z.enum(["aleste", "sosandra"]),
    transport_type: z.enum(["train", "flight"]),
    // to_ischia = ARRIVO (comportamento legacy, default per compatibilità con l'UI esistente).
    // from_ischia = PARTENZA: richiede pickup_time, embark_port ammesso, hotel_id/zone opzionali.
    direction: z.enum(["to_ischia", "from_ischia"]).default("to_ischia"),
    boat_type: z.enum(["traghetto", "aliscafo"]).default("traghetto"),
    hotel_id: z.string().uuid().nullable().optional(),
    zone: z.string().min(1).max(40).nullable().optional(),
    transport_from: z.string().regex(/^\d{2}:\d{2}$/),
    transport_to: z.string().regex(/^\d{2}:\d{2}$/),
    company: z.string().min(1).max(60).transform((v) => v.trim().toLowerCase()),
    departure_time: z.string().regex(/^\d{2}:\d{2}$/),
    embark_port: z.string().min(1).max(60).transform((v) => v.trim().toLowerCase()).nullable().optional(),
    arrival_port: z.string().min(1).max(60).transform((v) => v.trim().toLowerCase()),
    arrival_time: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
    pickup_time: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
    valid_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    valid_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    days_of_week: z.array(z.number().int().min(0).max(6)).nullable().optional(),
    season_notes: z.string().max(200).nullable().optional(),
  })
  .refine((data) => isTransportWindowValid(data.transport_from, data.transport_to), {
    message: "L'orario finale deve essere successivo all'orario iniziale.",
    path: ["transport_to"],
  })
  .refine((data) => data.direction !== "from_ischia" || !!data.pickup_time, {
    message: "pickup_time è obbligatorio per le regole di PARTENZA (direction='from_ischia').",
    path: ["pickup_time"],
  })
  .refine((data) => data.direction !== "from_ischia" || !!data.embark_port, {
    message: "embark_port è obbligatorio per le regole di PARTENZA (direction='from_ischia').",
    path: ["embark_port"],
  })
  .refine((data) => data.direction === "from_ischia" || (!data.pickup_time && !data.embark_port && !data.hotel_id && !data.zone), {
    message: "pickup_time/embark_port/hotel_id/zone hanno senso solo per direction='from_ischia' (PARTENZA): compatibilità legacy ARRIVI invariata.",
    path: ["direction"],
  });

export async function GET(request: NextRequest) {
  const auth = await authorizeServiceRoleRequest(request, {
    roles: ["admin", "operator", "supervisor"],
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
    roles: ["admin", "operator", "supervisor"],
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

  // Candidate selection identica al matcher reale (findFerryPickupRule /
  // resolveOperationalConnection): stessa terna agency_logic/transport_type/
  // boat_type + stessa direction. Il confronto fine (scope hotel/zona/generale,
  // finestra oraria, stagione, giorni settimana) avviene in findConflictingRule.
  const { data: siblingRules, error: siblingsError } = await auth.admin
    .from("ferry_pickup_rules")
    .select("*")
    .eq("agency_logic", parsed.data.agency_logic)
    .eq("transport_type", parsed.data.transport_type)
    .eq("boat_type", parsed.data.boat_type)
    .eq("direction", parsed.data.direction);

  if (siblingsError) {
    return NextResponse.json({ error: siblingsError.message }, { status: 500 });
  }

  const conflict = findConflictingRule((siblingRules ?? []) as FerryPickupRule[], {
    ...parsed.data,
    valid_from: parsed.data.valid_from ?? null,
    valid_to: parsed.data.valid_to ?? null,
    days_of_week: parsed.data.days_of_week ?? null,
  });
  if (conflict) {
    return conflictErrorResponse(conflict);
  }

  const { data, error } = await auth.admin
    .from("ferry_pickup_rules")
    .insert({ ...parsed.data, updated_at: new Date().toISOString() })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  auditLog({
    event: "ferry_pickup_rule_created",
    level: "info",
    tenantId: auth.membership.tenant_id,
    userId: auth.user.id,
    role: auth.membership.role,
    outcome: "created",
    details: { ruleId: data.id, previous: null, next: data },
  });

  return NextResponse.json({ ok: true, rule: data }, { status: 201 });
}
