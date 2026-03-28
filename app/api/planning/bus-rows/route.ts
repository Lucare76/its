import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

// GET /api/planning/bus-rows
export async function GET(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request);
    if (auth instanceof NextResponse) return auth;

    const tenantId = auth.membership.tenant_id;
    const { data, error } = await auth.admin
      .from("tenant_mario_bus_rows")
      .select("id, label, notes, sort_order")
      .eq("tenant_id", tenantId)
      .order("sort_order")
      .order("label");

    if (error) throw new Error(error.message);
    return NextResponse.json({ rows: data ?? [] });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Errore interno." }, { status: 500 });
  }
}

// POST /api/planning/bus-rows — crea nuova riga
export async function POST(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request);
    if (auth instanceof NextResponse) return auth;

    const body = await request.json();
    const { label, notes } = z
      .object({
        label: z.string().min(1).max(100),
        notes: z.string().max(100).nullable().optional(),
      })
      .parse(body);
    const tenantId = auth.membership.tenant_id;

    const { data: existing } = await auth.admin
      .from("tenant_mario_bus_rows")
      .select("sort_order")
      .eq("tenant_id", tenantId)
      .order("sort_order", { ascending: false })
      .limit(1);
    const nextOrder = existing && existing.length > 0 ? (existing[0].sort_order ?? 0) + 1 : 0;

    const { data, error } = await auth.admin
      .from("tenant_mario_bus_rows")
      .insert({
        tenant_id: tenantId,
        label: label.trim().toUpperCase(),
        notes: notes?.trim() ?? null,
        sort_order: nextOrder,
      })
      .select("id, label, notes, sort_order")
      .single();

    if (error) throw new Error(error.message);
    return NextResponse.json({ row: data });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Errore interno." }, { status: 500 });
  }
}

// PATCH /api/planning/bus-rows — rinomina, aggiorna notes o riordina
export async function PATCH(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request);
    if (auth instanceof NextResponse) return auth;

    const body = await request.json();
    const { id, label, notes, sort_order } = z
      .object({
        id: z.string().uuid(),
        label: z.string().min(1).max(100).optional(),
        notes: z.string().max(100).nullable().optional(),
        sort_order: z.number().int().min(0).optional(),
      })
      .parse(body);
    const tenantId = auth.membership.tenant_id;

    const update: Record<string, unknown> = {};
    if (label !== undefined) update.label = label.trim().toUpperCase();
    if (notes !== undefined) update.notes = notes?.trim() ?? null;
    if (sort_order !== undefined) update.sort_order = sort_order;

    const { error } = await auth.admin
      .from("tenant_mario_bus_rows")
      .update(update)
      .eq("tenant_id", tenantId)
      .eq("id", id);

    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Errore interno." }, { status: 500 });
  }
}

// DELETE /api/planning/bus-rows
export async function DELETE(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request);
    if (auth instanceof NextResponse) return auth;

    const body = await request.json();
    const { id } = z.object({ id: z.string().uuid() }).parse(body);
    const tenantId = auth.membership.tenant_id;

    const { error } = await auth.admin
      .from("tenant_mario_bus_rows")
      .delete()
      .eq("tenant_id", tenantId)
      .eq("id", id);

    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Errore interno." }, { status: 500 });
  }
}
