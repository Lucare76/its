// Obiettivo A (card gruppo unica): logica di raggruppamento condivisa tra
// /ricerca e /inbox (la vera pagina "Prenotazioni", vedi lib/app-shell-nav.tsx)
// così le due viste non divergono. Nessuna logica specifica di una pagina
// qui dentro — solo dati già restituiti da app/api/ops/search/route.ts.

export type BookingGroupMeta = {
  id: string;
  name: string;
  kind: string | null;
  service_date: string | null;
  return_date: string | null;
  hotel_id: string | null;
  hotel_name: string | null;
  notes: string | null;
  // Obiettivo A: contatto capogruppo — mai un parsing di note, solo campi
  // strutturati già esistenti su booking_groups.
  contact_name: string | null;
  contact_phone: string | null;
};

export const GROUP_KIND_LABEL: Record<string, string> = {
  bus_exclusive: "Bus esclusivo",
  bus_group: "Gruppo bus",
};

export type GroupableRow = {
  id: string;
  pax: number;
  direction?: string | null;
  time?: string | null;
  bus_city_origin?: string | null;
  meeting_point?: string | null;
  booking_group_id?: string | null;
  booking_group_name?: string | null;
};

// Obiettivo A: contatto capogruppo. Regola fallback esplicita — mai un
// parsing di note come telefono strutturato:
// 1. contact_name/contact_phone (già su booking_groups);
// 2. "Contatto non indicato" se nessuno dei due è presente.
export function formatGroupContact(meta: Pick<BookingGroupMeta, "contact_name" | "contact_phone"> | undefined): { name: string | null; phone: string | null; hasContact: boolean } {
  const name = meta?.contact_name?.trim() || null;
  const phone = meta?.contact_phone?.trim() || null;
  return { name, phone, hasContact: Boolean(name || phone) };
}

export function formatStopLine(r: GroupableRow): string {
  const city = r.bus_city_origin?.trim();
  const pickup = r.meeting_point?.trim();
  const place = city && pickup && pickup.toUpperCase() !== city.toUpperCase() ? `${city} - ${pickup}` : city || pickup || "Fermata da definire";
  const time = r.time?.trim();
  return `${place} — ${r.pax} pax${time ? ` — ${time.slice(0, 5)}` : ""}`;
}

export type GroupRenderItem<T extends GroupableRow> =
  | { type: "individual"; result: T }
  | { type: "group"; groupId: string; services: T[] };

// Una sola card per booking_group_id, mai una per service — i services
// senza booking_group_id restano individuali (Obiettivo F, invariati).
export function groupSearchResults<T extends GroupableRow>(results: T[]): GroupRenderItem<T>[] {
  const servicesByGroup = new Map<string, T[]>();
  for (const r of results) {
    if (!r.booking_group_id) continue;
    const list = servicesByGroup.get(r.booking_group_id) ?? [];
    list.push(r);
    servicesByGroup.set(r.booking_group_id, list);
  }
  const items: GroupRenderItem<T>[] = [];
  const seenGroups = new Set<string>();
  for (const r of results) {
    if (r.booking_group_id) {
      if (seenGroups.has(r.booking_group_id)) continue;
      seenGroups.add(r.booking_group_id);
      items.push({ type: "group", groupId: r.booking_group_id, services: servicesByGroup.get(r.booking_group_id) ?? [] });
    } else {
      items.push({ type: "individual", result: r });
    }
  }
  return items;
}
