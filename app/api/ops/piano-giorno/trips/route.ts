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
import { sendPushToUser } from "@/lib/server/web-push";
import { type SupabaseClient } from "@supabase/supabase-js";

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
      vehicle_id?: string | null;
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
      const { date, service_ids, driver_user_id, vehicle_label, vehicle_id, vehicle_capacity, notes } = body;
      if (!date || !service_ids?.length) {
        return NextResponse.json({ ok: false, error: "date e service_ids obbligatori." }, { status: 400 });
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
  | { ok: true; vehicle: { id: string; label: string; capacity: number | null } | null }
  | { ok: false; error: string }
> {
  if (!vehicleId && !vehicleLabel) return { ok: true, vehicle: null };

  const { byVehicleId } = await loadVehicleCommitmentsForDate(admin, tenantId, date);

  if (vehicleId && byVehicleId.has(vehicleId)) {
    const commitment = byVehicleId.get(vehicleId)!;
    return { ok: false, error: `Mezzo impegnato per ${commitment.commitment_type}. Rimuovi prima l'impegno in Fleet Ops.` };
  }

  let vehicle: { id: string; label: string; capacity: number | null } | null = null;
  if (vehicleId) {
    const { data } = await admin
      .from("vehicles")
      .select("id, label, capacity")
      .eq("tenant_id", tenantId)
      .eq("id", vehicleId)
      .maybeSingle();
    if (data) vehicle = { id: data.id as string, label: data.label as string, capacity: (data.capacity as number | null) ?? null };
  } else if (vehicleLabel) {
    const { data } = await admin
      .from("vehicles")
      .select("id, label, capacity")
      .eq("tenant_id", tenantId)
      .eq("label", vehicleLabel)
      .maybeSingle();
    if (data) vehicle = { id: data.id as string, label: data.label as string, capacity: (data.capacity as number | null) ?? null };
  }

  if (vehicle && byVehicleId.has(vehicle.id)) {
    const commitment = byVehicleId.get(vehicle.id)!;
    return { ok: false, error: `Mezzo impegnato per ${commitment.commitment_type}. Rimuovi prima l'impegno in Fleet Ops.` };
  }

  return { ok: true, vehicle };
}

type ServiceValidationRow = {
  id: string;
  time: string;
  pickup_hotel: string | null;
  direction: "arrival" | "departure";
  pax: number;
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
    .select("id, time, pickup_hotel, direction, pax")
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

  const { data: otherAssignments, error: otherAssignmentsError } = await admin
    .from("assignments")
    .select("group_id, services!inner(id, time, pickup_hotel, direction)")
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
    .map((assignment) => (assignment.services as unknown) as Pick<ServiceValidationRow, "time" | "pickup_hotel" | "direction">)
    .map((service) => toMinutes(serviceOperationalTime({ ...service, id: "", pax: 0 })));

  for (const service of serviceRows) {
    const currentTime = toMinutes(serviceOperationalTime(service));
    if (otherTimes.some((otherTime) => Math.abs(otherTime - currentTime) < 75)) {
      return { ok: false, error: "Autista gia impegnato in un altro giro nella stessa finestra operativa." };
    }
  }

  return { ok: true, totalPax };
}
