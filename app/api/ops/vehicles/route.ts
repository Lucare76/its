import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import {
  deactivateDriverProfileAndAccess,
  ensureDriverAccessForProfile,
  listDriverRegistry,
  syncMembershipNameFromProfile,
} from "@/lib/server/driver-registry";
import { vehicleUpsertSchema } from "@/lib/server/fleet-schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const anomalySchema = z.object({
  vehicle_id: z.string().uuid(),
  severity: z.enum(["low", "medium", "high", "blocking"]),
  title: z.string().min(2).max(160),
  description: z.string().max(2000).optional().nullable(),
  blocked_from: z.string().datetime().optional().nullable(),
  blocked_until: z.string().datetime().optional().nullable()
});

const driverSchema = z.object({
  id: z.string().uuid().optional(),
  full_name: z.string().min(2).max(120),
  phone: z.string().max(32).optional().nullable(),
});

const toggleVehicleSchema = z.object({
  id: z.string().uuid(),
  active: z.boolean(),
});

const vehicleBlockSchema = z.object({
  id: z.string().uuid(),
  blocked_reason: z.string().max(500).nullable().optional(),
  blocked_until: z.string().datetime().nullable().optional(),
  is_blocked_manual: z.boolean(),
});

const vehicleDocumentsSchema = z.object({
  id: z.string().uuid(),
  insurance_expiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  road_tax_expiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  inspection_expiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});

export async function GET(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
    if (auth instanceof NextResponse) return auth;
    const tenantId = auth.membership.tenant_id;

    const today = new Date().toISOString().slice(0, 10);
    const [vehiclesResult, anomaliesResult, drivers, commitmentsResult] = await Promise.all([
      auth.admin.from("vehicles").select("*").eq("tenant_id", tenantId).order("label"),
      auth.admin.from("vehicle_anomalies").select("*").eq("tenant_id", tenantId).order("reported_at", { ascending: false }),
      listDriverRegistry(auth.admin, tenantId),
      auth.admin.from("vehicle_commitments")
        .select("id, vehicle_id, commitment_date, commitment_type, notes, created_at")
        .eq("tenant_id", tenantId)
        .gte("commitment_date", today)
        .order("commitment_date", { ascending: true })
    ]);

    const error = vehiclesResult.error || anomaliesResult.error || commitmentsResult.error;
    if (error) throw new Error(error.message);

    return NextResponse.json({
      ok: true,
      vehicles: vehiclesResult.data ?? [],
      anomalies: anomaliesResult.data ?? [],
      drivers,
      commitments: commitmentsResult.data ?? []
    }, {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
    if (auth instanceof NextResponse) return auth;
    const tenantId = auth.membership.tenant_id;
    const body = await request.json().catch(() => null);
    const action = String(body?.action ?? "");
    let driverAccessResponse: { username: string; temporary_password: string; created: boolean } | null = null;

    if (action === "upsert_vehicle") {
      if (!["admin", "operator"].includes(auth.membership.role)) {
        return NextResponse.json({ ok: false, error: "Ruolo non autorizzato." }, { status: 403 });
      }
      const parsed = vehicleUpsertSchema.parse(body);
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
        inspection_expiry: parsed.inspection_expiry ?? null,
        km: parsed.km ?? null,
        telaio: parsed.telaio ?? null,
        license_number: parsed.license_number ?? null,
      };
      const { error } = await (parsed.id
        ? auth.admin.from("vehicles").update(payload).eq("tenant_id", tenantId).eq("id", parsed.id)
        : auth.admin.from("vehicles").insert(payload));
      if (error) throw new Error(error.message);
    }

    if (action === "toggle_vehicle_active") {
      if (!["admin", "operator"].includes(auth.membership.role)) {
        return NextResponse.json({ ok: false, error: "Ruolo non autorizzato." }, { status: 403 });
      }
      const parsed = toggleVehicleSchema.parse(body);
      const { error } = await auth.admin
        .from("vehicles")
        .update({ active: parsed.active })
        .eq("tenant_id", tenantId)
        .eq("id", parsed.id);
      if (error) throw new Error(error.message);
    }

    if (action === "set_vehicle_block") {
      if (!["admin", "operator"].includes(auth.membership.role)) {
        return NextResponse.json({ ok: false, error: "Ruolo non autorizzato." }, { status: 403 });
      }
      const parsed = vehicleBlockSchema.parse(body);
      const { error } = await auth.admin
        .from("vehicles")
        .update({
          blocked_reason: parsed.blocked_reason ?? null,
          blocked_until: parsed.blocked_until ?? null,
          is_blocked_manual: parsed.is_blocked_manual,
        })
        .eq("tenant_id", tenantId)
        .eq("id", parsed.id);
      if (error) throw new Error(error.message);
    }

    if (action === "set_vehicle_documents") {
      if (!["admin", "operator"].includes(auth.membership.role)) {
        return NextResponse.json({ ok: false, error: "Ruolo non autorizzato." }, { status: 403 });
      }
      const parsed = vehicleDocumentsSchema.parse(body);
      const { error } = await auth.admin
        .from("vehicles")
        .update({
          insurance_expiry: parsed.insurance_expiry ?? null,
          road_tax_expiry: parsed.road_tax_expiry ?? null,
          inspection_expiry: parsed.inspection_expiry ?? null,
        })
        .eq("tenant_id", tenantId)
        .eq("id", parsed.id);
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
        blocked_from: parsed.blocked_from ?? null,
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
      if (!parsed.id && !parsed.phone?.trim()) {
        return NextResponse.json({ ok: false, error: "Inserire il numero di telefono: verrà usato come password per l'accesso autista." }, { status: 400 });
      }
      const payload = { tenant_id: tenantId, full_name: parsed.full_name, phone: parsed.phone ?? null, active: true };
      const profileResult = parsed.id
        ? await auth.admin
            .from("driver_profiles")
            .update({ full_name: payload.full_name, phone: payload.phone, active: true })
            .eq("tenant_id", tenantId)
            .eq("id", parsed.id)
            .select("id, user_id")
            .maybeSingle()
        : await auth.admin
            .from("driver_profiles")
            .insert(payload)
            .select("id, user_id")
            .maybeSingle();
      if (profileResult.error || !profileResult.data?.id) {
        throw new Error(profileResult.error?.message ?? "Salvataggio autista fallito.");
      }

      let createdDriverAccess: { username: string; temporary_password: string; created: boolean } | null = null;
      if (payload.phone) {
        const access = await ensureDriverAccessForProfile(auth.admin, {
          tenantId,
          profileId: profileResult.data.id,
          fullName: payload.full_name,
          phone: payload.phone,
        });
        createdDriverAccess = {
          username: access.username,
          temporary_password: access.temporaryPassword,
          created: access.created,
        };
      }

      if (parsed.id) {
        const linkedProfile = await auth.admin
          .from("driver_profiles")
          .select("user_id")
          .eq("tenant_id", tenantId)
          .eq("id", parsed.id)
          .maybeSingle();
        if (linkedProfile.error) throw new Error(linkedProfile.error.message);
        if (linkedProfile.data?.user_id) {
          await syncMembershipNameFromProfile(auth.admin, {
            tenantId,
            userId: linkedProfile.data.user_id,
            fullName: payload.full_name,
          });
        }
        if (!createdDriverAccess && payload.phone && linkedProfile.data?.user_id) {
          const registry = await listDriverRegistry(auth.admin, tenantId);
          const currentDriver = registry.find((driver) => driver.id === parsed.id) ?? null;
          if (currentDriver?.username) {
            createdDriverAccess = {
              username: currentDriver.username,
              temporary_password: payload.phone.replace(/\s+/g, "").trim(),
              created: false,
            };
          }
        }
      }

      driverAccessResponse = createdDriverAccess;
    }

    if (action === "delete_driver") {
      if (!["admin", "operator"].includes(auth.membership.role)) {
        return NextResponse.json({ ok: false, error: "Ruolo non autorizzato." }, { status: 403 });
      }
      const driverId = String(body?.id ?? "");
      if (!driverId) return NextResponse.json({ ok: false, error: "ID mancante." }, { status: 400 });
      await deactivateDriverProfileAndAccess(auth.admin, { tenantId, profileId: driverId });
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

    const todayStr = new Date().toISOString().slice(0, 10);
    const [vehiclesResult, anomaliesResult, drivers, commitmentsResult] = await Promise.all([
      auth.admin.from("vehicles").select("*").eq("tenant_id", tenantId).order("label"),
      auth.admin.from("vehicle_anomalies").select("*").eq("tenant_id", tenantId).order("reported_at", { ascending: false }),
      listDriverRegistry(auth.admin, tenantId),
      auth.admin.from("vehicle_commitments")
        .select("id, vehicle_id, commitment_date, commitment_type, notes, created_at")
        .eq("tenant_id", tenantId)
        .gte("commitment_date", todayStr)
        .order("commitment_date", { ascending: true })
    ]);
    const error = vehiclesResult.error || anomaliesResult.error || commitmentsResult.error;
    if (error) throw new Error(error.message);

    return NextResponse.json({
      ok: true,
      vehicles: vehiclesResult.data ?? [],
      anomalies: anomaliesResult.data ?? [],
      drivers,
      commitments: commitmentsResult.data ?? [],
      driver_access: driverAccessResponse,
    }, {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
