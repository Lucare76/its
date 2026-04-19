/**
 * POST /api/ops/piano-giorno/trips
 * Gestisce creazione, modifica ed eliminazione dei giri del Piano del Giorno.
 *
 * Actions:
 *   create_trip   — crea gruppo + assignments per i servizi selezionati
 *   update_trip   — aggiorna driver/mezzo/note del gruppo; ricalcola assignments
 *   delete_trip   — elimina gruppo, rimuove assignments, riporta servizi a "new"
 *   move_services — sposta servizi da un giro a un altro (o crea nuovo giro)
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
    if (auth instanceof NextResponse) return auth;

    const tenantId = auth.membership.tenant_id;
    const userId = auth.user.id;

    type Body = {
      action: "create_trip" | "update_trip" | "delete_trip" | "move_services";
      // create_trip
      date?: string;
      service_ids?: string[];
      driver_user_id?: string | null;
      vehicle_label?: string | null;
      vehicle_capacity?: number | null;
      notes?: string | null;
      // update_trip / delete_trip / move_services
      group_id?: string;
      // move_services
      target_group_id?: string | null; // null = crea nuovo giro
    };

    const body = (await request.json().catch(() => null)) as Body | null;
    if (!body?.action) {
      return NextResponse.json({ ok: false, error: "action obbligatoria." }, { status: 400 });
    }

    const now = new Date().toISOString();

    // ─── CREATE TRIP ──────────────────────────────────────────────────────────
    if (body.action === "create_trip") {
      const { date, service_ids, driver_user_id, vehicle_label, vehicle_capacity, notes } = body;
      if (!date || !service_ids?.length) {
        return NextResponse.json({ ok: false, error: "date e service_ids obbligatori." }, { status: 400 });
      }

      // 1. Crea trip_group
      const { data: group, error: groupErr } = await auth.admin
        .from("trip_groups")
        .insert({
          tenant_id: tenantId,
          date,
          driver_user_id: driver_user_id || null,
          vehicle_label: vehicle_label || null,
          vehicle_capacity: vehicle_capacity || null,
          notes: notes || null,
          created_by: userId,
          created_at: now,
          updated_at: now,
        })
        .select("id")
        .single();

      if (groupErr || !group?.id) {
        return NextResponse.json({ ok: false, error: groupErr?.message ?? "Errore creazione giro." }, { status: 500 });
      }

      const groupId = group.id as string;

      // 2. Assignments + status update per ogni servizio
      await _assignServicesToGroup(auth.admin, tenantId, service_ids, groupId, driver_user_id ?? null, vehicle_label ?? null, userId, now);

      return NextResponse.json({ ok: true, group_id: groupId });
    }

    // ─── UPDATE TRIP ──────────────────────────────────────────────────────────
    if (body.action === "update_trip") {
      const { group_id, driver_user_id, vehicle_label, vehicle_capacity, notes, service_ids } = body;
      if (!group_id) {
        return NextResponse.json({ ok: false, error: "group_id obbligatorio." }, { status: 400 });
      }

      // Aggiorna trip_group
      await auth.admin
        .from("trip_groups")
        .update({
          driver_user_id: driver_user_id ?? null,
          vehicle_label: vehicle_label ?? null,
          vehicle_capacity: vehicle_capacity ?? null,
          notes: notes ?? null,
          updated_at: now,
        })
        .eq("id", group_id)
        .eq("tenant_id", tenantId);

      // Aggiorna assignments esistenti del gruppo
      await auth.admin
        .from("assignments")
        .update({
          driver_user_id: driver_user_id ?? null,
          vehicle_label: vehicle_label ?? null,
        })
        .eq("group_id", group_id)
        .eq("tenant_id", tenantId);

      // Se passati nuovi service_ids, riassegna (add/remove dal gruppo)
      if (service_ids !== undefined) {
        // Rimuovi servizi che non sono più nel gruppo
        const { data: existing } = await auth.admin
          .from("assignments")
          .select("id, service_id")
          .eq("group_id", group_id)
          .eq("tenant_id", tenantId);

        const existingIds = new Set((existing ?? []).map((a) => a.service_id as string));
        const newIds = new Set(service_ids);

        // Servizi rimossi dal gruppo → cancella assignment o svincola
        const toRemove = (existing ?? []).filter((a) => !newIds.has(a.service_id as string));
        if (toRemove.length > 0) {
          await Promise.all([
            auth.admin.from("assignments").delete().in("id", toRemove.map((a) => a.id)).eq("tenant_id", tenantId),
            auth.admin.from("services").update({ status: "new" }).in("id", toRemove.map((a) => a.service_id)).eq("tenant_id", tenantId),
          ]);
        }

        // Servizi aggiunti → nuovi assignments
        const toAdd = service_ids.filter((id) => !existingIds.has(id));
        if (toAdd.length > 0) {
          await _assignServicesToGroup(auth.admin, tenantId, toAdd, group_id, driver_user_id ?? null, vehicle_label ?? null, userId, now);
        }
      }

      return NextResponse.json({ ok: true });
    }

    // ─── DELETE TRIP ──────────────────────────────────────────────────────────
    if (body.action === "delete_trip") {
      const { group_id } = body;
      if (!group_id) {
        return NextResponse.json({ ok: false, error: "group_id obbligatorio." }, { status: 400 });
      }

      // Recupera service_ids del gruppo prima di cancellare
      const { data: groupAssignments } = await auth.admin
        .from("assignments")
        .select("id, service_id")
        .eq("group_id", group_id)
        .eq("tenant_id", tenantId);

      const serviceIds = (groupAssignments ?? []).map((a) => a.service_id as string);

      await Promise.all([
        auth.admin.from("assignments").delete().eq("group_id", group_id).eq("tenant_id", tenantId),
        auth.admin.from("trip_groups").update({ status: "cancelled", updated_at: now }).eq("id", group_id).eq("tenant_id", tenantId),
      ]);

      if (serviceIds.length > 0) {
        await auth.admin.from("services").update({ status: "new" }).in("id", serviceIds).eq("tenant_id", tenantId);
      }

      return NextResponse.json({ ok: true });
    }

    // ─── MOVE SERVICES ────────────────────────────────────────────────────────
    if (body.action === "move_services") {
      const { service_ids, target_group_id, group_id: source_group_id, driver_user_id, vehicle_label, vehicle_capacity, notes, date } = body;
      if (!service_ids?.length) {
        return NextResponse.json({ ok: false, error: "service_ids obbligatori." }, { status: 400 });
      }

      let destGroupId = target_group_id;

      // Se target_group_id è null → crea un nuovo giro
      if (!destGroupId) {
        if (!date) return NextResponse.json({ ok: false, error: "date obbligatoria per nuovo giro." }, { status: 400 });
        const { data: newGroup, error: newGroupErr } = await auth.admin
          .from("trip_groups")
          .insert({
            tenant_id: tenantId,
            date,
            driver_user_id: driver_user_id || null,
            vehicle_label: vehicle_label || null,
            vehicle_capacity: vehicle_capacity || null,
            notes: notes || null,
            created_by: userId,
            created_at: now,
            updated_at: now,
          })
          .select("id")
          .single();
        if (newGroupErr || !newGroup?.id) {
          return NextResponse.json({ ok: false, error: newGroupErr?.message ?? "Errore creazione giro." }, { status: 500 });
        }
        destGroupId = newGroup.id as string;
      }

      // Ottieni driver/vehicle del giro destinazione
      const { data: destGroup } = await auth.admin
        .from("trip_groups")
        .select("driver_user_id, vehicle_label")
        .eq("id", destGroupId)
        .eq("tenant_id", tenantId)
        .maybeSingle();

      const destDriver = destGroup?.driver_user_id ?? driver_user_id ?? null;
      const destVehicle = destGroup?.vehicle_label ?? vehicle_label ?? null;

      // Aggiorna assignments (cambia group_id)
      await auth.admin
        .from("assignments")
        .update({ group_id: destGroupId, driver_user_id: destDriver, vehicle_label: destVehicle })
        .in("service_id", service_ids)
        .eq("tenant_id", tenantId);

      // Verifica se il gruppo sorgente è rimasto vuoto → cancellalo
      if (source_group_id) {
        const { data: remaining } = await auth.admin
          .from("assignments")
          .select("id")
          .eq("group_id", source_group_id)
          .eq("tenant_id", tenantId);
        if (!remaining?.length) {
          await auth.admin.from("trip_groups").update({ status: "cancelled", updated_at: now }).eq("id", source_group_id).eq("tenant_id", tenantId);
        }
      }

      return NextResponse.json({ ok: true, group_id: destGroupId });
    }

    return NextResponse.json({ ok: false, error: "Azione non riconosciuta." }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Errore." },
      { status: 500 }
    );
  }
}

// ─── Helper ───────────────────────────────────────────────────────────────────

async function _assignServicesToGroup(
  admin: any,
  tenantId: string,
  serviceIds: string[],
  groupId: string,
  driverUserId: string | null,
  vehicleLabel: string | null,
  byUserId: string,
  now: string
) {
  // Upsert assignments
  const assignRows = serviceIds.map((sid) => ({
    tenant_id: tenantId,
    service_id: sid,
    driver_user_id: driverUserId,
    vehicle_label: vehicleLabel ?? "",
    group_id: groupId,
  }));

  await (admin as any)
    .from("assignments")
    .upsert(assignRows, { onConflict: "service_id,tenant_id", ignoreDuplicates: false });

  // Status → assigned + status_events
  await (admin as any).from("services").update({ status: "assigned" }).in("id", serviceIds).eq("tenant_id", tenantId);

  const statusEventRows = serviceIds.map((sid) => ({
    tenant_id: tenantId,
    service_id: sid,
    status: "assigned",
    at: now,
    by_user_id: byUserId,
  }));
  await (admin as any).from("status_events").upsert(statusEventRows, { onConflict: "tenant_id,service_id,status", ignoreDuplicates: true });
}
