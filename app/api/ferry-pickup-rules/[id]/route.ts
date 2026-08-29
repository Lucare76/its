import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizeServiceRoleRequest } from "@/lib/server/pricing-auth";
import { auditLog } from "@/lib/server/ops-audit";
import { findConflictingRule, isTransportWindowValid, type FerryPickupRule } from "@/lib/ferry-pickup-rules";
import { conflictErrorResponse } from "@/lib/server/ferry-pickup-rules-conflict";

export const runtime = "nodejs";

const patchSchema = z.object({
  agency_logic: z.enum(["aleste", "sosandra"]).optional(),
  // 'direct' = SNAV/MEDMAR diretto — ammesso solo su regole già from_ischia
  // (direction non è modificabile via PATCH, vedi sotto); verificato nel
  // merge con l'esistente più giù (non esprimibile in un refine puro sul
  // patch parziale, che non conosce il valore corrente di direction).
  transport_type: z.enum(["train", "flight", "direct"]).optional(),
  // direction intenzionalmente esclusa: cambiare direzione di una regola esistente
  // (arrivo<->partenza) è un'operazione semanticamente diversa, non un update di campo.
  boat_type: z.enum(["traghetto", "aliscafo"]).optional(),
  hotel_id: z.string().uuid().nullable().optional(),
  zone: z.string().min(1).max(40).nullable().optional(),
  // nullable: passare null converte la regola a 'direct' (nessuna finestra).
  transport_from: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  transport_to: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  company: z.string().min(1).max(60).transform((v) => v.trim().toLowerCase()).optional(),
  // departure_time intentionally excluded — read-only in the UI
  embark_port: z.string().min(1).max(60).transform((v) => v.trim().toLowerCase()).nullable().optional(),
  arrival_port: z.string().min(1).max(60).transform((v) => v.trim().toLowerCase()).optional(),
  arrival_time: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  pickup_time: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  valid_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  valid_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  days_of_week: z.array(z.number().int().min(0).max(6)).nullable().optional(),
  season_notes: z.string().max(200).nullable().optional(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authorizeServiceRoleRequest(request, {
    roles: ["admin", "operator", "supervisor"],
    auditPrefix: "ferry_pickup_rules_update",
  });
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;

  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Dati non validi." },
      { status: 400 }
    );
  }

  if (Object.keys(parsed.data).length === 0) {
    return NextResponse.json({ error: "Nessun campo da aggiornare." }, { status: 400 });
  }

  const { data: existing, error: existingError } = await auth.admin
    .from("ferry_pickup_rules")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (existingError) {
    return NextResponse.json({ error: existingError.message }, { status: 500 });
  }
  if (!existing) {
    return NextResponse.json({ error: "Regola non trovata." }, { status: 404 });
  }

  const merged = { ...(existing as FerryPickupRule), ...parsed.data };

  if (merged.transport_type === "direct" && merged.direction !== "from_ischia") {
    return NextResponse.json(
      { error: "transport_type='direct' (SNAV/MEDMAR diretto) è ammesso solo per direction='from_ischia'." },
      { status: 400 }
    );
  }
  if (merged.transport_type === "direct") {
    if (merged.transport_from || merged.transport_to) {
      return NextResponse.json(
        { error: "Le regole dirette (transport_type='direct') non hanno transport_from/transport_to." },
        { status: 400 }
      );
    }
  } else {
    if (!merged.transport_from || !merged.transport_to) {
      return NextResponse.json(
        { error: "transport_from e transport_to sono obbligatori per le regole treno/volo." },
        { status: 400 }
      );
    }
    if (!isTransportWindowValid(merged.transport_from!, merged.transport_to!)) {
      return NextResponse.json(
        { error: "L'orario finale deve essere successivo all'orario iniziale." },
        { status: 400 }
      );
    }
  }

  const { data: siblingRules, error: siblingsError } = await auth.admin
    .from("ferry_pickup_rules")
    .select("*")
    .eq("agency_logic", merged.agency_logic)
    .eq("transport_type", merged.transport_type)
    .eq("boat_type", merged.boat_type)
    .eq("direction", merged.direction ?? "to_ischia");

  if (siblingsError) {
    return NextResponse.json({ error: siblingsError.message }, { status: 500 });
  }

  const conflict = findConflictingRule((siblingRules ?? []) as FerryPickupRule[], merged, id);
  if (conflict) {
    return conflictErrorResponse(conflict);
  }

  const { data, error } = await auth.admin
    .from("ferry_pickup_rules")
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  auditLog({
    event: "ferry_pickup_rule_updated",
    level: "info",
    tenantId: auth.membership.tenant_id,
    userId: auth.user.id,
    role: auth.membership.role,
    outcome: "updated",
    details: { ruleId: id, previous: existing, next: data },
  });

  return NextResponse.json({ ok: true, rule: data });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authorizeServiceRoleRequest(request, {
    roles: ["admin", "operator", "supervisor"],
    auditPrefix: "ferry_pickup_rules_delete",
  });
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;

  const { data: existing, error: existingError } = await auth.admin
    .from("ferry_pickup_rules")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (existingError) {
    return NextResponse.json({ error: existingError.message }, { status: 500 });
  }
  if (!existing) {
    return NextResponse.json({ error: "Regola non trovata." }, { status: 404 });
  }

  const { error } = await auth.admin
    .from("ferry_pickup_rules")
    .delete()
    .eq("id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  auditLog({
    event: "ferry_pickup_rule_deleted",
    level: "info",
    tenantId: auth.membership.tenant_id,
    userId: auth.user.id,
    role: auth.membership.role,
    outcome: "deleted",
    details: { ruleId: id, previous: existing, next: null },
  });

  return NextResponse.json({ ok: true });
}
