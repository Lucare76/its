import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { estimateConsumption } from "@/lib/server/vehicle-consumption";

const schema = z.object({ vehicle_id: z.string().uuid(), min: z.number().positive().max(200).nullable(), max: z.number().positive().max(200).nullable() })
  .refine(value => value.min == null || value.max == null || value.max >= value.min);

export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;
  const tenantId = auth.membership.tenant_id;
  const vehicleId = new URL(request.url).searchParams.get("vehicle_id");
  let query = auth.admin.from("vehicles").select("id, label, plate, consumption_min_l_per_100km, consumption_max_l_per_100km")
    .eq("tenant_id", tenantId).order("label");
  if (vehicleId) query = query.eq("id", vehicleId);
  const { data: vehicles, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!vehicleId) return NextResponse.json({ vehicles });
  const vehicle = vehicles?.[0];
  if (!vehicle) return NextResponse.json({ error: "Mezzo non trovato." }, { status: 404 });
  const { data: fills, error: fillsError } = await auth.admin.from("vehicle_fuel")
    .select("id, fuel_date, km_at_fuel, liters").eq("tenant_id", tenantId).eq("vehicle_id", vehicleId)
    .eq("approval_status", "approved").order("fuel_date", { ascending: false }).limit(250);
  if (fillsError) return NextResponse.json({ error: fillsError.message }, { status: 500 });
  return NextResponse.json({ vehicle, estimates: estimateConsumption(fills ?? [], vehicle.consumption_min_l_per_100km, vehicle.consumption_max_l_per_100km) });
}

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Intervallo consumi non valido." }, { status: 400 });
  const { data, error } = await auth.admin.from("vehicles")
    .update({ consumption_min_l_per_100km: parsed.data.min, consumption_max_l_per_100km: parsed.data.max })
    .eq("tenant_id", auth.membership.tenant_id).eq("id", parsed.data.vehicle_id).select("id").maybeSingle();
  return error ? NextResponse.json({ error: error.message }, { status: 500 })
    : data ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "Mezzo non trovato." }, { status: 404 });
}
