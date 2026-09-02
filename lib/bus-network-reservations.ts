export type BusNetworkReservation = {
  id: string;
  booking_group_id: string;
  bus_unit_id: string;
  service_date: string;
  exclusive: boolean | null;
  booking_group_name: string | null;
  booking_group_kind: string | null;
};

export type BusNetworkReservationConflict = {
  serviceDate: string;
  normalizedGroupName: string;
  reservationIds: string[];
  bookingGroupIds: string[];
  busUnitIds: string[];
  groupNames: string[];
};

export function normalizeBusReservationGroupName(value: string | null | undefined): string {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\bgruppo\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function summarizeBusReservationConflicts(
  reservations: BusNetworkReservation[],
  serviceDate: string,
): BusNetworkReservationConflict[] {
  const byName = new Map<string, BusNetworkReservation[]>();
  for (const reservation of reservations) {
    if (reservation.service_date !== serviceDate) continue;
    if (!reservation.exclusive) continue;
    if (reservation.booking_group_kind !== "bus_exclusive") continue;
    const normalized = normalizeBusReservationGroupName(reservation.booking_group_name);
    if (!normalized) continue;
    const list = byName.get(normalized) ?? [];
    list.push(reservation);
    byName.set(normalized, list);
  }

  const conflicts: BusNetworkReservationConflict[] = [];
  for (const [normalizedGroupName, list] of byName) {
    const bookingGroupIds = Array.from(new Set(list.map((r) => r.booking_group_id)));
    const busUnitIds = Array.from(new Set(list.map((r) => r.bus_unit_id)));
    if (bookingGroupIds.length <= 1 && busUnitIds.length <= 1) continue;
    conflicts.push({
      serviceDate,
      normalizedGroupName,
      reservationIds: list.map((r) => r.id),
      bookingGroupIds,
      busUnitIds,
      groupNames: Array.from(new Set(list.map((r) => r.booking_group_name?.trim()).filter((v): v is string => Boolean(v)))),
    });
  }
  return conflicts;
}
