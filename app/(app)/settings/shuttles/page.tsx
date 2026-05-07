"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { SidePanel } from "@/components/ui/side-panel";
import { getClientSessionContext } from "@/lib/supabase/client-session";
import type { Hotel } from "@/lib/types";
import type { ShuttleSchedule } from "@/lib/shuttle-schedules";

const DAYS_LABEL = ["Dom", "Lun", "Mar", "Mer", "Gio", "Ven", "Sab"];

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function isScheduleActiveOnDate(schedule: ShuttleSchedule, isoDate: string) {
  if (isoDate < schedule.valid_from) return false;
  if (isoDate > schedule.valid_to) return false;
  if (!schedule.days_of_week?.length) return true;
  const dow = new Date(`${isoDate}T12:00:00`).getDay();
  return schedule.days_of_week.includes(dow);
}

type ScheduleFormData = {
  hotel_id: string;
  booking_service_kind: "navetta" | "shuttle_hotel";
  customer_name: string;
  direction: "arrival" | "departure";
  departure_time: string;
  meeting_point: string;
  vessel: string;
  valid_from: string;
  valid_to: string;
  days_of_week: number[];
  notes: string;
};

type TenantDataResponse = {
  ok: boolean;
  hotels: Hotel[];
  error?: string;
};

const emptyForm: ScheduleFormData = {
  hotel_id: "",
  booking_service_kind: "navetta",
  customer_name: "",
  direction: "departure",
  departure_time: "",
  meeting_point: "",
  vessel: "Navetta",
  valid_from: "",
  valid_to: "",
  days_of_week: [1, 2, 3, 4, 5, 6],
  notes: "",
};

function formatSeasonBadge(schedule: ShuttleSchedule) {
  const parts = [`${schedule.valid_from.slice(5).replace("-", "/")}→${schedule.valid_to.slice(5).replace("-", "/")}`];
  if (schedule.days_of_week?.length) {
    parts.push(schedule.days_of_week.map((day) => DAYS_LABEL[day]).join("+"));
  }
  return parts.join(" ");
}

function formatDisplayDate(isoDate: string) {
  return new Date(`${isoDate}T12:00:00`).toLocaleDateString("it-IT", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
}

export default function ShuttleSchedulesPage() {
  const [token, setToken] = useState<string | null>(null);
  const [schedules, setSchedules] = useState<ShuttleSchedule[]>([]);
  const [hotels, setHotels] = useState<Hotel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState(todayIsoDate());

  const [panelOpen, setPanelOpen] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState<ShuttleSchedule | null>(null);
  const [form, setForm] = useState<ScheduleFormData>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const hotelsById = useMemo(() => new Map(hotels.map((hotel) => [hotel.id, hotel])), [hotels]);
  const groupedSchedules = useMemo(() => {
    const grouped = new Map<string, ShuttleSchedule[]>();
    for (const schedule of schedules.filter((item) => isScheduleActiveOnDate(item, selectedDate))) {
      const hotelName = hotelsById.get(schedule.hotel_id ?? "")?.name ?? schedule.customer_name ?? "Senza hotel";
      const current = grouped.get(hotelName) ?? [];
      current.push(schedule);
      grouped.set(hotelName, current);
    }
    return Array.from(grouped.entries())
      .sort((left, right) => left[0].localeCompare(right[0], "it"))
      .map(([hotelName, items]) => [
        hotelName,
        items.sort((left, right) => left.departure_time.localeCompare(right.departure_time)),
      ] as const);
  }, [hotelsById, schedules, selectedDate]);
  const totalActiveSchedules = groupedSchedules.reduce((sum, [, items]) => sum + items.length, 0);

  const fetchSchedules = useCallback(async (accessToken: string) => {
    const [schedulesRes, hotelsRes] = await Promise.all([
      fetch("/api/shuttle-schedules", {
        headers: { authorization: `Bearer ${accessToken}` },
        cache: "no-store",
      }),
      fetch("/api/ops/tenant-data", {
        headers: { authorization: `Bearer ${accessToken}` },
        cache: "no-store",
      }),
    ]);

    const schedulesBody = await schedulesRes.json().catch(() => null) as { ok?: boolean; schedules?: ShuttleSchedule[]; error?: string } | null;
    const hotelsBody = await hotelsRes.json().catch(() => null) as TenantDataResponse | null;

    if (!schedulesRes.ok || !schedulesBody?.ok) {
      throw new Error(schedulesBody?.error ?? "Errore nel caricamento navette.");
    }
    if (!hotelsRes.ok || !hotelsBody?.ok) {
      throw new Error(hotelsBody?.error ?? "Errore nel caricamento hotel.");
    }

    setSchedules(schedulesBody.schedules ?? []);
    setHotels(hotelsBody.hotels ?? []);
  }, []);

  useEffect(() => {
    const load = async () => {
      const session = await getClientSessionContext();
      if (!session.accessToken) {
        setError("Login richiesto.");
        setLoading(false);
        return;
      }
      setToken(session.accessToken);
      try {
        await fetchSchedules(session.accessToken);
      } catch (loadError) {
        setError((loadError as Error).message);
      }
      setLoading(false);
    };
    void load();
  }, [fetchSchedules]);

  function openAdd() {
    setEditingSchedule(null);
    setForm(emptyForm);
    setSaveError(null);
    setPanelOpen(true);
  }

  function openEdit(schedule: ShuttleSchedule) {
    setEditingSchedule(schedule);
    setForm({
      hotel_id: schedule.hotel_id ?? "",
      booking_service_kind: schedule.booking_service_kind,
      customer_name: schedule.customer_name,
      direction: schedule.direction,
      departure_time: schedule.departure_time.slice(0, 5),
      meeting_point: schedule.meeting_point ?? "",
      vessel: schedule.vessel,
      valid_from: schedule.valid_from,
      valid_to: schedule.valid_to,
      days_of_week: schedule.days_of_week ?? [],
      notes: schedule.notes ?? "",
    });
    setSaveError(null);
    setPanelOpen(true);
  }

  function toggleDay(day: number) {
    setForm((current) => ({
      ...current,
      days_of_week: current.days_of_week.includes(day)
        ? current.days_of_week.filter((value) => value !== day)
        : [...current.days_of_week, day].sort(),
    }));
  }

  async function handleSave() {
    if (!token) return;
    setSaving(true);
    setSaveError(null);

    const payload = {
      hotel_id: form.hotel_id || null,
      booking_service_kind: form.booking_service_kind,
      customer_name: form.customer_name,
      direction: form.direction,
      departure_time: form.departure_time,
      meeting_point: form.meeting_point || null,
      vessel: form.vessel || "Navetta",
      valid_from: form.valid_from,
      valid_to: form.valid_to,
      days_of_week: form.days_of_week.length > 0 ? form.days_of_week : null,
      notes: form.notes || null,
    };

    const url = editingSchedule ? `/api/shuttle-schedules/${editingSchedule.id}` : "/api/shuttle-schedules";
    const method = editingSchedule ? "PATCH" : "POST";

    const res = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;

    if (!res.ok || !body?.ok) {
      setSaveError(body?.error ?? "Errore nel salvataggio navetta.");
      setSaving(false);
      return;
    }

    await fetchSchedules(token);
    setPanelOpen(false);
    setSaving(false);
  }

  async function handleDelete(id: string) {
    if (!token) return;
    if (!confirm("Eliminare questo orario navetta? Verranno rimossi anche i servizi futuri collegati.")) return;
    const res = await fetch(`/api/shuttle-schedules/${id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null) as { error?: string } | null;
      setError(body?.error ?? "Eliminazione navetta non riuscita.");
      return;
    }
    setSchedules((current) => current.filter((schedule) => schedule.id !== id));
  }

  if (loading) return <p className="p-6 text-sm text-slate-500">Caricamento...</p>;
  if (error) return <p className="p-6 text-sm text-rose-600">{error}</p>;

  return (
    <>
      <section className="max-w-5xl space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Navette</h1>
          <p className="mt-1 text-sm text-slate-500">
            Gestisci gli orari ricorrenti delle navette hotel. Ogni modifica aggiorna anche le corse future collegate.
          </p>
        </div>

        <div className="card p-5 space-y-3">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h2 className="text-base font-semibold text-slate-800">Lista navette del giorno</h2>
              <p className="mt-1 text-sm text-slate-500">
                Lista del giorno divisa per hotel, così l&apos;operatore vede e gestisce subito le navette corrette.
              </p>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <label className="block min-w-0">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">Data</span>
                <input
                  type="date"
                  value={selectedDate}
                  onChange={(event) => setSelectedDate(event.target.value)}
                  className="input w-full sm:w-40"
                />
              </label>
              <button type="button" className="btn-primary px-3 py-1.5 text-sm" onClick={openAdd}>
                + Aggiungi
              </button>
            </div>
          </div>

          <div className="flex flex-col gap-2 rounded-2xl border border-slate-100 bg-slate-50/70 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Data operativa</p>
              <p className="text-sm font-semibold text-slate-700">{formatDisplayDate(selectedDate)}</p>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <span className="rounded-full border border-slate-200 bg-white px-2.5 py-1 font-medium text-slate-600">
                {groupedSchedules.length} hotel
              </span>
              <span className="rounded-full border border-slate-200 bg-white px-2.5 py-1 font-medium text-slate-600">
                {totalActiveSchedules} corse
              </span>
            </div>
          </div>

          {groupedSchedules.length === 0 ? (
            <p className="text-sm italic text-slate-400">Nessuna navetta attiva per la data selezionata.</p>
          ) : (
            <div className="space-y-5">
              {groupedSchedules.map(([hotelName, hotelSchedules]) => (
                <div key={hotelName} className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <div className="w-full border-b border-slate-100 bg-slate-50/80 px-4 py-3 sm:flex sm:items-center sm:justify-between">
                      <div>
                        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-700">{hotelName}</h3>
                        <p className="mt-1 text-xs text-slate-400">{hotelSchedules.length} corse attive nel giorno selezionato</p>
                      </div>
                      <div className="mt-2 flex items-center gap-2 sm:mt-0">
                        <span className="rounded-full bg-white px-2.5 py-1 text-xs font-medium text-slate-600 shadow-sm ring-1 ring-slate-200">
                          Prima {hotelSchedules[0]?.departure_time.slice(0, 5)}
                        </span>
                        <span className="rounded-full bg-white px-2.5 py-1 text-xs font-medium text-slate-600 shadow-sm ring-1 ring-slate-200">
                          Ultima {hotelSchedules[hotelSchedules.length - 1]?.departure_time.slice(0, 5)}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="overflow-x-auto px-4 pb-4">
                    <table className="w-full border-collapse text-sm">
                      <thead>
                        <tr className="border-b border-slate-100 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                          <th className="pb-2 pr-3">Direzione</th>
                          <th className="pb-2 pr-3">Orario</th>
                          <th className="pb-2 pr-3">Meeting point</th>
                          <th className="pb-2 pr-3">Validità</th>
                          <th className="pb-2 pr-3">Tipo</th>
                          <th className="pb-2" />
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-50">
                        {hotelSchedules.map((schedule) => (
                          <tr key={schedule.id} className="hover:bg-slate-50/60">
                            <td className="py-2 pr-3 text-slate-600">
                              <span
                                className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${
                                  schedule.direction === "departure"
                                    ? "bg-amber-50 text-amber-700 ring-1 ring-amber-200"
                                    : "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200"
                                }`}
                              >
                                {schedule.direction === "departure" ? "Andata" : "Ritorno"}
                              </span>
                            </td>
                            <td className="py-2 pr-3">
                              <span className="rounded-lg bg-slate-100 px-2 py-1 font-mono text-slate-700">
                                {schedule.departure_time.slice(0, 5)}
                              </span>
                            </td>
                            <td className="py-2 pr-3 text-slate-600">{schedule.meeting_point ?? "—"}</td>
                            <td className="py-2 pr-3 text-[11px] text-slate-400">{formatSeasonBadge(schedule)}</td>
                            <td className="py-2 pr-3 text-xs text-slate-500">
                              {schedule.booking_service_kind === "shuttle_hotel" ? "Navetta hotel" : "Navetta"}
                            </td>
                            <td className="py-2 text-right whitespace-nowrap">
                              <button
                                type="button"
                                className="mr-3 text-xs text-blue-600 hover:underline"
                                onClick={() => openEdit(schedule)}
                              >
                                Modifica
                              </button>
                              <button
                                type="button"
                                className="text-xs text-rose-600 hover:underline"
                                onClick={() => void handleDelete(schedule.id)}
                              >
                                Elimina
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      <SidePanel
        open={panelOpen}
        title={editingSchedule ? "Modifica navetta" : "Nuovo orario navetta"}
        subtitle={editingSchedule ? `${editingSchedule.customer_name} · ${editingSchedule.departure_time.slice(0, 5)}` : undefined}
        onClose={() => setPanelOpen(false)}
        widthClassName="max-w-lg"
      >
        <div className="space-y-5">
          <fieldset className="space-y-3">
            <legend className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              Servizio
            </legend>
            <label className="block space-y-1">
              <span className="text-xs text-slate-500">Hotel</span>
              <select
                value={form.hotel_id}
                onChange={(event) => {
                  const hotelId = event.target.value;
                  const hotelName = hotelsById.get(hotelId)?.name ?? "";
                  setForm((current) => ({
                    ...current,
                    hotel_id: hotelId,
                    customer_name: current.customer_name || hotelName,
                  }));
                }}
                className="input w-full"
              >
                <option value="">Seleziona hotel</option>
                {hotels.map((hotel) => (
                  <option key={hotel.id} value={hotel.id}>
                    {hotel.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="block space-y-1">
              <span className="text-xs text-slate-500">Nome visualizzato</span>
              <input
                type="text"
                value={form.customer_name}
                onChange={(event) => setForm((current) => ({ ...current, customer_name: event.target.value }))}
                className="input w-full"
                placeholder="Es. Hotel President"
              />
            </label>

            <div className="grid grid-cols-2 gap-3">
              <label className="block space-y-1">
                <span className="text-xs text-slate-500">Direzione</span>
                <select
                  value={form.direction}
                  onChange={(event) => setForm((current) => ({ ...current, direction: event.target.value as "arrival" | "departure" }))}
                  className="input w-full"
                >
                  <option value="departure">Hotel → esterno</option>
                  <option value="arrival">Esterno → hotel</option>
                </select>
              </label>
              <label className="block space-y-1">
                <span className="text-xs text-slate-500">Orario</span>
                <input
                  type="time"
                  value={form.departure_time}
                  onChange={(event) => setForm((current) => ({ ...current, departure_time: event.target.value }))}
                  className="input w-full font-mono"
                />
              </label>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <label className="block space-y-1">
                <span className="text-xs text-slate-500">Tipo</span>
                <select
                  value={form.booking_service_kind}
                  onChange={(event) => setForm((current) => ({ ...current, booking_service_kind: event.target.value as "navetta" | "shuttle_hotel" }))}
                  className="input w-full"
                >
                  <option value="navetta">Navetta</option>
                  <option value="shuttle_hotel">Navetta hotel</option>
                </select>
              </label>
              <label className="block space-y-1">
                <span className="text-xs text-slate-500">Mezzo</span>
                <input
                  type="text"
                  value={form.vessel}
                  onChange={(event) => setForm((current) => ({ ...current, vessel: event.target.value }))}
                  className="input w-full"
                />
              </label>
            </div>

            <label className="block space-y-1">
              <span className="text-xs text-slate-500">Meeting point</span>
              <input
                type="text"
                value={form.meeting_point}
                onChange={(event) => setForm((current) => ({ ...current, meeting_point: event.target.value }))}
                className="input w-full"
                placeholder="Es. Citara / Piazza Marina / Caffè del Direttore"
              />
            </label>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              Validità
            </legend>
            <div className="grid grid-cols-2 gap-3">
              <label className="block space-y-1">
                <span className="text-xs text-slate-500">Dal</span>
                <input
                  type="date"
                  value={form.valid_from}
                  onChange={(event) => setForm((current) => ({ ...current, valid_from: event.target.value }))}
                  className="input w-full"
                />
              </label>
              <label className="block space-y-1">
                <span className="text-xs text-slate-500">Al</span>
                <input
                  type="date"
                  value={form.valid_to}
                  onChange={(event) => setForm((current) => ({ ...current, valid_to: event.target.value }))}
                  className="input w-full"
                />
              </label>
            </div>

            <div className="space-y-1.5">
              <span className="text-xs text-slate-500">Giorni della settimana</span>
              <div className="flex flex-wrap gap-1.5">
                {DAYS_LABEL.map((label, index) => (
                  <button
                    key={index}
                    type="button"
                    onClick={() => toggleDay(index)}
                    className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
                      form.days_of_week.includes(index)
                        ? "border-blue-600 bg-blue-600 text-white"
                        : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <label className="block space-y-1">
              <span className="text-xs text-slate-500">Note</span>
              <input
                type="text"
                value={form.notes}
                onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))}
                className="input w-full"
                placeholder="Opzionale"
              />
            </label>
          </fieldset>

          {saveError && (
            <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
              {saveError}
            </p>
          )}

          <div className="flex gap-3 pt-1">
            <button type="button" disabled={saving} onClick={() => void handleSave()} className="btn-primary flex-1 py-2">
              {saving ? "Salvataggio..." : editingSchedule ? "Salva modifiche" : "Aggiungi orario"}
            </button>
            <button type="button" onClick={() => setPanelOpen(false)} className="btn-secondary px-4 py-2">
              Annulla
            </button>
          </div>
        </div>
      </SidePanel>
    </>
  );
}
