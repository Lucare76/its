import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { fuelApprovalSchema } from "@/lib/server/fleet-schemas";

export const runtime = "nodejs";

const createFuelSchema = z.object({
  vehicle_id: z.string().uuid(),
  fuel_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  liters: z.number().min(0).nullable().optional(),
  cost: z.number().min(0).nullable().optional(),
  km_at_fuel: z.number().int().min(0).nullable().optional(),
  fuel_type: z.string().max(40).nullable().optional(),
  station: z.string().max(160).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
  submitted_via_qr: z.boolean().optional(),
});

export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");
  const vehicleId = searchParams.get("vehicle_id");

  let query = auth.admin
    .from("vehicle_fuel")
    .select("id, vehicle_id, fuel_date, liters, cost, km_at_fuel, fuel_type, station, notes, approval_status, fiscal_document_url, fiscal_document_name, submitted_via_qr, approved_at, created_at")
    .eq("tenant_id", auth.membership.tenant_id)
    .order("fuel_date", { ascending: false })
    .limit(250);

  if (status && ["pending", "approved", "rejected"].includes(status)) query = query.eq("approval_status", status);
  if (vehicleId) query = query.eq("vehicle_id", vehicleId);

  const [{ data: records, error }, { data: vehicles, error: vehiclesError }] = await Promise.all([
    query,
    auth.admin.from("vehicles").select("id, label, plate, license_number").eq("tenant_id", auth.membership.tenant_id),
  ]);

  if (error || vehiclesError) {
    return NextResponse.json({ error: error?.message ?? vehiclesError?.message ?? "Errore caricamento rifornimenti." }, { status: 500 });
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
    | { action: "create"; data: z.infer<typeof createFuelSchema> }
    | { action: "approve"; data: z.infer<typeof fuelApprovalSchema> }
    | null;

  if (!body?.action || !body.data) {
    return NextResponse.json({ error: "action e data richiesti." }, { status: 400 });
  }

  if (body.action === "create") {
    const parsed = createFuelSchema.parse(body.data);
    const { error } = await auth.admin.from("vehicle_fuel").insert({
      tenant_id: auth.membership.tenant_id,
      vehicle_id: parsed.vehicle_id,
      fuel_date: parsed.fuel_date,
      liters: parsed.liters ?? null,
      cost: parsed.cost ?? null,
      km_at_fuel: parsed.km_at_fuel ?? null,
      fuel_type: parsed.fuel_type ?? null,
      station: parsed.station ?? null,
      notes: parsed.notes ?? null,
      approval_status: "approved",
      approved_at: new Date().toISOString(),
      approved_by: auth.user.id,
      submitted_via_qr: parsed.submitted_via_qr ?? false,
      created_by: auth.user.id,
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  const parsed = fuelApprovalSchema.parse(body.data);
  const { error } = await auth.admin
    .from("vehicle_fuel")
    .update({
      approval_status: parsed.approval_status,
      approved_at: new Date().toISOString(),
      approved_by: auth.user.id,
      fiscal_document_url: parsed.fiscal_document_url ?? null,
      fiscal_document_name: parsed.fiscal_document_name ?? null,
    })
    .eq("tenant_id", auth.membership.tenant_id)
    .eq("id", parsed.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
