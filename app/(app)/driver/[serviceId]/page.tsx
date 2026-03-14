"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { useTenantOperationalData } from "@/lib/supabase/use-tenant-operational-data";
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

  if (loading) return <div className="card p-4 text-sm text-muted">Caricamento dettaglio...</div>;
  if (errorMessage) return <div className="card p-4 text-sm text-muted">{errorMessage}</div>;
  if (!service) return <div className="card p-4 text-sm text-muted">Servizio non trovato.</div>;
  if (!isMine) return <div className="card p-4 text-sm text-muted">Servizio non assegnato al driver corrente.</div>;

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
        <p className="text-sm">
          Stato attuale: <strong className={statusBadgeClass(service.status)}>{service.status}</strong>
        </p>
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
