import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest, type PricingAuthContext } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

async function loadReteIschia(auth: PricingAuthContext) {
  const tenantId = auth.membership.tenant_id;
  const [servicesRes, driversRes, hotelsRes] = await Promise.all([
    auth.admin
      .from("services_ischia")
      .select("*")
      .eq("tenant_id", tenantId)
      .order("travel_date", { ascending: false })
      .order("orario")
      .limit(200),
    auth.admin
      .from("drivers")
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("active", true)
      .order("name"),
    auth.admin
      .from("hotels")
      .select("id,name,address,zone")
      .eq("tenant_id", tenantId)
      .order("name")
      .limit(500),
  ]);
  if (servicesRes.error) throw new Error(servicesRes.error.message);
  if (driversRes.error) throw new Error(driversRes.error.message);
  if (hotelsRes.error) throw new Error(hotelsRes.error.message);
  return {
    services: servicesRes.data ?? [],
    drivers: driversRes.data ?? [],
    hotels: hotelsRes.data ?? [],
  };
}

export async function GET(req: NextRequest) {
  try {
    const auth = await authorizePricingRequest(req, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;
    return NextResponse.json({ ok: true, ...(await loadReteIschia(auth)) });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Errore" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await authorizePricingRequest(req, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;
    const tenantId = auth.membership.tenant_id;
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const action = z.string().parse(body?.action);

    if (action === "create_service") {
      const schema = z.object({
        customer_name: z.string().min(1).max(200),
        customer_phone: z.string().max(100).optional().nullable(),
        hotel_partenza_name: z.string().min(1).max(200),
        hotel_arrivo_name: z.string().min(1).max(200),
        hotel_partenza_id: z.string().uuid().optional().nullable(),
        hotel_arrivo_id: z.string().uuid().optional().nullable(),
        travel_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        orario: z.string().regex(/^\d{2}:\d{2}$/).optional().nullable(),
        pax: z.number().int().min(1).max(60),
        notes: z.string().max(500).optional().nullable(),
      });
      const parsed = schema.parse(body);
      const { data, error } = await auth.admin
        .from("services_ischia")
        .insert({ tenant_id: tenantId, ...parsed })
        .select()
        .single();
      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true, service: data, ...(await loadReteIschia(auth)) });
    }

    if (action === "assign_driver") {
      const schema = z.object({
        service_id: z.string().uuid(),
        driver_id: z.string().uuid().nullable(),
      });
      const parsed = schema.parse(body);
      const { error } = await auth.admin
        .from("services_ischia")
        .update({ driver_id: parsed.driver_id, status: parsed.driver_id ? "assigned" : "pending", updated_at: new Date().toISOString() })
        .eq("tenant_id", tenantId)
        .eq("id", parsed.service_id);
      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true, ...(await loadReteIschia(auth)) });
    }

    if (action === "update_status") {
      const schema = z.object({
        service_id: z.string().uuid(),
        status: z.enum(["pending", "assigned", "completed", "cancelled"]),
      });
      const parsed = schema.parse(body);
      const { error } = await auth.admin
        .from("services_ischia")
        .update({ status: parsed.status, updated_at: new Date().toISOString() })
        .eq("tenant_id", tenantId)
        .eq("id", parsed.service_id);
      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true, ...(await loadReteIschia(auth)) });
    }

    if (action === "create_driver") {
      const schema = z.object({
        name: z.string().min(1).max(200),
        phone: z.string().max(100).optional().nullable(),
        vehicle_type: z.string().max(100).optional().nullable(),
        capacity: z.number().int().min(1).max(60).default(8),
        notes: z.string().max(500).optional().nullable(),
      });
      const parsed = schema.parse(body);
      const { data, error } = await auth.admin
        .from("drivers")
        .insert({ tenant_id: tenantId, ...parsed })
        .select()
        .single();
      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true, driver: data, ...(await loadReteIschia(auth)) });
    }

    if (action === "delete_service") {
      const id = z.string().uuid().parse(body?.service_id);
      await auth.admin.from("services_ischia").delete().eq("tenant_id", tenantId).eq("id", id);
      return NextResponse.json({ ok: true, ...(await loadReteIschia(auth)) });
    }

    return NextResponse.json({ ok: false, error: "Azione non supportata." }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Errore" }, { status: 500 });
  }
}
