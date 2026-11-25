import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import {
  deactivateDriverProfileAndAccess,
  ensureDriverAccessForProfile,
  listDriverRegistry,
  normalizeDriverPassword,
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
  blocked_from: z.string().datetime().nullable().optional(),
  blocked_until: z.string().datetime().nullable().optional(),
  is_blocked_manual: z.boolean(),
});

const decommissionSchema = z.object({
  id: z.string().uuid(),
  decommissioned_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reason: z.enum(["sold", "scrapped", "other"]),
  note: z.string().trim().max(1000).optional().nullable(),
});

/** Tabelle con lo storico di un mezzo: se ce n'è, il mezzo si dismette, non si elimina. */
const VEHICLE_HISTORY_TABLES: Array<[table: string, label: string]> = [
  ["vehicle_fuel", "rifornimenti"],
  ["vehicle_maintenance", "manutenzioni"],
  ["vehicle_km_logs", "chilometri dei turni"],
  ["vehicle_qr_reports", "segnalazioni QR"],
  ["vehicle_anomalies", "anomalie"],
  ["vehicle_documents", "documenti"],
  ["vehicle_insurances", "assicurazioni"],
  ["vehicle_inspections", "revisioni"],
  ["vehicle_compliance_costs", "costi scadenze"],
  ["vehicle_tachographs", "tachigrafi"],
  ["vehicle_extinguishers", "estintori"],
  ["vehicle_km_corrections", "correzioni km"],
];

/** Il vincolo nel DB impedisce di riattivare un mezzo dismesso: messaggio leggibile. */
function decommissionErrorMessage(message: string): string | null {
  return message.includes("vehicles_decommissioned_inactive_check")
    ? "Mezzo dismesso: non può tornare operativo. Un admin deve prima annullare la dismissione."
    : null;
}

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
    let driverAccessError: string | null = null;

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
      if (error) {
        const friendly = decommissionErrorMessage(error.message);
        if (friendly) return NextResponse.json({ ok: false, error: friendly }, { status: 409 });
        throw new Error(error.message);
      }
    }

    if (action === "decommission_vehicle") {
      if (!["admin", "operator"].includes(auth.membership.role)) {
        return NextResponse.json({ ok: false, error: "Ruolo non autorizzato." }, { status: 403 });
      }
      const parsed = decommissionSchema.safeParse(body);
      if (!parsed.success) return NextResponse.json({ ok: false, error: "Indica data e motivo della dismissione." }, { status: 400 });
      const note = parsed.data.note?.trim() || null;
      if (parsed.data.reason === "other" && !note) {
        return NextResponse.json({ ok: false, error: "Motivo \"altro\": scrivi una nota." }, { status: 400 });
      }
      const { data: changed, error } = await auth.admin.from("vehicles")
        .update({
          active: false,
          // Il QR stampato sul mezzo venduto/rottamato smette di funzionare.
          qr_token: null,
          decommissioned_at: parsed.data.decommissioned_at,
          decommission_reason: parsed.data.reason,
          decommission_note: note,
          decommissioned_by: auth.user.id,
          decommission_recorded_at: new Date().toISOString(),
        })
        .eq("tenant_id", tenantId).eq("id", parsed.data.id).is("decommissioned_at", null)
        .select("id").maybeSingle();
      if (error) throw new Error(error.message);
      if (!changed) return NextResponse.json({ ok: false, error: "Mezzo non trovato o già dismesso." }, { status: 409 });
    }

    if (action === "restore_vehicle") {
      if (auth.membership.role !== "admin") {
        return NextResponse.json({ ok: false, error: "Solo admin può annullare una dismissione." }, { status: 403 });
      }
      const vehicleId = String(body?.id ?? "");
      if (!z.string().uuid().safeParse(vehicleId).success) return NextResponse.json({ ok: false, error: "ID mancante." }, { status: 400 });
      const { data: changed, error } = await auth.admin.from("vehicles")
        .update({
          decommissioned_at: null, decommission_reason: null, decommission_note: null,
          decommissioned_by: null, decommission_recorded_at: null,
          // Nuovo QR: quello vecchio potrebbe essere rimasto sul mezzo venduto.
          qr_token: randomBytes(16).toString("hex"),
        })
        .eq("tenant_id", tenantId).eq("id", vehicleId).not("decommissioned_at", "is", null)
        .select("id").maybeSingle();
      if (error) throw new Error(error.message);
      if (!changed) return NextResponse.json({ ok: false, error: "Mezzo non trovato o non dismesso." }, { status: 409 });
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
      if (error) {
        const friendly = decommissionErrorMessage(error.message);
        if (friendly) return NextResponse.json({ ok: false, error: friendly }, { status: 409 });
        throw new Error(error.message);
      }
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
          blocked_from: parsed.blocked_from ?? null,
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
      // Eliminazione definitiva solo per mezzi senza storico (es. creati per errore):
      // la cascata cancellerebbe rifornimenti, manutenzioni, km, documenti...
      const { data: ownVehicle, error: ownError } = await auth.admin.from("vehicles").select("id")
        .eq("tenant_id", tenantId).eq("id", vehicleId).maybeSingle();
      if (ownError) throw new Error(ownError.message);
      if (!ownVehicle) return NextResponse.json({ ok: false, error: "Mezzo non trovato." }, { status: 404 });
      const counts = await Promise.all(VEHICLE_HISTORY_TABLES.map(async ([table, label]) => {
        let countQuery = auth.admin.from(table).select("id", { count: "exact", head: true }).eq("vehicle_id", vehicleId);
        // vehicle_km_logs non ha tenant_id: il mezzo è già verificato come del tenant.
        if (table !== "vehicle_km_logs") countQuery = countQuery.eq("tenant_id", tenantId);
        const { count, error: countError } = await countQuery;
        if (countError) throw new Error(countError.message);
        return [label, count ?? 0] as const;
      }));
      const history = counts.filter(([, count]) => count > 0);
      if (history.length > 0) {
        return NextResponse.json({
          ok: false,
          error: `Il mezzo ha uno storico (${history.map(([label, count]) => `${count} ${label}`).join(", ")}): eliminandolo andrebbe perso. Usa "Dismetti mezzo".`,
          history: Object.fromEntries(history),
        }, { status: 409 });
      }
      const { error } = await auth.admin.from("vehicles").delete().eq("tenant_id", tenantId).eq("id", vehicleId);
      if (error) throw new Error(error.message);
    }

    if (action === "upsert_driver") {
      if (!["admin", "operator"].includes(auth.membership.role)) {
        return NextResponse.json({ ok: false, error: "Ruolo non autorizzato." }, { status: 403 });
      }
      const parsed = driverSchema.parse(body);
      const normalizedPhone = normalizeDriverPassword(parsed.phone);
      if (!parsed.id && normalizedPhone.length < 6) {
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
        try {
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
        } catch (err) {
          if (!parsed.id) {
            await auth.admin
              .from("driver_profiles")
              .update({ active: false })
              .eq("tenant_id", tenantId)
              .eq("id", profileResult.data.id);
            throw err;
          }
          driverAccessError = err instanceof Error ? err.message : "Creazione accesso autista fallita.";
        }
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
      driver_access_error: driverAccessError,
    }, {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
