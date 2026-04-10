import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

const vehicleSchema = z.object({
  id: z.string().uuid().optional(),
  label: z.string().min(2).max(120),
  plate: z.string().max(32).optional().nullable(),
  capacity: z.number().int().min(1).max(120).nullable(),
  vehicle_size: z.enum(["small", "medium", "large", "bus"]).nullable(),
  habitual_driver_user_id: z.string().uuid().optional().nullable(),
  default_zone: z.string().max(120).optional().nullable(),
  blocked_until: z.string().datetime().optional().nullable(),
  blocked_reason: z.string().max(500).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  is_blocked_manual: z.boolean().optional().default(false),
  active: z.boolean().optional().default(true),
  radius_vehicle_id: z.string().max(120).optional().nullable(),
  insurance_expiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  road_tax_expiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  inspection_expiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable()
});

const anomalySchema = z.object({
  vehicle_id: z.string().uuid(),
  severity: z.enum(["low", "medium", "high", "blocking"]),
  title: z.string().min(2).max(160),
  description: z.string().max(2000).optional().nullable(),
  blocked_until: z.string().datetime().optional().nullable()
});

const driverSchema = z.object({
  id: z.string().uuid().optional(),
  full_name: z.string().min(2).max(120),
  phone: z.string().max(32).optional().nullable(),
});

export async function GET(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator", "driver"]);
    if (auth instanceof NextResponse) return auth;
    const tenantId = auth.membership.tenant_id;

    const [vehiclesResult, anomaliesResult, driversResult] = await Promise.all([
      auth.admin.from("vehicles").select("*").eq("tenant_id", tenantId).order("label"),
      auth.admin.from("vehicle_anomalies").select("*").eq("tenant_id", tenantId).order("reported_at", { ascending: false }),
      auth.admin.from("driver_profiles").select("id, full_name, phone, active").eq("tenant_id", tenantId).eq("active", true).order("full_name")
    ]);

    const error = vehiclesResult.error || anomaliesResult.error || driversResult.error;
    if (error) throw new Error(error.message);

    return NextResponse.json({
      ok: true,
      vehicles: vehiclesResult.data ?? [],
      anomalies: anomaliesResult.data ?? [],
      drivers: driversResult.data ?? []
    });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator", "driver"]);
    if (auth instanceof NextResponse) return auth;
    const tenantId = auth.membership.tenant_id;
    const body = await request.json().catch(() => null);
    const action = String(body?.action ?? "");

    if (action === "upsert_vehicle") {
      if (!["admin", "operator"].includes(auth.membership.role)) {
        return NextResponse.json({ ok: false, error: "Ruolo non autorizzato." }, { status: 403 });
      }
      const parsed = vehicleSchema.parse(body);
      const payload = {
        tenant_id: tenantId,
        label: parsed.label,
        plate: parsed.plate ?? null,
        capacity: parsed.capacity ?? null,
        vehicle_size: parsed.vehicle_size ?? null,
        habitual_driver_profile_id: parsed.habitual_driver_user_id ?? null,
        default_zone: parsed.default_zone ?? null,
        blocked_until: parsed.blocked_until ?? null,
        blocked_reason: parsed.blocked_reason ?? null,
        notes: parsed.notes ?? null,
        is_blocked_manual: parsed.is_blocked_manual,
        active: parsed.active,
        radius_vehicle_id: parsed.radius_vehicle_id ?? null,
        insurance_expiry: parsed.insurance_expiry ?? null,
        road_tax_expiry: parsed.road_tax_expiry ?? null,
        inspection_expiry: parsed.inspection_expiry ?? null
      };
      const query = parsed.id
        ? auth.admin.from("vehicles").update(payload).eq("tenant_id", tenantId).eq("id", parsed.id)
        : auth.admin.from("vehicles").insert(payload);
      const { error } = await query;
      if (error) throw new Error(error.message);
    }

    if (action === "report_anomaly") {
      const parsed = anomalySchema.parse(body);
      const { error } = await auth.admin.from("vehicle_anomalies").insert({
        tenant_id: tenantId,
        vehicle_id: parsed.vehicle_id,
        driver_user_id: auth.membership.role === "driver" ? auth.user.id : body?.driver_user_id ?? null,
        severity: parsed.severity,
        title: parsed.title,
        description: parsed.description ?? null,
        blocked_until: parsed.blocked_until ?? null,
        active: true
      });
      if (error) throw new Error(error.message);
      if (parsed.severity === "blocking" || parsed.blocked_until) {
        await auth.admin
          .from("vehicles")
          .update({
            blocked_until: parsed.blocked_until ?? new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
            blocked_reason: parsed.title,
            is_blocked_manual: true
          })
          .eq("tenant_id", tenantId)
          .eq("id", parsed.vehicle_id);
      }
    }

    if (action === "delete_vehicle") {
      if (!["admin", "operator"].includes(auth.membership.role)) {
        return NextResponse.json({ ok: false, error: "Ruolo non autorizzato." }, { status: 403 });
      }
      const vehicleId = String(body?.id ?? "");
      if (!vehicleId) return NextResponse.json({ ok: false, error: "ID mancante." }, { status: 400 });
      const { error } = await auth.admin.from("vehicles").delete().eq("tenant_id", tenantId).eq("id", vehicleId);
      if (error) throw new Error(error.message);
    }

    if (action === "upsert_driver") {
      if (!["admin", "operator"].includes(auth.membership.role)) {
        return NextResponse.json({ ok: false, error: "Ruolo non autorizzato." }, { status: 403 });
      }
      const parsed = driverSchema.parse(body);
      const payload = { tenant_id: tenantId, full_name: parsed.full_name, phone: parsed.phone ?? null, active: true };
      const query = parsed.id
        ? auth.admin.from("driver_profiles").update({ full_name: payload.full_name, phone: payload.phone }).eq("tenant_id", tenantId).eq("id", parsed.id)
        : auth.admin.from("driver_profiles").insert(payload);
      const { error } = await query;
      if (error) throw new Error(error.message);
    }

    if (action === "delete_driver") {
      if (!["admin", "operator"].includes(auth.membership.role)) {
        return NextResponse.json({ ok: false, error: "Ruolo non autorizzato." }, { status: 403 });
      }
      const driverId = String(body?.id ?? "");
      if (!driverId) return NextResponse.json({ ok: false, error: "ID mancante." }, { status: 400 });
      const { error } = await auth.admin.from("driver_profiles").update({ active: false }).eq("tenant_id", tenantId).eq("id", driverId);
      if (error) throw new Error(error.message);
    }

    if (action === "resolve_anomaly") {
      if (!["admin", "operator"].includes(auth.membership.role)) {
        return NextResponse.json({ ok: false, error: "Ruolo non autorizzato." }, { status: 403 });
      }
      const anomalyId = String(body?.anomaly_id ?? "");
      const vehicleId = String(body?.vehicle_id ?? "");
      await auth.admin
        .from("vehicle_anomalies")
        .update({ active: false, resolved_at: new Date().toISOString(), resolved_by_user_id: auth.user.id })
        .eq("tenant_id", tenantId)
        .eq("id", anomalyId);
      if (vehicleId) {
        await auth.admin
          .from("vehicles")
          .update({ blocked_until: null, blocked_reason: null, is_blocked_manual: false })
          .eq("tenant_id", tenantId)
          .eq("id", vehicleId);
      }
    }

    const [vehiclesResult, anomaliesResult, driversResult] = await Promise.all([
      auth.admin.from("vehicles").select("*").eq("tenant_id", tenantId).order("label"),
      auth.admin.from("vehicle_anomalies").select("*").eq("tenant_id", tenantId).order("reported_at", { ascending: false }),
      auth.admin.from("driver_profiles").select("id, full_name, phone, active").eq("tenant_id", tenantId).eq("active", true).order("full_name")
    ]);
    const error = vehiclesResult.error || anomaliesResult.error || driversResult.error;
    if (error) throw new Error(error.message);

    return NextResponse.json({
      ok: true,
      vehicles: vehiclesResult.data ?? [],
      anomalies: anomaliesResult.data ?? [],
      drivers: driversResult.data ?? []
    });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
