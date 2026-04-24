import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { inventorySparePartSchema, inventorySparePartUpdateSchema } from "@/lib/server/fleet-schemas";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");

  let query = auth.admin
    .from("inventory_spare_parts")
    .select("id, vehicle_id, part_name, part_code, supplier, ordered_from, ordered_by_name, order_date, unit_cost, quantity_on_hand, quantity_ordered, status, notes, updated_at")
    .eq("tenant_id", auth.membership.tenant_id)
    .order("updated_at", { ascending: false })
    .limit(300);

  if (status && ["available", "ordered", "out_of_stock"].includes(status)) query = query.eq("status", status);

  const [{ data: records, error }, { data: vehicles, error: vehiclesError }] = await Promise.all([
    query,
    auth.admin.from("vehicles").select("id, label, plate").eq("tenant_id", auth.membership.tenant_id).order("label"),
  ]);

  if (error || vehiclesError) {
    return NextResponse.json({ error: error?.message ?? vehiclesError?.message ?? "Errore caricamento inventario ricambi." }, { status: 500 });
  }

  const vehicleMap = new Map((vehicles ?? []).map((vehicle) => [vehicle.id, vehicle]));
  const enriched = (records ?? []).map((record) => ({
    ...record,
    vehicle: record.vehicle_id ? vehicleMap.get(record.vehicle_id) ?? null : null,
  }));

  return NextResponse.json({ ok: true, records: enriched, vehicles: vehicles ?? [] });
}

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  const body = await request.json().catch(() => null) as
    | { action: "create"; data: z.infer<typeof inventorySparePartSchema> }
    | { action: "update"; data: z.infer<typeof inventorySparePartUpdateSchema> }
    | { action: "delete"; id: string }
    | null;

  if (!body?.action) return NextResponse.json({ error: "action richiesto." }, { status: 400 });

  if (body.action === "delete") {
    if (!body.id) return NextResponse.json({ error: "id richiesto." }, { status: 400 });
    const { error } = await auth.admin.from("inventory_spare_parts").delete().eq("tenant_id", auth.membership.tenant_id).eq("id", body.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  if (body.action === "update") {
    const parsed = inventorySparePartUpdateSchema.parse(body.data);
    const { id, ...rest } = parsed;
    const { error } = await auth.admin
      .from("inventory_spare_parts")
      .update({ ...rest, updated_at: new Date().toISOString() })
      .eq("tenant_id", auth.membership.tenant_id)
      .eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  const parsed = inventorySparePartSchema.parse(body.data);
  const { error } = await auth.admin.from("inventory_spare_parts").insert({
    tenant_id: auth.membership.tenant_id,
    ...parsed,
    created_by: auth.user.id,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
