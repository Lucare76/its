"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTenantOperationalData } from "@/lib/supabase/use-tenant-operational-data";
import { supabase } from "@/lib/supabase/client";
import type { Assignment, Hotel, Service } from "@/lib/types";
import { z } from "zod";

type ShuttleGroup = {
  hotelId: string;
  hotelName: string;
  zone: string;
  services: Service[];
};

type AssignmentDraft = {
  driverUserId: string;
  driverProfileId?: string;
  vehicleLabel: string;
};

type AvailabilityDriver = {
  id: string;
  user_id: string | null;
  full_name: string;
};

type AvailabilityVehicle = {
  id: string;
  label: string;
  plate: string | null;
  capacity: number | null;
};

type DriverAvailability = {
  driver_profile_id: string;
  driver_user_id: string | null;
  available: boolean;
  vehicle_1_id: string | null;
  vehicle_1_from: string | null;
  vehicle_1_to: string | null;
  vehicle_2_id: string | null;
  vehicle_2_from: string | null;
  vehicle_2_to: string | null;
};

const assignmentPayloadSchema = z.object({
  tenant_id: z.string().uuid(),
  service_id: z.string().uuid(),
  driver_user_id: z.string().uuid().nullable(),
  driver_profile_id: z.string().uuid().nullable(),
  vehicle_label: z.string().max(120)
});

const todayIso = () => new Date().toISOString().slice(0, 10);

function isShuttleService(service: Service) {
  const kind = service.booking_service_kind?.toLowerCase() ?? "";
  return kind === "navetta" || kind === "shuttle_hotel" || service.vessel?.trim().toLowerCase() === "navetta";
}

function normalize(value?: string | null) {
  return (value ?? "").trim();
}

function serviceDate(service: Service) {
  if (service.direction === "arrival") return service.arrival_date || service.date;
  if (service.direction === "departure") return service.departure_date || service.date;
  return service.date;
}

function serviceTime(service: Service) {
  return service.pickup_time || service.time_from || service.departure_time || service.arrival_time || service.time || "--:--";
}

function customerName(service: Service) {
  const composed = `${normalize(service.customer_first_name)} ${normalize(service.customer_last_name)}`.trim();
  return composed || normalize(service.customer_name) || "Cliente senza nome";
}

function hotelName(service: Service, hotelsById: Map<string, Hotel>) {
  return hotelsById.get(service.hotel_id)?.name ?? "Hotel da verificare";
}

function hotelZone(service: Service, hotelsById: Map<string, Hotel>) {
  return hotelsById.get(service.hotel_id)?.zone ?? "Zona N/D";
}

function directionLabel(service: Service) {
  return service.direction === "departure" ? "Partenza" : "Arrivo";
}

function assignmentKey(serviceId: string, drafts: Record<string, AssignmentDraft>, assignment?: Assignment) {
  const draft = drafts[serviceId];
  return {
    driverUserId: draft?.driverUserId ?? assignment?.driver_user_id ?? "",
    driverProfileId: draft?.driverProfileId ?? assignment?.driver_profile_id ?? "",
    vehicleLabel: draft?.vehicleLabel ?? assignment?.vehicle_label ?? ""
  };
}

function timeToMinutes(value?: string | null) {
  if (!value) return null;
  const [hours, minutes] = value.slice(0, 5).split(":").map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return hours * 60 + minutes;
}

function downloadCsv(filename: string, rows: string[][]) {
  const csv = rows
    .map((row) =>
      row
        .map((cell) => {
          const value = String(cell ?? "");
          return /[",\n;]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
        })
        .join(";")
    )
    .join("\n");
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export default function NavetteHotelPage() {
  const [date, setDate] = useState(todayIso());
  const [query, setQuery] = useState("");
  const [savingId, setSavingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, AssignmentDraft>>({});
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [availabilityDrivers, setAvailabilityDrivers] = useState<AvailabilityDriver[]>([]);
  const [availabilityVehicles, setAvailabilityVehicles] = useState<AvailabilityVehicle[]>([]);
  const [driverAvailability, setDriverAvailability] = useState<Map<string, DriverAvailability>>(new Map());
  const [availabilityError, setAvailabilityError] = useState<string | null>(null);

  const { data, loading, errorMessage, tenantId, refresh } = useTenantOperationalData({ serviceScope: { mode: "date", date } });

  const hotelsById = useMemo(() => new Map(data.hotels.map((hotel) => [hotel.id, hotel])), [data.hotels]);
  const assignmentByServiceId = useMemo(() => new Map(data.assignments.map((assignment) => [assignment.service_id, assignment])), [data.assignments]);
  useEffect(() => {
    supabase?.auth.getSession().then(({ data }) => {
      setAccessToken(data.session?.access_token ?? null);
    });
  }, []);

  const loadAvailability = useCallback(async () => {
    if (!accessToken) return;
    setAvailabilityError(null);
    try {
      const res = await fetch(`/api/ops/disponibilita?date=${date}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        cache: "no-store"
      });
      const body = (await res.json()) as {
        ok: boolean;
        error?: string;
        drivers?: AvailabilityDriver[];
        vehicles?: AvailabilityVehicle[];
        driver_availability?: DriverAvailability[];
      };
      if (!body.ok) {
        setAvailabilityError(body.error ?? "Disponibilità autisti non disponibile.");
        return;
      }
      setAvailabilityDrivers((body.drivers ?? []).sort((a, b) => a.full_name.localeCompare(b.full_name, "it")));
      setAvailabilityVehicles(body.vehicles ?? []);
      setDriverAvailability(new Map((body.driver_availability ?? []).map((row) => [row.driver_profile_id, row])));
    } catch {
      setAvailabilityError("Disponibilità autisti non disponibile.");
    }
  }, [accessToken, date]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadAvailability();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadAvailability]);

  const membershipDrivers = useMemo(
    () =>
      data.memberships
        .filter((member) => member.role === "driver" || member.role === "autista")
        .sort((a, b) => a.full_name.localeCompare(b.full_name, "it")),
    [data.memberships]
  );

  const driverOptions = useMemo(() => {
    if (availabilityDrivers.length > 0) {
      return availabilityDrivers.map((driver) => ({
        profileId: driver.id,
        userId: driver.user_id ?? "",
        name: driver.full_name
      }));
    }
    return membershipDrivers.map((driver) => ({
      profileId: "",
      userId: driver.user_id,
      name: driver.full_name
    }));
  }, [availabilityDrivers, membershipDrivers]);

  const vehicleById = useMemo(() => new Map(availabilityVehicles.map((vehicle) => [vehicle.id, vehicle])), [availabilityVehicles]);

  function dailyVehicleLabelForDriver(profileId: string | undefined, service: Service) {
    if (!profileId) return "";
    const availability = driverAvailability.get(profileId);
    if (!availability || availability.available === false) return "";

    const serviceMinutes = timeToMinutes(serviceTime(service));
    const vehicle2From = timeToMinutes(availability.vehicle_2_from);
    const vehicle2To = timeToMinutes(availability.vehicle_2_to);

    if (
      availability.vehicle_2_id &&
      serviceMinutes !== null &&
      vehicle2From !== null &&
      serviceMinutes >= vehicle2From &&
      (vehicle2To === null || serviceMinutes <= vehicle2To)
    ) {
      return vehicleById.get(availability.vehicle_2_id)?.label ?? "";
    }

    if (availability.vehicle_1_id) return vehicleById.get(availability.vehicle_1_id)?.label ?? "";
    if (availability.vehicle_2_id) return vehicleById.get(availability.vehicle_2_id)?.label ?? "";
    return "";
  }
  const vehicleLabels = useMemo(() => {
    const labels = new Set<string>();
    availabilityVehicles.forEach((vehicle) => {
      if (vehicle.label?.trim()) labels.add(vehicle.label.trim());
    });
    data.assignments.forEach((assignment) => {
      if (assignment.vehicle_label?.trim()) labels.add(assignment.vehicle_label.trim());
    });
    data.services.forEach((service) => {
      if (service.bus_plate?.trim()) labels.add(service.bus_plate.trim());
    });
    return Array.from(labels).sort((a, b) => a.localeCompare(b, "it"));
  }, [availabilityVehicles, data.assignments, data.services]);

  const shuttleServices = useMemo(
    () =>
      data.services
        .filter(isShuttleService)
        .filter((service) => serviceDate(service) === date)
        .filter((service) => {
          const needle = query.trim().toLowerCase();
          if (!needle) return true;
          const haystack = [
            customerName(service),
            service.phone,
            hotelName(service, hotelsById),
            hotelZone(service, hotelsById),
            service.notes,
            service.meeting_point
          ]
            .join(" ")
            .toLowerCase();
          return haystack.includes(needle);
        })
        .sort((a, b) => serviceTime(a).localeCompare(serviceTime(b)) || customerName(a).localeCompare(customerName(b), "it")),
    [data.services, date, hotelsById, query]
  );

  const groups = useMemo<ShuttleGroup[]>(() => {
    const map = new Map<string, ShuttleGroup>();
    shuttleServices.forEach((service) => {
      const key = service.hotel_id || hotelName(service, hotelsById);
      const current = map.get(key) ?? {
        hotelId: key,
        hotelName: hotelName(service, hotelsById),
        zone: hotelZone(service, hotelsById),
        services: []
      };
      current.services.push(service);
      map.set(key, current);
    });
    return Array.from(map.values()).sort((a, b) => a.zone.localeCompare(b.zone, "it") || a.hotelName.localeCompare(b.hotelName, "it"));
  }, [hotelsById, shuttleServices]);

  const assignedServices = shuttleServices.filter((service) => {
    const assignment = assignmentByServiceId.get(service.id);
    const draft = drafts[service.id];
    return Boolean((draft?.driverUserId ?? assignment?.driver_user_id) || (draft?.vehicleLabel ?? assignment?.vehicle_label));
  }).length;
  const zones = new Set(groups.map((group) => group.zone)).size;

  async function saveAssignment(service: Service) {
    if (!supabase || !tenantId) {
      setMessage("Sessione non pronta: ricarica la pagina e riprova.");
      return;
    }
    const existing = assignmentByServiceId.get(service.id);
    const draft = assignmentKey(service.id, drafts, existing);
    setSavingId(service.id);
    setMessage(null);

    const parsedPayload = assignmentPayloadSchema.safeParse({
      tenant_id: tenantId,
      service_id: service.id,
      driver_user_id: draft.driverUserId || null,
      driver_profile_id: draft.driverProfileId || null,
      vehicle_label: draft.vehicleLabel.trim()
    });

    if (!parsedPayload.success) {
      setSavingId(null);
      setMessage("Dati assegnazione non validi: controlla autista e mezzo.");
      return;
    }

    const payload = parsedPayload.data;

    const result = existing
      ? await supabase
          .from("assignments")
          .update({ driver_user_id: payload.driver_user_id, driver_profile_id: payload.driver_profile_id, vehicle_label: payload.vehicle_label })
          .eq("id", existing.id)
      : await supabase.from("assignments").insert(payload);

    setSavingId(null);
    if (result.error) {
      setMessage(`Errore salvataggio: ${result.error.message}`);
      return;
    }
    setMessage("Assegnazione navetta salvata.");
    setDrafts((current) => {
      const next = { ...current };
      delete next[service.id];
      return next;
    });
    await refresh();
  }

  function updateDraft(serviceId: string, patch: Partial<AssignmentDraft>) {
    const existing = assignmentByServiceId.get(serviceId);
    setDrafts((current) => ({
      ...current,
      [serviceId]: {
        driverUserId: current[serviceId]?.driverUserId ?? existing?.driver_user_id ?? "",
        driverProfileId: current[serviceId]?.driverProfileId ?? existing?.driver_profile_id ?? "",
        vehicleLabel: current[serviceId]?.vehicleLabel ?? existing?.vehicle_label ?? "",
        ...patch
      }
    }));
  }

  function selectDriver(service: Service, driverUserId: string) {
    const driver = driverOptions.find((option) => option.userId === driverUserId);
    const dailyVehicleLabel = dailyVehicleLabelForDriver(driver?.profileId, service);
    updateDraft(service.id, {
      driverUserId,
      driverProfileId: driver?.profileId ?? "",
      vehicleLabel: dailyVehicleLabel || assignmentByServiceId.get(service.id)?.vehicle_label || ""
    });
  }

  function exportExcel() {
    downloadCsv(`navette-hotel-${date}.csv`, [
      ["Data", "Hotel", "Zona", "Ora", "Direzione", "Cliente", "Telefono", "Servizio", "Autista", "Mezzo", "Note"],
      ...groups.flatMap((group) =>
        group.services.map((service) => {
          const assignment = assignmentByServiceId.get(service.id);
          const driver = driverOptions.find((member) => member.userId === assignment?.driver_user_id);
          return [
            date,
            group.hotelName,
            group.zone,
            serviceTime(service),
            directionLabel(service),
            customerName(service),
            service.phone || "",
            "Navetta hotel",
            driver?.name ?? "",
            assignment?.vehicle_label ?? "",
            service.notes ?? ""
          ];
        })
      )
    ]);
  }

  return (
    <main className="mx-auto max-w-[1600px] space-y-5 px-4 py-6 text-slate-900 lg:px-6">
      <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm print:shadow-none">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.24em] text-slate-400">Pianificazione</p>
            <h1 className="mt-1 text-3xl font-black tracking-tight">Navette Hotel</h1>
            <p className="mt-1 truncate text-sm text-slate-500">Vista dedicata alle navette hotel, separate dalle assegnazioni operative standard.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2 print:hidden">
            <button type="button" onClick={() => setDate(todayIso())} className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-700 hover:border-indigo-200 hover:text-indigo-700">
              Oggi
            </button>
            <input type="date" value={date} onChange={(event) => setDate(event.target.value)} className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold outline-none focus:border-indigo-400 focus:ring-4 focus:ring-indigo-100" />
            <button type="button" onClick={() => window.print()} className="rounded-2xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm font-bold text-blue-700 hover:bg-blue-100">
              Stampa PDF
            </button>
            <button type="button" onClick={exportExcel} className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-bold text-emerald-700 hover:bg-emerald-100">
              Excel
            </button>
          </div>
        </div>
      </section>

      <section className="grid gap-3 md:grid-cols-4">
        {[
          ["Navette", shuttleServices.length, "Servizi hotel del giorno", "bg-indigo-50 text-indigo-700"],
          ["Servizi", shuttleServices.length, "Navette operative", "bg-emerald-50 text-emerald-700"],
          ["Hotel", groups.length, "Strutture coinvolte", "bg-sky-50 text-sky-700"],
          ["Assegnate", assignedServices, `${Math.max(shuttleServices.length - assignedServices, 0)} da completare`, "bg-amber-50 text-amber-700"]
        ].map(([label, value, caption, tone]) => (
          <article key={label} className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold text-slate-500">{label}</p>
              <span className={`rounded-2xl px-3 py-1 text-xs font-bold ${tone}`}>{caption}</span>
            </div>
            <p className="mt-3 text-4xl font-black">{value}</p>
          </article>
        ))}
      </section>

      <section className="rounded-[28px] border border-slate-200 bg-white p-4 shadow-sm print:hidden">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Cerca hotel, cliente, telefono, zona..."
            className="min-h-12 flex-1 rounded-2xl border border-slate-200 bg-slate-50 px-4 text-sm outline-none focus:border-indigo-400 focus:bg-white focus:ring-4 focus:ring-indigo-100"
          />
          <span className="rounded-2xl bg-slate-100 px-4 py-3 text-sm font-bold text-slate-600">{zones} zone</span>
          <button type="button" onClick={() => void refresh()} className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-700 hover:border-indigo-200 hover:text-indigo-700">
            Aggiorna
          </button>
        </div>
      </section>

      {message ? (
        <div className={`rounded-2xl border px-4 py-3 text-sm font-semibold ${message.startsWith("Errore") ? "border-rose-200 bg-rose-50 text-rose-700" : "border-emerald-200 bg-emerald-50 text-emerald-700"}`}>{message}</div>
      ) : null}

      {errorMessage ? <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700">{errorMessage}</div> : null}
      {availabilityError ? <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800">{availabilityError} Puoi comunque compilare il mezzo manualmente.</div> : null}

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-4">
          {loading ? (
            <div className="rounded-[28px] border border-slate-200 bg-white p-8 text-center text-slate-500">Carico navette hotel...</div>
          ) : groups.length === 0 ? (
            <div className="rounded-[28px] border border-dashed border-slate-300 bg-white p-10 text-center">
              <p className="text-xl font-black">Nessuna navetta hotel nel filtro attuale.</p>
              <p className="mt-2 text-sm text-slate-500">Quando una prenotazione viene marcata come navetta hotel apparirà qui, pronta per l’assegnazione.</p>
            </div>
          ) : (
            groups.map((group) => (
              <article key={group.hotelId} className="overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-sm">
                <header className="flex flex-col gap-3 border-b border-slate-100 bg-gradient-to-r from-indigo-50 via-white to-emerald-50 p-5 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-2xl font-black uppercase tracking-tight">{group.hotelName}</h2>
                      <span className="rounded-full bg-white px-3 py-1 text-xs font-bold text-slate-500 shadow-sm">{group.zone}</span>
                    </div>
                    <p className="mt-1 truncate text-sm text-slate-500">{group.services.length} servizi navetta</p>
                  </div>
                  <span className="w-fit rounded-2xl bg-emerald-100 px-4 py-2 text-sm font-black text-emerald-700">{group.services.length} servizi</span>
                </header>
                <div className="divide-y divide-slate-100">
                  {group.services.map((service) => {
                    const assignment = assignmentByServiceId.get(service.id);
                    const draft = assignmentKey(service.id, drafts, assignment);
                    const assignedDriver = driverOptions.find((member) => member.userId === draft.driverUserId);
                    return (
                      <div key={service.id} className="grid gap-3 px-4 py-3 lg:grid-cols-[112px_minmax(220px,1.35fr)_96px_minmax(210px,1fr)_minmax(210px,1fr)_112px] lg:items-center">
                        <div className="rounded-2xl bg-indigo-50 px-3 py-2">
                          <p className="text-[10px] font-black uppercase tracking-wide text-slate-400">{directionLabel(service)}</p>
                          <p className="mt-0.5 whitespace-nowrap font-mono text-lg font-black leading-none text-indigo-700">{serviceTime(service)}</p>
                        </div>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-black">{customerName(service)}</p>
                          <p className="mt-1 truncate text-sm text-slate-500">{service.phone || "Telefono non indicato"}</p>
                        </div>
                        <div className="flex min-h-[58px] flex-col justify-center rounded-2xl bg-slate-50 px-3 py-2 text-center">
                          <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Tipo</p>
                          <p className="text-xs font-black">Navetta</p>
                        </div>
                        <label className="space-y-1 print:hidden">
                          <span className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Autista</span>
                          <select value={draft.driverUserId} onChange={(event) => selectDriver(service, event.target.value)} className="h-11 w-full rounded-2xl border border-slate-200 bg-white px-3 text-sm font-semibold outline-none focus:border-indigo-400">
                            <option value="">— da assegnare —</option>
                            {driverOptions.map((driver) => (
                              <option key={driver.profileId || driver.userId} value={driver.userId}>{driver.name}</option>
                            ))}
                          </select>
                        </label>
                        <label className="space-y-1 print:hidden">
                          <span className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Mezzo</span>
                          <input
                            value={draft.vehicleLabel}
                            onChange={(event) => updateDraft(service.id, { vehicleLabel: event.target.value })}
                            list="navette-vehicle-labels"
                            placeholder="Es. VAN 4"
                            className="h-11 w-full rounded-2xl border border-slate-200 bg-white px-3 text-sm font-semibold outline-none focus:border-indigo-400"
                          />
                        </label>
                        <div className="flex items-center justify-between gap-2">
                          <div className="hidden print:block">
                            <p className="text-sm font-semibold">{assignedDriver?.name ?? "Autista N/D"}</p>
                            <p className="text-xs text-slate-500">{draft.vehicleLabel || "Mezzo N/D"}</p>
                          </div>
                          <button type="button" onClick={() => void saveAssignment(service)} disabled={savingId === service.id} className="h-11 w-full rounded-2xl bg-indigo-600 px-4 text-sm font-black text-white shadow-lg shadow-indigo-200 hover:bg-indigo-700 disabled:cursor-wait disabled:opacity-60 print:hidden">
                            {savingId === service.id ? "Salvo..." : "Salva"}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </article>
            ))
          )}
        </div>

        <aside className="space-y-4 print:hidden">
          <article className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-xl font-black">Controllo navette</h2>
            <div className="mt-4 space-y-3 text-sm">
              <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                <span className="font-semibold text-slate-600">Da assegnare</span>
                <strong className="rounded-full bg-amber-100 px-3 py-1 text-amber-700">{Math.max(shuttleServices.length - assignedServices, 0)}</strong>
              </div>
              <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                <span className="font-semibold text-slate-600">Hotel coinvolti</span>
                <strong>{groups.length}</strong>
              </div>
              <div className="flex items-center justify-between">
                <span className="font-semibold text-slate-600">Servizi navetta</span>
                <strong>{shuttleServices.length}</strong>
              </div>
            </div>
          </article>
          <article className="rounded-[28px] border border-blue-100 bg-blue-50 p-5 text-sm text-blue-900">
            <h2 className="text-lg font-black">Come entra nel piano</h2>
            <p className="mt-2 leading-6">Questa pagina non crea un flusso separato: assegna autista e mezzo agli stessi servizi navetta. Quindi il riepilogo del Piano del Giorno continua a pescare dai servizi reali.</p>
          </article>
        </aside>
      </section>

      <datalist id="navette-vehicle-labels">
        {vehicleLabels.map((label) => (
          <option key={label} value={label} />
        ))}
      </datalist>
    </main>
  );
}

