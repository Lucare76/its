import type { PricingAuthContext } from "@/lib/server/pricing-auth";
import { deriveServiceBusIdentity } from "@/lib/server/bus-network";

export type BusAssignmentFeedbackActionType =
  | "initial_allocation"
  | "move"
  | "cross_line_move"
  | "stop_change"
  | "delete_allocation"
  | "auto_confirmed"
  | "auto_corrected";

export type BusAssignmentFeedbackSource = "manual" | "mario" | "auto_assignment" | "ml_suggestion";

export type BusAssignmentFeedbackInput = {
  tenantId: string;
  serviceId: string;
  actionType: BusAssignmentFeedbackActionType;
  source: BusAssignmentFeedbackSource;
  oldBusUnitId?: string | null;
  newBusUnitId?: string | null;
  oldBusLineId?: string | null;
  newBusLineId?: string | null;
  oldStopId?: string | null;
  newStopId?: string | null;
  oldDirection?: string | null;
  newDirection?: string | null;
  oldDate?: string | null;
  newDate?: string | null;
  pax?: number | null;
  customerName?: string | null;
  hotelName?: string | null;
  derivedFamilyCode?: string | null;
  finalFamilyCode?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
  createdByUserId?: string | null;
};

/**
 * Scrittura best-effort: un fallimento nel logging non deve mai bloccare
 * un'operazione di assegnazione bus già andata a buon fine. Nessun retry,
 * nessuna propagazione dell'errore al chiamante (solo log lato server).
 */
export async function recordBusAssignmentFeedback(
  auth: PricingAuthContext,
  input: BusAssignmentFeedbackInput
): Promise<void> {
  try {
    const { error } = await auth.admin.from("bus_assignment_feedback").insert({
      tenant_id: input.tenantId,
      service_id: input.serviceId,
      action_type: input.actionType,
      source: input.source,
      old_bus_unit_id: input.oldBusUnitId ?? null,
      new_bus_unit_id: input.newBusUnitId ?? null,
      old_bus_line_id: input.oldBusLineId ?? null,
      new_bus_line_id: input.newBusLineId ?? null,
      old_stop_id: input.oldStopId ?? null,
      new_stop_id: input.newStopId ?? null,
      old_direction: input.oldDirection ?? null,
      new_direction: input.newDirection ?? null,
      old_date: input.oldDate ?? null,
      new_date: input.newDate ?? null,
      pax: input.pax ?? null,
      customer_name: input.customerName ?? null,
      hotel_name: input.hotelName ?? null,
      derived_family_code: input.derivedFamilyCode ?? null,
      final_family_code: input.finalFamilyCode ?? null,
      reason: input.reason ?? null,
      metadata: input.metadata ?? null,
      created_by_user_id: input.createdByUserId ?? null,
    });
    if (error) {
      console.error("[bus-assignment-feedback] insert fallito:", error.message);
    }
  } catch (err) {
    // Best-effort per davvero: anche un client/mock che non implementa
    // .insert() (o lancia sincronicamente) non deve mai far fallire
    // un'azione di assegnazione bus già andata a buon fine.
    console.error("[bus-assignment-feedback] insert fallito:", err instanceof Error ? err.message : err);
  }
}

export type ServiceFeedbackContext = {
  pax: number | null;
  direction: string | null;
  date: string | null;
  customerName: string | null;
  hotelName: string | null;
  derivedFamilyCode: string | null;
};

type RawServiceRow = {
  id: string;
  customer_name?: string | null;
  customer_first_name?: string | null;
  customer_last_name?: string | null;
  pax?: number | null;
  direction?: string | null;
  date?: string | null;
  bus_city_origin?: string | null;
  transport_code?: string | null;
  time?: string | null;
  outbound_time?: string | null;
  service_type_code?: string | null;
  booking_service_kind?: string | null;
  booking_group_id?: string | null;
  hotel_id?: string | null;
};

/**
 * Carica in batch (una query services + una hotels, mai una per servizio)
 * il contesto "umano" — cliente, hotel, linea derivata dall'import — da
 * allegare alle righe di bus_assignment_feedback. Evita N+1 sui path bulk
 * (allocate_services_bulk, move_allocations_bulk).
 */
export async function loadServiceFeedbackContexts(
  auth: PricingAuthContext,
  tenantId: string,
  serviceIds: string[]
): Promise<Map<string, ServiceFeedbackContext>> {
  const map = new Map<string, ServiceFeedbackContext>();
  const uniqueIds = [...new Set(serviceIds)];
  if (uniqueIds.length === 0) return map;

  const { data: services } = await auth.admin
    .from("services")
    .select(
      "id,customer_name,customer_first_name,customer_last_name,pax,direction,date,bus_city_origin,transport_code,time,outbound_time,service_type_code,booking_service_kind,booking_group_id,hotel_id"
    )
    .eq("tenant_id", tenantId)
    .in("id", uniqueIds);
  const rows = (services ?? []) as RawServiceRow[];

  const hotelIds = [...new Set(rows.map((r) => r.hotel_id).filter((id): id is string => Boolean(id)))];
  const hotelNameById = new Map<string, string>();
  if (hotelIds.length > 0) {
    const { data: hotels } = await auth.admin
      .from("hotels")
      .select("id,name")
      .eq("tenant_id", tenantId)
      .in("id", hotelIds);
    for (const hotel of (hotels ?? []) as Array<{ id: string; name: string }>) {
      hotelNameById.set(hotel.id, hotel.name);
    }
  }

  for (const row of rows) {
    const identity = deriveServiceBusIdentity(row as Parameters<typeof deriveServiceBusIdentity>[0]);
    const customerName =
      [row.customer_first_name, row.customer_last_name].filter(Boolean).join(" ").trim() ||
      row.customer_name ||
      null;
    map.set(row.id, {
      pax: row.pax ?? null,
      direction: row.direction ?? null,
      date: row.date ?? null,
      customerName,
      hotelName: row.hotel_id ? hotelNameById.get(row.hotel_id) ?? null : null,
      derivedFamilyCode: identity.family_code ?? null,
    });
  }
  return map;
}

/**
 * Family code delle linee bus coinvolte in un'azione (per popolare
 * final_family_code). Batch su piu' lineId per evitare query ripetute nei
 * path bulk.
 */
export async function loadBusLineFamilyCodes(
  auth: PricingAuthContext,
  tenantId: string,
  lineIds: Array<string | null | undefined>
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const uniqueIds = [...new Set(lineIds.filter((id): id is string => Boolean(id)))];
  if (uniqueIds.length === 0) return map;

  const { data: lines } = await auth.admin
    .from("tenant_bus_lines")
    .select("id,family_code")
    .eq("tenant_id", tenantId)
    .in("id", uniqueIds);
  for (const line of (lines ?? []) as Array<{ id: string; family_code: string }>) {
    map.set(line.id, line.family_code);
  }
  return map;
}
