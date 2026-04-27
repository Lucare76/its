"use client";

import { useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/ui";
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

async function ensureSupabaseClientReady() {
  if (!supabase) return false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const { data: sessionData } = await supabase.auth.getSession();
    if (sessionData.session?.access_token) return true;
    const storedSession = readStoredSupabaseSession();
    if (storedSession) {
      const restored = await supabase.auth.setSession({
        access_token: storedSession.access_token,
        refresh_token: storedSession.refresh_token,
      });
      if (!restored.error && restored.data.session?.access_token) return true;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 200));
  }
  return false;
}

type RowState = { driverId: string; vehicleLabel: string; saving: boolean; saved: boolean; error: string };
type DateTab = "today" | "tomorrow" | "all";

export default function DispatchPage() {
  const [loading, setLoading]         = useState(true);
  const [message, setMessage]         = useState("");
  const [tenantId, setTenantId]       = useState<string | null>(null);
  const [actorUserId, setActorUserId] = useState<string | null>(null);
  const [services, setServices]       = useState<Service[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [hotels, setHotels]           = useState<Hotel[]>([]);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [vehicles, setVehicles]       = useState<VehicleRecord[]>([]);
  const [search, setSearch]           = useState("");
  const [dateTab, setDateTab]         = useState<DateTab>("today");
  const [rowStates, setRowStates] = useState<Record<string, Partial<RowState>>>({});

  useEffect(() => {
    let active = true;

    const loadData = async (accessToken: string) => {
      const response = await fetch("/api/ops/dispatch-data", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const payload = await response.json().catch(() => null) as {
        ok?: boolean; services?: Service[]; assignments?: Assignment[];
        hotels?: Hotel[]; memberships?: Membership[]; vehicles?: VehicleRecord[];
      } | null;
      if (!active || !response.ok || !payload?.ok) return false;
      setServices((payload.services ?? []) as Service[]);
      setAssignments((payload.assignments ?? []) as Assignment[]);
      setHotels((payload.hotels ?? []) as Hotel[]);
      setMemberships((payload.memberships ?? []) as Membership[]);
      setVehicles((payload.vehicles ?? []) as VehicleRecord[]);
      return true;
    };

    const load = async () => {
      if (!supabase) { setMessage("Sessione non valida."); setLoading(false); return; }
      const clientReady = await ensureSupabaseClientReady();
      if (!clientReady) { setMessage("Sessione non valida. Rifai login."); setLoading(false); return; }

      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData.session?.access_token ?? null;
      const userId      = sessionData.session?.user?.id ?? null;
      const e2eOverride = getE2ETestSessionOverride();
      const resolvedUserId  = e2eOverride?.userId ?? userId;
      if (!resolvedUserId || !accessToken) { setMessage("Sessione non valida."); setLoading(false); return; }
      setActorUserId(resolvedUserId);

      const tenantResponse = await fetch("/api/onboarding/tenant", { headers: { Authorization: `Bearer ${accessToken}` } });
      const tenantBody = await tenantResponse.json().catch(() => null) as { hasTenant?: boolean; tenant?: { id?: string | null } } | null;
      const nextTenantId = tenantBody?.hasTenant ? tenantBody.tenant?.id ?? null : null;
      if (!nextTenantId) { setMessage("Tenant non configurato."); setLoading(false); return; }
      setTenantId(nextTenantId);

      await loadData(accessToken);
      setLoading(false);

      const channel = supabase
        .channel(`dispatch-live-${nextTenantId}`)
        .on("postgres_changes", { event: "*", schema: "public", table: "services",    filter: `tenant_id=eq.${nextTenantId}` }, () => { void loadData(accessToken); })
        .on("postgres_changes", { event: "*", schema: "public", table: "assignments", filter: `tenant_id=eq.${nextTenantId}` }, () => { void loadData(accessToken); })
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
  const drivers               = useMemo(() => tenantMemberships.filter((m) => m.role === "driver" || m.role === "autista"), [tenantMemberships]);
  const tenantVehicles        = useMemo(() => (tenantId ? vehicles.filter((vehicle) => vehicle.tenant_id === tenantId) : vehicles), [vehicles, tenantId]);

  const today    = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const tomorrow = useMemo(() => {
    const next = new Date(`${today}T12:00:00`);
    next.setDate(next.getDate() + 1);
    return next.toISOString().slice(0, 10);
  }, [today]);

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

  const getRow = (svc: Service): RowState =>
    ({
      driverId: assignmentByServiceId.get(svc.id)?.driver_user_id ?? "",
      vehicleLabel: assignmentByServiceId.get(svc.id)?.vehicle_label ?? suggestedVehicleByPax(svc.pax),
      saving: false,
      saved: false,
      error: "",
      ...rowStates[svc.id],
    });

  const save = async (svc: Service) => {
    if (!tenantId || !actorUserId || !supabase) return;
    const state = getRow(svc);
    setRowStates((current) => ({
      ...current,
      [svc.id]: { ...state, saving: true, error: "", saved: false },
    }));

    const existing = assignmentByServiceId.get(svc.id);
    if (existing) {
      const { error } = await supabase.from("assignments")
        .update({ driver_user_id: state.driverId || null, vehicle_label: state.vehicleLabel })
        .eq("id", existing.id).eq("tenant_id", tenantId);
      if (error) {
        setRowStates((current) => ({
          ...current,
          [svc.id]: { ...getRow(svc), saving: false, error: error.message, saved: false },
        }));
        return;
      }
    } else {
      const { error } = await supabase.from("assignments").insert({
        tenant_id: tenantId, service_id: svc.id,
        driver_user_id: state.driverId || null, vehicle_label: state.vehicleLabel,
      });
      if (error) {
        setRowStates((current) => ({
          ...current,
          [svc.id]: { ...getRow(svc), saving: false, error: error.message, saved: false },
        }));
        return;
      }
    }

    await supabase.from("services").update({ status: "assigned" }).eq("id", svc.id).eq("tenant_id", tenantId).neq("status", "assigned");

    const { data: ev } = await supabase.from("status_events").select("id").eq("tenant_id", tenantId).eq("service_id", svc.id).eq("status", "assigned").maybeSingle();
    if (!ev) await supabase.from("status_events").insert({ tenant_id: tenantId, service_id: svc.id, status: "assigned", by_user_id: actorUserId });

    setRowStates((current) => ({
      ...current,
      [svc.id]: { ...getRow(svc), saving: false, saved: true, error: "" },
    }));
    setTimeout(() => {
      setRowStates((current) => {
        const currentRow = current[svc.id];
        if (!currentRow) return current;
        return {
          ...current,
          [svc.id]: { ...currentRow, saved: false },
        };
      });
    }, 2000);
  };

  if (loading) return <div className="card p-4 text-sm text-slate-500">Caricamento assegnazioni...</div>;

  const tabs: { key: DateTab; label: string; pending: number; total: number }[] = [
    { key: "today",    label: "Oggi",   pending: todayPending,    total: todayTotal },
    { key: "tomorrow", label: "Domani", pending: tomorrowPending, total: tomorrowTotal },
    { key: "all",      label: "Tutte le date", pending: 0, total: baseServices.length },
  ];

  return (
    <section className="page-section">
      <PageHeader
        title="Dispatch"
        subtitle="Assegna driver e mezzo a ogni servizio."
        breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "Dispatch" }]}
      />

      {message && <p className="text-sm text-red-600">{message}</p>}

      {/* ── Tabs data ── */}
      <div className="flex gap-2 flex-wrap">
        {tabs.map(({ key, label, pending, total }) => {
          const active = dateTab === key;
          return (
            <button
              key={key}
              onClick={() => setDateTab(key)}
              className={`flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition border ${
                active
                  ? "bg-indigo-600 text-white border-indigo-600 shadow-sm"
                  : "bg-white text-slate-600 border-slate-200 hover:border-indigo-300 hover:text-indigo-600"
              }`}
            >
              {label}
              {key !== "all" && (
                <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                  active
                    ? pending > 0 ? "bg-white/20 text-white" : "bg-white/20 text-white"
                    : pending > 0 ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700"
                }`}>
                  {pending > 0 ? `${pending}/${total}` : `${total} ✓`}
                </span>
              )}
              {key === "all" && total > 0 && (
                <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${active ? "bg-white/20 text-white" : "bg-slate-100 text-slate-500"}`}>
                  {total}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* ── Barra ricerca ── */}
      <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4 shrink-0 text-slate-400">
          <circle cx="6.5" cy="6.5" r="4" /><path d="M10.5 10.5 14 14" />
        </svg>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Cerca cliente o hotel…"
          className="flex-1 bg-transparent text-sm text-slate-700 placeholder:text-slate-400 outline-none"
        />
        {search && <button onClick={() => setSearch("")} className="text-slate-400 hover:text-slate-600 text-lg leading-none">×</button>}
      </div>

      {/* ── Lista ── */}
      {grouped.length === 0 ? (
        <div className="rounded-2xl border border-slate-100 bg-white p-8 text-center text-sm text-slate-400">
          {dateTab === "today" ? "Nessun servizio da assegnare oggi." : dateTab === "tomorrow" ? "Nessun servizio da assegnare domani." : "Nessun servizio trovato."}
        </div>
      ) : (
        <div className="space-y-6">
          {grouped.map(([date, rows]) => {
            const groupPending = rows.filter((s) => !assignmentByServiceId.has(s.id)).length;
            return (
              <div key={date}>
                {/* Header gruppo — visibile solo in "Tutte le date" */}
                {dateTab === "all" && (
                  <div className="mb-2 flex items-center gap-3">
                    <p className="text-xs font-bold uppercase tracking-widest text-slate-400">
                      {formatIsoDateShort(date)}
                    </p>
                    {groupPending > 0
                      ? <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-700">{groupPending} senza scheda</span>
                      : <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700">tutti assegnati</span>
                    }
                  </div>
                )}

                <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden divide-y divide-slate-100">
                  {rows.map((svc) => {
                    const state     = getRow(svc);
                    const hotel     = hotelsById.get(svc.hotel_id);
                    const hasAssign = assignmentByServiceId.has(svc.id);
                    const vehicleOptions = state.vehicleLabel && !tenantVehicles.some((vehicle) => vehicle.label === state.vehicleLabel)
                      ? [{ id: `custom-${svc.id}`, label: state.vehicleLabel, plate: null }, ...tenantVehicles]
                      : tenantVehicles;
                    return (
                      <div key={svc.id} className={`grid grid-cols-1 gap-2 px-4 py-3 sm:grid-cols-[1fr_180px_180px_90px] sm:items-center transition-colors ${!hasAssign ? "bg-amber-50/40" : ""}`}>

                        {/* Info servizio */}
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${hasAssign ? "bg-emerald-500" : "bg-amber-400"}`} />
                            <p className="text-sm font-semibold text-slate-800 truncate">{getCustomerFullName(svc)}</p>
                            {svc.linked_service_id && <span className="rounded px-1 py-0.5 text-[10px] font-bold bg-purple-100 text-purple-700">A/R</span>}
                          </div>
                          <p className="text-xs text-slate-500 mt-0.5 pl-3">
                            {svc.booking_service_kind === "private_island" && svc.time_from
                              ? `${svc.time_from}–${svc.time_to ?? "?"}`
                              : svc.time.slice(0, 5)}
                            {" · "}{hotel?.name ?? "Hotel N/D"} · {svc.pax} pax · {svc.vessel}
                            {svc.pickup_time ? ` · ⏱ ${svc.pickup_time}` : ""}
                          </p>
                        </div>

                        {/* Driver */}
                        <select
                          value={state.driverId}
                          onChange={(e) => {
                            const value = e.target.value;
                            setRowStates((current) => ({
                              ...current,
                              [svc.id]: { ...getRow(svc), driverId: value },
                            }));
                          }}
                          className="input-saas text-sm"
                        >
                          <option value="">— Nessun driver —</option>
                          {drivers.map((d) => (
                            <option key={d.user_id} value={d.user_id}>{d.full_name}</option>
                          ))}
                        </select>

                        {/* Mezzo */}
                        <select
                          value={state.vehicleLabel}
                          onChange={(e) => {
                            const value = e.target.value;
                            setRowStates((current) => ({
                              ...current,
                              [svc.id]: { ...getRow(svc), vehicleLabel: value },
                            }));
                          }}
                          className="input-saas text-sm"
                        >
                          <option value="">— Nessun mezzo —</option>
                          {vehicleOptions.map((vehicle) => (
                            <option key={vehicle.id} value={vehicle.label}>
                              {vehicle.label}{vehicle.plate ? ` · ${vehicle.plate}` : ""}
                            </option>
                          ))}
                        </select>

                        {/* Salva */}
                        <button
                          type="button"
                          onClick={() => void save(svc)}
                          disabled={state.saving}
                          className={`rounded-xl px-3 py-2 text-sm font-semibold transition whitespace-nowrap ${
                            state.saved
                              ? "bg-emerald-100 text-emerald-700"
                              : "bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-60"
                          }`}
                        >
                          {state.saving ? "…" : state.saved ? "✓" : "Salva"}
                        </button>

                        {state.error && <p className="text-xs text-red-600 sm:col-span-4">{state.error}</p>}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
