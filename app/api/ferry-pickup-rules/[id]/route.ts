import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizeServiceRoleRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

const patchSchema = z.object({
  agency_logic: z.enum(["aleste", "sosandra"]).optional(),
  transport_type: z.enum(["train", "flight"]).optional(),
  boat_type: z.enum(["traghetto", "aliscafo"]).optional(),
  transport_from: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  transport_to: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  company: z.string().min(1).max(60).optional(),
  // departure_time intentionally excluded — read-only in the UI
  arrival_port: z.string().min(1).max(60).optional(),
  arrival_time: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
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
    roles: ["admin", "operator"],
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

  const { data, error } = await auth.admin
    .from("ferry_pickup_rules")
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, rule: data });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authorizeServiceRoleRequest(request, {
    roles: ["admin", "operator"],
    auditPrefix: "ferry_pickup_rules_delete",
  });
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;

  const { error } = await auth.admin
    .from("ferry_pickup_rules")
    .delete()
    .eq("id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
