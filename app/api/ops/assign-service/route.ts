/**
 * POST /api/ops/assign-service
 * Assegna o rimuove un singolo servizio creando sempre un trip_group con group_id.
 * Usato da dispatch, service-workflow e dashboard per garantire che le
 * assegnazioni siano visibili nel Piano del Giorno.
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import {
  geographicBlockMessage,
  strongestGeographicResult,
  validateGeographicCompatibility,
  type GeographicCompatibilityService,
} from "@/lib/server/geo-assignment";
import { type SupabaseClient } from "@supabase/supabase-js";
import { auditLog } from "@/lib/server/ops-audit";

export const runtime = "nodejs";

// Elimina, in modo best-effort, il trip_group appena creato dalla richiesta
// corrente quando il successivo insert su assignments fallisce (CONC-01).
// Va chiamata solo con un groupId proveniente da un insert eseguito nella
// stessa richiesta: non deve mai cancellare un gruppo preesistente/riusato.
async function cleanupCreatedTripGroup(
  admin: SupabaseClient,
  tenantId: string,
  groupId: string
): Promise<boolean> {
  try {
    const { error } = await admin.from("trip_groups").delete().eq("id", groupId).eq("tenant_id", tenantId);
    if (error) {
      auditLog({
        event: "assignment_cleanup_failed",
        level: "error",
        tenantId,
        details: { groupIdCreated: groupId, error: error.message },
      });
      return false;
    }
    return true;
  } catch (err) {
    auditLog({
      event: "assignment_cleanup_failed",
      level: "error",
      tenantId,
      details: { groupIdCreated: groupId, error: err instanceof Error ? err.message : "Errore sconosciuto." },
    });
    return false;
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
    if (auth instanceof NextResponse) return auth;

    const tenantId = auth.membership.tenant_id;
    const userId = auth.user.id;

    type Body = {
      service_id: string;
      driver_user_id?: string | null;
      driver_profile_id?: string | null;
      vehicle_label?: string | null;
      action?: "assign" | "remove";
    };

    const body = (await request.json().catch(() => null)) as Body | null;
    if (!body?.service_id) {
      return NextResponse.json({ ok: false, error: "service_id obbligatorio." }, { status: 400 });
    }

    const action = body.action ?? "assign";
    const now = new Date().toISOString();
    const manualAssignmentLock = {
      assignment_source: "manual_assign_service",
      locked_by_operator: true,
      assigned_by: userId,
      assigned_at: now,
      lock_reason: "manual_assignment_from_assign_service",
    };

    // Recupera il servizio per avere la data
    const { data: service, error: serviceErr } = await auth.admin
      .from("services")
      .select("id, date, status, time, pickup_hotel, direction, hotel_id, meeting_point")
      .eq("id", body.service_id)
      .eq("tenant_id", tenantId)
      .maybeSingle();

    if (serviceErr || !service) {
      return NextResponse.json({ ok: false, error: "Servizio non trovato." }, { status: 404 });
    }

    const date = service.date as string;

    // Verifica disponibilità confermata
    const { data: availability } = await auth.admin
      .from("daily_availability_confirmations")
      .select("confirmed")
      .eq("tenant_id", tenantId)
      .eq("date", date)
      .maybeSingle();

    if (!availability?.confirmed) {
      return NextResponse.json({
        ok: false,
        error: "Disponibilita del giorno non confermata. Completa prima la conferma in Disponibilita."
      }, { status: 409 });
    }

    // Recupera assignment esistente
    const { data: existingAssignment } = await auth.admin
      .from("assignments")
      .select("id, group_id")
      .eq("service_id", body.service_id)
      .eq("tenant_id", tenantId)
      .maybeSingle();

    // ─── REMOVE ───────────────────────────────────────────────────────────────
    if (action === "remove") {
      if (!existingAssignment) {
        return NextResponse.json({ ok: true });
      }
      await auth.admin.from("assignments").delete().eq("id", existingAssignment.id).eq("tenant_id", tenantId);

      if (existingAssignment.group_id) {
        const { data: remaining } = await auth.admin
          .from("assignments")
          .select("id")
          .eq("group_id", existingAssignment.group_id)
          .eq("tenant_id", tenantId);
        if (!remaining?.length) {
          await auth.admin.from("trip_groups")
            .update({ status: "cancelled", updated_at: now })
            .eq("id", existingAssignment.group_id)
            .eq("tenant_id", tenantId);
        }
      }

      await auth.admin.from("services").update({ status: "new" }).eq("id", body.service_id).eq("tenant_id", tenantId);
      return NextResponse.json({ ok: true });
    }

    // ─── ASSIGN ───────────────────────────────────────────────────────────────
    if (body.driver_user_id) {
      const geoValidation = await validateSingleServiceGeography(auth.admin, tenantId, body.driver_user_id, {
        id: service.id as string,
        time: service.time as string,
        pickup_hotel: service.pickup_hotel as string | null,
        direction: service.direction as "arrival" | "departure",
        hotel_id: service.hotel_id as string | null,
        meeting_point: service.meeting_point as string | null,
      });
      if (!geoValidation.ok) {
        return NextResponse.json({ ok: false, error: geoValidation.error }, { status: 409 });
      }
    }

    let groupId: string;

    if (existingAssignment?.group_id) {
      groupId = existingAssignment.group_id as string;
      await Promise.all([
        auth.admin.from("trip_groups").update({
          driver_user_id: body.driver_user_id ?? null,
          driver_profile_id: body.driver_profile_id ?? null,
          vehicle_label: body.vehicle_label ?? null,
          updated_at: now,
        }).eq("id", groupId).eq("tenant_id", tenantId),
        auth.admin.from("assignments").update({
          driver_user_id: body.driver_user_id ?? null,
          driver_profile_id: body.driver_profile_id ?? null,
          vehicle_label: body.vehicle_label ?? "",
          ...manualAssignmentLock,
        }).eq("id", existingAssignment.id).eq("tenant_id", tenantId),
      ]);
    } else {
      // Rimuovi eventuale assignment vecchio senza group_id
      if (existingAssignment) {
        await auth.admin.from("assignments").delete().eq("id", existingAssignment.id).eq("tenant_id", tenantId);
      }

      const { data: newGroup, error: groupErr } = await auth.admin
        .from("trip_groups")
        .insert({
          tenant_id: tenantId,
          date,
          driver_user_id: body.driver_user_id ?? null,
          driver_profile_id: body.driver_profile_id ?? null,
          vehicle_label: body.vehicle_label ?? null,
          created_by: userId,
          created_at: now,
          updated_at: now,
        })
        .select("id")
        .single();

      if (groupErr || !newGroup?.id) {
        return NextResponse.json({ ok: false, error: groupErr?.message ?? "Errore creazione giro." }, { status: 500 });
      }

      groupId = newGroup.id as string;

      const { error: assignmentInsertError } = await auth.admin.from("assignments").insert({
        tenant_id: tenantId,
        service_id: body.service_id,
        driver_user_id: body.driver_user_id ?? null,
        driver_profile_id: body.driver_profile_id ?? null,
        vehicle_label: body.vehicle_label ?? "",
        group_id: groupId,
        ...manualAssignmentLock,
      });

      if (assignmentInsertError) {
        const cleanupSucceeded = await cleanupCreatedTripGroup(auth.admin, tenantId, groupId);

        if (assignmentInsertError.code === "23505") {
          auditLog({
            event: "assignment_conflict",
            level: "warn",
            tenantId,
            userId,
            details: {
              serviceId: body.service_id,
              groupIdCreated: groupId,
              cleanupAttempted: true,
              cleanupSucceeded,
            },
          });
          return NextResponse.json(
            {
              ok: false,
              error: "SERVICE_ALREADY_ASSIGNED",
              message: "Il servizio è già stato assegnato da un altro operatore. Ricarica la pagina.",
            },
            { status: 409 }
          );
        }

        auditLog({
          event: "assignment_insert_failed",
          level: "error",
          tenantId,
          userId,
          details: {
            serviceId: body.service_id,
            groupIdCreated: groupId,
            cleanupAttempted: true,
            cleanupSucceeded,
            dbCode: assignmentInsertError.code ?? null,
          },
        });
        return NextResponse.json(
          { ok: false, error: "ASSIGNMENT_FAILED", message: "Errore durante l'assegnazione. Riprova." },
          { status: 500 }
        );
      }
    }

    await auth.admin.from("services").update({ status: "assigned" }).eq("id", body.service_id).eq("tenant_id", tenantId);

    await auth.admin.from("status_events").upsert({
      tenant_id: tenantId,
      service_id: body.service_id,
      status: "assigned",
      at: now,
      by_user_id: userId,
    }, { onConflict: "tenant_id,service_id,status", ignoreDuplicates: true });

    return NextResponse.json({ ok: true, group_id: groupId });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Errore." },
      { status: 500 }
    );
  }
}

type AssignServiceGeoRow = {
  id: string;
  time: string;
  pickup_hotel: string | null;
  direction: "arrival" | "departure";
  hotel_id: string | null;
  meeting_point: string | null;
};

type AssignHotelGeoRow = {
  id: string;
  zone: string | null;
};

function assignServiceOperationalTime(service: AssignServiceGeoRow): string {
  return service.direction === "departure"
    ? (service.pickup_hotel ?? service.time).slice(0, 5)
    : service.time.slice(0, 5);
}

function assignServiceToGeographicWindow(
  service: AssignServiceGeoRow,
  hotels: Map<string, AssignHotelGeoRow>
): GeographicCompatibilityService {
  const hotelZone = service.hotel_id ? hotels.get(service.hotel_id)?.zone ?? null : null;
  const startTime = assignServiceOperationalTime(service);
  if (service.direction === "departure") {
    return { id: service.id, startTime, startZone: hotelZone, endZone: service.meeting_point };
  }
  return { id: service.id, startTime, startZone: service.meeting_point, endZone: hotelZone };
}

async function validateSingleServiceGeography(
  admin: SupabaseClient,
  tenantId: string,
  driverUserId: string,
  service: AssignServiceGeoRow
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data: otherAssignments, error } = await admin
    .from("assignments")
    .select("group_id, services!inner(id, time, pickup_hotel, direction, hotel_id, meeting_point)")
    .eq("tenant_id", tenantId)
    .eq("driver_user_id", driverUserId)
    .not("group_id", "is", null);

  if (error) {
    return { ok: false, error: `Errore validazione geografica autista: ${error.message}` };
  }

  const otherAssignmentsForGeo = (otherAssignments ?? [])
    .filter((assignment) => ((assignment.services as unknown) as AssignServiceGeoRow).id !== service.id);
  const otherServices = otherAssignmentsForGeo.map((assignment) => (assignment.services as unknown) as AssignServiceGeoRow);
  const hotelIds = [...otherServices, service].map((row) => row.hotel_id).filter((id): id is string => Boolean(id));
  const { data: hotelsData } = hotelIds.length > 0
    ? await admin.from("hotels").select("id, zone").eq("tenant_id", tenantId).in("id", [...new Set(hotelIds)])
    : { data: [] as AssignHotelGeoRow[] };
  const hotelMap = new Map((hotelsData ?? []).map((hotel) => [hotel.id as string, hotel as AssignHotelGeoRow]));
  const otherServicesByGroup = new Map<string, AssignServiceGeoRow[]>();
  for (const assignment of otherAssignmentsForGeo) {
    const groupId = (assignment.group_id as string | null) ?? `service:${((assignment.services as unknown) as AssignServiceGeoRow).id}`;
    otherServicesByGroup.set(groupId, [
      ...(otherServicesByGroup.get(groupId) ?? []),
      (assignment.services as unknown) as AssignServiceGeoRow,
    ]);
  }
  const windows = [
    ...Array.from(otherServicesByGroup.values()).map((groupServices) => assignServicesToTripGeographicWindow(groupServices, hotelMap)),
    assignServicesToTripGeographicWindow([service], hotelMap),
  ]
    .sort((a, b) => assignServiceOperationalMinutes(a.startTime) - assignServiceOperationalMinutes(b.startTime));
  const issues = [];
  for (let i = 1; i < windows.length; i++) {
    issues.push(validateGeographicCompatibility(windows[i - 1]!, windows[i]!));
  }
  const strongest = strongestGeographicResult(issues.filter((issue) => issue.severity !== "ok"));
  if (strongest?.severity === "block") {
    const { data: driver } = await admin
      .from("memberships")
      .select("full_name")
      .eq("tenant_id", tenantId)
      .eq("user_id", driverUserId)
      .maybeSingle();
    return { ok: false, error: geographicBlockMessage((driver?.full_name as string | null) ?? "selezionato", strongest) };
  }
  return { ok: true };
}

function assignServicesToTripGeographicWindow(
  services: AssignServiceGeoRow[],
  hotels: Map<string, AssignHotelGeoRow>
): GeographicCompatibilityService {
  const windows = [...services]
    .sort((a, b) => assignServiceOperationalMinutes(assignServiceOperationalTime(a)) - assignServiceOperationalMinutes(assignServiceOperationalTime(b)))
    .map((service) => assignServiceToGeographicWindow(service, hotels));
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

function assignServiceOperationalMinutes(value: string): number {
  const [h, m] = value.slice(0, 5).split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}
