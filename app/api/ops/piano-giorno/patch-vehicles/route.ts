/**
 * POST /api/ops/piano-giorno/patch-vehicles
 * Aggiorna vehicle_label/vehicle_capacity sui giri esistenti senza mezzo,
 * leggendo il mezzo dichiarato in driver_daily_availability per la data.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { extractFeatures, logAssignmentChange, type AssignmentHistoryEntry } from "@/lib/server/assignment-history";
import { updateLearnedPatterns } from "@/lib/server/learned-patterns";
import { effectiveServiceDisembarkTime, type FerryArrivalServiceLike } from "@/lib/piano-arrival-time";

export const runtime = "nodejs";

const schema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

type FeatureServiceRow = FerryArrivalServiceLike & {
  id: string;
  hotel_id: string | null;
  direction: string | null;
  meeting_point: string | null;
  pax: number | null;
};

function patchVehiclesOperationalTime(service: FeatureServiceRow): string | null {
  const raw = service.direction === "departure"
    ? (service.time ?? "")
    : effectiveServiceDisembarkTime(service) ?? (service.time ?? "");
  const trimmed = raw.slice(0, 5);
  return trimmed.length > 0 ? trimmed : null;
}

function isNavettaFeatureRow(service: Pick<FeatureServiceRow, "booking_service_kind" | "service_type_code">): boolean {
  const kind = service.booking_service_kind ?? service.service_type_code ?? "";
  return kind === "navetta" || kind === "shuttle_hotel" || kind === "bus_city_hotel";
}

export async function POST(req: NextRequest) {
  try {
    const auth = await authorizePricingRequest(req, ["admin", "operator", "supervisor"]);
    if (auth instanceof NextResponse) return auth;
    const tenantId = auth.membership.tenant_id;
    const userId = auth.user.id;

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

    // CONC-07: snapshot "prima" degli assignments dei giri candidati,
    // tenant-scoped, letto in un'unica query batch subito prima della
    // mutazione — stesso pattern già validato in swap_vehicle/executeMovePax.
    // Se la lettura fallisce (errore Supabase o eccezione sincrona),
    // previousSnapshotFailed viene marcato e la costruzione dello storico più
    // sotto viene saltata per l'intera richiesta (mai previous values
    // indovinati/falsi) — ma il patch principale prosegue comunque: policy
    // best-effort già stabilita altrove.
    const allGroupIds = groupsWithoutVehicle.map((g) => g.id as string);
    const previousAssignmentsByGroupId = new Map<string, { service_id: string; vehicle_label: string | null }[]>();
    let previousSnapshotFailed = false;
    try {
      const { data: previousAssignmentsData, error: previousAssignmentsError } = await auth.admin
        .from("assignments")
        .select("service_id, group_id, vehicle_label")
        .eq("tenant_id", tenantId)
        .in("group_id", allGroupIds);
      if (previousAssignmentsError) {
        previousSnapshotFailed = true;
      } else {
        for (const row of previousAssignmentsData ?? []) {
          const groupId = row.group_id as string | null;
          if (!groupId) continue;
          const list = previousAssignmentsByGroupId.get(groupId) ?? [];
          list.push({ service_id: row.service_id as string, vehicle_label: ((row.vehicle_label as string | null) ?? null) || null });
          previousAssignmentsByGroupId.set(groupId, list);
        }
      }
    } catch {
      previousSnapshotFailed = true;
    }

    // 5. Aggiorna trip_groups e assignments
    const now = new Date().toISOString();
    let updated = 0;
    const historyCandidates: { serviceId: string; groupId: string; fromVehicleLabel: string | null; toVehicleLabel: string }[] = [];

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

      // CONC-07: storico solo per le righe assignments realmente coinvolte in
      // questo giro (dallo snapshot "prima") il cui vehicle_label cambia
      // davvero — nessun evento per righe già sul mezzo target (no-op).
      if (!previousSnapshotFailed) {
        const previousRows = previousAssignmentsByGroupId.get(groupId) ?? [];
        for (const row of previousRows) {
          if (row.vehicle_label === (vehicle.label || null)) continue;
          historyCandidates.push({
            serviceId: row.service_id,
            groupId,
            fromVehicleLabel: row.vehicle_label,
            toVehicleLabel: vehicle.label,
          });
        }
      }
    }

    // CONC-07: registra lo storico strutturato per tutte le righe realmente
    // mutate, riusando esattamente il contratto già in uso in
    // move_services/swap_vehicle/executeMovePax: changeType "vehicle_binding"
    // (patch-vehicles non tocca mai il driver, quindi mai "driver_swap"),
    // un entry al massimo per service_id (historyCandidates è costruito da
    // previousAssignmentsByGroupId, una entry per row di assignments).
    // Features arricchite con un'unica query batch su services/hotels (nessun
    // N+1). Scrittura fire-and-forget dopo il successo del ciclo di
    // mutazioni sopra: un errore qui non altera né la risposta né il
    // risultato principale già determinato.
    if (historyCandidates.length > 0) {
      try {
        const serviceIds = Array.from(new Set(historyCandidates.map((c) => c.serviceId)));
        const { data: featureServices } = await auth.admin
          .from("services")
          .select("id, hotel_id, direction, meeting_point, time, arrival_time, orario_barca, porto_bruno, barca_compagnia, booking_service_kind, service_type_code, vessel, ferry_details, pax")
          .eq("tenant_id", tenantId)
          .in("id", serviceIds);
        const featureServiceRows = (featureServices ?? []) as FeatureServiceRow[];
        const featureServiceMap = new Map(featureServiceRows.map((service) => [service.id, service]));

        const featureHotelIds = Array.from(
          new Set(featureServiceRows.map((service) => service.hotel_id).filter((id): id is string => Boolean(id)))
        );
        const { data: featureHotels } = featureHotelIds.length > 0
          ? await auth.admin.from("hotels").select("id, zone").eq("tenant_id", tenantId).in("id", featureHotelIds)
          : { data: [] };
        const featureHotelMap = new Map((featureHotels ?? []).map((hotel) => [hotel.id as string, hotel as { id: string; zone: string | null }]));

        const historyEntries: AssignmentHistoryEntry[] = historyCandidates.map((candidate) => {
          const service = featureServiceMap.get(candidate.serviceId);
          const hotel = service?.hotel_id ? featureHotelMap.get(service.hotel_id) : null;
          const features = extractFeatures({
            serviceDate: date,
            changeType: "vehicle_binding",
            fromVehicleLabel: candidate.fromVehicleLabel,
            toVehicleLabel: candidate.toVehicleLabel,
            direction: service?.direction ?? null,
            zone: hotel?.zone ?? service?.meeting_point ?? null,
            time: service ? patchVehiclesOperationalTime(service) : null,
            vessel: service?.vessel ?? service?.barca_compagnia ?? null,
            pax: service?.pax ?? null,
            isNavetta: service ? isNavettaFeatureRow(service) : false,
          });
          return {
            tenantId,
            serviceDate: date,
            serviceId: candidate.serviceId,
            groupId: candidate.groupId,
            changeType: "vehicle_binding" as const,
            fromVehicleLabel: candidate.fromVehicleLabel,
            toVehicleLabel: candidate.toVehicleLabel,
            features,
            operatorId: userId,
          };
        });

        if (historyEntries.length > 0) {
          void logAssignmentChange(auth.admin, historyEntries)
            .then(() => updateLearnedPatterns(auth.admin, tenantId))
            .catch(() => undefined);
        }
      } catch {
        // best-effort: mai bloccare né alterare la risposta principale già determinata.
      }
    }

    return NextResponse.json({ ok: true, updated, total: groupsWithoutVehicle.length });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Errore" }, { status: 500 });
  }
}
