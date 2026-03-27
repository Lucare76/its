"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/ui";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";

type Driver = { id: string; name: string; phone: string | null; vehicle_type: string | null; capacity: number; active: boolean };
type Hotel = { id: string; name: string; zone: string | null };
type ServiceIschia = {
  id: string;
  customer_name: string;
  customer_phone: string | null;
  hotel_partenza_name: string;
  hotel_arrivo_name: string;
  hotel_partenza_id: string | null;
  hotel_arrivo_id: string | null;
  travel_date: string;
  orario: string | null;
  pax: number;
  driver_id: string | null;
  status: "pending" | "assigned" | "completed" | "cancelled";
  notes: string | null;
  created_at: string;
};

async function getToken() {
  if (!hasSupabaseEnv || !supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

const STATUS_LABELS: Record<string, string> = {
  pending: "Da assegnare",
  assigned: "Assegnato",
  completed: "Completato",
  cancelled: "Annullato",
};
const STATUS_COLORS: Record<string, string> = {
  pending: "bg-amber-100 text-amber-700",
  assigned: "bg-emerald-100 text-emerald-700",
  completed: "bg-slate-100 text-slate-600",
  cancelled: "bg-rose-100 text-rose-600",
};

function fmtDate(iso: string) {
  return new Date(iso + "T12:00:00").toLocaleDateString("it-IT", { weekday: "short", day: "numeric", month: "short" });
}

export default function ReteIschiaPage() {
  const [services, setServices] = useState<ServiceIschia[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [hotels, setHotels] = useState<Hotel[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [filterDate, setFilterDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [showNewService, setShowNewService] = useState(false);
  const [showNewDriver, setShowNewDriver] = useState(false);

  // New service form
  const [form, setForm] = useState({
    customer_name: "", customer_phone: "", hotel_partenza_name: "",
    hotel_arrivo_name: "", travel_date: new Date().toISOString().slice(0, 10),
    orario: "", pax: 1, notes: "",
  });

  // New driver form
  const [driverForm, setDriverForm] = useState({ name: "", phone: "", vehicle_type: "", capacity: 8 });

  const load = useCallback(async () => {
    const token = await getToken();
    if (!token) { setLoading(false); return; }
    const res = await fetch("/api/ops/rete-ischia", { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json().catch(() => null);
    if (body?.ok) {
      setServices(body.services ?? []);
      setDrivers(body.drivers ?? []);
      setHotels(body.hotels ?? []);
    }
    setLoading(false);
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  const post = useCallback(async (action: string, data: Record<string, unknown>) => {
    const token = await getToken();
    if (!token) return null;
    setSaving(true);
    setMessage("");
    const res = await fetch("/api/ops/rete-ischia", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action, ...data }),
    });
    const body = await res.json().catch(() => null);
    setSaving(false);
    if (!res.ok || !body?.ok) { setMessage(body?.error ?? "Errore."); return null; }
    if (body.services) { setServices(body.services); setDrivers(body.drivers); setHotels(body.hotels); }
    return body;
  }, []);

  const createService = useCallback(async () => {
    if (!form.customer_name.trim() || !form.hotel_partenza_name.trim() || !form.hotel_arrivo_name.trim()) return;
    const partenzaHotel = hotels.find((h) => h.name.toLowerCase().includes(form.hotel_partenza_name.toLowerCase()));
    const arrivoHotel = hotels.find((h) => h.name.toLowerCase().includes(form.hotel_arrivo_name.toLowerCase()));
    const result = await post("create_service", {
      customer_name: form.customer_name.trim(),
      customer_phone: form.customer_phone.trim() || null,
      hotel_partenza_name: form.hotel_partenza_name.trim(),
      hotel_arrivo_name: form.hotel_arrivo_name.trim(),
      hotel_partenza_id: partenzaHotel?.id ?? null,
      hotel_arrivo_id: arrivoHotel?.id ?? null,
      travel_date: form.travel_date,
      orario: form.orario.trim() || null,
      pax: form.pax,
      notes: form.notes.trim() || null,
    });
    if (result) {
      setShowNewService(false);
      setForm({ customer_name: "", customer_phone: "", hotel_partenza_name: "", hotel_arrivo_name: "", travel_date: form.travel_date, orario: "", pax: 1, notes: "" });
    }
  }, [form, hotels, post]);

  const createDriver = useCallback(async () => {
    if (!driverForm.name.trim()) return;
    const result = await post("create_driver", {
      name: driverForm.name.trim(),
      phone: driverForm.phone.trim() || null,
      vehicle_type: driverForm.vehicle_type.trim() || null,
      capacity: driverForm.capacity,
    });
    if (result) {
      setShowNewDriver(false);
      setDriverForm({ name: "", phone: "", vehicle_type: "", capacity: 8 });
    }
  }, [driverForm, post]);

  const filteredServices = services.filter((s) => {
    if (filterStatus !== "all" && s.status !== filterStatus) return false;
    if (filterDate && s.travel_date !== filterDate) return false;
    return true;
  });

  if (loading) return <div className="p-8 text-slate-500">Caricamento rete Ischia...</div>;

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Rete Ischia" subtitle="Servizi interni all'isola — trasferimenti hotel" />

      {message && (
        <div className="mx-6 mb-0 mt-2 rounded-lg bg-rose-50 px-4 py-2 text-sm text-rose-700">{message}</div>
      )}

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-6 py-3">
        <input type="date" value={filterDate} onChange={(e) => setFilterDate(e.target.value)}
          className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm" />
        <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}
          className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-700">
          <option value="all">Tutti gli stati</option>
          <option value="pending">Da assegnare</option>
          <option value="assigned">Assegnati</option>
          <option value="completed">Completati</option>
          <option value="cancelled">Annullati</option>
        </select>
        <div className="ml-auto flex gap-2">
          <button onClick={() => setShowNewDriver(true)}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50">
            + Autista
          </button>
          <button onClick={() => setShowNewService(true)}
            className="rounded-lg bg-indigo-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-indigo-700">
            + Servizio
          </button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Servizi */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">
            {filteredServices.length} servizi · {filterDate ? fmtDate(filterDate) : "tutte le date"}
          </p>

          {filteredServices.length === 0 && (
            <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-slate-400">
              Nessun servizio. Clicca <strong>+ Servizio</strong> per aggiungerne uno.
            </div>
          )}

          {filteredServices.map((svc) => {
            const driver = drivers.find((d) => d.id === svc.driver_id) ?? null;
            return (
              <div key={svc.id} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="flex items-start gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-bold uppercase text-slate-900">{svc.customer_name}</span>
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[svc.status]}`}>
                        {STATUS_LABELS[svc.status]}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-sm text-slate-600">
                      <span>🏨 {svc.hotel_partenza_name} → {svc.hotel_arrivo_name}</span>
                      <span>📅 {fmtDate(svc.travel_date)}{svc.orario ? ` · ${svc.orario}` : ""}</span>
                      <span>👥 {svc.pax} pax</span>
                      {svc.customer_phone && <span>📞 {svc.customer_phone}</span>}
                    </div>
                    {svc.notes && <div className="mt-0.5 text-xs text-slate-400">{svc.notes}</div>}
                  </div>

                  <div className="flex flex-shrink-0 flex-col items-end gap-2">
                    {/* Assign driver */}
                    <select
                      value={svc.driver_id ?? ""}
                      disabled={saving || svc.status === "completed" || svc.status === "cancelled"}
                      onChange={(e) => void post("assign_driver", { service_id: svc.id, driver_id: e.target.value || null })}
                      className="rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-700 disabled:opacity-50">
                      <option value="">— Assegna autista —</option>
                      {drivers.map((d) => (
                        <option key={d.id} value={d.id}>{d.name}{d.vehicle_type ? ` (${d.vehicle_type})` : ""}</option>
                      ))}
                    </select>
                    <div className="flex gap-1">
                      {svc.status === "assigned" && (
                        <button onClick={() => void post("update_status", { service_id: svc.id, status: "completed" })}
                          disabled={saving}
                          className="rounded border border-emerald-200 px-2 py-0.5 text-xs text-emerald-700 hover:bg-emerald-50">
                          ✓ Completato
                        </button>
                      )}
                      {svc.status !== "cancelled" && svc.status !== "completed" && (
                        <button onClick={() => void post("update_status", { service_id: svc.id, status: "cancelled" })}
                          disabled={saving}
                          className="rounded border border-rose-200 px-2 py-0.5 text-xs text-rose-600 hover:bg-rose-50">
                          Annulla
                        </button>
                      )}
                      <button onClick={() => void post("delete_service", { service_id: svc.id })}
                        disabled={saving}
                        className="rounded border border-slate-200 px-2 py-0.5 text-xs text-slate-400 hover:border-rose-300 hover:text-rose-500">
                        ✕
                      </button>
                    </div>
                    {driver && (
                      <div className="text-right text-xs text-slate-500">
                        🚗 {driver.name}{driver.phone ? ` · ${driver.phone}` : ""}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Sidebar autisti */}
        <div className="w-56 flex-shrink-0 overflow-y-auto border-l border-slate-200 bg-slate-50 p-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">Autisti ({drivers.length})</p>
          {drivers.length === 0 && (
            <p className="text-xs text-slate-400">Nessun autista. Clicca + Autista.</p>
          )}
          {drivers.map((d) => {
            const today = services.filter((s) => s.driver_id === d.id && s.travel_date === filterDate && s.status === "assigned");
            return (
              <div key={d.id} className="mb-2 rounded-lg bg-white border border-slate-200 px-3 py-2">
                <div className="font-medium text-slate-800">{d.name}</div>
                {d.vehicle_type && <div className="text-xs text-slate-400">{d.vehicle_type} · {d.capacity} pax</div>}
                {d.phone && <div className="text-xs text-slate-400">{d.phone}</div>}
                {today.length > 0 && (
                  <div className="mt-1 text-xs font-medium text-emerald-600">{today.length} servizi oggi</div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Modal: nuovo servizio */}
      {showNewService && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md space-y-3 rounded-2xl bg-white p-6 shadow-2xl">
            <h2 className="text-lg font-bold text-slate-900">Nuovo servizio Ischia</h2>
            <input value={form.customer_name} onChange={(e) => setForm((f) => ({ ...f, customer_name: e.target.value }))}
              placeholder="Nome cliente *" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
            <input value={form.customer_phone} onChange={(e) => setForm((f) => ({ ...f, customer_phone: e.target.value }))}
              placeholder="Telefono" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
            <input value={form.hotel_partenza_name} onChange={(e) => setForm((f) => ({ ...f, hotel_partenza_name: e.target.value }))}
              placeholder="Hotel partenza *" list="hotels-list" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
            <input value={form.hotel_arrivo_name} onChange={(e) => setForm((f) => ({ ...f, hotel_arrivo_name: e.target.value }))}
              placeholder="Hotel arrivo *" list="hotels-list" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
            <datalist id="hotels-list">
              {hotels.map((h) => <option key={h.id} value={h.name} />)}
            </datalist>
            <div className="flex gap-2">
              <input type="date" value={form.travel_date} onChange={(e) => setForm((f) => ({ ...f, travel_date: e.target.value }))}
                className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm" />
              <input type="time" value={form.orario} onChange={(e) => setForm((f) => ({ ...f, orario: e.target.value }))}
                className="w-28 rounded-lg border border-slate-200 px-3 py-2 text-sm" />
              <input type="number" value={form.pax} min={1} max={60} onChange={(e) => setForm((f) => ({ ...f, pax: parseInt(e.target.value) || 1 }))}
                placeholder="Pax" className="w-16 rounded-lg border border-slate-200 px-3 py-2 text-sm text-center" />
            </div>
            <textarea value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              placeholder="Note (opzionale)" rows={2}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
            <div className="flex gap-3 pt-1">
              <button onClick={() => setShowNewService(false)} className="flex-1 rounded-lg border border-slate-200 py-2 text-sm text-slate-600 hover:bg-slate-50">Annulla</button>
              <button onClick={() => void createService()} disabled={saving || !form.customer_name.trim()}
                className="flex-1 rounded-lg bg-indigo-600 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40">
                {saving ? "Salvataggio..." : "Crea servizio"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: nuovo autista */}
      {showNewDriver && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-sm space-y-3 rounded-2xl bg-white p-6 shadow-2xl">
            <h2 className="text-lg font-bold text-slate-900">Nuovo autista</h2>
            <input value={driverForm.name} onChange={(e) => setDriverForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="Nome *" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
            <input value={driverForm.phone} onChange={(e) => setDriverForm((f) => ({ ...f, phone: e.target.value }))}
              placeholder="Telefono" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
            <input value={driverForm.vehicle_type} onChange={(e) => setDriverForm((f) => ({ ...f, vehicle_type: e.target.value }))}
              placeholder="Tipo veicolo (es: Minibus, Taxi)" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
            <input type="number" value={driverForm.capacity} min={1} max={60} onChange={(e) => setDriverForm((f) => ({ ...f, capacity: parseInt(e.target.value) || 8 }))}
              placeholder="Capienza" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
            <div className="flex gap-3 pt-1">
              <button onClick={() => setShowNewDriver(false)} className="flex-1 rounded-lg border border-slate-200 py-2 text-sm text-slate-600 hover:bg-slate-50">Annulla</button>
              <button onClick={() => void createDriver()} disabled={saving || !driverForm.name.trim()}
                className="flex-1 rounded-lg bg-indigo-600 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40">
                {saving ? "Salvataggio..." : "Aggiungi autista"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
