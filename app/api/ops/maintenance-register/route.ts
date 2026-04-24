import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { maintenanceRecordSchema } from "@/lib/server/fleet-schemas";

export const runtime = "nodejs";

const createMaintenanceSchema = maintenanceRecordSchema.extend({
  vehicle_id: z.string().uuid(),
});

export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  const { searchParams } = new URL(request.url);
  const vehicleId = searchParams.get("vehicle_id");
  const kind = searchParams.get("kind");

  let query = auth.admin
    .from("vehicle_maintenance")
    .select("id, vehicle_id, maintenance_date, description, cost, km_at_service, provider, notes, maintenance_kind, execution_mode, replaced_parts, created_at")
    .eq("tenant_id", auth.membership.tenant_id)
    .order("maintenance_date", { ascending: false })
    .limit(250);

  if (vehicleId) query = query.eq("vehicle_id", vehicleId);
  if (kind && ["ordinary", "extraordinary"].includes(kind)) query = query.eq("maintenance_kind", kind);

  const [{ data: records, error }, { data: vehicles, error: vehiclesError }] = await Promise.all([
    query,
    auth.admin.from("vehicles").select("id, label, plate").eq("tenant_id", auth.membership.tenant_id),
  ]);

  if (error || vehiclesError) {
    return NextResponse.json({ error: error?.message ?? vehiclesError?.message ?? "Errore caricamento manutenzioni." }, { status: 500 });
  }

  const vehicleMap = new Map((vehicles ?? []).map((vehicle) => [vehicle.id, vehicle]));
  const enriched = (records ?? []).map((record) => ({
    ...record,
    vehicle: vehicleMap.get(record.vehicle_id) ?? null,
  }));

  return NextResponse.json({ ok: true, records: enriched, vehicles: vehicles ?? [] });
}

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  const body = await request.json().catch(() => null) as
    | { action: "create"; data: z.infer<typeof createMaintenanceSchema> }
    | { action: "delete"; id: string }
    | null;

  if (!body?.action) return NextResponse.json({ error: "action richiesto." }, { status: 400 });

  if (body.action === "delete") {
    if (!body.id) return NextResponse.json({ error: "id richiesto." }, { status: 400 });
    const { error } = await auth.admin.from("vehicle_maintenance").delete().eq("tenant_id", auth.membership.tenant_id).eq("id", body.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  const parsed = createMaintenanceSchema.parse(body.data);
  const { error } = await auth.admin.from("vehicle_maintenance").insert({
    tenant_id: auth.membership.tenant_id,
    vehicle_id: parsed.vehicle_id,
    maintenance_date: parsed.maintenance_date,
    description: parsed.description,
    cost: parsed.cost ?? null,
    km_at_service: parsed.km_at_service ?? null,
    provider: parsed.provider ?? null,
    notes: parsed.notes ?? null,
    maintenance_kind: parsed.maintenance_kind,
    execution_mode: parsed.execution_mode,
    replaced_parts: parsed.replaced_parts,
    created_by: auth.user.id,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
