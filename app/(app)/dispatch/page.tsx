"use client";

import { useEffect, useMemo, useState } from "react";
import { formatIsoDateShort, getCustomerFullName } from "@/lib/service-display";
import { getE2ETestSessionOverride } from "@/lib/supabase/client-session";
import { supabase } from "@/lib/supabase/client";
import type { Assignment, Hotel, Membership, Service, VehicleRecord } from "@/lib/types";

function suggestedVehicleByPax(pax: number) {
  return pax >= 6 ? "VAN" : "CAR";
}

function readStoredSupabaseSession() {
  if (typeof window === "undefined") return null;
  const key = Object.keys(window.localStorage).find((item) => /^sb-.*-auth-token$/i.test(item));
  if (!key) return null;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) ?? "null") as {
      access_token?: string;
      refresh_token?: string;
    } | null;
    if (!parsed?.access_token || !parsed.refresh_token) return null;
    return { access_token: parsed.access_token, refresh_token: parsed.refresh_token };
  } catch {
    return null;
  }
}

function readUserIdFromAccessToken(accessToken: string | null) {
  if (typeof window === "undefined" || !accessToken) return null;
  try {
    const payload = accessToken.split(".")[1];
    if (!payload) return null;
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const parsed = JSON.parse(window.atob(normalized)) as { sub?: unknown };
    return typeof parsed.sub === "string" ? parsed.sub : null;
  } catch {
    return null;
  }
}

async function ensureSupabaseClientReady() {
  if (!supabase) return false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const sessionResult = await Promise.race([
      supabase.auth.getSession(),
      new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 1200)),
    ]);
    const sessionData = sessionResult?.data;
    if (sessionData?.session?.access_token) return true;
    const storedSession = readStoredSupabaseSession();
    if (storedSession?.access_token) return true;
    if (storedSession) {
      const restored = await Promise.race([
        supabase.auth.setSession({
          access_token: storedSession.access_token,
          refresh_token: storedSession.refresh_token,
        }),
        new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 1200)),
      ]);
      if (restored && !restored.error && restored.data.session?.access_token) return true;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 200));
  }
  return false;
}

type DispatchDriver = {
  id: string;
  user_id: string | null;
  tenant_id?: string;
  full_name: string;
  active?: boolean;
  has_access?: boolean;
};

type RowState = { driverProfileId: string; vehicleLabel: string; saving: boolean; saved: boolean; error: string };
type DateTab = "today" | "tomorrow" | "all";

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function tomorrowIsoDate(today: string) {
  const next = new Date(`${today}T12:00:00`);
  next.setDate(next.getDate() + 1);
  return next.toISOString().slice(0, 10);
}

function readDispatchQueryParam(name: string) {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get(name)?.trim() ?? "";
}

function readInitialDateTab(): DateTab {
  const date = readDispatchQueryParam("date");
  if (!date) return "today";
  const today = todayIsoDate();
  if (date === today) return "today";
  if (date === tomorrowIsoDate(today)) return "tomorrow";
  return "all";
}

export default function DispatchPage() {
  const [loading, setLoading]         = useState(true);
  const [message, setMessage]         = useState("");
  const [tenantId, setTenantId]       = useState<string | null>(null);
  const [actorUserId, setActorUserId] = useState<string | null>(null);
  const [services, setServices]       = useState<Service[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [hotels, setHotels]           = useState<Hotel[]>([]);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [driverProfiles, setDriverProfiles] = useState<DispatchDriver[]>([]);
  const [vehicles, setVehicles]       = useState<VehicleRecord[]>([]);
  const [token, setToken]             = useState<string | null>(null);
  const [search, setSearch]           = useState(() => readDispatchQueryParam("q"));
  const [dateTab, setDateTab]         = useState<DateTab>(() => readInitialDateTab());
  const [rowStates, setRowStates] = useState<Record<string, Partial<RowState>>>({});
  const [selectedServiceId, setSelectedServiceId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    const loadData = async (accessToken: string) => {
      const response = await fetch("/api/ops/dispatch-data", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const payload = await response.json().catch(() => null) as {
        ok?: boolean; services?: Service[]; assignments?: Assignment[];
        hotels?: Hotel[]; memberships?: Membership[]; driver_profiles?: DispatchDriver[]; vehicles?: VehicleRecord[];
        error?: string;
      } | null;
      if (!active) return false;
      if (!response.ok || !payload?.ok) {
        setMessage(payload?.error ?? "Impossibile caricare il cambio operativo.");
        return false;
      }
      setMessage("");
      setServices((payload.services ?? []) as Service[]);
      setAssignments((payload.assignments ?? []) as Assignment[]);
      setHotels((payload.hotels ?? []) as Hotel[]);
      setMemberships((payload.memberships ?? []) as Membership[]);
      setDriverProfiles(payload.driver_profiles ?? []);
      setVehicles((payload.vehicles ?? []) as VehicleRecord[]);
      return true;
    };

    const load = async () => {
      if (!supabase) { setMessage("Sessione non valida."); setLoading(false); return; }
      const clientReady = await ensureSupabaseClientReady();
      if (!clientReady) { setMessage("Sessione non valida. Rifai login."); setLoading(false); return; }

      const sessionResult = await Promise.race([
        supabase.auth.getSession(),
        new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 1200)),
      ]);
      const storedSession = readStoredSupabaseSession();
      const accessToken = sessionResult?.data.session?.access_token ?? storedSession?.access_token ?? null;
      const userId      = sessionResult?.data.session?.user?.id ?? readUserIdFromAccessToken(accessToken);
      const e2eOverride = getE2ETestSessionOverride();
      const resolvedUserId  = e2eOverride?.userId ?? userId;
      if (!resolvedUserId || !accessToken) { setMessage("Sessione non valida."); setLoading(false); return; }
      setActorUserId(resolvedUserId);
      setToken(accessToken);

      const tenantResponse = await fetch("/api/onboarding/tenant", { headers: { Authorization: `Bearer ${accessToken}` } });
      const tenantBody = await tenantResponse.json().catch(() => null) as { hasTenant?: boolean; tenant?: { id?: string | null } } | null;
      const nextTenantId = tenantBody?.hasTenant ? tenantBody.tenant?.id ?? null : null;
      if (!nextTenantId) { setMessage("Tenant non configurato."); setLoading(false); return; }
      setTenantId(nextTenantId);

      await loadData(accessToken);
      setLoading(false);

      const channel = supabase
        .channel(`dispatch-live-${nextTenantId}-${Date.now()}`)
        .on("postgres_changes", { event: "*", schema: "public", table: "services",    filter: `tenant_id=eq.${nextTenantId}` }, () => { void loadData(accessToken); })
        .on("postgres_changes", { event: "*", schema: "public", table: "assignments", filter: `tenant_id=eq.${nextTenantId}` }, () => { void loadData(accessToken); })
        .on("postgres_changes", { event: "*", schema: "public", table: "driver_profiles", filter: `tenant_id=eq.${nextTenantId}` }, () => { void loadData(accessToken); })
        .on("postgres_changes", { event: "*", schema: "public", table: "memberships", filter: `tenant_id=eq.${nextTenantId}` }, () => { void loadData(accessToken); })
        .on("postgres_changes", { event: "*", schema: "public", table: "vehicles", filter: `tenant_id=eq.${nextTenantId}` }, () => { void loadData(accessToken); })
        .subscribe();

      return channel;
    };

    let activeChannel: ReturnType<NonNullable<typeof supabase>["channel"]> | null = null;
    void load().then((ch) => { if (active && ch) activeChannel = ch; });
    return () => {
      active = false;
      if (activeChannel && supabase) void supabase.removeChannel(activeChannel);
    };
  }, []);

  const tenantServices    = tenantId ? services.filter((s) => s.tenant_id === tenantId) : services;
  const tenantAssignments = tenantId ? assignments.filter((a) => a.tenant_id === tenantId) : assignments;
  const tenantMemberships = tenantId ? memberships.filter((m) => m.tenant_id === tenantId) : memberships;
  const assignmentByServiceId = useMemo(() => new Map(tenantAssignments.map((a) => [a.service_id, a])), [tenantAssignments]);
  const hotelsById            = useMemo(() => new Map((tenantId ? hotels.filter((h) => h.tenant_id === tenantId) : hotels).map((h) => [h.id, h])), [hotels, tenantId]);
  const drivers = useMemo(() => {
    const profileDrivers = driverProfiles.filter((driver) => driver.active !== false);
    const profileUserIds = new Set(profileDrivers.map((driver) => driver.user_id).filter(Boolean));
    const legacyDrivers = tenantMemberships
      .filter((m) => m.role === "driver" || m.role === "autista")
      .filter((m) => !profileUserIds.has(m.user_id))
      .map((m) => ({
        id: m.user_id,
        user_id: m.user_id,
        tenant_id: m.tenant_id,
        full_name: m.full_name,
        active: true,
        has_access: true,
      }));
    return [...profileDrivers, ...legacyDrivers]
      .sort((left, right) => left.full_name.localeCompare(right.full_name, "it"));
  }, [driverProfiles, tenantMemberships]);
  const tenantVehicles        = useMemo(() => (tenantId ? vehicles.filter((vehicle) => vehicle.tenant_id === tenantId) : vehicles), [vehicles, tenantId]);

  const today    = useMemo(() => todayIsoDate(), []);
  const tomorrow = useMemo(() => tomorrowIsoDate(today), [today]);

  const baseServices = useMemo(() =>
    tenantServices
      .filter((s) => s.status === "new" || s.status === "assigned")
      .filter((s) => {
        if (!search.trim()) return true;
        const q = search.toLowerCase();
        return (
          getCustomerFullName(s).toLowerCase().includes(q) ||
          (hotelsById.get(s.hotel_id)?.name ?? "").toLowerCase().includes(q)
        );
      }),
  [tenantServices, search, hotelsById]);

  const filteredServices = useMemo(() => {
    let list = baseServices;
    if (dateTab === "today")    list = list.filter((s) => s.date === today);
    if (dateTab === "tomorrow") list = list.filter((s) => s.date === tomorrow);
    return [...list].sort((a, b) => {
      const aAssigned = assignmentByServiceId.has(a.id) ? 1 : 0;
      const bAssigned = assignmentByServiceId.has(b.id) ? 1 : 0;
      if (aAssigned !== bAssigned) return aAssigned - bAssigned;
      return a.date !== b.date ? a.date.localeCompare(b.date) : a.time.localeCompare(b.time);
    });
  }, [baseServices, dateTab, today, tomorrow, assignmentByServiceId]);

  const grouped = useMemo(() => {
    if (dateTab !== "all") {
      const date = dateTab === "today" ? today : tomorrow;
      return filteredServices.length > 0 ? [[date, filteredServices] as [string, Service[]]] : [];
    }
    const map = new Map<string, Service[]>();
    for (const s of filteredServices) {
      if (!map.has(s.date)) map.set(s.date, []);
      map.get(s.date)!.push(s);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [filteredServices, dateTab, today, tomorrow]);

  const todayPending    = baseServices.filter((s) => s.date === today && !assignmentByServiceId.has(s.id)).length;
  const todayTotal      = baseServices.filter((s) => s.date === today).length;
  const tomorrowPending = baseServices.filter((s) => s.date === tomorrow && !assignmentByServiceId.has(s.id)).length;
  const tomorrowTotal   = baseServices.filter((s) => s.date === tomorrow).length;

  const getRow = (svc: Service): RowState => {
    const assignment = assignmentByServiceId.get(svc.id);
    const assignedProfileId = assignment?.driver_profile_id
      ?? drivers.find((driver) => assignment?.driver_user_id && driver.user_id === assignment.driver_user_id)?.id
      ?? "";
    return ({
      driverProfileId: assignedProfileId,
      vehicleLabel: assignmentByServiceId.get(svc.id)?.vehicle_label ?? suggestedVehicleByPax(svc.pax),
      saving: false,
      saved: false,
      error: "",
      ...rowStates[svc.id],
    });
  };

  const save = async (svc: Service) => {
    if (!token) return;
    const state = getRow(svc);
    const selectedDriver = drivers.find((driver) => driver.id === state.driverProfileId);
    setRowStates((current) => ({
      ...current,
      [svc.id]: { ...state, saving: true, error: "", saved: false },
    }));

    const res = await fetch("/api/ops/assign-service", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        service_id: svc.id,
        driver_user_id: selectedDriver?.user_id ?? null,
        driver_profile_id: state.driverProfileId || null,
        vehicle_label: state.vehicleLabel,
        action: "assign",
      }),
    });
    const json = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;

    if (!res.ok || !json?.ok) {
      setRowStates((current) => ({
        ...current,
        [svc.id]: { ...getRow(svc), saving: false, error: json?.error ?? "Errore salvataggio.", saved: false },
      }));
      return;
    }

    setRowStates((current) => ({
      ...current,
      [svc.id]: { ...getRow(svc), saving: false, saved: true, error: "" },
    }));
    setTimeout(() => {
      setRowStates((current) => {
        const currentRow = current[svc.id];
        if (!currentRow) return current;
        return { ...current, [svc.id]: { ...currentRow, saved: false } };
      });
    }, 2000);
  };

  if (loading) return <div className="card p-4 text-sm text-slate-500">Caricamento assegnazioni...</div>;

  const tabs: { key: DateTab; label: string; pending: number; total: number }[] = [
    { key: "today", label: "Oggi", pending: todayPending, total: todayTotal },
    { key: "tomorrow", label: "Domani", pending: tomorrowPending, total: tomorrowTotal },
    { key: "all", label: "Tutte le date", pending: 0, total: baseServices.length },
  ];

  const selectedService = filteredServices.find((service) => service.id === selectedServiceId) ?? filteredServices[0] ?? null;
  const assignedCount = filteredServices.filter((service) => assignmentByServiceId.has(service.id)).length;
  const unassignedServices = filteredServices.filter((service) => !assignmentByServiceId.has(service.id));
  const freeDrivers = drivers.length;
  const freeVehicles = tenantVehicles.length;
  const conflictCount = filteredServices.filter((service) => !assignmentByServiceId.has(service.id) && service.status === "new").length;
  const selectedHotel = selectedService ? hotelsById.get(selectedService.hotel_id) : null;
  const selectedState = selectedService ? getRow(selectedService) : null;
  const selectedDriver = selectedState ? drivers.find((driver) => driver.id === selectedState.driverProfileId) : null;
  const selectedVehicleOptions = selectedService && selectedState?.vehicleLabel && !tenantVehicles.some((vehicle) => vehicle.label === selectedState.vehicleLabel)
    ? [{ id: `custom-${selectedService.id}`, label: selectedState.vehicleLabel, plate: null }, ...tenantVehicles]
    : tenantVehicles;
  const boardDrivers = drivers.slice(0, 3);
  const boardRows = [
    ...boardDrivers.map((driver) => ({ kind: "driver" as const, id: driver.id, label: driver.full_name, vehicle: tenantVehicles[boardDrivers.indexOf(driver)]?.label ?? "Mezzo N/D" })),
    { kind: "unassigned" as const, id: "unassigned", label: "Non assegnato", vehicle: `${unassignedServices.length} servizi` },
  ];

  const servicesForBoardRow = (rowId: string) => filteredServices.filter((service) => {
    const assignment = assignmentByServiceId.get(service.id);
    if (rowId === "unassigned") return !assignment;
    const driver = drivers.find((item) => item.id === rowId);
    return assignment?.driver_profile_id === rowId || Boolean(driver?.user_id && assignment?.driver_user_id === driver.user_id);
  }).slice(0, 4);

  const serviceKindLabel = (service: Service) => {
    const raw = [service.booking_service_kind, service.transport_code, service.vessel].filter(Boolean).join(" ").toLowerCase();
    if (raw.includes("part") || raw.includes("departure")) return "Partenza";
    return "Arrivo";
  };

  const serviceRoute = (service: Service) => {
    const hotel = hotelsById.get(service.hotel_id)?.name ?? "Hotel N/D";
    return `${service.vessel || service.transport_code || "Corsa N/D"} → ${hotel}`;
  };

  return (
    <section className="space-y-5">
      <header className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div>
          <h1 className="text-4xl font-extrabold tracking-tight text-slate-950">Assegnazioni</h1>
          <p className="mt-1 text-base font-medium text-slate-500">{new Intl.DateTimeFormat("it-IT", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date())}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex h-12 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
            {tabs.map(({ key, label, pending, total }) => <button key={key} type="button" onClick={() => setDateTab(key)} className={`px-4 text-sm font-bold transition ${dateTab === key ? "bg-blue-600 text-white" : "text-slate-600 hover:bg-slate-50"}`}>{label} <span className="ml-1 text-xs opacity-80">{key === "all" ? total : `${pending}/${total}`}</span></button>)}
          </div>
          <button type="button" className="h-12 rounded-xl border border-slate-200 bg-white px-5 text-sm font-bold text-slate-700 shadow-sm hover:bg-slate-50">✦ Auto assegna</button>
          <button type="button" className="h-12 rounded-xl border border-slate-200 bg-white px-5 text-sm font-bold text-slate-700 shadow-sm hover:bg-slate-50">⎙ Stampa</button>
          <button type="button" className="h-12 rounded-xl border border-slate-200 bg-white px-5 text-sm font-bold text-slate-700 shadow-sm hover:bg-slate-50">▣ Esporta Excel</button>
          <button type="button" className="h-12 rounded-xl bg-gradient-to-r from-blue-600 to-violet-600 px-6 text-sm font-bold text-white shadow-[0_16px_36px_rgba(79,70,229,0.32)]">✓ Salva assegnazioni</button>
        </div>
      </header>

      {message ? <div className="rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm font-semibold text-rose-700">{message}</div> : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {[
          ["☷", "Servizi da assegnare", unassignedServices.length, "bg-blue-50 text-blue-700"],
          ["👥", "Assegnati", assignedCount, "bg-emerald-50 text-emerald-700"],
          ["◉", "Autisti liberi", freeDrivers, "bg-indigo-50 text-indigo-700"],
          ["▰", "Mezzi liberi", freeVehicles, "bg-violet-50 text-violet-700"],
          ["⚠", "Conflitti", conflictCount, "bg-rose-50 text-rose-700"],
        ].map(([icon, label, value, tone]) => <div key={String(label)} className="flex min-h-[104px] items-center gap-4 rounded-2xl border border-slate-200 bg-white px-5 shadow-[0_14px_36px_rgba(15,23,42,0.07)]"><span className={`flex h-14 w-14 items-center justify-center rounded-2xl text-3xl ${tone}`}>{icon}</span><div><p className="text-sm font-semibold text-slate-500">{label}</p><strong className="mt-1 block text-4xl leading-none text-slate-950">{value}</strong></div></div>)}
      </div>

      <div className="grid gap-4 xl:grid-cols-[330px_minmax(720px,1fr)_330px]">
        <section className="rounded-3xl border border-slate-200 bg-white shadow-[0_18px_50px_rgba(15,23,42,0.08)]">
          <div className="border-b border-slate-100 p-5"><div className="flex items-center justify-between"><h2 className="text-xl font-extrabold text-slate-950">Servizi da assegnare</h2><span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-bold text-blue-700">{unassignedServices.length}</span></div><div className="mt-4 flex h-11 items-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-3"><span className="text-slate-400">⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Cerca servizio, cliente, hotel..." className="min-w-0 flex-1 bg-transparent text-sm outline-none" />{search ? <button type="button" onClick={() => setSearch("")} className="text-slate-400">×</button> : null}</div><div className="mt-3 flex flex-wrap gap-2"><button className="rounded-full border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-bold text-blue-700">Arrivi</button><button className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-bold text-emerald-700">Partenze</button><button className="rounded-full border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-bold text-rose-700">Urgenti</button><button className="rounded-full border border-slate-200 px-3 py-1.5 text-xs font-bold text-slate-600">Hotel</button></div></div>
          <div className="max-h-[570px] space-y-3 overflow-y-auto p-4">{(unassignedServices.length ? unassignedServices : filteredServices).slice(0, 8).map((service) => { const active = selectedService?.id === service.id; return <button key={service.id} type="button" onClick={() => setSelectedServiceId(service.id)} className={`w-full rounded-2xl border p-4 text-left transition ${active ? "border-blue-500 bg-blue-50 shadow-sm" : "border-slate-200 bg-white hover:border-blue-200"}`}><div className="flex items-start justify-between gap-3"><div><p className="text-lg font-extrabold text-blue-700">{service.time.slice(0, 5)}</p><p className="mt-1 text-sm font-extrabold text-slate-950">{getCustomerFullName(service)}</p></div><span className="text-xs font-bold text-slate-600">{service.pax} pax</span></div><p className="mt-2 text-xs font-medium text-slate-500">{serviceRoute(service)}</p><div className="mt-3 flex items-center justify-between"><span className={`rounded-lg px-2.5 py-1 text-[11px] font-bold ${serviceKindLabel(service) === "Arrivo" ? "bg-blue-50 text-blue-700" : "bg-emerald-50 text-emerald-700"}`}>{serviceKindLabel(service)}</span><span className="rounded-lg bg-amber-50 px-2.5 py-1 text-[11px] font-bold text-amber-700">Da assegnare</span></div></button>; })}</div>
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-[0_18px_50px_rgba(15,23,42,0.08)]"><div className="flex items-center justify-between"><h2 className="text-xl font-extrabold text-slate-950">Board assegnazioni</h2><div className="flex gap-6 text-xs font-bold text-slate-400">{["08:00", "10:00", "12:00", "14:00", "16:00", "18:00"].map((time) => <span key={time}>{time}</span>)}</div></div><div className="mt-5 overflow-hidden rounded-2xl border border-slate-200">{boardRows.map((row) => <div key={row.id} className="grid min-h-[120px] grid-cols-[132px_1fr] border-b border-slate-100 last:border-b-0"><div className="border-r border-slate-100 bg-slate-50/80 p-4"><p className="text-sm font-extrabold text-slate-950">{row.label}</p><p className="mt-1 text-xs font-semibold text-slate-500">{row.vehicle}</p><p className="mt-3 text-xs font-bold text-emerald-600">● Disponibile</p></div><div className="grid grid-cols-4 gap-3 bg-[linear-gradient(90deg,rgba(226,232,240,.55)_1px,transparent_1px)] bg-[length:25%_100%] p-4">{servicesForBoardRow(row.id).map((service) => <button key={service.id} type="button" onClick={() => setSelectedServiceId(service.id)} className={`rounded-2xl border px-3 py-3 text-left shadow-sm ${serviceKindLabel(service) === "Arrivo" ? "border-blue-300 bg-blue-50" : "border-emerald-300 bg-emerald-50"}`}><strong className="text-sm text-slate-950">{service.time.slice(0, 5)}</strong><span className={`ml-2 rounded-md px-2 py-0.5 text-[10px] font-bold ${serviceKindLabel(service) === "Arrivo" ? "bg-blue-100 text-blue-700" : "bg-emerald-100 text-emerald-700"}`}>{serviceKindLabel(service)}</span><p className="mt-2 line-clamp-2 text-xs font-semibold text-slate-700">{serviceRoute(service)}</p><p className="mt-2 text-[11px] font-bold text-slate-500">{service.pax} pax</p></button>)}{row.id === "unassigned" ? <div className="col-span-4 flex min-h-[84px] items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-white text-sm font-semibold text-slate-400">Trascina qui un servizio per assegnarlo</div> : null}</div></div>)}</div></section>

        <aside className="space-y-4"><section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-[0_18px_50px_rgba(15,23,42,0.08)]"><div className="flex items-center justify-between"><h2 className="text-lg font-extrabold text-slate-950">Dettaglio servizio</h2><span className="rounded-lg bg-blue-50 px-2.5 py-1 text-xs font-bold text-blue-700">{selectedService ? serviceKindLabel(selectedService) : "—"}</span></div>{selectedService && selectedState ? <><div className="mt-4 border-b border-slate-100 pb-4"><p className="text-2xl font-extrabold text-slate-950">{getCustomerFullName(selectedService)}</p><p className="mt-1 text-sm font-semibold text-slate-600">{serviceRoute(selectedService)}</p><div className="mt-4 grid grid-cols-2 gap-3 text-sm"><div><p className="text-xs font-bold uppercase text-slate-400">Pax</p><p className="font-extrabold">{selectedService.pax}</p></div><div><p className="text-xs font-bold uppercase text-slate-400">Orario</p><p className="font-extrabold">{selectedService.time.slice(0, 5)}</p></div></div></div><div className="mt-4 space-y-3"><label className="block text-xs font-bold uppercase text-slate-400">Autista</label><select value={selectedState.driverProfileId} onChange={(event) => setRowStates((current) => ({ ...current, [selectedService.id]: { ...getRow(selectedService), driverProfileId: event.target.value } }))} className="input-saas w-full text-sm"><option value="">— Nessun driver —</option>{drivers.map((driver) => <option key={driver.id} value={driver.id}>{driver.full_name}</option>)}</select><label className="block text-xs font-bold uppercase text-slate-400">Mezzo</label><select value={selectedState.vehicleLabel} onChange={(event) => setRowStates((current) => ({ ...current, [selectedService.id]: { ...getRow(selectedService), vehicleLabel: event.target.value } }))} className="input-saas w-full text-sm"><option value="">— Nessun mezzo —</option>{selectedVehicleOptions.map((vehicle) => <option key={vehicle.id} value={vehicle.label}>{vehicle.label}{vehicle.plate ? ` · ${vehicle.plate}` : ""}</option>)}</select><button type="button" onClick={() => void save(selectedService)} disabled={selectedState.saving} className="mt-2 w-full rounded-xl bg-gradient-to-r from-blue-600 to-violet-600 px-4 py-3 text-sm font-bold text-white shadow-lg disabled:opacity-60">{selectedState.saving ? "Salvataggio..." : selectedState.saved ? "✓ Salvato" : selectedDriver ? `Assegna a ${selectedDriver.full_name}` : "Salva assegnazione"}</button>{selectedState.error ? <p className="text-xs font-semibold text-rose-600">{selectedState.error}</p> : null}<div className="grid grid-cols-2 gap-2"><button type="button" className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-700">Cambia mezzo</button><a href={`/services/${selectedService.id}`} className="rounded-xl border border-slate-200 px-3 py-2 text-center text-xs font-bold text-slate-700">Apri prenotazione</a></div></div></> : <p className="mt-4 text-sm text-slate-500">Seleziona un servizio.</p>}</section><section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm"><h2 className="text-lg font-extrabold text-slate-950">Controlli <span className="rounded-full bg-rose-100 px-2 py-0.5 text-xs text-rose-700">{conflictCount}</span></h2><div className="mt-3 divide-y divide-slate-100 text-sm">{["Mezzo sovraccarico", "Autista senza accesso", "Orario sovrapposto"].map((item) => <div key={item} className="flex items-center justify-between py-3"><span className="font-semibold text-slate-700">⚠ {item}</span><span className="text-slate-400">›</span></div>)}</div></section><section className="rounded-3xl border border-violet-100 bg-violet-50/40 p-5 shadow-sm"><h2 className="text-lg font-extrabold text-slate-950">Suggerimenti AI</h2><div className="mt-3 space-y-2 text-sm"><p className="rounded-2xl bg-white px-4 py-3 font-semibold text-slate-700">Mario è l&apos;opzione migliore: massima efficienza, nessun conflitto.</p><p className="rounded-2xl bg-white px-4 py-3 font-semibold text-slate-700">VAN disponibile vicino alla zona selezionata.</p></div></section></aside>
      </div>

      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-[0_18px_50px_rgba(15,23,42,0.08)]"><div className="flex items-center justify-between"><h2 className="text-lg font-extrabold text-slate-950">Timeline giornata</h2><div className="flex gap-4 text-xs font-bold"><span className="text-blue-700">● Arrivi</span><span className="text-emerald-700">● Partenze</span><span className="text-amber-700">● In servizio</span><span className="text-slate-500">● Non assegnati</span></div></div><div className="mt-5 grid grid-cols-8 gap-3">{["06:00", "08:00", "10:00", "12:00", "14:00", "16:00", "18:00", "20:00"].map((time, index) => <div key={time} className="text-center"><p className="mb-2 text-xs font-bold text-slate-500">{time}</p><div className="flex justify-center gap-1"><span className="rounded-lg bg-blue-600 px-2 py-1 text-xs font-bold text-white">{(index + 2) % 8}</span><span className="rounded-lg bg-emerald-500 px-2 py-1 text-xs font-bold text-white">{(index + 1) % 6}</span><span className="rounded-lg bg-amber-400 px-2 py-1 text-xs font-bold text-white">{index % 3}</span></div></div>)}</div></section>
    </section>
  );
}
