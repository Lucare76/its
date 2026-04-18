"use client";

import { useEffect, useState } from "react";
import { EmptyState, PageHeader, SectionCard } from "@/components/ui";
import { formatIsoDateShort, formatIsoDateTimeShort } from "@/lib/service-display";
import { getClientSessionContext } from "@/lib/supabase/client-session";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";

type ServiceSnap = {
  id: string;
  customer_name: string;
  pax: number;
  booking_service_kind: string | null;
  arrival_date: string | null;
  arrival_time: string | null;
  departure_date: string | null;
  departure_time: string | null;
  hotels: { id: string; name: string } | { id: string; name: string }[] | null;
  agencies: { name: string } | { name: string }[] | null;
};

type ModRequest = {
  id: string;
  status: "pending" | "approved" | "rejected";
  changes: Record<string, unknown>;
  original_values: Record<string, unknown>;
  operator_notes: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  requested_by_name: string | null;
  services: ServiceSnap | null;
};

const fieldLabels: Record<string, string> = {
  arrival_date:         "Data andata",
  arrival_time:         "Ora andata",
  departure_date:       "Data ritorno",
  departure_time:       "Ora ritorno",
  pax:                  "Passeggeri",
  hotel_id:             "Hotel",
  booking_service_kind: "Tipologia servizio",
  phone:                "Telefono cliente",
  notes:                "Note",
};

const serviceKindLabels: Record<string, string> = {
  transfer_port_hotel:               "Porto - Hotel",
  transfer_airport_hotel:            "Aeroporto - Hotel",
  transfer_airport_hotel_exclusive:  "Aeroporto - Hotel (esclusivo)",
  transfer_airport_hotel_aliscafo:   "Aeroporto - Hotel (aliscafo)",
  transfer_train_hotel:              "Stazione - Hotel",
  transfer_train_hotel_exclusive:    "Stazione - Hotel (esclusivo)",
  transfer_train_hotel_aliscafo:     "Stazione - Hotel (aliscafo)",
  bus_city_hotel:                    "Bus città - Hotel",
  excursion:                         "Escursione",
  formula_snav:                      "Formula SNAV",
  formula_medmar_napoli:             "Formula MEDMAR Napoli",
  formula_medmar_pozzuoli:           "Formula MEDMAR Pozzuoli",
};

function fmt(d: unknown) {
  if (typeof d !== "string" || !d) return "—";
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return formatIsoDateShort(d);
  if (/^\d{2}:\d{2}/.test(d)) return d.slice(0, 5);
  return d;
}

function StatusBadge({ status }: { status: string }) {
  if (status === "pending")  return <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-[11px] font-semibold text-amber-800">In attesa</span>;
  if (status === "approved") return <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-800">Approvata</span>;
  if (status === "rejected") return <span className="rounded-full bg-rose-100 px-2.5 py-0.5 text-[11px] font-semibold text-rose-800">Rifiutata</span>;
  return null;
}

export default function RichiesteModificaPage() {
  const [loading, setLoading]         = useState(true);
  const [requests, setRequests]       = useState<ModRequest[]>([]);
  const [selected, setSelected]       = useState<ModRequest | null>(null);
  const [filter, setFilter]           = useState<"pending" | "all">("pending");
  const [search, setSearch]           = useState("");
  const [resolving, setResolving]     = useState(false);
  const [rejectNote, setRejectNote]   = useState("");
  const [approveNote, setApproveNote] = useState("");
  const [showReject, setShowReject]   = useState(false);
  const [actionMsg, setActionMsg]     = useState("");
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [message, setMessage]         = useState("");

  // Hotel names cache
  const [hotelNames, setHotelNames] = useState<Record<string, string>>({});

  useEffect(() => {
    let active = true;

    const load = async () => {
      const session = await getClientSessionContext();
      if (!active) return;

      if (session.mode === "demo" || !hasSupabaseEnv || !supabase) {
        setMessage("Disponibile solo con Supabase reale.");
        setLoading(false);
        return;
      }
      if (session.role !== "admin" && session.role !== "operator") {
        setMessage("Ruolo non autorizzato.");
        setLoading(false);
        return;
      }

      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) { setMessage("Sessione non valida."); setLoading(false); return; }
      setAccessToken(token);

      const res  = await fetch("/api/ops/modification-requests", { headers: { Authorization: `Bearer ${token}` } });
      const body = await res.json().catch(() => null) as { ok?: boolean; requests?: ModRequest[]; error?: string } | null;
      if (!active) return;

      if (!res.ok) { setMessage(body?.error ?? "Errore caricamento."); setLoading(false); return; }

      const rows = body?.requests ?? [];
      setRequests(rows);

      // Carica nomi hotel per le richieste con hotel_id nei changes
      const hotelIds = [...new Set(
        rows
          .flatMap((r) => Object.entries(r.changes).filter(([k]) => k === "hotel_id").map(([, v]) => v as string))
          .filter(Boolean)
      )];
      if (hotelIds.length && session.tenantId) {
        const { data: hs } = await supabase.from("hotels").select("id, name").in("id", hotelIds);
        const map: Record<string, string> = {};
        for (const h of hs ?? []) map[h.id] = h.name;
        setHotelNames(map);
      }

      setLoading(false);
    };

    void load();
    return () => { active = false; };
  }, []);

  const displayed = requests.filter((r) => {
    const byFilter = filter === "all" || r.status === "pending";
    const svc = r.services;
    const customerName = svc?.customer_name ?? "";
    const agencyRaw    = svc?.agencies;
    const agencyName   = (Array.isArray(agencyRaw) ? agencyRaw[0] : agencyRaw)?.name ?? "";
    const hotelRaw     = svc?.hotels;
    const hotelName    = (Array.isArray(hotelRaw) ? hotelRaw[0] : hotelRaw)?.name ?? "";
    const bySearch = !search.trim() ||
      customerName.toLowerCase().includes(search.toLowerCase()) ||
      agencyName.toLowerCase().includes(search.toLowerCase()) ||
      hotelName.toLowerCase().includes(search.toLowerCase());
    return byFilter && bySearch;
  });

  const pendingCount = requests.filter((r) => r.status === "pending").length;

  const resolve = async (action: "approve" | "reject") => {
    if (!selected || !accessToken) return;
    setResolving(true);
    setActionMsg("");
    const notes = action === "approve" ? approveNote.trim() : rejectNote.trim();
    const res  = await fetch(`/api/ops/modification-requests/${selected.id}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ action, notes: notes || undefined }),
    });
    const data = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
    setResolving(false);
    if (!res.ok) { setActionMsg(data?.error ?? "Errore."); return; }

    const newStatus = action === "approve" ? "approved" as const : "rejected" as const;
    setRequests((prev) => prev.map((r) => r.id === selected.id
      ? { ...r, status: newStatus, operator_notes: notes || null, resolved_at: new Date().toISOString() }
      : r
    ));
    setSelected((prev) => prev ? { ...prev, status: newStatus, operator_notes: notes || null, resolved_at: new Date().toISOString() } : prev);
    setShowReject(false);
    setActionMsg(action === "approve" ? "Modifica approvata e applicata al servizio." : "Modifica rifiutata. L'agenzia è stata notificata.");
  };

  const svc = selected?.services ?? null;
  const hotelRaw    = svc?.hotels;
  const hotelName   = (Array.isArray(hotelRaw) ? hotelRaw[0] : hotelRaw)?.name ?? "—";
  const agencyRaw   = svc?.agencies;
  const agencyName  = (Array.isArray(agencyRaw) ? agencyRaw[0] : agencyRaw)?.name ?? "—";

  return (
    <section className="page-section">
      <PageHeader
        title="Richieste modifica"
        breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "Richieste modifica" }]}
        subtitle="Gestisci le richieste di modifica inviate dalle agenzie."
      />

      {message ? (
        <EmptyState title={message} compact />
      ) : (
        <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
          {/* ── Lista ── */}
          <SectionCard
            title="Richieste"
            subtitle={`${pendingCount} in attesa · ${requests.length} totali`}
          >
            <div className="space-y-3">
              {/* Barra ricerca + filtro */}
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Cerca cliente, hotel, agenzia..."
                    className="input-saas w-full pl-8 text-sm"
                  />
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8"
                    className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400 pointer-events-none">
                    <circle cx="6.5" cy="6.5" r="4" /><path d="M10.5 10.5 14 14" />
                  </svg>
                </div>
                <select value={filter} onChange={(e) => setFilter(e.target.value as "pending" | "all")} className="input-saas w-auto">
                  <option value="pending">In attesa</option>
                  <option value="all">Tutte</option>
                </select>
              </div>

              {loading ? (
                <p className="text-sm text-slate-400 py-4 text-center">Caricamento...</p>
              ) : displayed.length === 0 ? (
                <EmptyState title="Nessuna richiesta trovata." compact />
              ) : (
                <div className="space-y-2">
                  {displayed.map((req) => {
                    const s        = req.services;
                    const hRaw     = s?.hotels;
                    const hName    = (Array.isArray(hRaw) ? hRaw[0] : hRaw)?.name ?? "—";
                    const aRaw     = s?.agencies;
                    const aName    = (Array.isArray(aRaw) ? aRaw[0] : aRaw)?.name ?? "—";
                    const isActive = selected?.id === req.id;
                    return (
                      <button
                        key={req.id}
                        type="button"
                        onClick={() => { setSelected(req); setShowReject(false); setActionMsg(""); setRejectNote(""); setApproveNote(""); }}
                        className={`w-full rounded-2xl border p-3.5 text-left transition-colors ${isActive ? "border-indigo-300 bg-indigo-50/60" : "border-border bg-surface/80 hover:bg-slate-50"}`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="text-sm font-semibold text-text truncate">{s?.customer_name ?? "—"}</p>
                            <p className="text-xs text-muted truncate">{aName} · {hName}</p>
                          </div>
                          <StatusBadge status={req.status} />
                        </div>
                        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted">
                          <span>Ricevuta: {formatIsoDateTimeShort(req.created_at)}</span>
                          <span>{Object.keys(req.changes).length} campi</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </SectionCard>

          {/* ── Dettaglio ── */}
          <SectionCard title="Dettaglio richiesta" subtitle="Confronto valori originali e richiesti.">
            {!selected ? (
              <EmptyState title="Seleziona una richiesta dalla lista." compact />
            ) : (
              <div className="space-y-4 overflow-y-auto max-h-[80vh] pr-1">
                {/* Header */}
                <div className="flex items-start justify-between gap-3 pb-3 border-b border-slate-100">
                  <div>
                    <p className="text-lg font-bold text-slate-900">{svc?.customer_name ?? "—"}</p>
                    <p className="text-xs text-muted">{agencyName} · {hotelName}</p>
                    {selected.requested_by_name && (
                      <p className="text-xs text-muted mt-0.5">Richiesta da: {selected.requested_by_name}</p>
                    )}
                    <p className="text-xs text-muted">{formatIsoDateTimeShort(selected.created_at)}</p>
                  </div>
                  <StatusBadge status={selected.status} />
                </div>

                {/* Confronto campi */}
                <div>
                  <p className="text-xs font-bold uppercase tracking-widest text-slate-400 mb-2">Modifiche richieste</p>
                  <div className="rounded-xl border border-slate-200 divide-y divide-slate-100 overflow-hidden">
                    <div className="grid grid-cols-3 bg-slate-50 px-3 py-2">
                      <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">Campo</span>
                      <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">Originale</span>
                      <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">Richiesto</span>
                    </div>
                    {Object.entries(selected.changes).map(([k, newVal]) => {
                      const origVal = selected.original_values[k];
                      const displayNew = k === "hotel_id" ? (hotelNames[newVal as string] ?? String(newVal)) : k === "booking_service_kind" ? (serviceKindLabels[newVal as string] ?? String(newVal)) : fmt(newVal);
                      const displayOrig = k === "hotel_id" ? (hotelName ?? "—") : k === "booking_service_kind" ? (serviceKindLabels[origVal as string] ?? fmt(origVal)) : fmt(origVal);
                      return (
                        <div key={k} className="grid grid-cols-3 px-3 py-2.5 text-sm">
                          <span className="text-slate-500 font-medium">{fieldLabels[k] ?? k}</span>
                          <span className="text-slate-500 line-through text-xs self-center">{displayOrig}</span>
                          <span className="text-slate-900 font-semibold">{displayNew}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Servizio attuale */}
                {svc && (
                  <div>
                    <p className="text-xs font-bold uppercase tracking-widest text-slate-400 mb-2">Servizio attuale</p>
                    <div className="rounded-xl border border-slate-200 bg-white divide-y divide-slate-100">
                      {[
                        { label: "Tipo", value: serviceKindLabels[svc.booking_service_kind ?? ""] ?? "—" },
                        { label: "Arrivo", value: `${formatIsoDateShort(svc.arrival_date ?? "")} ${(svc.arrival_time ?? "").slice(0, 5)}`.trim() || "—" },
                        { label: "Ritorno", value: svc.departure_date ? `${formatIsoDateShort(svc.departure_date)} ${(svc.departure_time ?? "").slice(0, 5)}`.trim() : "—" },
                        { label: "Pax", value: String(svc.pax) },
                      ].map(({ label, value }) => (
                        <div key={label} className="flex items-baseline justify-between gap-3 px-3 py-2 text-sm">
                          <span className="text-slate-400 font-medium">{label}</span>
                          <span className="text-slate-800">{value}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Note operatore (se già risolto) */}
                {selected.status !== "pending" && selected.operator_notes && (
                  <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5">
                    <p className="text-xs font-bold uppercase tracking-widest text-slate-400 mb-1">Note operatore</p>
                    <p className="text-sm text-slate-700">{selected.operator_notes}</p>
                  </div>
                )}

                {actionMsg && (
                  <p className={`text-xs font-semibold px-1 ${actionMsg.includes("approv") ? "text-emerald-700" : actionMsg.includes("rifiut") ? "text-rose-700" : "text-red-600"}`}>
                    {actionMsg}
                  </p>
                )}

                {/* Azioni (solo se pending) */}
                {selected.status === "pending" && (
                  <div className="space-y-3 pt-1">
                    {!showReject ? (
                      <div className="space-y-2">
                        <div>
                          <label className="text-xs text-muted">Nota (opzionale)</label>
                          <input
                            className="input-saas mt-1 w-full"
                            placeholder="es. approvato, aggiornato il sistema..."
                            value={approveNote}
                            onChange={(e) => setApproveNote(e.target.value)}
                          />
                        </div>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => void resolve("approve")}
                            disabled={resolving}
                            className="flex-1 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-emerald-700 disabled:opacity-60"
                          >
                            {resolving ? "Applicazione..." : "Approva e applica"}
                          </button>
                          <button
                            type="button"
                            onClick={() => setShowReject(true)}
                            className="rounded-xl border border-rose-300 px-4 py-2.5 text-sm font-semibold text-rose-700 hover:bg-rose-50"
                          >
                            Rifiuta
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 space-y-2">
                        <p className="text-sm font-semibold text-rose-900">Rifiuta richiesta</p>
                        <div>
                          <label className="text-xs text-rose-700">Motivo del rifiuto (consigliato)</label>
                          <textarea
                            className="input-saas mt-1 w-full min-h-[70px]"
                            placeholder="es. data non disponibile, cambio non consentito..."
                            value={rejectNote}
                            onChange={(e) => setRejectNote(e.target.value)}
                          />
                        </div>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => void resolve("reject")}
                            disabled={resolving}
                            className="rounded-xl bg-rose-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-rose-700 disabled:opacity-60"
                          >
                            {resolving ? "Invio..." : "Conferma rifiuto"}
                          </button>
                          <button type="button" onClick={() => setShowReject(false)}
                            className="rounded-xl border border-slate-300 px-4 py-2.5 text-sm text-slate-600 hover:bg-slate-50">
                            Indietro
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </SectionCard>
        </div>
      )}
    </section>
  );
}
