"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader, SectionCard, EmptyState } from "@/components/ui";
import { getClientSessionContext } from "@/lib/supabase/client-session";
import {
  summarizeBookingGroupPax,
  computeBookingGroupStatusSummary,
  BOOKING_GROUP_KINDS,
  BOOKING_GROUP_STATUSES,
  type BookingGroup,
  type BookingGroupStop,
  type BookingGroupBusReservation,
  type BookingGroupStopPaxSummary,
} from "@/lib/booking-groups";

type Detail = {
  group: BookingGroup;
  stops: BookingGroupStop[];
  bus_reservations: BookingGroupBusReservation[];
  services: Array<{ id: string; pax: number | null; customer_name: string | null; status: string | null; is_draft: boolean | null; booking_group_stop_id: string | null }>;
  summary: ReturnType<typeof computeBookingGroupStatusSummary>;
  stop_summaries: BookingGroupStopPaxSummary[];
};
type AvailableBus = { id: string; label: string; capacity: number; tag: string | null };
type BusLineOption = { id: string; name: string; code: string | null; family_name: string | null; variant_label: string | null };
type PostResult = Record<string, unknown> | null;

const KIND_LABEL: Record<string, string> = {
  bus_exclusive: "Bus esclusivo",
  bus_group: "Gruppo bus",
  multi_service: "Multi-servizio",
  other: "Altro",
};
const STATUS_LABEL: Record<string, string> = {
  draft: "Bozza",
  to_complete: "Da completare",
  stops_defined: "Fermate definite",
  passengers_defined: "Nominativi definiti",
  operational: "Operativo",
  cancelled: "Annullato",
};

async function api(path: string, init?: RequestInit) {
  const ctx = await getClientSessionContext();
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (ctx.accessToken) headers["Authorization"] = `Bearer ${ctx.accessToken}`;
  const res = await fetch(path, { ...init, headers });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

export default function BookingGroupsPage() {
  const [groups, setGroups] = useState<BookingGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("open");
  // FASE 4 — apertura diretta da link esterno (es. "Apri gruppo" dal Piano del
  // Giorno): /booking-groups?id=<uuid>. Letto una sola volta come stato
  // iniziale lazy, non in un effect (evita setState sincrono in effect).
  const [selectedId, setSelectedId] = useState<string | null>(
    () => (typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("id"))
  );
  const [detail, setDetail] = useState<Detail | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [busLines, setBusLines] = useState<BusLineOption[]>([]);

  const loadList = useCallback(async () => {
    setLoading(true);
    setErr(null);
    const qs = query.trim() ? `?q=${encodeURIComponent(query.trim())}` : "";
    const { ok, json } = await api(`/api/ops/booking-groups${qs}`);
    setLoading(false);
    if (ok && json.ok) setGroups(json.groups ?? json.matches ?? []);
    else setErr(json.error ?? "Errore caricamento gruppi");
  }, [query]);

  const loadDetail = useCallback(async (id: string) => {
    setDetailLoading(true);
    setErr(null);
    const { ok, json } = await api(`/api/ops/booking-groups?id=${id}`);
    setDetailLoading(false);
    if (ok && json.ok) setDetail(json as Detail);
    else setErr(json.error ?? "Errore caricamento dettaglio");
  }, []);

  const loadBusLines = useCallback(async () => {
    const { ok, json } = await api("/api/ops/booking-groups?catalog=bus_lines");
    if (ok && json.ok) setBusLines(json.lines ?? []);
  }, []);

  // Il setState avviene dentro loadList/loadDetail dopo un await (fetch), non
  // in modo sincrono nel corpo dell'effect: nessun rischio di cascading render.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void loadList(); }, [loadList]);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void loadBusLines(); }, [loadBusLines]);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { if (selectedId) void loadDetail(selectedId); }, [selectedId, loadDetail]);

  const closeDetail = useCallback(() => {
    setSelectedId(null);
    setDetail(null);
    window.history.replaceState(null, "", "/booking-groups");
  }, []);

  const selectGroup = useCallback((id: string) => {
    setSelectedId(id);
    setDetail(null);
    window.history.replaceState(null, "", `/booking-groups?id=${id}`);
  }, []);

  const refresh = useCallback(async () => {
    await loadList();
    if (selectedId) await loadDetail(selectedId);
  }, [loadList, loadDetail, selectedId]);

  const visibleGroups = useMemo(() => groups.filter((g) => {
    if (statusFilter === "all") return true;
    if (statusFilter === "open") return g.status !== "cancelled" && g.status !== "operational";
    return g.status === statusFilter;
  }), [groups, statusFilter]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Gruppi prenotazione"
        subtitle="Contenitore commerciale: pax previsti, fermate pianificate, nominativi progressivi, bus esclusivo e traghetto di gruppo."
        actions={<button type="button" onClick={() => setShowNew(true)} className="btn-primary px-3 py-2 text-sm">+ Nuovo gruppo</button>}
      />
      {err ? <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{err}</p> : null}
      {msg ? <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{msg}</p> : null}

      <SectionCard title="Elenco gruppi">
        <div className="mb-3 grid gap-2 md:grid-cols-[1fr_180px_auto]">
          <input className="input-saas" placeholder="Cerca gruppo" value={query} onChange={(e) => setQuery(e.target.value)} />
          <select className="input-saas" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="open">Aperti</option>
            <option value="all">Tutti</option>
            {BOOKING_GROUP_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          </select>
          <button type="button" onClick={() => void loadList()} className="btn-secondary px-3 py-2 text-sm">Aggiorna</button>
        </div>
        {loading ? (
          <p className="text-sm text-slate-500">Caricamento…</p>
        ) : visibleGroups.length === 0 ? (
          <EmptyState title="Nessun gruppo" description="Crea il primo gruppo prenotazione." />
        ) : (
          <div className="space-y-2">
            {visibleGroups.map((g) => {
              const s = summarizeBookingGroupPax({ expectedPax: g.expected_pax, stopExpectedPax: [], servicePax: [] });
              return (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => selectGroup(g.id)}
                  className={`w-full rounded-xl border px-3 py-2 text-left text-sm ${selectedId === g.id ? "border-slate-800 bg-slate-50" : "border-slate-200 hover:bg-slate-50"}`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-slate-800">{g.name}</span>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600">{STATUS_LABEL[g.status] ?? g.status}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-slate-500">
                    <span>{KIND_LABEL[g.kind] ?? g.kind}</span>
                    {g.service_date ? <span>arrivo {g.service_date}</span> : null}
                    {g.return_date ? <span>ritorno {g.return_date}</span> : null}
                    {!g.service_date && !g.return_date ? <span>date da definire</span> : null}
                    <span className="font-semibold text-slate-700">{s.expectedPax} previsti</span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </SectionCard>

      {detailLoading ? <p className="text-sm text-slate-500">Caricamento dettaglio…</p> : null}
      {detail ? <GroupDetail detail={detail} busLines={busLines} onChange={refresh} onMessage={(m) => { setErr(null); setMsg(m); }} onError={(e) => { setMsg(null); setErr(e); }} onClose={closeDetail} /> : null}

      {showNew ? <NewGroupForm onClose={() => setShowNew(false)} onCreated={async (id) => { setShowNew(false); await loadList(); selectGroup(id); }} onError={(e) => { setMsg(null); setErr(e); }} /> : null}
    </div>
  );
}

// ─── New group form ────────────────────────────────────────────────────────

function NewGroupForm({ onClose, onCreated, onError }: { onClose: () => void; onCreated: (id: string) => void; onError: (e: string) => void }) {
  const [name, setName] = useState("");
  const [expectedPax, setExpectedPax] = useState("50");
  const [kind, setKind] = useState<string>("bus_exclusive");
  const [status, setStatus] = useState<string>("to_complete");
  const [arrivalDate, setArrivalDate] = useState("");
  const [returnDate, setReturnDate] = useState("");
  const [contactName, setContactName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const formError = useMemo(() => {
    if (kind === "bus_exclusive" && !arrivalDate && !returnDate) {
      return "Per un bus esclusivo inserisci almeno una data tra arrivo e ritorno.";
    }
    if (arrivalDate && returnDate && returnDate < arrivalDate) {
      return "La data di ritorno non puo essere precedente alla data di arrivo.";
    }
    return null;
  }, [arrivalDate, kind, returnDate]);
  const canSubmit = !busy && !formError && name.trim().length > 0 && Number(expectedPax) > 0;

  const submit = async () => {
    setBusy(true);
    const { ok, json } = await api("/api/ops/booking-groups", {
      method: "POST",
      body: JSON.stringify({
        action: "create_group",
        name: name.trim(),
        expected_pax: Number(expectedPax),
        kind,
        status,
        service_date: arrivalDate || null,
        return_date: returnDate || null,
        contact_name: contactName.trim() || null,
        contact_phone: contactPhone.trim() || null,
        notes: notes.trim() || null,
      }),
    });
    setBusy(false);
    if (ok && json.ok) onCreated(json.group.id);
    else onError(json.error ?? "Creazione gruppo non riuscita");
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/45 p-4" onClick={onClose}>
      <div className="w-full max-w-md space-y-3 rounded-2xl bg-white p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-base font-bold text-slate-800">Nuovo gruppo prenotazione</h3>
        <label className="block text-xs font-medium text-slate-600">Nome gruppo *
          <input className="input-saas mt-1 w-full" value={name} onChange={(e) => setName(e.target.value)} placeholder="Parrocchia Natività" />
        </label>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
          <label className="block text-xs font-medium text-slate-600">Pax previsti *
            <input type="number" min={1} max={500} className="input-saas mt-1 w-full" value={expectedPax} onChange={(e) => setExpectedPax(e.target.value)} />
          </label>
          <label className="block text-xs font-medium text-slate-600">Data arrivo
            <input type="date" className="input-saas mt-1 w-full" value={arrivalDate} onChange={(e) => setArrivalDate(e.target.value)} />
          </label>
          <label className="block text-xs font-medium text-slate-600">Data ritorno
            <input type="date" className="input-saas mt-1 w-full" value={returnDate} onChange={(e) => setReturnDate(e.target.value)} />
          </label>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <label className="block text-xs font-medium text-slate-600">Tipo
            <select className="input-saas mt-1 w-full" value={kind} onChange={(e) => setKind(e.target.value)}>
              {BOOKING_GROUP_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
            </select>
          </label>
          <label className="block text-xs font-medium text-slate-600">Stato iniziale
            <select className="input-saas mt-1 w-full" value={status} onChange={(e) => setStatus(e.target.value)}>
              {BOOKING_GROUP_STATUSES.filter((s) => s !== "cancelled").map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
            </select>
          </label>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <label className="block text-xs font-medium text-slate-600">Referente
            <input className="input-saas mt-1 w-full" value={contactName} onChange={(e) => setContactName(e.target.value)} />
          </label>
          <label className="block text-xs font-medium text-slate-600">Telefono
            <input className="input-saas mt-1 w-full" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} />
          </label>
        </div>
        <label className="block text-xs font-medium text-slate-600">Note
          <textarea rows={2} className="input-saas mt-1 w-full resize-none" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
        {formError ? <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">{formError}</p> : null}
        <p className="text-[11px] text-slate-400">Per i bus esclusivi e richiesta almeno una data tra arrivo e ritorno. Punti di carico/fermate, nominativi, nave e bus si aggiungono dopo nella scheda gruppo.</p>
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="flex-1 rounded-xl border border-slate-200 py-2 text-sm font-semibold text-slate-600">Annulla</button>
          <button type="button" disabled={!canSubmit} onClick={() => void submit()} className="flex-1 rounded-xl bg-slate-800 py-2 text-sm font-bold text-white disabled:opacity-50">
            {busy ? "Creo…" : "Crea gruppo"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Group detail ──────────────────────────────────────────────────────────

function GroupDetail({ detail, busLines, onChange, onMessage, onError, onClose }: {
  detail: Detail;
  busLines: BusLineOption[];
  onChange: () => Promise<void> | void;
  onMessage: (m: string) => void;
  onError: (e: string) => void;
  onClose: () => void;
}) {
  const { group, stops, services, bus_reservations, stop_summaries } = detail;
  const pax = summarizeBookingGroupPax({
    expectedPax: group.expected_pax,
    stopExpectedPax: stops.map((s) => s.expected_pax),
    servicePax: services.map((s) => Number(s.pax ?? 0)),
  });
  const statusSummary = computeBookingGroupStatusSummary({
    status: group.status,
    expectedPax: group.expected_pax,
    stopExpectedPax: stops.map((s) => s.expected_pax),
    servicePax: services.map((s) => Number(s.pax ?? 0)),
    busReservationCount: bus_reservations.length,
  });

  const post = async (body: unknown): Promise<PostResult> => {
    const { ok, json } = await api("/api/ops/booking-groups", { method: "POST", body: JSON.stringify(body) });
    if (ok && json.ok) { onMessage("Salvato."); await onChange(); return json; }
    if (ok && typeof json.created_count === "number") {
      onError(`Salvataggio parziale: ${json.created_count} creati, ${json.failed_count ?? 0} falliti.`);
      await onChange();
      return json;
    }
    onError(json.error ?? "Operazione non riuscita");
    return null;
  };

  const cancelGroup = async () => {
    const confirmed = window.confirm("Annullare questo gruppo? I servizi gia creati verranno annullati e rimossi dalla Linea Bus.");
    if (!confirmed) return;
    await post({ action: "update_group", id: group.id, status: "cancelled" });
  };

  return (
    <SectionCard
      title={`Dettaglio: ${group.name}`}
      actions={<button type="button" onClick={onClose} className="text-xs text-slate-500 underline">chiudi</button>}
    >
      <div className="space-y-4">
        {/* Riepilogo */}
        <div className="grid grid-cols-2 gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600 md:grid-cols-3">
          <span><b>Pax previsti:</b> {group.expected_pax}</span>
          <span><b>Stato:</b> {STATUS_LABEL[group.status] ?? group.status}</span>
          <span><b>Arrivo:</b> {group.service_date ?? "da definire"}</span>
          <span><b>Ritorno:</b> {group.return_date ?? "da definire"}</span>
          <span><b>Referente:</b> {group.contact_name ?? "—"}</span>
          <span><b>Telefono:</b> {group.contact_phone ?? "—"}</span>
          <span><b>Tipo:</b> {KIND_LABEL[group.kind] ?? group.kind}</span>
        </div>

        <GroupEditSection key={`edit-${group.id}-${group.updated_at}`} group={group} onSave={(patch) => post({ action: "update_group", id: group.id, ...patch })} />

        {/* FASE A.5 §T — group.status "operational" è uno stato commerciale
            manuale (FASE 1), non certifica da solo che il gruppo sia
            realmente pronto/visibile in Linea Bus: se mancano fermate o
            servizi lo diciamo esplicitamente, senza toccare lo status. */}
        {group.status === "operational" && (!statusSummary.hasStops || !statusSummary.hasServices) ? (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800">
            <div className="font-semibold">Stato gruppo: Operativo — Readiness: Da completare</div>
            <div className="mt-1">
              {pax.plannedPax} pianificati su fermate, {Math.max(0, pax.remainingServicePax)} pax ancora da creare come servizi.
              {!statusSummary.hasStops ? " Nessuna fermata pianificata." : ""} Finché mancano fermate/servizi il gruppo non comparirà in Linea Bus.
            </div>
          </div>
        ) : null}

        {/* Avanzamento pax */}
        <div className={`rounded-lg border p-3 text-sm ${pax.overbooked ? "border-rose-300 bg-rose-50 text-rose-800" : "border-slate-200"}`}>
          <div className="font-semibold">Avanzamento pax</div>
          <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs md:grid-cols-3">
            <span>{pax.expectedPax} previsti</span>
            <span>{pax.plannedPax} pianificati su fermate</span>
            <span>{Math.max(0, pax.unplannedPax)} da pianificare{pax.unplannedPax < 0 ? " (sforato)" : ""}</span>
            <span>{pax.servicePax} creati come services</span>
            <span>{Math.max(0, pax.remainingServicePax)} ancora da creare</span>
            <span>stato suggerito: <b>{STATUS_LABEL[statusSummary.suggestedStatus] ?? statusSummary.suggestedStatus}</b></span>
          </div>
          {pax.overbooked ? <p className="mt-1 font-semibold">Attenzione: overbooking — non corretto automaticamente.</p> : null}
        </div>

        {/* Fermate */}
        <StopsSection stops={stops} stopSummaries={stop_summaries} services={services}
          onAddStop={(s) => post({ action: "add_stop", booking_group_id: group.id, ...s })}
          onUpdateStop={(id, patch) => post({ action: "update_stop", id, ...patch })}
          onDeleteStop={(id) => post({ action: "delete_stop", id })}
          onCreateServices={(stopId, passengers, serviceDate) => post({ action: "create_group_services_batch", booking_group_id: group.id, booking_group_stop_id: stopId, service_date: serviceDate, passengers })}
          arrivalDate={group.service_date}
          returnDate={group.return_date}
          busLines={busLines}
          preferExclusiveLine={group.kind === "bus_exclusive"}
        />

        {/* Bus riservato */}
        {(group.kind === "bus_exclusive" || group.kind === "bus_group") ? (
          <BusReservationSection key={`bus-${group.id}-${group.updated_at}`} group={group} reservations={bus_reservations}
            onUpsert={(r) => post({ action: "upsert_bus_reservation", booking_group_id: group.id, ...r })}
          />
        ) : null}

        {/* Operativizzazione */}
        <OperationalizeSection groupId={group.id} onMessage={onMessage} onError={onError} onChanged={onChange} />

        {/* Traghetto gruppo */}
        <FerrySection key={`ferry-${group.id}-${group.updated_at}`} group={group} onSave={(patch) => post({ action: "update_group", id: group.id, ...patch })} />

        {/* Stato / cancellazione */}
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 pt-3">
          <label className="text-xs font-medium text-slate-600">Stato:
            <select className="input-saas ml-1" defaultValue={group.status}
              onChange={(e) => void post({ action: "update_group", id: group.id, status: e.target.value })}>
              {BOOKING_GROUP_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
            </select>
          </label>
          {group.status !== "cancelled" ? (
            <button type="button" onClick={() => void cancelGroup()} className="rounded-xl border border-rose-200 px-3 py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-50">
              Annulla gruppo
            </button>
          ) : null}
          <span className="text-[11px] text-slate-400">Annullare il gruppo mantiene lo storico commerciale, ma rimuove i servizi operativi dalla Linea Bus.</span>
        </div>
      </div>
    </SectionCard>
  );
}

function GroupEditSection({ group, onSave }: { group: BookingGroup; onSave: (patch: Record<string, string | number | null>) => Promise<PostResult> }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState(group.name);
  const [expectedPax, setExpectedPax] = useState(String(group.expected_pax));
  const [serviceDate, setServiceDate] = useState(group.service_date ?? "");
  const [returnDate, setReturnDate] = useState(group.return_date ?? "");
  const [contactName, setContactName] = useState(group.contact_name ?? "");
  const [contactPhone, setContactPhone] = useState(group.contact_phone ?? "");
  const [notes, setNotes] = useState(group.notes ?? "");

  if (!open) {
    return <button type="button" className="text-xs font-semibold text-slate-600 underline" onClick={() => setOpen(true)}>Modifica dati gruppo</button>;
  }

  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-sm font-semibold text-slate-800">Dati gruppo</div>
        <button type="button" className="text-xs text-slate-500 underline" onClick={() => setOpen(false)}>chiudi</button>
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        <input className="input-saas" placeholder="Nome gruppo" value={name} onChange={(e) => setName(e.target.value)} />
        <input className="input-saas" type="number" min={1} max={500} placeholder="Pax previsti" value={expectedPax} onChange={(e) => setExpectedPax(e.target.value)} />
        <label className="block text-xs font-medium text-slate-600">Data arrivo
          <input className="input-saas mt-1 w-full" type="date" value={serviceDate} onChange={(e) => setServiceDate(e.target.value)} />
        </label>
        <label className="block text-xs font-medium text-slate-600">Data ritorno
          <input className="input-saas mt-1 w-full" type="date" value={returnDate} onChange={(e) => setReturnDate(e.target.value)} />
        </label>
        <input className="input-saas" placeholder="Referente" value={contactName} onChange={(e) => setContactName(e.target.value)} />
        <input className="input-saas" placeholder="Telefono" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} />
        <textarea rows={2} className="input-saas resize-none md:col-span-2" placeholder="Note" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      <button
        type="button"
        disabled={busy || !name.trim() || !(Number(expectedPax) > 0)}
        onClick={async () => {
          setBusy(true);
          await onSave({
            name: name.trim(),
            expected_pax: Number(expectedPax),
            service_date: serviceDate || null,
            return_date: returnDate || null,
            contact_name: contactName.trim() || null,
            contact_phone: contactPhone.trim() || null,
            notes: notes.trim() || null,
          });
          setBusy(false);
        }}
        className="btn-secondary mt-2 px-3 py-1.5 text-xs disabled:opacity-50"
      >
        {busy ? "Salvo…" : "Salva dati gruppo"}
      </button>
    </div>
  );
}

function StopsSection({ stops, stopSummaries, services, onAddStop, onUpdateStop, onDeleteStop, onCreateServices, arrivalDate, returnDate, busLines, preferExclusiveLine }: {
  stops: BookingGroupStop[];
  stopSummaries: BookingGroupStopPaxSummary[];
  services: Detail["services"];
  onAddStop: (s: { city: string; pickup_point: string | null; expected_pax: number; direction: string; notes: string | null; create_catalog_stop?: boolean; bus_line_id?: string | null; pickup_time?: string | null }) => Promise<PostResult>;
  onUpdateStop: (id: string, patch: { city?: string; pickup_point?: string | null; expected_pax?: number; direction?: string; pickup_time?: string | null }) => Promise<PostResult>;
  onDeleteStop: (id: string) => Promise<PostResult>;
  onCreateServices: (stopId: string, passengers: Array<{ customer_name: string; pax: number }>, serviceDate: string) => Promise<PostResult>;
  arrivalDate: string | null;
  returnDate: string | null;
  busLines: BusLineOption[];
  preferExclusiveLine: boolean;
}) {
  const [city, setCity] = useState("");
  const [pickup, setPickup] = useState("");
  const [pickupTime, setPickupTime] = useState("");
  const [px, setPx] = useState("20");
  const [dir, setDir] = useState("arrival");
  const [persistCatalog, setPersistCatalog] = useState(true);
  const [busLineId, setBusLineId] = useState("");
  const [busy, setBusy] = useState(false);
  const orderedBusLines = useMemo(() => {
    if (!preferExclusiveLine) return busLines;
    return [...busLines].sort((a, b) => {
      const ax = a.code === "GRUPPI_ESCLUSIVI" ? 0 : 1;
      const bx = b.code === "GRUPPI_ESCLUSIVI" ? 0 : 1;
      return ax - bx || a.name.localeCompare(b.name);
    });
  }, [busLines, preferExclusiveLine]);
  const preferredBusLineId = preferExclusiveLine ? busLines.find((line) => line.code === "GRUPPI_ESCLUSIVI")?.id ?? "" : "";
  const effectiveBusLineId = busLineId || preferredBusLineId;
  const canAdd = !busy && city.trim().length > 0 && Number(px) > 0 && (!persistCatalog || Boolean(effectiveBusLineId));

  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="text-sm font-semibold text-slate-800">Punti di carico / fermate</div>
      <div className="mt-2 space-y-2">
        {stops.length === 0 ? <p className="text-xs text-slate-400">Nessuna fermata pianificata.</p> : stops.map((s) => {
          const sum = stopSummaries.find((x) => x.stopId === s.id);
          const linked = services.filter((sv) => sv.booking_group_stop_id === s.id);
          const serviceDate = s.direction === "departure" ? (returnDate ?? arrivalDate) : arrivalDate;
          return (
            <div key={s.id} className={`rounded-lg border p-2 text-xs ${sum?.overbooked ? "border-rose-300 bg-rose-50" : "border-slate-200"}`}>
              <div className="font-semibold uppercase text-slate-700">{s.city}</div>
              <div className="text-slate-500">{s.pickup_point ?? "punto di carico da definire"} · {s.expected_pax} pax · {s.direction}{s.stop_id ? " · fermata catalogo" : ""}</div>
              {sum ? (
                <div className="mt-1 text-slate-600">
                  {sum.expectedPax} previsti · {sum.servicePax} in services · {Math.max(0, sum.remainingServicePax)} da inserire
                  {sum.overbooked ? <span className="ml-1 font-semibold text-rose-700">overbooked</span> : null}
                </div>
              ) : null}
              {linked.length > 0 ? (
                <ul className="mt-1 list-disc pl-4 text-slate-500">
                  {linked.map((sv) => <li key={sv.id}>{sv.customer_name} — {sv.pax} pax <span className="text-slate-400">({sv.status})</span></li>)}
                </ul>
              ) : null}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <EditableStopRow stop={s} onSave={onUpdateStop} />
                {!s.stop_id ? (
                  <StopCatalogLinker stop={s} busLines={orderedBusLines} defaultBusLineId={effectiveBusLineId} onLink={onAddStop} />
                ) : null}
                {linked.length === 0 ? (
                  <button type="button" className="text-[11px] text-rose-600 underline" onClick={() => void onDeleteStop(s.id)}>Elimina fermata</button>
                ) : null}
              </div>
              {(sum?.remainingServicePax ?? s.expected_pax) <= 0 ? (
                <div className="mt-1 text-[11px] font-semibold text-emerald-700">Completato: tutti i pax sono gia in services.</div>
              ) : (
                <StopPassengerBatch
                  stop={s}
                  serviceDate={serviceDate}
                  suggestedPax={Math.max(1, sum?.remainingServicePax ?? s.expected_pax)}
                  onCreate={onCreateServices}
                />
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-[1.1fr_1.4fr_90px_110px_110px]">
        <input className="input-saas" placeholder="Citta / localita *" value={city} onChange={(e) => setCity(e.target.value)} />
        <input className="input-saas" placeholder="Punto di carico" value={pickup} onChange={(e) => setPickup(e.target.value)} />
        <input className="input-saas" type="number" min={1} max={500} placeholder="Pax *" value={px} onChange={(e) => setPx(e.target.value)} />
        <select className="input-saas" value={dir} onChange={(e) => setDir(e.target.value)}>
          <option value="arrival">arrivo</option>
          <option value="departure">partenza</option>
        </select>
        <input className="input-saas" type="time" value={pickupTime} onChange={(e) => setPickupTime(e.target.value)} />
      </div>
      <div className="mt-2 grid gap-2 md:grid-cols-[auto_minmax(220px,1fr)]">
        <label className="flex items-center gap-2 text-xs font-medium text-slate-600">
          <input type="checkbox" checked={persistCatalog} onChange={(e) => setPersistCatalog(e.target.checked)} />
          salva nel catalogo bus
        </label>
        {persistCatalog ? (
          <select className="input-saas text-xs" value={effectiveBusLineId} onChange={(e) => setBusLineId(e.target.value)}>
            <option value="">{busLines.length ? "Seleziona linea bus" : "Nessuna linea bus disponibile"}</option>
            {orderedBusLines.map((line) => (
              <option key={line.id} value={line.id}>{[line.name, line.variant_label, line.family_name].filter(Boolean).join(" - ")}</option>
            ))}
          </select>
        ) : null}
      </div>
      <button type="button" disabled={!canAdd}
        onClick={async () => {
          setBusy(true);
          const result = await onAddStop({
            city: city.trim(),
            pickup_point: pickup.trim() || null,
            expected_pax: Number(px),
            direction: dir,
            notes: null,
            create_catalog_stop: persistCatalog,
            bus_line_id: persistCatalog ? effectiveBusLineId : null,
            pickup_time: pickupTime || null,
          });
          setBusy(false);
          if (result) { setCity(""); setPickup(""); setPickupTime(""); setPx("20"); }
        }}
        className="btn-secondary mt-2 px-3 py-1.5 text-xs disabled:opacity-50">{busy ? "Aggiungo…" : "+ Aggiungi fermata"}</button>
    </div>
  );
}

function StopCatalogLinker({ stop, busLines, defaultBusLineId, onLink }: {
  stop: BookingGroupStop;
  busLines: BusLineOption[];
  defaultBusLineId: string;
  onLink: (s: { city: string; pickup_point: string | null; expected_pax: number; direction: string; notes: string | null; create_catalog_stop?: boolean; bus_line_id?: string | null; pickup_time?: string | null }) => Promise<PostResult>;
}) {
  const [open, setOpen] = useState(false);
  const [lineId, setLineId] = useState(defaultBusLineId);
  const [time, setTime] = useState("");
  const [busy, setBusy] = useState(false);
  const effectiveLineId = lineId || defaultBusLineId;

  if (!open) {
    return (
      <button type="button" className="text-[11px] font-semibold text-slate-600 underline" onClick={() => setOpen(true)}>
        Collega/orario catalogo
      </button>
    );
  }

  return (
    <div className="w-full rounded-lg border border-slate-200 bg-slate-50 p-2">
      <div className="grid gap-2 md:grid-cols-[minmax(220px,1fr)_110px_auto_auto]">
        <select className="input-saas text-xs" value={effectiveLineId} onChange={(e) => setLineId(e.target.value)}>
          <option value="">{busLines.length ? "Seleziona linea bus" : "Nessuna linea bus disponibile"}</option>
          {busLines.map((line) => (
            <option key={line.id} value={line.id}>{[line.name, line.variant_label, line.family_name].filter(Boolean).join(" - ")}</option>
          ))}
        </select>
        <input className="input-saas text-xs" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        <button
          type="button"
          className="rounded-lg bg-slate-800 px-3 py-2 text-[11px] font-bold text-white disabled:opacity-50"
          disabled={busy || !effectiveLineId || !time}
          onClick={async () => {
            setBusy(true);
            await onLink({
              city: stop.city,
              pickup_point: stop.pickup_point,
              expected_pax: stop.expected_pax,
              direction: stop.direction,
              notes: stop.notes,
              create_catalog_stop: true,
              bus_line_id: effectiveLineId,
              pickup_time: time,
            });
            setBusy(false);
            setOpen(false);
          }}
        >
          {busy ? "Salvo..." : "Salva orario"}
        </button>
        <button type="button" className="text-[11px] text-slate-500 underline" onClick={() => setOpen(false)}>chiudi</button>
      </div>
    </div>
  );
}

function EditableStopRow({ stop, onSave }: {
  stop: BookingGroupStop;
  onSave: (id: string, patch: { city?: string; pickup_point?: string | null; expected_pax?: number; direction?: string; pickup_time?: string | null }) => Promise<PostResult>;
}) {
  const [open, setOpen] = useState(false);
  const [city, setCity] = useState(stop.city);
  const [pickup, setPickup] = useState(stop.pickup_point ?? "");
  const [pax, setPax] = useState(String(stop.expected_pax));
  const [direction, setDirection] = useState(stop.direction);
  const [pickupTime, setPickupTime] = useState("");
  const [busy, setBusy] = useState(false);
  const canSave = city.trim().length > 0 && Number(pax) > 0;

  if (!open) {
    return (
      <button
        type="button"
        className="text-[11px] font-semibold text-indigo-600 underline"
        onClick={() => {
          setCity(stop.city);
          setPickup(stop.pickup_point ?? "");
          setPax(String(stop.expected_pax));
          setDirection(stop.direction);
          setOpen(true);
        }}
      >
        Modifica città/punto
      </button>
    );
  }

  return (
    <div className="w-full rounded-lg border border-indigo-100 bg-indigo-50/60 p-2">
      <div className="grid gap-2 md:grid-cols-[1fr_1.4fr_90px_110px_110px]">
        <input className="input-saas text-xs" placeholder="Citta / localita" value={city} onChange={(e) => setCity(e.target.value)} />
        <input className="input-saas text-xs" placeholder="Punto di carico" value={pickup} onChange={(e) => setPickup(e.target.value)} />
        <input className="input-saas text-xs" type="number" min={1} max={500} value={pax} onChange={(e) => setPax(e.target.value)} />
        <select className="input-saas text-xs" value={direction} onChange={(e) => setDirection(e.target.value as "arrival" | "departure")}>
          <option value="arrival">arrivo</option>
          <option value="departure">partenza</option>
        </select>
        <input className="input-saas text-xs" type="time" value={pickupTime} onChange={(e) => setPickupTime(e.target.value)} />
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          className="rounded bg-indigo-700 px-3 py-1.5 text-[11px] font-bold text-white disabled:opacity-50"
          disabled={busy || !canSave}
          onClick={async () => {
            setBusy(true);
            const result = await onSave(stop.id, {
              city: city.trim(),
              pickup_point: pickup.trim() || null,
              expected_pax: Number(pax),
              direction,
              pickup_time: pickupTime || null,
            });
            setBusy(false);
            if (result) setOpen(false);
          }}
        >
          {busy ? "Salvo..." : "Salva modifica"}
        </button>
        <button type="button" className="text-[11px] text-slate-500 underline" onClick={() => setOpen(false)}>annulla</button>
      </div>
      <p className="mt-1 text-[11px] text-slate-500">
        Se la fermata e collegata al catalogo, aggiorno anche la fermata della Linea Bus.
      </p>
    </div>
  );
}

function StopPassengerBatch({ stop, serviceDate, suggestedPax, onCreate }: {
  stop: BookingGroupStop;
  serviceDate: string | null;
  suggestedPax: number;
  onCreate: (stopId: string, rows: Array<{ customer_name: string; pax: number }>, serviceDate: string) => Promise<PostResult>;
}) {
  const [open, setOpen] = useState(false);
  const defaultName = stop.pickup_point ? `${stop.city} - ${stop.pickup_point}` : stop.city;
  const [rows, setRows] = useState<Array<{ name: string; pax: string }>>([{ name: defaultName, pax: String(suggestedPax) }]);
  const [busy, setBusy] = useState(false);
  const disabled = !serviceDate;
  const valid = rows.filter((r) => r.name.trim() && Number(r.pax) > 0);
  const totalPax = useMemo(() => valid.reduce((n, r) => n + Number(r.pax), 0), [valid]);

  if (!open) {
    return <button type="button" className="mt-1 text-[11px] text-slate-500 underline" onClick={() => setOpen(true)}>+ Passeggeri / sottogruppi</button>;
  }
  return (
    <div className="mt-2 rounded-lg border border-slate-200 bg-white p-3">
      {disabled ? <p className="mb-2 text-[11px] text-rose-600">Imposta prima la data {stop.direction === "departure" ? "ritorno" : "arrivo"} del gruppo per creare i servizi.</p> : null}
      {rows.map((r, i) => (
        <div key={i} className="mb-2 grid grid-cols-[minmax(0,1fr)_96px_auto] gap-2">
          <input className="input-saas min-w-0 text-xs" placeholder="Nominativo / sottogruppo" value={r.name} onChange={(e) => setRows((p) => p.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
          <input className="input-saas text-xs" type="number" min={1} max={500} value={r.pax} onChange={(e) => setRows((p) => p.map((x, j) => j === i ? { ...x, pax: e.target.value } : x))} />
          <button
            type="button"
            className="rounded-lg border border-slate-200 px-2 text-xs text-slate-500 disabled:opacity-40"
            disabled={rows.length === 1}
            onClick={() => setRows((p) => p.filter((_, j) => j !== i))}
          >
            x
          </button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="text-[11px] text-slate-500 underline" onClick={() => setRows((p) => [...p, { name: "", pax: "1" }])}>Aggiungi riga</button>
        <button type="button" className="text-[11px] text-slate-500 underline" onClick={() => setOpen(false)}>chiudi</button>
        <button type="button" disabled={busy || disabled || valid.length === 0}
          className="rounded bg-slate-800 px-2 py-1 text-[11px] font-bold text-white disabled:opacity-50"
          onClick={async () => {
            if (!serviceDate) return;
            setBusy(true);
            const result = await onCreate(stop.id, valid.map((r) => ({ customer_name: r.name.trim(), pax: Number(r.pax) })), serviceDate);
            setBusy(false);
            if (result && Number(result.failed_count ?? 0) === 0) {
              setRows([{ name: defaultName, pax: String(suggestedPax) }]);
              setOpen(false);
            }
          }}>
          {busy ? "Creo…" : `Crea ${valid.length} servizi (${totalPax} pax)`}
        </button>
      </div>
    </div>
  );
}

function BusReservationSection({ group, reservations, onUpsert }: {
  group: BookingGroup;
  reservations: BookingGroupBusReservation[];
  onUpsert: (r: { bus_unit_id: string; service_date: string; reserved_pax: number; exclusive: boolean }) => Promise<unknown>;
}) {
  const [unitId, setUnitId] = useState("");
  const [date, setDate] = useState(group.service_date ?? group.return_date ?? "");
  const [rp, setRp] = useState(String(group.expected_pax));
  const [exclusive, setExclusive] = useState(true);
  const [buses, setBuses] = useState<AvailableBus[]>([]);
  const [loadingBuses, setLoadingBuses] = useState(false);
  const [busy, setBusy] = useState(false);

  const loadBuses = async () => {
    if (!date || !(Number(rp) > 0)) return;
    setLoadingBuses(true);
    const { ok, json } = await api(`/api/ops/booking-groups?available_buses_for_group=${group.id}&service_date=${date}&required_capacity=${Number(rp)}`);
    setLoadingBuses(false);
    if (ok && json.ok) setBuses(json.buses ?? []);
    else setBuses([]);
  };

  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="text-sm font-semibold text-slate-800">Bus riservato (date-scoped)</div>
      {reservations.length > 0 ? (
        <ul className="mt-1 list-disc pl-4 text-xs text-slate-600">
          {reservations.map((r) => <li key={r.id}>{r.service_date} · unit {r.bus_unit_id.slice(0, 8)} · {r.reserved_pax} pax · {r.exclusive ? "esclusivo" : "non esclusivo"}</li>)}
        </ul>
      ) : <p className="mt-1 text-xs text-slate-400">Nessuna riserva. La riserva vale SOLO per la data indicata.</p>}
      <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-[1fr_1fr_1fr_auto]">
        <select className="input-saas text-xs" value={unitId} onChange={(e) => setUnitId(e.target.value)}>
          <option value="">{loadingBuses ? "Carico bus…" : "Seleziona bus disponibile"}</option>
          {buses.map((bus) => (
            <option key={bus.id} value={bus.id}>{bus.label} · {bus.capacity} pax{bus.tag ? ` · ${bus.tag}` : ""}</option>
          ))}
        </select>
        <input className="input-saas text-xs" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <input className="input-saas text-xs" type="number" min={1} value={rp} onChange={(e) => setRp(e.target.value)} />
        <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={exclusive} onChange={(e) => setExclusive(e.target.checked)} /> esclusivo</label>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" disabled={loadingBuses || !date || !(Number(rp) > 0)} onClick={() => void loadBuses()}
          className="btn-secondary px-3 py-1.5 text-xs disabled:opacity-50">{loadingBuses ? "Cerco…" : "Mostra bus disponibili"}</button>
        <button type="button" disabled={busy || !unitId.trim() || !date || !(Number(rp) > 0)}
          onClick={async () => { setBusy(true); await onUpsert({ bus_unit_id: unitId.trim(), service_date: date, reserved_pax: Number(rp), exclusive }); setBusy(false); }}
          className="btn-secondary px-3 py-1.5 text-xs disabled:opacity-50">{busy ? "Salvo…" : "Salva riserva"}</button>
      </div>
      <p className="mt-1 text-[11px] text-slate-400">Non modifica tag/group_name/status del bus. Warning se pax riservati &gt; capacità va gestito lato bus-network.</p>
    </div>
  );
}

const MISSING_LABEL: Record<string, string> = {
  missing_date: "data mancante", missing_time: "orario mancante (00:00 placeholder)", missing_direction: "direzione mancante",
  missing_city: "città mancante", missing_pickup_point: "punto di carico mancante", missing_hotel: "hotel mancante",
  missing_customer_name: "nominativo mancante", missing_booking_group_id: "gruppo non collegato",
  missing_booking_group_stop_id: "fermata gruppo non collegata", invalid_pax: "pax non valido",
};
const WARN_LABEL: Record<string, string> = {
  bus_reservation_missing: "nessun bus riservato per la data", reserved_pax_below_expected: "pax riservati < previsti",
  reserved_pax_above_capacity: "pax riservati > capacità bus", ferry_outbound_missing: "traghetto andata: default/da definire",
  ferry_return_missing: "traghetto ritorno: default/da definire", allocation_pending: "allocazione bus da completare",
};

type PreviewSvc = { service_id: string; customer_name: string | null; pax: number; ready: boolean; already_operational: boolean; missing_fields: string[]; warnings: string[] };
type Preview = {
  ok: boolean; expected_pax: number; planned_pax: number; service_pax: number;
  services_total: number; services_ready: number; services_blocked: number; services_already_operational: number;
  warnings: string[]; services: PreviewSvc[];
};

function OperationalizeSection({ groupId, onMessage, onError, onChanged }: {
  groupId: string; onMessage: (m: string) => void; onError: (e: string) => void; onChanged: () => Promise<void> | void;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const runPreview = async () => {
    setBusy(true);
    const { ok, json } = await api("/api/ops/booking-groups", { method: "POST", body: JSON.stringify({ action: "preview_operationalize_group", booking_group_id: groupId }) });
    setBusy(false);
    if (ok && json.ok) { setPreview(json as Preview); setChecked(new Set((json.services as PreviewSvc[]).filter((s) => s.ready).map((s) => s.service_id))); }
    else onError(json.error ?? "Preview non riuscita");
  };

  const confirm = async () => {
    if (checked.size === 0) return;
    setBusy(true);
    const { ok, status, json } = await api("/api/ops/booking-groups", { method: "POST", body: JSON.stringify({ action: "operationalize_group", booking_group_id: groupId, service_ids: [...checked] }) });
    setBusy(false);
    if (ok || status === 207) {
      onMessage(`Operativi: ${json.operationalized?.length ?? 0}${json.blocked?.length ? ` · Bloccati: ${json.blocked.length}` : ""}`);
      setPreview(null); setChecked(new Set()); await onChanged();
    } else onError(json.error ?? `Nessun servizio operativizzabile (HTTP ${status}).`);
  };

  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-slate-800">Operativizzazione</div>
        <button type="button" disabled={busy} onClick={() => void runPreview()} className="btn-secondary px-3 py-1.5 text-xs disabled:opacity-50">Verifica servizi</button>
      </div>
      {!preview ? (
        <p className="mt-1 text-[11px] text-slate-400">Verifica cosa manca prima di rendere operativi i servizi. Nessuna scrittura in preview.</p>
      ) : (
        <div className="mt-2 space-y-2 text-xs">
          <div className="flex flex-wrap gap-3">
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 font-semibold text-emerald-700">Pronti: {preview.services_ready}</span>
            <span className="rounded-full bg-amber-100 px-2 py-0.5 font-semibold text-amber-700">Da completare: {preview.services_blocked}</span>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 font-semibold text-slate-600">Già operativi: {preview.services_already_operational}</span>
          </div>
          {preview.warnings.length > 0 ? (
            <p className="text-amber-700">Gruppo: {preview.warnings.map((w) => WARN_LABEL[w] ?? w).join(" · ")}</p>
          ) : null}
          <ul className="space-y-1">
            {preview.services.map((s) => {
              const badge = s.already_operational ? "Operativo" : s.ready ? "Pronto" : "Bloccato";
              const badgeCls = s.already_operational ? "bg-slate-200 text-slate-700" : s.ready ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700";
              return (
                <li key={s.service_id} className="flex items-start gap-2 rounded border border-slate-200 p-1.5">
                  {s.ready ? (
                    <input type="checkbox" className="mt-0.5" checked={checked.has(s.service_id)}
                      onChange={(e) => setChecked((p) => { const n = new Set(p); if (e.target.checked) n.add(s.service_id); else n.delete(s.service_id); return n; })} />
                  ) : <span className="w-3" />}
                  <div className="flex-1">
                    <span className="font-semibold text-slate-700">{s.customer_name ?? "—"}</span> — {s.pax} pax
                    <span className={`ml-2 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${badgeCls}`}>{badge}</span>
                    {s.missing_fields.length > 0 ? <div className="text-rose-600">manca: {s.missing_fields.map((m) => MISSING_LABEL[m] ?? m).join(", ")}</div> : null}
                    {s.warnings.length > 0 ? <div className="text-amber-600">{s.warnings.map((w) => WARN_LABEL[w] ?? w).join(", ")}</div> : null}
                  </div>
                </li>
              );
            })}
          </ul>
          <button type="button" disabled={busy || checked.size === 0} onClick={() => void confirm()}
            className="rounded-xl bg-slate-800 px-3 py-2 text-xs font-bold text-white disabled:opacity-50">
            Rendi operativi i selezionati ({checked.size})
          </button>
        </div>
      )}
    </div>
  );
}

function FerrySection({ group, onSave }: { group: BookingGroup; onSave: (patch: Record<string, string | null>) => Promise<unknown> }) {
  const f = (k: keyof BookingGroup) => (group[k] as string | null) ?? "";
  const [state, setState] = useState<Record<string, string>>({
    outbound_ferry_company: f("outbound_ferry_company"), outbound_departure_port: f("outbound_departure_port"),
    outbound_ferry_time: f("outbound_ferry_time"), outbound_arrival_port: f("outbound_arrival_port"),
    outbound_expected_arrival_time: f("outbound_expected_arrival_time"),
    return_ferry_company: f("return_ferry_company"), return_departure_port: f("return_departure_port"),
    return_ferry_time: f("return_ferry_time"), return_arrival_port: f("return_arrival_port"),
    return_expected_arrival_time: f("return_expected_arrival_time"),
  });
  const [busy, setBusy] = useState(false);
  const upd = (k: string, v: string) => setState((p) => ({ ...p, [k]: v }));
  const row = (prefix: "outbound" | "return") => (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
      <input className="input-saas text-xs" placeholder="Compagnia" value={state[`${prefix}_ferry_company`]} onChange={(e) => upd(`${prefix}_ferry_company`, e.target.value)} />
      <input className="input-saas text-xs" placeholder="Porto partenza" value={state[`${prefix}_departure_port`]} onChange={(e) => upd(`${prefix}_departure_port`, e.target.value)} />
      <input className="input-saas text-xs" type="time" value={state[`${prefix}_ferry_time`]} onChange={(e) => upd(`${prefix}_ferry_time`, e.target.value)} />
      <input className="input-saas text-xs" placeholder="Porto arrivo" value={state[`${prefix}_arrival_port`]} onChange={(e) => upd(`${prefix}_arrival_port`, e.target.value)} />
      <input className="input-saas text-xs" type="time" value={state[`${prefix}_expected_arrival_time`]} onChange={(e) => upd(`${prefix}_expected_arrival_time`, e.target.value)} />
    </div>
  );
  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="text-sm font-semibold text-slate-800">Traghetto gruppo <span className="font-normal text-slate-400">(vuoto = default linea / da definire — non modifica bus_line_ferry_config)</span></div>
      <div className="mt-2 text-[11px] font-semibold text-slate-500">Andata → Ischia</div>
      {row("outbound")}
      <div className="mt-2 text-[11px] font-semibold text-slate-500">Ritorno ← Ischia</div>
      {row("return")}
      <button type="button" disabled={busy} className="btn-secondary mt-2 px-3 py-1.5 text-xs disabled:opacity-50"
        onClick={async () => {
          setBusy(true);
          await onSave(Object.fromEntries(Object.entries(state).map(([k, v]) => [k, v.trim() || null])));
          setBusy(false);
        }}>
        {busy ? "Salvo…" : "Salva traghetto gruppo"}
      </button>
    </div>
  );
}
