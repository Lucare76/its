"use client";

import Link from "next/link";
import {
  formatGroupContact,
  formatStopLine,
  resolveGroupTotalPax,
  GROUP_KIND_LABEL,
  type BookingGroupMeta,
  type GroupableRow,
} from "@/lib/booking-group-card";

// Obiettivo A (prompt "ALLINEARE TUTTE LE VISTE"): riga aggregata unica per
// un booking_group.kind = 'bus_exclusive' in /arrivals e /departures — stessa
// fonte di verita' (booking_groups.name/contact_name/contact_phone/
// expected_pax/hotel) gia' usata da /inbox e /ricerca (lib/booking-group-card.ts),
// mai una seconda logica di aggregazione. Ogni pagina resta responsabile di
// COSA passa qui dentro (le sole istanze bus_exclusive del giorno/direzione
// corrente); questo componente si limita a renderizzarle come un'unica card.
export function BookingGroupSummaryCard({
  meta,
  stops,
  direction,
}: {
  meta: BookingGroupMeta | undefined;
  stops: (GroupableRow & { id: string })[];
  direction: "arrival" | "departure";
}) {
  const groupName = meta?.name ?? "Gruppo";
  const kindLabel = meta?.kind ? GROUP_KIND_LABEL[meta.kind] ?? meta.kind : null;
  const contact = formatGroupContact(meta);
  const totalPax = direction === "arrival"
    ? resolveGroupTotalPax(meta, stops.map((s) => s.pax), [])
    : resolveGroupTotalPax(meta, [], stops.map((s) => s.pax));
  const sortedStops = [...stops].sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""));

  return (
    <div className="mb-3 rounded-2xl border border-indigo-200 bg-indigo-50/40 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-extrabold text-slate-900">{groupName}</span>
        <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[11px] font-bold text-indigo-700">{totalPax} pax</span>
        {kindLabel && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-700">🚌 {kindLabel}</span>}
        {meta?.id && (
          <Link href={`/booking-groups?id=${meta.id}`} className="ml-auto text-[11px] font-semibold text-indigo-700 hover:underline">
            Apri gruppo →
          </Link>
        )}
      </div>
      {meta?.hotel_name && <p className="mt-1 text-xs font-semibold text-slate-700">Hotel: {meta.hotel_name}</p>}
      <p className="mt-1 text-xs text-slate-600">
        {contact.hasContact
          ? [contact.name ? `Capogruppo: ${contact.name}` : null, contact.phone ? `Cellulare: ${contact.phone}` : null].filter(Boolean).join("　·　")
          : <span className="text-slate-400">Contatto non indicato</span>}
      </p>
      <div className="mt-2 text-xs text-slate-600">
        <p className="font-semibold text-slate-500">Dettaglio fermate {direction === "arrival" ? "andata" : "ritorno"}:</p>
        {sortedStops.length > 0 ? (
          <ul className="mt-0.5 space-y-0.5">
            {sortedStops.map((s) => <li key={s.id}>{formatStopLine(s)}</li>)}
          </ul>
        ) : <p className="text-slate-400">Da completare</p>}
      </div>
    </div>
  );
}
