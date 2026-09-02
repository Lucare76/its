"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { getClientSessionContext } from "@/lib/supabase/client-session";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";
import { GROUP_KIND_LABEL, formatGroupContact, formatStopLine, groupSearchResults, type BookingGroupMeta } from "@/lib/booking-group-card";

type SearchResult = {
  id: string;
  customer_name: string;
  phone: string | null;
  date: string;
  time?: string | null;
  status: string;
  direction: string;
  pax: number;
  vessel: string | null;
  booking_service_kind: string | null;
  arrival_date: string | null;
  departure_date: string | null;
  transport_code: string | null;
  hotel_name: string | null;
  bus_city_origin?: string | null;
  meeting_point: string | null;
  notes: string | null;
  booking_group_id?: string | null;
  booking_group_name: string | null;
  // Obiettivo A/E (card gruppo unica): true se questa riga ha davvero
  // combaciato con la query; false se è stata aggiunta solo per completare
  // la card del gruppo (vedi "fratelli" in app/api/ops/search/route.ts).
  matched_query?: boolean;
};


const STATUS_LABEL: Record<string, string> = {
  new: "Nuovo", assigned: "Assegnato", partito: "Partito",
  arrivato: "Arrivato", completato: "Completato",
  problema: "Problema", cancelled: "Cancellato",
};
const STATUS_COLOR: Record<string, string> = {
  new: "bg-slate-100 text-slate-600 border-slate-200",
  assigned: "bg-blue-50 text-blue-700 border-blue-200",
  partito: "bg-amber-50 text-amber-700 border-amber-200",
  arrivato: "bg-teal-50 text-teal-700 border-teal-200",
  completato: "bg-emerald-50 text-emerald-700 border-emerald-200",
  problema: "bg-rose-50 text-rose-700 border-rose-200",
  cancelled: "bg-slate-50 text-slate-400 border-slate-200",
};
const KIND_LABEL: Record<string, string> = {
  formula_snav: "Formula SNAV",
  formula_medmar_napoli: "Formula MEDMAR Napoli",
  formula_medmar_pozzuoli: "Formula MEDMAR Pozzuoli",
  transfer_airport_hotel: "Transfer aeroporto",
  transfer_airport_hotel_exclusive: "Transfer aeroporto (esclusivo)",
  transfer_train_hotel: "Transfer stazione",
  transfer_train_hotel_exclusive: "Transfer stazione (esclusivo)",
  bus_city_hotel: "Linea bus",
  excursion: "Escursione",
  transfer_port_hotel: "Transfer porto",
};

function fmtDate(d: string | null) {
  if (!d) return "—";
  return new Date(`${d}T00:00:00`).toLocaleDateString("it-IT", { day: "2-digit", month: "short", year: "numeric" });
}

function BookingGroupCard({
  meta, services, expanded, onToggle, onGenerateReturn,
}: {
  meta: BookingGroupMeta | undefined;
  services: SearchResult[];
  expanded: boolean;
  onToggle: () => void;
  onGenerateReturn: () => void;
}) {
  const groupName = meta?.name ?? services[0]?.booking_group_name ?? "Gruppo";
  const totalPax = services.reduce((sum, s) => sum + (s.pax || 0), 0);
  const kindLabel = meta?.kind ? GROUP_KIND_LABEL[meta.kind] ?? meta.kind : null;
  const arrivalStops = services
    .filter((s) => s.direction === "arrival")
    .sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""));
  const departureStops = services
    .filter((s) => s.direction === "departure")
    .sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""));
  // Obiettivo C: mai inventare fermate di ritorno — se return_date c'è ma
  // nessun service departure esiste ancora, si mostra solo un warning.
  const returnMissing = Boolean(meta?.return_date) && departureStops.length === 0;
  const anyMatchedStop = services.some((s) => s.matched_query);

  return (
    <div className="card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-slate-900 text-sm">{groupName}</span>
            <span className="inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold bg-indigo-50 text-indigo-700 border-indigo-200">
              {totalPax} pax
            </span>
            {kindLabel && (
              <span className="inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold bg-slate-100 text-slate-600 border-slate-200">
                {kindLabel}
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-slate-600">
            {meta?.hotel_name && <span>Hotel: {meta.hotel_name}</span>}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-slate-600">
            {(() => {
              const contact = formatGroupContact(meta);
              return contact.hasContact ? (
                <>
                  {contact.name && <span>Capogruppo: {contact.name}</span>}
                  {contact.phone && <span>Cellulare: {contact.phone}</span>}
                </>
              ) : (
                <span className="text-slate-400">Contatto non indicato</span>
              );
            })()}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-slate-500">
            {meta?.service_date && <span>Arrivo: {fmtDate(meta.service_date)}</span>}
            {meta?.return_date && <span>Ritorno: {fmtDate(meta.return_date)}</span>}
          </div>

          <div className="mt-2 text-xs text-slate-600">
            <p className="font-semibold text-slate-500">Fermate andata:</p>
            {arrivalStops.length > 0 ? (
              <ul className="mt-0.5 space-y-0.5">
                {arrivalStops.map((s) => (
                  <li
                    key={s.id}
                    className={s.matched_query && anyMatchedStop ? "rounded bg-amber-50 px-1 -mx-1 font-medium text-amber-800" : undefined}
                  >
                    {formatStopLine(s)}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-slate-400">Da completare</p>
            )}
          </div>

          <div className="mt-2 text-xs text-slate-600">
            <p className="font-semibold text-slate-500">Fermate ritorno:</p>
            {departureStops.length > 0 ? (
              <ul className="mt-0.5 space-y-0.5">
                {departureStops.map((s) => (
                  <li
                    key={s.id}
                    className={s.matched_query && anyMatchedStop ? "rounded bg-amber-50 px-1 -mx-1 font-medium text-amber-800" : undefined}
                  >
                    {formatStopLine(s)}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-slate-400">Da completare</p>
            )}
            {returnMissing && (
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <p className="text-amber-700">
                  Ritorno previsto il {fmtDate(meta!.return_date)}, fermate ritorno non ancora inserite
                </p>
                {meta?.kind === "bus_exclusive" && (
                  <button type="button" onClick={onGenerateReturn} className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-800 hover:bg-amber-100">
                    Genera ritorno da andata
                  </button>
                )}
              </div>
            )}
          </div>

          {expanded && (
            <div className="mt-3 border-t border-slate-100 pt-3 text-xs text-slate-600 space-y-2">
              {meta?.notes && (
                <p><span className="font-semibold text-slate-500">Note gruppo: </span>{meta.notes}</p>
              )}
              <div>
                <p className="font-semibold text-slate-500">Services collegati ({services.length}):</p>
                <ul className="mt-0.5 space-y-0.5">
                  {services.map((s) => (
                    <li key={s.id}>
                      {s.customer_name} — {s.pax} pax — {s.direction === "arrival" ? "andata" : "ritorno"} —{" "}
                      <span className={`inline-flex rounded-full border px-1.5 py-0 text-[10px] font-semibold ${STATUS_COLOR[s.status] ?? "bg-slate-100 text-slate-500 border-slate-200"}`}>
                        {STATUS_LABEL[s.status] ?? s.status}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          <button
            type="button"
            onClick={onToggle}
            className="mt-2 text-xs font-semibold text-blue-700 hover:underline"
          >
            {expanded ? "Nascondi dettagli" : "Dettagli"}
          </button>
        </div>
      </div>
    </div>
  );
}

function RicercaInner() {
  const searchParams = useSearchParams();
  const [query, setQuery] = useState(() => searchParams.get("q") ?? "");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [bookingGroups, setBookingGroups] = useState<BookingGroupMeta[]>([]);
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null);
  // Obiettivo B: forza un refresh della ricerca corrente dopo un'azione di
  // gruppo (es. "Genera ritorno da andata").
  const [searchRefreshKey, setSearchRefreshKey] = useState(0);
  const [loading, setLoading] = useState(false);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [initError, setInitError] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let active = true;
    const boot = async () => {
      const session = await getClientSessionContext();
      if (!active) return;
      if (session.mode === "demo" || !hasSupabaseEnv || !supabase) {
        setInitError("Disponibile solo con Supabase reale.");
        return;
      }
      if (session.role !== "admin" && session.role !== "operator") {
        setInitError("Ruolo non autorizzato.");
        return;
      }
      const { data } = await supabase.auth.getSession();
      setAccessToken(data.session?.access_token ?? null);
    };
    void boot();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query.trim().length < 2) { setResults([]); setBookingGroups([]); return; }
    if (!accessToken) return;

    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/ops/search?q=${encodeURIComponent(query.trim())}&limit=40`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        const body = (await res.json().catch(() => null)) as { ok?: boolean; results?: SearchResult[]; booking_groups?: BookingGroupMeta[] } | null;
        if (body?.ok) {
          setResults(body.results ?? []);
          setBookingGroups(body.booking_groups ?? []);
        }
      } finally {
        setLoading(false);
      }
    }, 280);
  }, [query, accessToken, searchRefreshKey]);

  // Obiettivo B: azione esplicita, mai automatica — genera le fermate/
  // services di ritorno rispecchiando l'andata in ordine invertito, poi
  // aggiorna la ricerca corrente per mostrarli subito.
  const handleGenerateReturnStops = async (bookingGroupId: string) => {
    if (!accessToken) return;
    await fetch("/api/ops/booking-groups", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ action: "generate_return_stops_from_arrival", booking_group_id: bookingGroupId }),
    });
    setSearchRefreshKey((k) => k + 1);
  };

  const bookingGroupById = useMemo(() => new Map(bookingGroups.map((g) => [g.id, g])), [bookingGroups]);
  const renderItems = useMemo(() => groupSearchResults(results), [results]);

  if (initError) return <div className="card p-4 text-sm text-slate-500">{initError}</div>;

  return (
    <section className="mx-auto max-w-4xl page-section">
      <div className="section-head">
        <h1 className="section-title">Ricerca prenotazioni</h1>
        <p className="section-subtitle">Cerca per nome, cognome o numero di telefono.</p>
      </div>

      {/* Search input */}
      <div className="card p-4 mb-4">
        <div className="relative">
          <svg className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            autoFocus
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Cerca nome, cognome o telefono..."
            className="input-saas w-full pl-9 pr-4 py-2.5 text-base"
          />
          {loading && (
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400">Ricerca...</span>
          )}
        </div>
        {query.trim().length > 0 && query.trim().length < 2 && (
          <p className="mt-2 text-xs text-slate-400">Inserisci almeno 2 caratteri.</p>
        )}
      </div>

      {/* Results */}
      {renderItems.length > 0 ? (
        <div className="space-y-2">
          <p className="text-xs text-slate-500 px-1">{renderItems.length} risultat{renderItems.length === 1 ? "o" : "i"}</p>
          {renderItems.map((item) => {
            if (item.type === "group") {
              return (
                <BookingGroupCard
                  key={item.groupId}
                  meta={bookingGroupById.get(item.groupId)}
                  services={item.services}
                  expanded={expandedGroupId === item.groupId}
                  onToggle={() => setExpandedGroupId((current) => (current === item.groupId ? null : item.groupId))}
                  onGenerateReturn={() => void handleGenerateReturnStops(item.groupId)}
                />
              );
            }
            const r = item.result;
            return (
              <Link
                key={r.id}
                href={`/scan/${r.id}`}
                className="card block p-4 hover:bg-slate-50 transition-colors"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-slate-900 text-sm">{r.customer_name}</span>
                      {r.phone && (
                        <span className="text-xs text-slate-500">{r.phone}</span>
                      )}
                      <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold ${STATUS_COLOR[r.status] ?? "bg-slate-100 text-slate-500 border-slate-200"}`}>
                        {STATUS_LABEL[r.status] ?? r.status}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-slate-600">
                      {r.booking_service_kind && (
                        <span>{KIND_LABEL[r.booking_service_kind] ?? r.booking_service_kind}</span>
                      )}
                      <span>{r.pax} pax</span>
                      {r.hotel_name && <span>· {r.hotel_name}</span>}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-slate-500">
                      {r.arrival_date && <span>Arrivo: {fmtDate(r.arrival_date)}</span>}
                      {r.departure_date && <span>Partenza: {fmtDate(r.departure_date)}</span>}
                      {!r.arrival_date && !r.departure_date && <span>{fmtDate(r.date)}</span>}
                      {r.vessel && <span>· {r.vessel}</span>}
                      {r.transport_code && <span>· {r.transport_code}</span>}
                    </div>
                    {r.notes && (
                      <p className="mt-1 text-xs text-slate-400 line-clamp-1">{r.notes}</p>
                    )}
                  </div>
                  <svg className="shrink-0 h-4 w-4 text-slate-400 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </div>
              </Link>
            );
          })}
        </div>
      ) : query.trim().length >= 2 && !loading ? (
        <div className="card p-8 text-center">
          <p className="text-sm text-slate-500">Nessun risultato per <strong>{query}</strong></p>
          <p className="mt-1 text-xs text-slate-400">Prova con nome, cognome o numero di telefono completo.</p>
        </div>
      ) : null}
    </section>
  );
}

export default function RicercaPage() {
  return (
    <Suspense>
      <RicercaInner />
    </Suspense>
  );
}
