/**
 * POST /api/ops/piano-giorno/patch-vehicles
 * Aggiorna vehicle_label/vehicle_capacity sui giri esistenti senza mezzo,
 * leggendo il mezzo dichiarato in driver_daily_availability per la data.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

const schema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export async function POST(req: NextRequest) {
  try {
    const auth = await authorizePricingRequest(req, ["admin", "operator", "supervisor"]);
    if (auth instanceof NextResponse) return auth;
    const tenantId = auth.membership.tenant_id;

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const parsed = schema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ ok: false, error: parsed.error.issues[0]?.message }, { status: 400 });
    const { date } = parsed.data;

    // 1. Giri non cancellati del giorno
    const { data: groups, error: groupsErr } = await auth.admin
      .from("trip_groups")
      .select("id, vehicle_label, driver_profile_id, driver_user_id")
      .eq("tenant_id", tenantId)
      .eq("date", date)
      .neq("status", "cancelled");
    if (groupsErr) return NextResponse.json({ ok: false, error: groupsErr.message }, { status: 500 });

    const groupsWithoutVehicle = (groups ?? []).filter((g) => !g.vehicle_label);
    if (groupsWithoutVehicle.length === 0) {
      return NextResponse.json({ ok: true, updated: 0, message: "Tutti i giri hanno già un mezzo assegnato." });
    }

    // 2. Disponibilità autisti del giorno con mezzi
    const { data: avails, error: availErr } = await auth.admin
      .from("driver_daily_availability")
      .select("driver_profile_id, vehicle_1_id, vehicle_2_id")
      .eq("tenant_id", tenantId)
      .eq("date", date)
      .eq("available", true);
    if (availErr) return NextResponse.json({ ok: false, error: availErr.message }, { status: 500 });

    const vehicleIdByProfile = new Map<string, string>();
    for (const a of avails ?? []) {
      if (a.driver_profile_id && a.vehicle_1_id) {
        vehicleIdByProfile.set(a.driver_profile_id as string, a.vehicle_1_id as string);
      }
    }

    if (vehicleIdByProfile.size === 0) {
      return NextResponse.json({ ok: true, updated: 0, message: "Nessun autista ha un mezzo dichiarato nella disponibilità." });
    }

    // 3. Veicoli del tenant
    const vehicleIds = Array.from(new Set(vehicleIdByProfile.values()));
    const { data: vehicles, error: vehErr } = await auth.admin
      .from("vehicles")
      .select("id, label, capacity")
      .eq("tenant_id", tenantId)
      .in("id", vehicleIds);
    if (vehErr) return NextResponse.json({ ok: false, error: vehErr.message }, { status: 500 });

    const vehicleById = new Map((vehicles ?? []).map((v) => [v.id as string, v as { id: string; label: string; capacity: number | null }]));

    // 4. Per i giri senza driver_profile_id, leggi dalle assignments
    const groupIdsNeedingAssignment = groupsWithoutVehicle
      .filter((g) => !g.driver_profile_id)
      .map((g) => g.id as string);

    const profileIdByGroup = new Map<string, string>();
    for (const g of groupsWithoutVehicle) {
      if (g.driver_profile_id) profileIdByGroup.set(g.id as string, g.driver_profile_id as string);
    }

    if (groupIdsNeedingAssignment.length > 0) {
      const { data: assigns } = await auth.admin
        .from("assignments")
        .select("group_id, driver_profile_id")
        .eq("tenant_id", tenantId)
        .in("group_id", groupIdsNeedingAssignment)
        .not("driver_profile_id", "is", null);
      for (const a of assigns ?? []) {
        if (a.group_id && a.driver_profile_id && !profileIdByGroup.has(a.group_id as string)) {
          profileIdByGroup.set(a.group_id as string, a.driver_profile_id as string);
        }
      }
    }

    // 5. Aggiorna trip_groups e assignments
    const now = new Date().toISOString();
    let updated = 0;

    for (const group of groupsWithoutVehicle) {
      const groupId = group.id as string;
      const profileId = profileIdByGroup.get(groupId);
      if (!profileId) continue;

      const vehicleId = vehicleIdByProfile.get(profileId);
      if (!vehicleId) continue;

      const vehicle = vehicleById.get(vehicleId);
      if (!vehicle) continue;

      const [tgRes, assignRes] = await Promise.all([
        auth.admin
          .from("trip_groups")
          .update({ vehicle_label: vehicle.label, vehicle_capacity: vehicle.capacity ?? null, updated_at: now })
          .eq("id", groupId)
          .eq("tenant_id", tenantId),
        auth.admin
          .from("assignments")
          .update({ vehicle_label: vehicle.label })
          .eq("group_id", groupId)
          .eq("tenant_id", tenantId),
      ]);

      if (tgRes.error) continue;
      if (assignRes.error) continue;
      updated++;
    }

    return NextResponse.json({ ok: true, updated, total: groupsWithoutVehicle.length });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Errore" }, { status: 500 });
  }
}
