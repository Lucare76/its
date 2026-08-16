"use client";

import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase/client";
import { getClientSessionContext } from "@/lib/supabase/client-session";

type CancellationRequest = {
  id: string;
  cancel_legs: "arrival" | "departure" | "both";
  status: "pending_review" | "pending_agency_approval" | "approved" | "rejected" | "closed";
  penalty_cents: number | null;
  penalty_note: string | null;
  requested_by_role: string;
  requested_by_name: string | null;
  created_at: string;
  agency_response: "accepted" | "rejected" | "counter" | null;
  agency_response_note: string | null;
  agency_counter_cents: number | null;
  agency_responded_at: string | null;
  services: {
    id: string;
    customer_name: string;
    pax: number;
    date: string;
    arrival_date: string | null;
    arrival_time: string | null;
    departure_date: string | null;
    booking_service_kind: string | null;
    hotels: { name: string } | null;
    agencies: { name: string; booking_email: string | null } | null;
  };
};

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return iso.split("-").reverse().join("/");
}
function formatEur(cents: number): string {
  return (cents / 100).toLocaleString("it-IT", { style: "currency", currency: "EUR" });
}
function legLabel(legs: string): string {
  if (legs === "arrival") return "Solo andata";
  if (legs === "departure") return "Solo ritorno";
  return "Intero servizio";
}
function statusLabel(status: string, agencyResponse: string | null): { label: string; className: string } {
  if (status === "pending_review") return { label: "Da gestire", className: "border-amber-200 bg-amber-50 text-amber-700" };
  if (status === "pending_agency_approval" && !agencyResponse) return { label: "Attesa risposta agenzia", className: "border-blue-200 bg-blue-50 text-blue-700" };
  if (status === "pending_agency_approval" && agencyResponse === "accepted") return { label: "Agenzia: accettato", className: "border-emerald-200 bg-emerald-50 text-emerald-700" };
  if (status === "rejected" || (status === "pending_agency_approval" && agencyResponse === "rejected")) return { label: "Agenzia: rifiutato", className: "border-rose-200 bg-rose-50 text-rose-700" };
  if (status === "pending_agency_approval" && agencyResponse === "counter") return { label: "Agenzia: controproposta", className: "border-violet-200 bg-violet-50 text-violet-700" };
  if (status === "approved" || status === "closed") return { label: "Chiusa", className: "border-slate-200 bg-slate-50 text-slate-500" };
  return { label: status, className: "border-slate-200 bg-slate-50 text-slate-500" };
}

export default function CancellazioniPage() {
  const [requests, setRequests] = useState<CancellationRequest[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ serviceId: string; customerName: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Modale penale
  const [modal, setModal] = useState<CancellationRequest | null>(null);
  const [penaltyEur, setPenaltyEur] = useState("");
  const [penaltyNote, setPenaltyNote] = useState("");
  const [forceClose, setForceClose] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const ctx = await getClientSessionContext();
      setIsAdmin(ctx.role === "admin");
      const token = ctx.accessToken ?? (await supabase?.auth.getSession())?.data.session?.access_token;
      if (!token) { setError("Sessione scaduta."); return; }
      const res = await fetch("/api/ops/cancellation-requests", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await res.json() as { ok: boolean; requests?: CancellationRequest[]; error?: string };
      if (!body.ok) { setError(body.error ?? "Errore caricamento."); return; }
      setRequests(body.requests ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const restoreRequest = async (reqId: string) => {
    setRestoring(reqId);
    try {
      const session = await supabase?.auth.getSession();
      const token = session?.data.session?.access_token;
      if (!token) return;
      await fetch(`/api/ops/cancellation-requests/${reqId}/restore`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      void load();
    } finally {
      setRestoring(null);
    }
  };

  const confirmDelete = (serviceId: string, customerName: string) => {
    setDeleteTarget({ serviceId, customerName });
    setDeleteError(null);
  };

  const executeDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const session = await supabase?.auth.getSession();
      const token = session?.data.session?.access_token;
      if (!token) { setDeleteError("Sessione scaduta."); return; }
      const res = await fetch(`/api/ops/services/${deleteTarget.serviceId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await res.json() as { ok?: boolean; error?: string };
      if (!body.ok) { setDeleteError(body.error ?? "Errore eliminazione."); return; }
      setDeleteTarget(null);
      void load();
    } finally {
      setDeleting(false);
    }
  };

  const openModal = (req: CancellationRequest) => {
    setModal(req);
    setPenaltyEur(req.agency_counter_cents ? String(req.agency_counter_cents / 100) : req.penalty_cents ? String(req.penalty_cents / 100) : "");
    setPenaltyNote(req.penalty_note ?? "");
    setForceClose(false);
    setModalError(null);
  };

  const submitResolve = async () => {
    if (!modal) return;
    const penaltyCents = penaltyEur ? Math.round(Number(penaltyEur.replace(",", ".")) * 100) : 0;
    if (isNaN(penaltyCents) || penaltyCents < 0) { setModalError("Importo penale non valido."); return; }

    setResolving(modal.id);
    setModalError(null);
    try {
      const session = await supabase?.auth.getSession();
      const token = session?.data.session?.access_token;
      if (!token) { setModalError("Sessione scaduta."); return; }
      const res = await fetch(`/api/ops/cancellation-requests/${modal.id}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ penalty_cents: penaltyCents, penalty_note: penaltyNote.trim() || undefined, force_close: forceClose }),
      });
      const body = await res.json() as { ok: boolean; error?: string };
      if (!body.ok) { setModalError(body.error ?? "Errore."); return; }
      setModal(null);
      void load();
    } finally {
      setResolving(null);
    }
  };

  const matchesSearch = (r: CancellationRequest) => {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return (
      r.services?.customer_name?.toLowerCase().includes(q) ||
      (Array.isArray(r.services?.agencies) ? r.services.agencies[0] : r.services?.agencies)?.name?.toLowerCase().includes(q) ||
      (Array.isArray(r.services?.hotels) ? r.services.hotels[0] : r.services?.hotels)?.name?.toLowerCase().includes(q) ||
      r.requested_by_name?.toLowerCase().includes(q)
    );
  };
  const pending = requests
    .filter((r) => r.status === "pending_review" || r.status === "pending_agency_approval")
    .filter(matchesSearch);
  const archived = requests
    .filter((r) => r.status === "closed" || r.status === "approved")
    .filter(matchesSearch);
  const agencyCount = requests.filter((req) => req.services?.agencies).length;
  const refundCount = requests.filter((req) => (req.penalty_cents ?? 0) > 0 || req.agency_response === "counter").length;
  const urgentCount = requests.filter((req) => req.agency_response === "rejected" || (req.penalty_cents ?? 0) > 0).length;
  return (
    <section className="space-y-5 pb-8">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div>
          <h1 className="text-4xl font-extrabold tracking-tight text-slate-950">Cancellazioni</h1>
          <p className="mt-1 text-lg text-slate-600">Richieste annullamento e servizi cancellati</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button className="rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-bold text-slate-700 shadow-sm">▣ Esporta Excel</button>
          <button className="rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-bold text-slate-700 shadow-sm">🖨️ Stampa</button>
          <button className="rounded-xl bg-gradient-to-r from-blue-600 to-violet-600 px-6 py-3 text-sm font-extrabold text-white shadow-lg shadow-blue-500/20">＋ Nuova cancellazione</button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        {[
          { icon: "🧾", label: "Da gestire", value: pending.length, tint: "bg-amber-50 text-amber-700" },
          { icon: "🛡️", label: "Rimborsi", value: refundCount, tint: "bg-emerald-50 text-emerald-700" },
          { icon: "📅", label: "Cancellate", value: archived.length, tint: "bg-blue-50 text-blue-700" },
          { icon: "👥", label: "Agenzie", value: agencyCount, tint: "bg-violet-50 text-violet-700" },
          { icon: "🔔", label: "Urgenze", value: urgentCount, tint: "bg-rose-50 text-rose-700" },
        ].map((kpi) => (
          <div key={kpi.label} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
            <div className="flex items-center gap-4">
              <span className={`grid h-12 w-12 place-items-center rounded-2xl text-xl ${kpi.tint}`}>{kpi.icon}</span>
              <div>
                <p className="text-sm font-semibold text-slate-500">{kpi.label}</p>
                <p className="text-3xl font-extrabold text-slate-950">{kpi.value}</p>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 lg:flex-row">
          <input
            type="search"
            placeholder="Cerca cliente, agenzia, hotel..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-12 flex-1 rounded-xl border border-slate-200 bg-slate-50 px-4 text-sm outline-none focus:border-blue-400 focus:bg-white"
          />
          <div className="flex flex-wrap gap-2 text-xs font-bold">
            <span className="rounded-full bg-blue-600 px-3 py-2 text-white">Tutte</span>
            <span className="rounded-full border border-slate-200 px-3 py-2 text-slate-600">Da approvare</span>
            <span className="rounded-full border border-slate-200 px-3 py-2 text-slate-600">Agenzia</span>
            <span className="rounded-full border border-slate-200 px-3 py-2 text-slate-600">Urgenti</span>
          </div>
        </div>
      </div>

      {error && <div className="mb-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>}

      {loading ? (
        <div className="rounded-3xl border border-slate-200 bg-white p-8 text-sm text-slate-400 shadow-sm">Caricamento cancellazioni...</div>
      ) : pending.length === 0 ? (
        <div className="rounded-3xl border border-emerald-200 bg-white p-10 text-center shadow-sm">
          <p className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-emerald-50 text-3xl text-emerald-700">✓</p>
          <p className="mt-4 text-xl font-extrabold text-slate-900">Nessuna richiesta pendente</p>
          <p className="mt-1 text-sm text-slate-500">Tutte le richieste di cancellazione sono state gestite.</p>
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {pending.map((req) => {
            const svc = req.services;
            const agency = Array.isArray(svc?.agencies) ? svc.agencies[0] : svc?.agencies;
            const hotel = Array.isArray(svc?.hotels) ? svc.hotels[0] : svc?.hotels;
            const st = statusLabel(req.status, req.agency_response);
            const needsAction = req.status === "pending_review" || req.status === "pending_agency_approval";

            return (
              <div key={req.id} className={`rounded-3xl border bg-white p-5 shadow-sm space-y-4 ${needsAction ? "border-amber-200" : "border-slate-200"}`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-lg font-extrabold uppercase text-slate-900">{svc?.customer_name}</span>
                      <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${st.className}`}>{st.label}</span>
                      <span className="inline-flex rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] text-slate-500">{legLabel(req.cancel_legs)}</span>
                    </div>
                    <div className="flex flex-wrap gap-3 text-xs text-slate-500">
                      {hotel?.name && <span>🏨 {hotel.name}</span>}
                      {svc?.arrival_date && <span>📅 {formatDate(svc.arrival_date)}</span>}
                      {svc?.pax && <span>👥 {svc.pax} pax</span>}
                      {agency?.name && <span>🏢 {agency.name}</span>}
                      <span className="text-slate-400">
                        Richiesta da: {req.requested_by_name ?? req.requested_by_role}
                        {req.requested_by_name && <span className="ml-1 text-slate-300">({req.requested_by_role})</span>}
                        {" · "}{new Date(req.created_at).toLocaleString("it-IT", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" })}
                      </span>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {needsAction && (
                      <button
                        onClick={() => openModal(req)}
                        className="rounded-xl bg-gradient-to-r from-blue-600 to-violet-600 px-4 py-2 text-xs font-extrabold text-white shadow-lg shadow-blue-500/20 transition"
                      >
                        {req.status === "pending_review"
                          ? "Gestisci"
                          : req.agency_response
                          ? "Rivedi risposta"
                          : "Forza chiusura"}
                      </button>
                    )}
                    <button
                      onClick={() => void restoreRequest(req.id)}
                      disabled={restoring === req.id}
                      className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-xs font-bold text-emerald-700 hover:bg-emerald-100 transition disabled:opacity-50"
                    >
                      {restoring === req.id ? "..." : "Ripristina"}
                    </button>
                    {isAdmin && (
                      <button
                        onClick={() => confirmDelete(svc.id, svc.customer_name)}
                        className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-2 text-xs font-bold text-rose-700 hover:bg-rose-100 transition"
                      >
                        Elimina
                      </button>
                    )}
                  </div>
                </div>

                {/* Risposta agenzia */}
                {req.agency_response && (
                  <div className={`rounded-xl border px-4 py-3 text-sm space-y-1 ${
                    req.agency_response === "accepted" ? "border-emerald-200 bg-emerald-50" :
                    req.agency_response === "rejected" ? "border-rose-200 bg-rose-50" :
                    "border-violet-200 bg-violet-50"
                  }`}>
                    <p className="font-semibold text-slate-700">
                      {req.agency_response === "accepted" && "✓ Agenzia ha accettato la penale"}
                      {req.agency_response === "rejected" && "✗ Agenzia ha rifiutato la penale"}
                      {req.agency_response === "counter" && `💬 Agenzia propone: ${req.agency_counter_cents ? formatEur(req.agency_counter_cents) : "—"}`}
                    </p>
                    {req.agency_response_note && <p className="text-xs text-slate-500">«{req.agency_response_note}»</p>}
                    {req.agency_responded_at && (
                      <p className="text-xs text-slate-400">{new Date(req.agency_responded_at).toLocaleString("it-IT")}</p>
                    )}
                  </div>
                )}

                {/* Penale impostata */}
                {req.penalty_cents !== null && req.status === "pending_agency_approval" && !req.agency_response && (
                  <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-2 text-xs text-slate-500">
                    Penale inviata all&apos;agenzia: <span className="font-semibold text-slate-700">{req.penalty_cents > 0 ? formatEur(req.penalty_cents) : "Nessuna penale"}</span>
                    {req.penalty_note && <span className="ml-2">— {req.penalty_note}</span>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Archivio cancellazioni (ultimi 30 giorni) */}
      {archived.length > 0 && (
        <div className="mt-6">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-400">
            Archivio — ultimi 30 giorni ({archived.length})
          </h2>
          <div className="space-y-2">
            {archived.map((req) => {
              const svc = req.services;
              const hotel = Array.isArray(svc?.hotels) ? svc.hotels[0] : svc?.hotels;
              const agency = Array.isArray(svc?.agencies) ? svc.agencies[0] : svc?.agencies;
              return (
                <div key={req.id} className="card flex flex-wrap items-center gap-3 p-4 text-sm opacity-80">
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold uppercase text-slate-800">{svc?.customer_name ?? "—"}</p>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {hotel?.name && <span>🏨 {hotel.name} · </span>}
                      {svc?.arrival_date && <span>📅 {formatDate(svc.arrival_date)} · </span>}
                      {agency?.name && <span>🏢 {agency.name} · </span>}
                      <span>{legLabel(req.cancel_legs)}</span>
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {req.penalty_cents != null && req.penalty_cents > 0 && (
                      <span className="rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-xs font-semibold text-rose-700">
                        Penale {formatEur(req.penalty_cents)}
                      </span>
                    )}
                    <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs text-slate-500">
                      {req.id.startsWith("direct_") ? "Cancellata direttamente" : "Chiusa"} · {new Date(req.created_at).toLocaleDateString("it-IT")}
                    </span>
                    {isAdmin && (
                      <button
                        onClick={() => confirmDelete(svc.id, svc.customer_name ?? "—")}
                        className="rounded-xl border border-rose-200 bg-rose-50 px-2 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-100 transition"
                      >
                        Elimina
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Modale conferma eliminazione definitiva */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !deleting && setDeleteTarget(null)}>
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-3">
              <span className="text-2xl">⚠️</span>
              <h2 className="text-base font-semibold text-slate-800">Eliminazione definitiva</h2>
            </div>
            <p className="text-sm text-slate-600">
              Stai per eliminare <span className="font-semibold uppercase">{deleteTarget.customerName}</span> in modo permanente. L&apos;operazione non è reversibile e lascerà traccia nel log di sistema con il tuo nome e l&apos;orario.
            </p>
            {deleteError && <p className="text-sm text-rose-600">{deleteError}</p>}
            <div className="flex gap-2 pt-1">
              <button
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
                className="flex-1 rounded-xl border border-slate-200 px-4 py-2.5 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              >
                Annulla
              </button>
              <button
                onClick={() => void executeDelete()}
                disabled={deleting}
                className="flex-1 rounded-xl bg-rose-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-rose-700 disabled:opacity-50 transition"
              >
                {deleting ? "Eliminazione..." : "Elimina definitivamente"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modale gestione penale */}
      {modal && (() => {
        const svc = modal.services;
        const agency = Array.isArray(svc?.agencies) ? svc.agencies[0] : svc?.agencies;
        const hotel = Array.isArray(svc?.hotels) ? svc.hotels[0] : svc?.hotels;
        const hasAgency = !!agency?.name;
        const isCounterProposal = modal.agency_response === "counter";
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setModal(null)}>
            <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl space-y-4" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold text-slate-800">
                  {modal.status === "pending_review" ? "Gestisci richiesta cancellazione" : "Rivedi risposta agenzia"}
                </h2>
                <button onClick={() => setModal(null)} className="text-slate-400 hover:text-slate-600 text-xl">×</button>
              </div>

              {/* Riepilogo servizio */}
              <div className="rounded-xl border border-slate-100 bg-slate-50 divide-y divide-slate-100 text-sm">
                <div className="flex justify-between px-4 py-2.5">
                  <span className="text-slate-500">Cliente</span>
                  <span className="font-semibold uppercase">{svc?.customer_name}</span>
                </div>
                <div className="flex justify-between px-4 py-2.5">
                  <span className="text-slate-500">Hotel</span>
                  <span className="font-medium">{hotel?.name ?? "N/D"}</span>
                </div>
                <div className="flex justify-between px-4 py-2.5">
                  <span className="text-slate-500">Data arrivo</span>
                  <span>{formatDate(svc?.arrival_date ?? null)}</span>
                </div>
                <div className="flex justify-between px-4 py-2.5">
                  <span className="text-slate-500">Tratta</span>
                  <span className="font-medium">{legLabel(modal.cancel_legs)}</span>
                </div>
                {hasAgency && (
                  <div className="flex justify-between px-4 py-2.5">
                    <span className="text-slate-500">Agenzia</span>
                    <span>{agency?.name}</span>
                  </div>
                )}
              </div>

              {/* Controproposta agenzia se presente */}
              {isCounterProposal && (
                <div className="rounded-xl border border-violet-200 bg-violet-50 px-4 py-3 text-sm space-y-1">
                  <p className="font-semibold text-violet-700">
                    💬 Agenzia propone: {modal.agency_counter_cents ? formatEur(modal.agency_counter_cents) : "—"}
                  </p>
                  {modal.agency_response_note && <p className="text-xs text-violet-500">«{modal.agency_response_note}»</p>}
                </div>
              )}

              {/* Campo penale */}
              <div className="space-y-3">
                <label className="block text-sm font-medium text-slate-700">
                  Penale (€) — lascia vuoto o 0 per nessuna penale
                  <input
                    type="number"
                    min="0"
                    step="0.5"
                    placeholder="Es. 50.00"
                    value={penaltyEur}
                    onChange={(e) => setPenaltyEur(e.target.value)}
                    onBlur={(e) => {
                      const v = parseFloat(e.target.value);
                      if (!isNaN(v) && v > 0) {
                        setPenaltyEur(String(Math.round(v * 2) / 2));
                      }
                    }}
                    className="mt-1 block w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none"
                  />
                </label>
                <label className="block text-sm font-medium text-slate-700">
                  Nota penale (facoltativo)
                  <textarea
                    rows={2}
                    placeholder="Es. Cancellazione entro 48h, regolamento art. 5..."
                    value={penaltyNote}
                    onChange={(e) => setPenaltyNote(e.target.value)}
                    className="mt-1 block w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none resize-none"
                  />
                </label>

                {hasAgency ? (
                  <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-500 space-y-1.5">
                    <p>
                      {Number(penaltyEur) > 0
                        ? `Verrà inviata un'email a ${agency?.name} con la penale di ${formatEur(Math.round(Number(penaltyEur.replace(",", ".")) * 100))} e i pulsanti per accettare/rifiutare/controproporre.`
                        : `Verrà inviata un'email a ${agency?.name} con la conferma della cancellazione senza penale.`}
                    </p>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={forceClose}
                        onChange={(e) => setForceClose(e.target.checked)}
                        className="rounded"
                      />
                      <span>Chiudi immediatamente senza attendere risposta agenzia</span>
                    </label>
                  </div>
                ) : (
                  <div className="rounded-xl border border-amber-100 bg-amber-50 px-4 py-3 text-xs text-amber-700">
                    Nessuna agenzia collegata — il servizio verrà cancellato direttamente.
                    {svc && "customer_email" in svc && svc.customer_email
                      ? " Email di conferma inviata al cliente."
                      : ""}
                  </div>
                )}
              </div>

              {modalError && <p className="text-sm text-rose-600">{modalError}</p>}

              <div className="flex gap-2 pt-1">
                <button onClick={() => setModal(null)} className="flex-1 rounded-xl border border-slate-200 px-4 py-2.5 text-sm text-slate-600 hover:bg-slate-50">
                  Annulla
                </button>
                <button
                  onClick={() => void submitResolve()}
                  disabled={resolving === modal.id}
                  className="flex-1 rounded-xl bg-slate-800 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
                >
                  {resolving === modal.id
                    ? "Invio..."
                    : forceClose || !hasAgency
                    ? "Cancella servizio"
                    : "Invia all'agenzia"}
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </section>
  );
}
