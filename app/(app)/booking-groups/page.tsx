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
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [showNew, setShowNew] = useState(false);

  const loadList = useCallback(async () => {
    setLoading(true);
    const { ok, json } = await api("/api/ops/booking-groups");
    setLoading(false);
    if (ok && json.ok) setGroups(json.groups ?? []);
    else setErr(json.error ?? "Errore caricamento gruppi");
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    const { ok, json } = await api(`/api/ops/booking-groups?id=${id}`);
    if (ok && json.ok) setDetail(json as Detail);
    else setErr(json.error ?? "Errore caricamento dettaglio");
  }, []);

  useEffect(() => { void loadList(); }, [loadList]);
  useEffect(() => { if (selectedId) void loadDetail(selectedId); }, [selectedId, loadDetail]);

  const closeDetail = useCallback(() => { setSelectedId(null); setDetail(null); }, []);

  const refresh = useCallback(async () => {
    await loadList();
    if (selectedId) await loadDetail(selectedId);
  }, [loadList, loadDetail, selectedId]);

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
        {loading ? (
          <p className="text-sm text-slate-500">Caricamento…</p>
        ) : groups.length === 0 ? (
          <EmptyState title="Nessun gruppo" description="Crea il primo gruppo prenotazione." />
        ) : (
          <div className="space-y-2">
            {groups.map((g) => {
              const s = summarizeBookingGroupPax({ expectedPax: g.expected_pax, stopExpectedPax: [], servicePax: [] });
              return (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => setSelectedId(g.id)}
                  className={`w-full rounded-xl border px-3 py-2 text-left text-sm ${selectedId === g.id ? "border-slate-800 bg-slate-50" : "border-slate-200 hover:bg-slate-50"}`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-slate-800">{g.name}</span>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600">{STATUS_LABEL[g.status] ?? g.status}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-slate-500">
                    <span>{KIND_LABEL[g.kind] ?? g.kind}</span>
                    {g.service_date ? <span>{g.service_date}</span> : <span>data da definire</span>}
                    <span className="font-semibold text-slate-700">{s.expectedPax} previsti</span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </SectionCard>

      {detail ? <GroupDetail detail={detail} onChange={refresh} onMessage={setMsg} onError={setErr} onClose={closeDetail} /> : null}

      {showNew ? <NewGroupForm onClose={() => setShowNew(false)} onCreated={async (id) => { setShowNew(false); await loadList(); setSelectedId(id); }} onError={setErr} /> : null}
    </div>
  );
}

// ─── New group form ────────────────────────────────────────────────────────

function NewGroupForm({ onClose, onCreated, onError }: { onClose: () => void; onCreated: (id: string) => void; onError: (e: string) => void }) {
  const [name, setName] = useState("");
  const [expectedPax, setExpectedPax] = useState("50");
  const [kind, setKind] = useState<string>("bus_exclusive");
  const [status, setStatus] = useState<string>("to_complete");
  const [serviceDate, setServiceDate] = useState("");
  const [contactName, setContactName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

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
        service_date: serviceDate || null,
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
        <div className="grid grid-cols-2 gap-2">
          <label className="block text-xs font-medium text-slate-600">Pax previsti *
            <input type="number" min={1} max={500} className="input-saas mt-1 w-full" value={expectedPax} onChange={(e) => setExpectedPax(e.target.value)} />
          </label>
          <label className="block text-xs font-medium text-slate-600">Data
            <input type="date" className="input-saas mt-1 w-full" value={serviceDate} onChange={(e) => setServiceDate(e.target.value)} />
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
        <p className="text-[11px] text-slate-400">Solo Nome e Pax previsti sono obbligatori. Hotel, fermate, nominativi, nave e bus si aggiungono dopo.</p>
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="flex-1 rounded-xl border border-slate-200 py-2 text-sm font-semibold text-slate-600">Annulla</button>
          <button type="button" disabled={busy || !name.trim() || !(Number(expectedPax) > 0)} onClick={() => void submit()} className="flex-1 rounded-xl bg-slate-800 py-2 text-sm font-bold text-white disabled:opacity-50">
            {busy ? "Creo…" : "Crea gruppo"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Group detail ──────────────────────────────────────────────────────────

function GroupDetail({ detail, onChange, onMessage, onError, onClose }: {
  detail: Detail;
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

  const post = async (body: unknown) => {
    const { ok, json } = await api("/api/ops/booking-groups", { method: "POST", body: JSON.stringify(body) });
    if (ok && (json.ok || typeof json.created_count === "number")) { onMessage("Salvato."); await onChange(); return json; }
    onError(json.error ?? "Operazione non riuscita");
    return null;
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
          <span><b>Data:</b> {group.service_date ?? "da definire"}</span>
          <span><b>Referente:</b> {group.contact_name ?? "—"}</span>
          <span><b>Telefono:</b> {group.contact_phone ?? "—"}</span>
          <span><b>Tipo:</b> {KIND_LABEL[group.kind] ?? group.kind}</span>
        </div>

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
        <StopsSection groupId={group.id} stops={stops} stopSummaries={stop_summaries} services={services}
          onAddStop={(s) => post({ action: "add_stop", booking_group_id: group.id, ...s })}
          onCreateServices={(stopId, passengers) => post({ action: "create_group_services_batch", booking_group_id: group.id, booking_group_stop_id: stopId, passengers })}
          serviceDateMissing={!group.service_date}
        />

        {/* Bus riservato */}
        {(group.kind === "bus_exclusive" || group.kind === "bus_group") ? (
          <BusReservationSection groupId={group.id} reservations={bus_reservations} defaultDate={group.service_date}
            onUpsert={(r) => post({ action: "upsert_bus_reservation", booking_group_id: group.id, ...r })}
          />
        ) : null}

        {/* Traghetto gruppo */}
        <FerrySection group={group} onSave={(patch) => post({ action: "update_group", id: group.id, ...patch })} />

        {/* Stato / cancellazione */}
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 pt-3">
          <label className="text-xs font-medium text-slate-600">Stato:
            <select className="input-saas ml-1" defaultValue={group.status}
              onChange={(e) => void post({ action: "update_group", id: group.id, status: e.target.value })}>
              {BOOKING_GROUP_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
            </select>
          </label>
          <span className="text-[11px] text-slate-400">Preferisci lo stato <b>Annullato</b> alla cancellazione fisica: i servizi esistenti non verranno cancellati.</span>
        </div>
      </div>
    </SectionCard>
  );
}

function StopsSection({ groupId, stops, stopSummaries, services, onAddStop, onCreateServices, serviceDateMissing }: {
  groupId: string;
  stops: BookingGroupStop[];
  stopSummaries: BookingGroupStopPaxSummary[];
  services: Detail["services"];
  onAddStop: (s: { city: string; pickup_point: string | null; expected_pax: number; direction: string; notes: string | null }) => Promise<unknown>;
  onCreateServices: (stopId: string, passengers: Array<{ customer_name: string; pax: number }>) => Promise<unknown>;
  serviceDateMissing: boolean;
}) {
  const [city, setCity] = useState("");
  const [pickup, setPickup] = useState("");
  const [px, setPx] = useState("20");
  const [dir, setDir] = useState("arrival");
  void groupId;

  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="text-sm font-semibold text-slate-800">Fermate / punti di carico</div>
      <div className="mt-2 space-y-2">
        {stops.length === 0 ? <p className="text-xs text-slate-400">Nessuna fermata pianificata.</p> : stops.map((s) => {
          const sum = stopSummaries.find((x) => x.stopId === s.id);
          const linked = services.filter((sv) => sv.booking_group_stop_id === s.id);
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
              <StopPassengerBatch stopId={s.id} disabled={serviceDateMissing} onCreate={onCreateServices} />
            </div>
          );
        })}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
        <input className="input-saas" placeholder="Città *" value={city} onChange={(e) => setCity(e.target.value)} />
        <input className="input-saas" placeholder="Punto di carico" value={pickup} onChange={(e) => setPickup(e.target.value)} />
        <input className="input-saas" type="number" min={1} max={500} placeholder="Pax *" value={px} onChange={(e) => setPx(e.target.value)} />
        <select className="input-saas" value={dir} onChange={(e) => setDir(e.target.value)}>
          <option value="arrival">arrivo</option>
          <option value="departure">partenza</option>
        </select>
      </div>
      <button type="button" disabled={!city.trim() || !(Number(px) > 0)}
        onClick={async () => { await onAddStop({ city: city.trim(), pickup_point: pickup.trim() || null, expected_pax: Number(px), direction: dir, notes: null }); setCity(""); setPickup(""); setPx("20"); }}
        className="btn-secondary mt-2 px-3 py-1.5 text-xs disabled:opacity-50">+ Aggiungi fermata</button>
    </div>
  );
}

function StopPassengerBatch({ stopId, disabled, onCreate }: {
  stopId: string;
  disabled: boolean;
  onCreate: (stopId: string, rows: Array<{ customer_name: string; pax: number }>) => Promise<unknown>;
}) {
  const [rows, setRows] = useState<Array<{ name: string; pax: string }>>([{ name: "", pax: "1" }]);
  const [open, setOpen] = useState(false);
  const valid = rows.filter((r) => r.name.trim() && Number(r.pax) > 0);
  const totalPax = useMemo(() => valid.reduce((n, r) => n + Number(r.pax), 0), [valid]);

  if (!open) {
    return <button type="button" className="mt-1 text-[11px] text-slate-500 underline" onClick={() => setOpen(true)}>+ Passeggeri / sottogruppi</button>;
  }
  return (
    <div className="mt-2 rounded border border-slate-200 bg-white p-2">
      {disabled ? <p className="mb-1 text-[11px] text-rose-600">Imposta prima la data del gruppo per creare i servizi.</p> : null}
      {rows.map((r, i) => (
        <div key={i} className="mb-1 flex gap-1">
          <input className="input-saas flex-1 text-xs" placeholder="Nominativo / sottogruppo" value={r.name} onChange={(e) => setRows((p) => p.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
          <input className="input-saas w-16 text-xs" type="number" min={1} value={r.pax} onChange={(e) => setRows((p) => p.map((x, j) => j === i ? { ...x, pax: e.target.value } : x))} />
        </div>
      ))}
      <div className="flex items-center gap-2">
        <button type="button" className="text-[11px] text-slate-500 underline" onClick={() => setRows((p) => [...p, { name: "", pax: "1" }])}>Aggiungi riga</button>
        <button type="button" disabled={disabled || valid.length === 0}
          className="rounded bg-slate-800 px-2 py-1 text-[11px] font-bold text-white disabled:opacity-50"
          onClick={async () => { await onCreate(stopId, valid.map((r) => ({ customer_name: r.name.trim(), pax: Number(r.pax) }))); setRows([{ name: "", pax: "1" }]); setOpen(false); }}>
          Crea {valid.length} servizi ({totalPax} pax)
        </button>
      </div>
    </div>
  );
}

function BusReservationSection({ groupId, reservations, defaultDate, onUpsert }: {
  groupId: string;
  reservations: BookingGroupBusReservation[];
  defaultDate: string | null;
  onUpsert: (r: { bus_unit_id: string; service_date: string; reserved_pax: number; exclusive: boolean }) => Promise<unknown>;
}) {
  const [unitId, setUnitId] = useState("");
  const [date, setDate] = useState(defaultDate ?? "");
  const [rp, setRp] = useState("50");
  const [exclusive, setExclusive] = useState(true);
  void groupId;
  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="text-sm font-semibold text-slate-800">Bus riservato (date-scoped)</div>
      {reservations.length > 0 ? (
        <ul className="mt-1 list-disc pl-4 text-xs text-slate-600">
          {reservations.map((r) => <li key={r.id}>{r.service_date} · unit {r.bus_unit_id.slice(0, 8)} · {r.reserved_pax} pax · {r.exclusive ? "esclusivo" : "non esclusivo"}</li>)}
        </ul>
      ) : <p className="mt-1 text-xs text-slate-400">Nessuna riserva. La riserva vale SOLO per la data indicata.</p>}
      <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-4">
        <input className="input-saas text-xs" placeholder="tenant_bus_unit id" value={unitId} onChange={(e) => setUnitId(e.target.value)} />
        <input className="input-saas text-xs" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <input className="input-saas text-xs" type="number" min={1} value={rp} onChange={(e) => setRp(e.target.value)} />
        <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={exclusive} onChange={(e) => setExclusive(e.target.checked)} /> esclusivo</label>
      </div>
      <button type="button" disabled={!unitId.trim() || !date || !(Number(rp) > 0)}
        onClick={() => void onUpsert({ bus_unit_id: unitId.trim(), service_date: date, reserved_pax: Number(rp), exclusive })}
        className="btn-secondary mt-2 px-3 py-1.5 text-xs disabled:opacity-50">Salva riserva</button>
      <p className="mt-1 text-[11px] text-slate-400">Non modifica tag/group_name/status del bus. Warning se pax riservati &gt; capacità va gestito lato bus-network.</p>
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
      <button type="button" className="btn-secondary mt-2 px-3 py-1.5 text-xs"
        onClick={() => void onSave(Object.fromEntries(Object.entries(state).map(([k, v]) => [k, v.trim() || null])))}>
        Salva traghetto gruppo
      </button>
    </div>
  );
}
