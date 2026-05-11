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
import { loadVehicleCommitmentsForDate } from "@/lib/server/vehicle-commitments";
import {
  isVehicleManuallyBlockedOnDate,
  manualVehicleBlockMessage,
  type VehicleManualBlock,
} from "@/lib/server/vehicle-availability";
import { sendPushToUser } from "@/lib/server/web-push";
import {
  geographicBlockMessage,
  strongestGeographicResult,
  validateGeographicCompatibility,
  type GeographicCompatibilityService,
} from "@/lib/server/geo-assignment";
import { type SupabaseClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
    if (auth instanceof NextResponse) return auth;

    const tenantId = auth.membership.tenant_id;
    const userId = auth.user.id;

    type Body = {
      action: "create_trip" | "update_trip" | "delete_trip" | "move_services" | "swap_driver" | "swap_vehicle" | "delay_vessel";
      // create_trip / common
      date?: string;
      service_ids?: string[];
      driver_user_id?: string | null;
      vehicle_label?: string | null;
      vehicle_id?: string | null;
      vehicle_capacity?: number | null;
      notes?: string | null;
      // update_trip / delete_trip / move_services
      group_id?: string;
      // move_services
      target_group_id?: string | null;
      // swap_driver
      from_driver_id?: string;
      to_driver_id?: string;
      // swap_vehicle
      from_vehicle_label?: string;
      to_vehicle_label?: string;
      // delay_vessel
      vessel?: string;
      original_time?: string;
      delay_minutes?: number;
    };

    const body = (await request.json().catch(() => null)) as Body | null;
    if (!body?.action) {
      return NextResponse.json({ ok: false, error: "action obbligatoria." }, { status: 400 });
    }

    const now = new Date().toISOString();

    // ─── CREATE TRIP ──────────────────────────────────────────────────────────
    if (body.action === "create_trip") {
      const { date, service_ids, driver_user_id, vehicle_label, vehicle_id, vehicle_capacity, notes } = body;
      if (!date || !service_ids?.length) {
        return NextResponse.json({ ok: false, error: "date e service_ids obbligatori." }, { status: 400 });
      }
      const confirmationError = await ensureAvailabilityConfirmed(auth.admin, tenantId, date);
      if (confirmationError) {
        return NextResponse.json({ ok: false, error: confirmationError }, { status: 409 });
      }
      const validation = await validateTripPayload(auth.admin, tenantId, {
        date,
        serviceIds: service_ids,
        driverUserId: driver_user_id ?? null,
        vehicleCapacity: vehicle_capacity ?? null,
      });
      if (!validation.ok) {
        return NextResponse.json({ ok: false, error: validation.error }, { status: 409 });
      }
      const vehicleCheck = await resolveVehicleAssignment(auth.admin, tenantId, date, vehicle_id ?? null, vehicle_label ?? null);
      if (!vehicleCheck.ok) {
        return NextResponse.json({ ok: false, error: vehicleCheck.error }, { status: 409 });
      }
      if (vehicleCheck.vehicle?.capacity != null && validation.totalPax > vehicleCheck.vehicle.capacity) {
        return NextResponse.json({ ok: false, error: `Overbooking bloccante: ${validation.totalPax} pax su mezzo da ${vehicleCheck.vehicle.capacity}.` }, { status: 409 });
      }

      // 1. Crea trip_group
      const { data: group, error: groupErr } = await auth.admin
        .from("trip_groups")
        .insert({
          tenant_id: tenantId,
          date,
          driver_user_id: driver_user_id || null,
          vehicle_label: (vehicleCheck.vehicle?.label ?? vehicle_label) || null,
          vehicle_capacity: (vehicleCheck.vehicle?.capacity ?? vehicle_capacity) || null,
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
      await _assignServicesToGroup(
        auth.admin,
        tenantId,
        service_ids,
        groupId,
        driver_user_id ?? null,
        vehicleCheck.vehicle?.label ?? vehicle_label ?? null,
        userId,
        now
      );

      // 3. Push all'autista se assegnato
      if (driver_user_id) {
        const { data: firstService } = await auth.admin
          .from("services")
          .select("time, customer_name, pax")
          .in("id", service_ids)
          .order("time")
          .limit(1)
          .maybeSingle();
        const label = firstService
          ? `${firstService.time.slice(0, 5)} — ${firstService.customer_name} · ${firstService.pax} pax`
          : `${service_ids.length} servizi`;
        void sendPushToUser(tenantId, driver_user_id, {
          title: `🚌 Nuovo giro assegnato — ${date}`,
          body: label,
          url: "/driver",
          tag: `trip-assigned-${groupId}`,
        });
      }

      return NextResponse.json({ ok: true, group_id: groupId });
    }

    // ─── UPDATE TRIP ──────────────────────────────────────────────────────────
    if (body.action === "update_trip") {
      const { group_id, driver_user_id, vehicle_label, vehicle_id, vehicle_capacity, notes, service_ids } = body;
      if (!group_id) {
        return NextResponse.json({ ok: false, error: "group_id obbligatorio." }, { status: 400 });
      }
      const { data: groupMeta } = await auth.admin
        .from("trip_groups")
        .select("date")
        .eq("id", group_id)
        .eq("tenant_id", tenantId)
        .maybeSingle();
      const groupDate = groupMeta?.date as string | undefined;
      const effectiveServiceIds = service_ids ?? await loadGroupServiceIds(auth.admin, tenantId, group_id);
      if (!groupDate) {
        return NextResponse.json({ ok: false, error: "Data giro non trovata." }, { status: 404 });
      }
      const confirmationError = await ensureAvailabilityConfirmed(auth.admin, tenantId, groupDate);
      if (confirmationError) {
        return NextResponse.json({ ok: false, error: confirmationError }, { status: 409 });
      }
      const validation = await validateTripPayload(auth.admin, tenantId, {
        date: groupDate,
        serviceIds: effectiveServiceIds,
        driverUserId: driver_user_id ?? null,
        vehicleCapacity: vehicle_capacity ?? null,
        excludeGroupId: group_id,
      });
      if (!validation.ok) {
        return NextResponse.json({ ok: false, error: validation.error }, { status: 409 });
      }
      const vehicleCheck = groupDate
        ? await resolveVehicleAssignment(auth.admin, tenantId, groupDate, vehicle_id ?? null, vehicle_label ?? null)
        : { ok: true as const, vehicle: null };
      if (!vehicleCheck.ok) {
        return NextResponse.json({ ok: false, error: vehicleCheck.error }, { status: 409 });
      }
      if (vehicleCheck.vehicle?.capacity != null && validation.totalPax > vehicleCheck.vehicle.capacity) {
        return NextResponse.json({ ok: false, error: `Overbooking bloccante: ${validation.totalPax} pax su mezzo da ${vehicleCheck.vehicle.capacity}.` }, { status: 409 });
      }

      // Aggiorna trip_group
      await auth.admin
        .from("trip_groups")
        .update({
          driver_user_id: driver_user_id ?? null,
          vehicle_label: vehicleCheck.vehicle?.label ?? vehicle_label ?? null,
          vehicle_capacity: vehicleCheck.vehicle?.capacity ?? vehicle_capacity ?? null,
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
          vehicle_label: vehicleCheck.vehicle?.label ?? vehicle_label ?? null,
        })
        .eq("group_id", group_id)
        .eq("tenant_id", tenantId);

      // Push all'autista se il driver è stato (ri)assegnato
      if (driver_user_id) {
        const { data: firstAssignment } = await auth.admin
          .from("assignments")
          .select("services!inner(date, time, customer_name, pax)")
          .eq("group_id", group_id)
          .eq("tenant_id", tenantId)
          .limit(1)
          .maybeSingle();
        const svc = (firstAssignment?.services as unknown) as { date: string; time: string; customer_name: string; pax: number } | null;
        const label = svc
          ? `${svc.time.slice(0, 5)} — ${svc.customer_name} · ${svc.pax} pax`
          : "Giro aggiornato";
        void sendPushToUser(tenantId, driver_user_id, {
          title: `🚌 Giro aggiornato — ${svc?.date ?? "oggi"}`,
          body: label,
          url: "/driver",
          tag: `trip-updated-${group_id}`,
        });
      }

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
      const { data: groupMeta } = await auth.admin
        .from("trip_groups")
        .select("date")
        .eq("id", group_id)
        .eq("tenant_id", tenantId)
        .maybeSingle();
      if (!groupMeta?.date) {
        return NextResponse.json({ ok: false, error: "Data giro non trovata." }, { status: 404 });
      }
      const confirmationError = await ensureAvailabilityConfirmed(auth.admin, tenantId, groupMeta.date as string);
      if (confirmationError) {
        return NextResponse.json({ ok: false, error: confirmationError }, { status: 409 });
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
      const { service_ids, target_group_id, group_id: source_group_id, driver_user_id, vehicle_label, vehicle_id, vehicle_capacity, notes, date } = body;
      if (!service_ids?.length) {
        return NextResponse.json({ ok: false, error: "service_ids obbligatori." }, { status: 400 });
      }

      let destGroupId = target_group_id;

      // Se target_group_id è null → crea un nuovo giro
      if (!destGroupId) {
        if (!date) return NextResponse.json({ ok: false, error: "date obbligatoria per nuovo giro." }, { status: 400 });
        const confirmationError = await ensureAvailabilityConfirmed(auth.admin, tenantId, date);
        if (confirmationError) {
          return NextResponse.json({ ok: false, error: confirmationError }, { status: 409 });
        }
        const validation = await validateTripPayload(auth.admin, tenantId, {
          date,
          serviceIds: service_ids,
          driverUserId: driver_user_id ?? null,
          vehicleCapacity: vehicle_capacity ?? null,
        });
        if (!validation.ok) {
          return NextResponse.json({ ok: false, error: validation.error }, { status: 409 });
        }
        const vehicleCheck = await resolveVehicleAssignment(auth.admin, tenantId, date, vehicle_id ?? null, vehicle_label ?? null);
        if (!vehicleCheck.ok) {
          return NextResponse.json({ ok: false, error: vehicleCheck.error }, { status: 409 });
        }
        if (vehicleCheck.vehicle?.capacity != null && validation.totalPax > vehicleCheck.vehicle.capacity) {
          return NextResponse.json({ ok: false, error: `Overbooking bloccante: ${validation.totalPax} pax su mezzo da ${vehicleCheck.vehicle.capacity}.` }, { status: 409 });
        }
        const { data: newGroup, error: newGroupErr } = await auth.admin
          .from("trip_groups")
          .insert({
            tenant_id: tenantId,
            date,
            driver_user_id: driver_user_id || null,
            vehicle_label: (vehicleCheck.vehicle?.label ?? vehicle_label) || null,
            vehicle_capacity: (vehicleCheck.vehicle?.capacity ?? vehicle_capacity) || null,
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

      if (destGroupId) {
        const { data: destGroupMeta } = await auth.admin
          .from("trip_groups")
          .select("date")
          .eq("id", destGroupId)
          .eq("tenant_id", tenantId)
          .maybeSingle();
        const effectiveDate = (destGroupMeta?.date as string | undefined) ?? date;
        if (!effectiveDate) {
          return NextResponse.json({ ok: false, error: "Data giro destinazione non trovata." }, { status: 404 });
        }
        const confirmationError = await ensureAvailabilityConfirmed(auth.admin, tenantId, effectiveDate);
        if (confirmationError) {
          return NextResponse.json({ ok: false, error: confirmationError }, { status: 409 });
        }
      }

      // Ottieni driver/vehicle del giro destinazione
      const { data: destGroup } = await auth.admin
        .from("trip_groups")
        .select("driver_user_id, vehicle_label, vehicle_capacity")
        .eq("id", destGroupId)
        .eq("tenant_id", tenantId)
        .maybeSingle();

      const destDriver = destGroup?.driver_user_id ?? driver_user_id ?? null;
      const destVehicle = destGroup?.vehicle_label ?? vehicle_label ?? null;
      if (destDriver && destGroupId) {
        const targetServiceIds = [...new Set([...(await loadGroupServiceIds(auth.admin, tenantId, destGroupId)), ...service_ids])];
        const { data: destGroupDate } = await auth.admin
          .from("trip_groups")
          .select("date")
          .eq("id", destGroupId)
          .eq("tenant_id", tenantId)
          .maybeSingle();
        const validation = await validateTripPayload(auth.admin, tenantId, {
          date: (destGroupDate?.date as string | undefined) ?? date ?? "",
          serviceIds: targetServiceIds,
          driverUserId: destDriver,
          vehicleCapacity: (destGroup?.vehicle_capacity as number | null) ?? vehicle_capacity ?? null,
          excludeGroupId: destGroupId,
        });
        if (!validation.ok) {
          return NextResponse.json({ ok: false, error: validation.error }, { status: 409 });
        }
      }

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

    // ─── SWAP DRIVER ─────────────────────────────────────────────────────────────
    if (body.action === "swap_driver") {
      const { date, from_driver_id, to_driver_id } = body;
      if (!date || !from_driver_id || !to_driver_id) {
        return NextResponse.json({ ok: false, error: "date, from_driver_id e to_driver_id obbligatori." }, { status: 400 });
      }

      const { data: groups, error: groupsErr } = await auth.admin
        .from("trip_groups")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("date", date)
        .eq("driver_user_id", from_driver_id)
        .eq("status", "active");

      if (groupsErr) {
        return NextResponse.json({ ok: false, error: groupsErr.message }, { status: 500 });
      }

      const groupIds = (groups ?? []).map((g) => g.id as string);
      if (!groupIds.length) {
        return NextResponse.json({ ok: true, affected: 0 });
      }

      const movedServiceIds = (await Promise.all(groupIds.map((groupId) => loadGroupServiceIds(auth.admin, tenantId, groupId)))).flat();
      const validation = await validateTripPayload(auth.admin, tenantId, {
        date,
        serviceIds: movedServiceIds,
        driverUserId: to_driver_id,
        vehicleCapacity: null,
      });
      if (!validation.ok) {
        return NextResponse.json({ ok: false, error: validation.error }, { status: 409 });
      }

      await Promise.all([
        auth.admin.from("trip_groups").update({ driver_user_id: to_driver_id, updated_at: now }).in("id", groupIds).eq("tenant_id", tenantId),
        auth.admin.from("assignments").update({ driver_user_id: to_driver_id }).in("group_id", groupIds).eq("tenant_id", tenantId),
      ]);

      void sendPushToUser(tenantId, to_driver_id, {
        title: `🔄 Giri riassegnati — ${date}`,
        body: `${groupIds.length} giro/i trasferiti dal collega`,
        url: "/driver",
        tag: `trip-swap-driver-${date}`,
      });

      return NextResponse.json({ ok: true, affected: groupIds.length });
    }

    // ─── SWAP VEHICLE ─────────────────────────────────────────────────────────────
    if (body.action === "swap_vehicle") {
      const { date, from_vehicle_label, to_vehicle_label } = body;
      if (!date || !from_vehicle_label || !to_vehicle_label) {
        return NextResponse.json({ ok: false, error: "date, from_vehicle_label e to_vehicle_label obbligatori." }, { status: 400 });
      }

      const warnings: string[] = [];
      const vehicleCheck = await resolveVehicleAssignment(auth.admin, tenantId, date, null, to_vehicle_label);
      if (!vehicleCheck.ok) warnings.push(vehicleCheck.error);

      const { data: groups, error: groupsErr } = await auth.admin
        .from("trip_groups")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("date", date)
        .eq("vehicle_label", from_vehicle_label)
        .eq("status", "active");

      if (groupsErr) {
        return NextResponse.json({ ok: false, error: groupsErr.message }, { status: 500 });
      }

      const groupIds = (groups ?? []).map((g) => g.id as string);
      if (!groupIds.length) {
        return NextResponse.json({ ok: true, affected: 0, warnings });
      }

      await Promise.all([
        auth.admin.from("trip_groups").update({ vehicle_label: to_vehicle_label, updated_at: now }).in("id", groupIds).eq("tenant_id", tenantId),
        auth.admin.from("assignments").update({ vehicle_label: to_vehicle_label }).in("group_id", groupIds).eq("tenant_id", tenantId),
      ]);

      return NextResponse.json({ ok: true, affected: groupIds.length, warnings });
    }

    // ─── DELAY VESSEL ─────────────────────────────────────────────────────────────
    if (body.action === "delay_vessel") {
      const { date, vessel, original_time, delay_minutes } = body;
      if (!date || !vessel || !original_time || delay_minutes == null) {
        return NextResponse.json({ ok: false, error: "date, vessel, original_time e delay_minutes obbligatori." }, { status: 400 });
      }

      const origMinutes = toMinutes(original_time);

      const { data: affectedServices, error: servicesErr } = await auth.admin
        .from("services")
        .select("id, time, vessel")
        .eq("tenant_id", tenantId)
        .eq("date", date)
        .ilike("vessel", `%${vessel}%`)
        .neq("status", "cancelled");

      if (servicesErr) {
        return NextResponse.json({ ok: false, error: servicesErr.message }, { status: 500 });
      }

      const matched = (affectedServices ?? []).filter((s) => Math.abs(toMinutes(s.time as string) - origMinutes) <= 10);

      if (!matched.length) {
        return NextResponse.json({ ok: true, affected: 0, new_time: null, warnings: ["Nessun servizio trovato per questa corsa."] });
      }

      const newTotalMinutes = origMinutes + Number(delay_minutes);
      const newH = String(Math.floor(newTotalMinutes / 60) % 24).padStart(2, "0");
      const newM = String(newTotalMinutes % 60).padStart(2, "0");
      const newTimeStr = `${newH}:${newM}:00`;
      const matchedIds = matched.map((s) => s.id as string);

      await auth.admin.from("services").update({ time: newTimeStr }).in("id", matchedIds).eq("tenant_id", tenantId);

      // Notifica autisti dei giri coinvolti
      const { data: assignedRows } = await auth.admin
        .from("assignments")
        .select("group_id")
        .in("service_id", matchedIds)
        .eq("tenant_id", tenantId)
        .not("group_id", "is", null);

      const affectedGroupIds = [...new Set((assignedRows ?? []).map((a) => a.group_id as string))];
      if (affectedGroupIds.length) {
        const { data: driverRows } = await auth.admin
          .from("trip_groups")
          .select("driver_user_id")
          .in("id", affectedGroupIds)
          .eq("tenant_id", tenantId)
          .not("driver_user_id", "is", null);

        const driverIds = [...new Set((driverRows ?? []).map((g) => g.driver_user_id as string))];
        for (const driverId of driverIds) {
          void sendPushToUser(tenantId, driverId, {
            title: `⚠️ Ritardo corsa — ${date}`,
            body: `${vessel}: ritardo ${delay_minutes} min. Nuovo orario: ${newH}:${newM}`,
            url: "/driver",
            tag: `delay-vessel-${date}-${vessel}`,
          });
        }
      }

      return NextResponse.json({ ok: true, affected: matchedIds.length, new_time: `${newH}:${newM}` });
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
  admin: SupabaseClient,
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

  await admin
    .from("assignments")
    .upsert(assignRows, { onConflict: "service_id,tenant_id", ignoreDuplicates: false });

  // Status → assigned + status_events
  await admin.from("services").update({ status: "assigned" }).in("id", serviceIds).eq("tenant_id", tenantId);

  const statusEventRows = serviceIds.map((sid) => ({
    tenant_id: tenantId,
    service_id: sid,
    status: "assigned",
    at: now,
    by_user_id: byUserId,
  }));
  await admin.from("status_events").upsert(statusEventRows, { onConflict: "tenant_id,service_id,status", ignoreDuplicates: true });
}

async function resolveVehicleAssignment(
  admin: SupabaseClient,
  tenantId: string,
  date: string,
  vehicleId: string | null,
  vehicleLabel: string | null
): Promise<
  | { ok: true; vehicle: (VehicleManualBlock & { id: string; label: string; capacity: number | null }) | null }
  | { ok: false; error: string }
> {
  if (!vehicleId && !vehicleLabel) return { ok: true, vehicle: null };

  const { byVehicleId } = await loadVehicleCommitmentsForDate(admin, tenantId, date);

  if (vehicleId && byVehicleId.has(vehicleId)) {
    const commitment = byVehicleId.get(vehicleId)!;
    return { ok: false, error: `Mezzo impegnato per ${commitment.commitment_type}. Rimuovi prima l'impegno in Fleet Ops.` };
  }

  let vehicle: (VehicleManualBlock & { id: string; label: string; capacity: number | null }) | null = null;
  if (vehicleId) {
    const { data } = await admin
      .from("vehicles")
      .select("id, label, capacity, blocked_from, blocked_until, blocked_reason, is_blocked_manual")
      .eq("tenant_id", tenantId)
      .eq("id", vehicleId)
      .maybeSingle();
    if (data) {
      vehicle = {
        id: data.id as string,
        label: data.label as string,
        capacity: (data.capacity as number | null) ?? null,
        blocked_from: (data.blocked_from as string | null) ?? null,
        blocked_until: (data.blocked_until as string | null) ?? null,
        blocked_reason: (data.blocked_reason as string | null) ?? null,
        is_blocked_manual: (data.is_blocked_manual as boolean | null) ?? null,
      };
    }
  } else if (vehicleLabel) {
    const { data } = await admin
      .from("vehicles")
      .select("id, label, capacity, blocked_from, blocked_until, blocked_reason, is_blocked_manual")
      .eq("tenant_id", tenantId)
      .eq("label", vehicleLabel)
      .maybeSingle();
    if (data) {
      vehicle = {
        id: data.id as string,
        label: data.label as string,
        capacity: (data.capacity as number | null) ?? null,
        blocked_from: (data.blocked_from as string | null) ?? null,
        blocked_until: (data.blocked_until as string | null) ?? null,
        blocked_reason: (data.blocked_reason as string | null) ?? null,
        is_blocked_manual: (data.is_blocked_manual as boolean | null) ?? null,
      };
    }
  }

  if (vehicle && byVehicleId.has(vehicle.id)) {
    const commitment = byVehicleId.get(vehicle.id)!;
    return { ok: false, error: `Mezzo impegnato per ${commitment.commitment_type}. Rimuovi prima l'impegno in Fleet Ops.` };
  }
  if (vehicle && isVehicleManuallyBlockedOnDate(vehicle, date)) {
    return { ok: false, error: manualVehicleBlockMessage(vehicle) };
  }

  return { ok: true, vehicle };
}

async function ensureAvailabilityConfirmed(
  admin: SupabaseClient,
  tenantId: string,
  date: string
): Promise<string | null> {
  const { data, error } = await admin
    .from("daily_availability_confirmations")
    .select("confirmed")
    .eq("tenant_id", tenantId)
    .eq("date", date)
    .maybeSingle();

  if (error) {
    return `Errore verifica disponibilita: ${error.message}`;
  }

  if (!data?.confirmed) {
    return "Disponibilita del giorno non confermata. Completa prima la conferma in Disponibilita.";
  }

  return null;
}

type ServiceValidationRow = {
  id: string;
  time: string;
  pickup_hotel: string | null;
  direction: "arrival" | "departure";
  pax: number;
  hotel_id: string | null;
  meeting_point: string | null;
};

type HotelValidationRow = {
  id: string;
  zone: string | null;
};

function serviceOperationalTime(service: ServiceValidationRow): string {
  return service.direction === "departure"
    ? (service.pickup_hotel ?? service.time).slice(0, 5)
    : service.time.slice(0, 5);
}

function toMinutes(value: string): number {
  const [h, m] = value.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

async function loadGroupServiceIds(
  admin: SupabaseClient,
  tenantId: string,
  groupId: string
): Promise<string[]> {
  const { data } = await admin
    .from("assignments")
    .select("service_id")
    .eq("tenant_id", tenantId)
    .eq("group_id", groupId);
  return (data ?? []).map((row) => row.service_id as string);
}

async function validateTripPayload(
  admin: SupabaseClient,
  tenantId: string,
  params: {
    date: string;
    serviceIds: string[];
    driverUserId: string | null;
    vehicleCapacity: number | null;
    excludeGroupId?: string;
  }
): Promise<
  | { ok: true; totalPax: number }
  | { ok: false; error: string }
> {
  if (!params.driverUserId) {
    return { ok: false, error: "Seleziona un autista prima di salvare il giro." };
  }

  const { data: services, error } = await admin
    .from("services")
    .select("id, time, pickup_hotel, direction, pax, hotel_id, meeting_point")
    .eq("tenant_id", tenantId)
    .in("id", params.serviceIds);

  if (error) {
    return { ok: false, error: `Errore validazione servizi: ${error.message}` };
  }

  const serviceRows = (services ?? []) as ServiceValidationRow[];
  const totalPax = serviceRows.reduce((sum, service) => sum + (service.pax ?? 0), 0);

  if (params.vehicleCapacity != null && totalPax > params.vehicleCapacity) {
    return { ok: false, error: `Overbooking bloccante: ${totalPax} pax su mezzo da ${params.vehicleCapacity}.` };
  }

  const hotelIds = serviceRows.map((service) => service.hotel_id).filter((id): id is string => Boolean(id));
  const { data: hotelsData } = hotelIds.length > 0
    ? await admin.from("hotels").select("id, zone").eq("tenant_id", tenantId).in("id", hotelIds)
    : { data: [] as HotelValidationRow[] };
  const hotelMap = new Map((hotelsData ?? []).map((hotel) => [hotel.id as string, hotel as HotelValidationRow]));

  const { data: otherAssignments, error: otherAssignmentsError } = await admin
    .from("assignments")
    .select("group_id, services!inner(id, time, pickup_hotel, direction, hotel_id, meeting_point)")
    .eq("tenant_id", tenantId)
    .eq("driver_user_id", params.driverUserId)
    .not("group_id", "is", null);

  if (otherAssignmentsError) {
    return { ok: false, error: `Errore validazione conflitti autista: ${otherAssignmentsError.message}` };
  }

  const { data: otherGroups, error: otherGroupsError } = await admin
    .from("trip_groups")
    .select("id, date, status")
    .eq("tenant_id", tenantId)
    .eq("date", params.date)
    .eq("status", "active")
    .eq("driver_user_id", params.driverUserId);

  if (otherGroupsError) {
    return { ok: false, error: `Errore validazione giri autista: ${otherGroupsError.message}` };
  }

  const activeGroupIds = new Set(
    (otherGroups ?? [])
      .map((group) => group.id as string)
      .filter((groupId) => groupId !== params.excludeGroupId)
  );

  const otherTimes = (otherAssignments ?? [])
    .filter((assignment) => activeGroupIds.has(assignment.group_id as string))
    .map((assignment) => (assignment.services as unknown) as ServiceValidationRow)
    .map((service) => toMinutes(serviceOperationalTime({ ...service, id: "", pax: 0 })));

  for (const service of serviceRows) {
    const currentTime = toMinutes(serviceOperationalTime(service));
    if (otherTimes.some((otherTime) => Math.abs(otherTime - currentTime) < 75)) {
      return { ok: false, error: "Autista gia impegnato in un altro giro nella stessa finestra operativa." };
    }
  }

  const otherAssignmentsForGeo = (otherAssignments ?? [])
    .filter((assignment) => activeGroupIds.has(assignment.group_id as string));
  const otherServices = otherAssignmentsForGeo
    .map((assignment) => (assignment.services as unknown) as ServiceValidationRow);
  const otherHotelIds = otherServices.map((service) => service.hotel_id).filter((id): id is string => Boolean(id));
  const missingHotelIds = otherHotelIds.filter((id) => !hotelMap.has(id));
  if (missingHotelIds.length > 0) {
    const { data: otherHotelsData } = await admin
      .from("hotels")
      .select("id, zone")
      .eq("tenant_id", tenantId)
      .in("id", [...new Set(missingHotelIds)]);
    for (const hotel of otherHotelsData ?? []) {
      hotelMap.set(hotel.id as string, hotel as HotelValidationRow);
    }
  }

  const otherServicesByGroup = new Map<string, ServiceValidationRow[]>();
  for (const assignment of otherAssignmentsForGeo) {
    const groupId = assignment.group_id as string;
    otherServicesByGroup.set(groupId, [
      ...(otherServicesByGroup.get(groupId) ?? []),
      (assignment.services as unknown) as ServiceValidationRow,
    ]);
  }
  const combinedGeoServices = [
    ...Array.from(otherServicesByGroup.values()).map((groupServices) => servicesToTripGeographicWindow(groupServices, hotelMap)),
    servicesToTripGeographicWindow(serviceRows, hotelMap),
  ]
    .sort((a, b) => toMinutes(a.startTime) - toMinutes(b.startTime));
  const geoResults = [];
  for (let i = 1; i < combinedGeoServices.length; i++) {
    geoResults.push(validateGeographicCompatibility(combinedGeoServices[i - 1]!, combinedGeoServices[i]!));
  }
  const strongestGeoIssue = strongestGeographicResult(geoResults.filter((result) => result.severity !== "ok"));
  if (strongestGeoIssue?.severity === "block") {
    const driverName = await loadDriverName(admin, tenantId, params.driverUserId);
    return { ok: false, error: geographicBlockMessage(driverName, strongestGeoIssue) };
  }

  return { ok: true, totalPax };
}

function serviceToGeographicWindow(
  service: ServiceValidationRow,
  hotels: Map<string, HotelValidationRow>
): GeographicCompatibilityService {
  const hotelZone = service.hotel_id ? hotels.get(service.hotel_id)?.zone ?? null : null;
  const portZone = service.meeting_point ?? null;
  const startTime = serviceOperationalTime(service);
  if (service.direction === "departure") {
    return {
      id: service.id,
      startTime,
      endZone: portZone,
      startZone: hotelZone,
    };
  }
  return {
    id: service.id,
    startTime,
    endZone: hotelZone,
    startZone: portZone,
  };
}

function servicesToTripGeographicWindow(
  services: ServiceValidationRow[],
  hotels: Map<string, HotelValidationRow>
): GeographicCompatibilityService {
  const windows = [...services]
    .sort((a, b) => toMinutes(serviceOperationalTime(a)) - toMinutes(serviceOperationalTime(b)))
    .map((service) => serviceToGeographicWindow(service, hotels));
  const first = windows[0];
  const last = windows[windows.length - 1] ?? first;
  return {
    id: services.map((service) => service.id).join(","),
    startTime: first?.startTime ?? "00:00",
    startZone: first?.startZone ?? null,
    startArea: first?.startArea ?? null,
    endZone: last?.endZone ?? first?.endZone ?? null,
    endArea: last?.endArea ?? first?.endArea ?? null,
  };
}

async function loadDriverName(admin: SupabaseClient, tenantId: string, driverUserId: string): Promise<string> {
  const { data } = await admin
    .from("memberships")
    .select("full_name")
    .eq("tenant_id", tenantId)
    .eq("user_id", driverUserId)
    .maybeSingle();
  return (data?.full_name as string | null) ?? "selezionato";
}
