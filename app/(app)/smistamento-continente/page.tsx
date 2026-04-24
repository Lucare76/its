"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { DateInput, PageHeader } from "@/components/ui";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";
import type { ContinentDispatchService } from "@/lib/server/continent-dispatch";

const TARGET_LABEL = "Smistamento continente";

async function getToken() {
  if (!hasSupabaseEnv || !supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

function PlaceBadge({ service }: { service: ContinentDispatchService }) {
  return service.place_type === "airport"
    ? <span className="rounded-full bg-sky-100 px-2 py-0.5 text-xs font-semibold text-sky-700">✈️ {service.meeting_point?.trim() || "Aeroporto"}</span>
    : <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-700">🚂 {service.meeting_point?.trim() || "Stazione"}</span>;
}

function ServiceCard({
  service,
  vendorDraft,
  savingId,
  onVendorChange,
  onSaveVendor,
  onMoveToBruno,
  onResetRule,
}: {
  service: ContinentDispatchService;
  vendorDraft: string;
  savingId: string | null;
  onVendorChange: (serviceId: string, value: string) => void;
  onSaveVendor: (serviceId: string) => void;
  onMoveToBruno: (serviceId: string) => void;
  onResetRule: (serviceId: string) => void;
}) {
  const isSaving = savingId === service.id;

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-[64px] text-center">
          <span className="font-mono text-lg font-bold text-slate-800">{service.time.slice(0, 5)}</span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-bold uppercase text-slate-900">{service.customer_name}</span>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">{service.pax} pax</span>
            <PlaceBadge service={service} />
            <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-700">
              {service.direction === "arrival" ? "Arrivo" : "Partenza"}
            </span>
            {service.target_source === "manual" ? (
              <span className="rounded-full bg-fuchsia-100 px-2 py-0.5 text-xs font-semibold text-fuchsia-700">Manuale</span>
            ) : null}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-600">
            {service.hotel_name ? <span>🏨 {service.hotel_name}</span> : null}
            {service.continent_hub ? <span className="font-medium uppercase text-slate-700">⚓ {service.continent_hub}</span> : null}
            {service.connection_time ? <span className="font-semibold text-orange-700">{service.place_type === "airport" ? "✈️" : "🚂"} {service.connection_time}</span> : null}
            {service.arrival_at_porto ? <span className="font-medium text-emerald-700">Arrivo porto {service.arrival_at_porto}</span> : null}
            <span>📞 {service.phone}</span>
            {service.notes ? <span className="text-slate-400">{service.notes}</span> : null}
          </div>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <label className="flex min-w-[220px] flex-col gap-1 text-xs font-medium text-slate-500">
              Vettore continente
              <div className="flex gap-2">
                <input
                  value={vendorDraft}
                  onChange={(event) => onVendorChange(service.id, event.target.value)}
                  placeholder="Es. Vettore Napoli 1"
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700"
                />
                <button
                  type="button"
                  onClick={() => onSaveVendor(service.id)}
                  disabled={isSaving}
                  className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  Salva
                </button>
              </div>
            </label>
            <button
              type="button"
              onClick={() => onMoveToBruno(service.id)}
              disabled={isSaving}
              className="rounded-lg border border-pink-200 bg-pink-50 px-3 py-2 text-xs font-semibold text-pink-700 hover:bg-pink-100 disabled:opacity-50"
            >
              Sposta a Bruno
            </button>
            {service.target_source === "manual" ? (
              <button
                type="button"
                onClick={() => onResetRule(service.id)}
                disabled={isSaving}
                className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Ripristina regola
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function SmistamentoContinentePage() {
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [services, setServices] = useState<ContinentDispatchService[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [vendorDrafts, setVendorDrafts] = useState<Record<string, string>>({});

  const load = useCallback(async (selectedDate: string) => {
    const token = await getToken();
    if (!token) {
      setLoading(false);
      return;
    }

    setLoading(true);
    const res = await fetch(`/api/ops/smistamento-continente?date=${selectedDate}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json().catch(() => null);
    if (body?.ok) {
      const nextServices = (body.services ?? []) as ContinentDispatchService[];
      setServices(nextServices);
      setVendorDrafts(Object.fromEntries(nextServices.map((service) => [service.id, service.vendor_name ?? ""])));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load(date);
  }, [date, load]);

  const post = useCallback(async (action: string, data: Record<string, unknown>) => {
    const token = await getToken();
    if (!token) return null;
    const res = await fetch("/api/ops/smistamento-continente", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action, date, ...data }),
    });
    return res.json().catch(() => null);
  }, [date]);

  const syncFromBody = useCallback((body: unknown) => {
    const payload = body as { ok?: boolean; services?: ContinentDispatchService[]; error?: string } | null;
    if (!payload?.ok) {
      setMessage({ type: "err", text: payload?.error ?? "Errore operazione." });
      return false;
    }
    const nextServices = payload.services ?? [];
    setServices(nextServices);
    setVendorDrafts(Object.fromEntries(nextServices.map((service) => [service.id, service.vendor_name ?? ""])));
    return true;
  }, []);

  const grouped = useMemo(() => {
    const byVendor = services.reduce<Record<string, ContinentDispatchService[]>>((acc, service) => {
      const key = service.vendor_name?.trim() || "__unassigned__";
      (acc[key] ??= []).push(service);
      return acc;
    }, {});

    return Object.entries(byVendor).sort(([left], [right]) => {
      if (left === "__unassigned__") return -1;
      if (right === "__unassigned__") return 1;
      return left.localeCompare(right);
    });
  }, [services]);

  const totalPax = services.reduce((sum, service) => sum + service.pax, 0);

  const handleMoveToBruno = async (serviceId: string) => {
    setSavingId(serviceId);
    const body = await post("set_dispatch_target", { service_id: serviceId, target: "bruno" });
    setSavingId(null);
    if (syncFromBody(body)) {
      setMessage({ type: "ok", text: "Servizio spostato su Bruno." });
    }
  };

  const handleResetRule = async (serviceId: string) => {
    setSavingId(serviceId);
    const body = await post("reset_dispatch_target", { service_id: serviceId });
    setSavingId(null);
    if (syncFromBody(body)) {
      setMessage({ type: "ok", text: "Regola automatica ripristinata." });
    }
  };

  const handleSaveVendor = async (serviceId: string) => {
    setSavingId(serviceId);
    const body = await post("set_vendor", { service_id: serviceId, vendor_name: vendorDrafts[serviceId] ?? "" });
    setSavingId(null);
    if (syncFromBody(body)) {
      setMessage({ type: "ok", text: "Vettore aggiornato." });
    }
  };

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Smistamento continente" subtitle="Arrivi stazione e tutte le partenze non gestite da Bruno" />

      <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-6 py-3">
        <DateInput value={date} onChange={setDate} className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm" />
        {!loading ? (
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
            {services.length} servizi · {totalPax} pax
          </span>
        ) : null}
        <span className="text-xs text-slate-500">
          Bucket corrente: {TARGET_LABEL}
        </span>
      </div>

      {message ? (
        <div className={`mx-6 mt-3 rounded-lg px-4 py-2 text-sm ${message.type === "ok" ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}`}>
          {message.text}
        </div>
      ) : null}

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {loading ? (
          <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-slate-400">Caricamento smistamento continente...</div>
        ) : services.length === 0 ? (
          <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-slate-400">
            <p className="text-lg font-semibold">Nessun servizio nello smistamento continente</p>
            <p className="mt-1 text-sm">Qui compaiono arrivi stazione e tutte le partenze non assegnate a Bruno.</p>
          </div>
        ) : (
          <div className="space-y-6">
            {grouped.map(([vendorKey, vendorServices]) => {
              const arrivals = vendorServices.filter((service) => service.direction === "arrival");
              const departures = vendorServices.filter((service) => service.direction === "departure");
              const vendorLabel = vendorKey === "__unassigned__" ? "Senza vettore assegnato" : vendorKey;
              const vendorPax = vendorServices.reduce((sum, service) => sum + service.pax, 0);

              return (
                <section key={vendorKey} className="space-y-3">
                  <div className={`rounded-xl px-4 py-3 ${vendorKey === "__unassigned__" ? "bg-amber-50 border border-amber-200" : "bg-slate-800"}`}>
                    <div className="flex flex-wrap items-center gap-3">
                      <span className={`text-sm font-bold uppercase ${vendorKey === "__unassigned__" ? "text-amber-900" : "text-white"}`}>{vendorLabel}</span>
                      <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${vendorKey === "__unassigned__" ? "bg-amber-200 text-amber-900" : "bg-slate-700 text-slate-200"}`}>
                        {vendorServices.length} servizi · {vendorPax} pax
                      </span>
                    </div>
                  </div>

                  {arrivals.length > 0 ? (
                    <div className="space-y-2">
                      <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">Arrivi stazione</p>
                      {arrivals.map((service) => (
                        <ServiceCard
                          key={service.id}
                          service={service}
                          vendorDraft={vendorDrafts[service.id] ?? ""}
                          savingId={savingId}
                          onVendorChange={(serviceId, value) => setVendorDrafts((prev) => ({ ...prev, [serviceId]: value }))}
                          onSaveVendor={handleSaveVendor}
                          onMoveToBruno={handleMoveToBruno}
                          onResetRule={handleResetRule}
                        />
                      ))}
                    </div>
                  ) : null}

                  {departures.length > 0 ? (
                    <div className="space-y-2">
                      <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">Partenze continente</p>
                      {departures.map((service) => (
                        <ServiceCard
                          key={service.id}
                          service={service}
                          vendorDraft={vendorDrafts[service.id] ?? ""}
                          savingId={savingId}
                          onVendorChange={(serviceId, value) => setVendorDrafts((prev) => ({ ...prev, [serviceId]: value }))}
                          onSaveVendor={handleSaveVendor}
                          onMoveToBruno={handleMoveToBruno}
                          onResetRule={handleResetRule}
                        />
                      ))}
                    </div>
                  ) : null}
                </section>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
