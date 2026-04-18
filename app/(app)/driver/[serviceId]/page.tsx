"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { useTenantOperationalData } from "@/lib/supabase/use-tenant-operational-data";
import { getPickupRule, getPickupRuleByRange, normalizeZonaIschia } from "@/lib/departure-pickup-rules";
import type { ServiceStatus } from "@/lib/types";

function statusBadgeClass(status: ServiceStatus) {
  return `status-badge status-badge-${status}`;
}

export default function DriverDetailPage() {
  const params = useParams<{ serviceId?: string | string[] }>();
  const serviceId = Array.isArray(params.serviceId) ? params.serviceId[0] : params.serviceId;
  const { loading, tenantId, userId, role, errorMessage, data, refresh } = useTenantOperationalData();
  const [savingStatus, setSavingStatus] = useState<ServiceStatus | null>(null);
  const [message, setMessage] = useState("");

  const service = useMemo(() => data.services.find((item) => item.id === serviceId), [data.services, serviceId]);
  const hotel = useMemo(() => (service ? data.hotels.find((item) => item.id === service.hotel_id) : null), [data.hotels, service]);
  const assignment = useMemo(() => (service ? data.assignments.find((item) => item.service_id === service.id) : null), [data.assignments, service]);
  const isMine = role === "driver" ? assignment?.driver_user_id === userId : true;

  const pickupNotes = useMemo(() => {
    if (!service || !hotel) return null;
    const kind = service.booking_service_kind;
    if (!kind || kind === "bus_city_hotel" || kind === "excursion") return null;
    const zona = normalizeZonaIschia(hotel.zone);
    const agency = service.billing_party_name?.trim() ?? "";
    const tFrom = (service.departure_time ?? service.return_time ?? service.time).trim();
    if (!tFrom) return null;
    let rule = null;
    if (kind === "formula_snav" || (kind === "transfer_port_hotel" && service.vessel?.toLowerCase().includes("snav"))) {
      rule = getPickupRule(agency, "snav", tFrom, zona);
    } else if (kind === "formula_medmar_napoli" || kind === "formula_medmar_pozzuoli" || (kind === "transfer_port_hotel" && service.vessel?.toLowerCase().includes("medmar"))) {
      rule = getPickupRule(agency, "medmar", tFrom, zona);
    } else if (kind === "transfer_train_hotel") {
      rule = getPickupRule(agency, "treno_traghetto", tFrom, zona)
        ?? getPickupRuleByRange(agency, "treno_traghetto", tFrom, zona)
        ?? getPickupRule(agency, "treno_aliscafo", tFrom, zona)
        ?? getPickupRuleByRange(agency, "treno_aliscafo", tFrom, zona);
    } else if (kind === "transfer_airport_hotel") {
      rule = getPickupRule("", "volo_traghetto", tFrom, zona)
        ?? getPickupRuleByRange("", "volo_traghetto", tFrom, zona)
        ?? getPickupRule("", "volo_aliscafo", tFrom, zona)
        ?? getPickupRuleByRange("", "volo_aliscafo", tFrom, zona);
    }
    return rule?.notes ?? null;
  }, [service, hotel]);
  const recentEvents = useMemo(
    () =>
      service
        ? [...data.statusEvents]
            .filter((item) => item.service_id === service.id)
            .sort((left, right) => right.at.localeCompare(left.at))
            .slice(0, 5)
        : [],
    [data.statusEvents, service]
  );

  useEffect(() => {
    if (!message) return;
    const timeout = window.setTimeout(() => setMessage(""), 2200);
    return () => window.clearTimeout(timeout);
  }, [message]);

  const persistStatus = async (nextStatus: ServiceStatus) => {
    if (!service || !tenantId || !supabase || !userId) return false;

    const { error: updateError } = await supabase
      .from("services")
      .update({ status: nextStatus })
      .eq("id", service.id)
      .eq("tenant_id", tenantId);
    if (updateError) return false;

    const { error: eventError } = await supabase.from("status_events").insert({
      tenant_id: tenantId,
      service_id: service.id,
      status: nextStatus,
      by_user_id: userId
    });
    if (eventError) return false;
    await refresh();
    return true;
  };

  const onStatusAction = async (nextStatus: ServiceStatus) => {
    if (!service) return;
    setSavingStatus(nextStatus);
    const ok = await persistStatus(nextStatus);
    setSavingStatus(null);
    setMessage(ok ? `Stato aggiornato: ${nextStatus}` : "Aggiornamento stato non riuscito.");
  };

  // Boarding check: se il servizio non è mio, chiedo i dettagli via scan API
  const [scanData, setScanData] = useState<{ customer_name?: string; hotel_name?: string | null; vehicle_label?: string; driver_name?: string | null } | null>(null);
  useEffect(() => {
    if (!serviceId || loading || isMine) return;
    supabase?.auth.getSession().then(({ data: s }) => {
      const token = s.session?.access_token;
      if (!token) return;
      fetch(`/api/scan/${serviceId}`, { headers: { Authorization: `Bearer ${token}` } })
        .then((r) => r.json())
        .then((body: { ok?: boolean; service?: { customer_name?: string; hotel_name?: string | null }; assignment?: { vehicle_label?: string; driver_name?: string | null } }) => {
          if (body.ok) {
            setScanData({
              customer_name: body.service?.customer_name,
              hotel_name: body.service?.hotel_name,
              vehicle_label: body.assignment?.vehicle_label ?? undefined,
              driver_name: body.assignment?.driver_name ?? undefined,
            });
          }
        })
        .catch(() => null);
    });
  }, [serviceId, loading, isMine]);

  if (loading) return <div className="card p-4 text-sm text-muted">Caricamento dettaglio...</div>;
  if (errorMessage) return <div className="card p-4 text-sm text-muted">{errorMessage}</div>;
  if (!service && !scanData && !loading) return <div className="card p-4 text-sm text-muted">Servizio non trovato.</div>;
  if (!isMine) {
    return (
      <section className="mx-auto max-w-lg space-y-4 p-4">
        <div className="rounded-2xl border-2 border-rose-500 bg-rose-50 p-6 text-center shadow-lg">
          <div className="mb-3 text-5xl">🚫</div>
          <h1 className="text-2xl font-black text-rose-700">IMBARCO VIETATO</h1>
          <p className="mt-2 text-base font-semibold text-rose-800">
            {scanData?.customer_name ?? "Questo ospite"} non appartiene al tuo bus.
          </p>
          {scanData?.hotel_name && (
            <p className="mt-1 text-sm text-rose-700">🏨 {scanData.hotel_name}</p>
          )}
          {scanData?.vehicle_label ? (
            <div className="mt-4 rounded-xl bg-white px-4 py-3 text-sm text-slate-700 shadow">
              <p className="font-semibold text-slate-500 text-xs uppercase tracking-wider mb-1">Bus corretto</p>
              <p className="font-bold text-slate-900">{scanData.vehicle_label.replace(/^DEP_BUS:/, "")}</p>
              {scanData.driver_name && <p className="text-slate-600 mt-0.5">Autista: {scanData.driver_name}</p>}
            </div>
          ) : (
            <p className="mt-4 text-sm text-rose-600">Nessun bus assegnato per questo ospite.</p>
          )}
          <button
            onClick={() => window.history.back()}
            className="mt-5 w-full rounded-xl bg-rose-600 py-3 text-base font-bold text-white hover:bg-rose-700">
            ← Torna indietro
          </button>
        </div>
      </section>
    );
  }

  if (!service) return <div className="card p-4 text-sm text-muted">Servizio non trovato.</div>;

  const destination = `${hotel?.lat ?? 40.74},${hotel?.lng ?? 13.9}`;
  const navigationUrl = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}&travelmode=driving`;
  const customerPhone = service.phone_e164?.trim() || service.phone?.trim() || "";
  const callHref = customerPhone ? `tel:${customerPhone}` : "";

  return (
    <section className="mx-auto max-w-lg space-y-4">
      <Link href="/driver" className="text-sm text-primary underline">
        Torna ai miei servizi
      </Link>
      <article className="card space-y-3 p-5">
        <h1 className="text-xl font-semibold">{service.customer_name}</h1>
        <p className="text-sm text-muted">
          {service.date} {service.time}
        </p>
        <p className="text-sm text-muted">Nave: {service.vessel}</p>
        <p className="text-sm text-muted">Hotel: {hotel?.name ?? "N/D"}</p>
        <p className="text-sm text-muted">Passeggeri: {service.pax}</p>
        <p className="text-sm text-muted">Telefono: {service.phone || "N/D"}</p>
        <p className="text-sm">
          Stato attuale: <strong className={statusBadgeClass(service.status)}>{service.status}</strong>
        </p>
        <div className="rounded-xl border border-border bg-surface-2 p-3 text-sm">
          <p className="font-medium">Note operative</p>
          <p className="mt-1 whitespace-pre-wrap text-muted">{service.notes || "Nessuna nota"}</p>
        </div>
        {pickupNotes && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm">
            <p className="font-medium text-amber-800">Punto di carico</p>
            <p className="mt-1 whitespace-pre-wrap text-amber-900">{pickupNotes}</p>
          </div>
        )}
        <div className="rounded-xl border border-border bg-surface-2 p-3 text-sm">
          <p className="font-medium">Storico rapido</p>
          {recentEvents.length === 0 ? (
            <p className="mt-1 text-muted">Nessun evento stato registrato.</p>
          ) : (
            <div className="mt-2 space-y-2">
              {recentEvents.map((event) => (
                <div key={event.id} className="rounded-lg border border-slate-200 bg-white px-3 py-2">
                  <p className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-700">{event.status}</p>
                  <p className="text-xs text-muted">{new Date(event.at).toLocaleString("it-IT")}</p>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {callHref ? (
            <a href={callHref} className="btn-secondary inline-flex w-fit">
              Chiama cliente
            </a>
          ) : null}
          <a href={navigationUrl} target="_blank" rel="noreferrer" className="btn-secondary inline-flex w-fit">
            Apri navigazione
          </a>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button type="button" onClick={() => void onStatusAction("partito")} disabled={savingStatus !== null} className="btn-primary px-2 py-2 text-xs disabled:opacity-50">
            {savingStatus === "partito" ? "..." : "Partito"}
          </button>
          <button type="button" onClick={() => void onStatusAction("arrivato")} disabled={savingStatus !== null} className="btn-primary px-2 py-2 text-xs disabled:opacity-50">
            {savingStatus === "arrivato" ? "..." : "Arrivato"}
          </button>
          <button type="button" onClick={() => void onStatusAction("completato")} disabled={savingStatus !== null} className="btn-primary px-2 py-2 text-xs disabled:opacity-50">
            {savingStatus === "completato" ? "..." : "Completato"}
          </button>
          <button type="button" onClick={() => void onStatusAction("problema")} disabled={savingStatus !== null} className="btn-primary px-2 py-2 text-xs disabled:opacity-50">
            {savingStatus === "problema" ? "..." : "Problema"}
          </button>
        </div>
      </article>
      {message ? <p className="text-sm text-muted">{message}</p> : null}
    </section>
  );
}
