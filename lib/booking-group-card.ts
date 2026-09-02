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
  // Obiettivo D (prompt "ALLINEARE TUTTE LE VISTE"): pax REALI del gruppo —
  // mai derivato sommando andata+ritorno lato services (root cause del bug
  // "58 pax" quando expected_pax = 38).
  expected_pax: number | null;
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

// Obiettivo F (prompt "ALLINEARE TUTTE LE VISTE"): "00:00"/"00:00:00" e' il
// placeholder scritto alla creazione dei service di gruppo (vedi
// BOOKING_GROUP_PLACEHOLDER_TIME in lib/booking-groups.ts), MAI un orario
// reale confermato — non va mai mostrato come se lo fosse.
export function isPlaceholderStopTime(value?: string | null): boolean {
  const time = value?.trim() ?? "";
  return !time || time === "00:00" || time === "00:00:00";
}

export function formatStopLine(r: GroupableRow): string {
  const city = r.bus_city_origin?.trim();
  const pickup = r.meeting_point?.trim();
  const place = city && pickup && pickup.toUpperCase() !== city.toUpperCase() ? `${city} - ${pickup}` : city || pickup || "Fermata da definire";
  const time = r.time?.trim();
  return `${place} — ${r.pax} pax${time && !isPlaceholderStopTime(time) ? ` — ${time.slice(0, 5)}` : ""}`;
}

export type GroupReturnStatus = {
  arrivalPax: number;
  departurePax: number;
  /** true se return_date e' valorizzata ma NESSUNA fermata/service di ritorno esiste ancora. */
  missing: boolean;
  /** true se return_date e' valorizzata e il ritorno esiste ma e' incompleto (anche parziale,
   *  es. manca solo MAROTTA) — usato per decidere quando riproporre "completa ritorno",
   *  MAI solo quando departurePax === 0 (root cause del bug "MAROTTA resta mancante": il
   *  vecchio gate nascondeva la CTA appena UNA fermata di ritorno esisteva). */
  incomplete: boolean;
};

// Obiettivo B (prompt "FIX MIRATO — GIACOMONI"): stato del ritorno per la
// card gruppo. Confronta i pax REALI di andata/ritorno (mai il conteggio
// fermate, che puo' essere fuorviante se una fermata ha pax parziali) — mai
// una fermata "finta" inventata, solo un confronto sui dati esistenti.
export function resolveGroupReturnStatus(
  meta: Pick<BookingGroupMeta, "return_date"> | undefined,
  arrivalPax: number[],
  departurePax: number[],
): GroupReturnStatus {
  const arrival = arrivalPax.reduce((sum, v) => sum + (Number.isFinite(v) ? v : 0), 0);
  const departure = departurePax.reduce((sum, v) => sum + (Number.isFinite(v) ? v : 0), 0);
  const hasReturn = Boolean(meta?.return_date);
  return {
    arrivalPax: arrival,
    departurePax: departure,
    missing: hasReturn && departure === 0,
    incomplete: hasReturn && arrival > 0 && departure < arrival,
  };
}

// Obiettivo D: pax REALE del gruppo — mai la somma andata+ritorno. Priorita':
// expected_pax del gruppo (fonte di verita' commerciale); se assente, il
// massimo tra andata e ritorno (mai la somma, che duplica le stesse persone).
export function resolveGroupTotalPax(
  meta: Pick<BookingGroupMeta, "expected_pax"> | undefined,
  arrivalPax: number[],
  departurePax: number[],
): number {
  if (meta?.expected_pax != null) return meta.expected_pax;
  const arrival = arrivalPax.reduce((sum, v) => sum + (Number.isFinite(v) ? v : 0), 0);
  const departure = departurePax.reduce((sum, v) => sum + (Number.isFinite(v) ? v : 0), 0);
  return Math.max(arrival, departure);
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
