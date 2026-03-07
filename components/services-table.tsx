"use client";

import { useEffect, useMemo, useState } from "react";
import { ExportServicesButton } from "@/components/export-services-button";
import { Timeline } from "@/components/timeline";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";
import type { Assignment, Hotel, InboundEmail, Membership, Service, ServiceStatus, ServiceType, StatusEvent } from "@/lib/types";

interface ServicesTableProps {
  services: Service[];
  hotels: Hotel[];
  assignments: Assignment[];
  memberships: Membership[];
  statusEvents: StatusEvent[];
  inboundEmails: InboundEmail[];
}

function statusClass(status: ServiceStatus) {
  if (status === "needs_review") return "status-badge status-badge-problema";
  if (status === "new") return "status-badge status-badge-new";
  if (status === "assigned") return "status-badge status-badge-assigned";
  if (status === "partito") return "status-badge status-badge-partito";
  if (status === "arrivato") return "status-badge status-badge-arrivato";
  if (status === "completato") return "status-badge status-badge-completato";
  return "status-badge status-badge-cancelled";
}

function isUndeliveredReminder(service: Service) {
  if (service.reminder_status !== "sent" || !service.sent_at) return false;
  const alertMinutes = Number(process.env.NEXT_PUBLIC_REMINDER_ALERT_MINUTES ?? "30");
  const thresholdMs = (Number.isFinite(alertMinutes) ? alertMinutes : 30) * 60 * 1000;
  const sentAtMs = new Date(service.sent_at).getTime();
  if (!Number.isFinite(sentAtMs)) return false;
  return Date.now() - sentAtMs > thresholdMs;
}

export function ServicesTable({ services, hotels, assignments, memberships, statusEvents, inboundEmails }: ServicesTableProps) {
  const [statusFilter, setStatusFilter] = useState<ServiceStatus | "all">("all");
  const [vesselFilter, setVesselFilter] = useState<string>("all");
  const [serviceTypeFilter, setServiceTypeFilter] = useState<ServiceType | "all">("all");
  const [zoneFilter, setZoneFilter] = useState<string>("all");
  const [driverFilter, setDriverFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [selectedServiceId, setSelectedServiceId] = useState<string | null>(null);
  const [serverServices, setServerServices] = useState<Service[] | null>(null);
  const [shareLoading, setShareLoading] = useState(false);
  const [shareMessage, setShareMessage] = useState<string>("");
  const [shareUrlByServiceId, setShareUrlByServiceId] = useState<Record<string, string>>({});

  const assignedMap = useMemo(() => new Map(assignments.map((item) => [item.service_id, item])), [assignments]);
  const drivers = memberships.filter((member) => member.role === "driver");
  const vessels = [...new Set(services.map((service) => service.vessel))];
  const zones = [...new Set(hotels.map((hotel) => hotel.zone))];
  const tenantId = services[0]?.tenant_id ?? null;

  useEffect(() => {
    let active = true;

    const loadFilteredServices = async () => {
      if (!hasSupabaseEnv || !supabase || !tenantId) {
        setServerServices(null);
        return;
      }

      const sortedDates = [...new Set(services.map((service) => service.date))].sort();
      const dateFrom = sortedDates[0];
      const dateTo = sortedDates[sortedDates.length - 1];
      if (!dateFrom || !dateTo) {
        setServerServices([]);
        return;
      }

      const { data, error } = await supabase.auth.getSession();
      if (error || !data.session?.access_token) {
        setServerServices(null);
        return;
      }

      const response = await fetch("/api/services/list", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${data.session.access_token}`
        },
        body: JSON.stringify({
          tenant_id: tenantId,
          dateFrom,
          dateTo,
          status: statusFilter === "all" ? [] : [statusFilter],
          ship: vesselFilter === "all" ? "" : vesselFilter,
          zone: zoneFilter === "all" ? "" : zoneFilter,
          search
        })
      });

      if (!response.ok) {
        setServerServices(null);
        return;
      }

      const payload = (await response.json().catch(() => null)) as { services?: Service[] } | null;
      if (!active) return;
      setServerServices(payload?.services ?? []);
    };

    void loadFilteredServices();

    return () => {
      active = false;
    };
  }, [search, services, statusFilter, tenantId, vesselFilter, zoneFilter]);

  const baseServices = serverServices ?? services;

  const filtered = useMemo(() => {
    return baseServices.filter((service) => {
      const assignment = assignedMap.get(service.id);
      const byServiceType = serviceTypeFilter === "all" || (service.service_type ?? "transfer") === serviceTypeFilter;
      const byDriver = driverFilter === "all" || assignment?.driver_user_id === driverFilter;
      return byServiceType && byDriver;
    });
  }, [assignedMap, baseServices, driverFilter, serviceTypeFilter]);

  const selectedService = selectedServiceId ? services.find((item) => item.id === selectedServiceId) : null;
  const selectedShareUrl = useMemo(() => {
    if (!selectedService) return "";
    const fromAction = shareUrlByServiceId[selectedService.id];
    if (fromAction) return fromAction;
    if (!selectedService.share_token) return "";
    const base =
      process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ??
      (typeof window !== "undefined" ? window.location.origin : "");
    if (!base) return "";
    return `${base}/share/service/${selectedService.share_token}`;
  }, [selectedService, shareUrlByServiceId]);

  const openWhatsAppShare = (shareUrl: string, service: Service) => {
    const hotelName = hotels.find((item) => item.id === service.hotel_id)?.name ?? "Hotel da confermare";
    const text = [
      "Dettagli transfer Ischia:",
      `${service.date} ${service.time}`,
      `Hotel: ${hotelName}`,
      `Porto/Nave: ${service.vessel}`,
      `Pax: ${service.pax}`,
      `Link: ${shareUrl}`
    ].join("\n");
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank", "noopener,noreferrer");
  };

  const handleGenerateShareLink = async () => {
    if (!selectedService || !hasSupabaseEnv || !supabase) {
      setShareMessage("Share link disponibile solo con Supabase configurato.");
      return;
    }
    setShareLoading(true);
    setShareMessage("Generazione link...");
    const { data, error } = await supabase.auth.getSession();
    if (error || !data.session?.access_token) {
      setShareLoading(false);
      setShareMessage("Sessione non valida.");
      return;
    }
    const response = await fetch("/api/services/share-link", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${data.session.access_token}`
      },
      body: JSON.stringify({
        service_id: selectedService.id
      })
    });
    const body = (await response.json().catch(() => null)) as { share_url?: string; error?: string } | null;
    if (!response.ok || !body?.share_url) {
      setShareLoading(false);
      setShareMessage(body?.error ?? "Impossibile generare link.");
      return;
    }
    setShareUrlByServiceId((prev) => ({
      ...prev,
      [selectedService.id]: body.share_url as string
    }));
    setShareLoading(false);
    setShareMessage("Link generato.");
  };

  const handleRevokeShareLink = async () => {
    if (!selectedService || !hasSupabaseEnv || !supabase) return;
    setShareLoading(true);
    setShareMessage("Revoca link...");
    const { data, error } = await supabase.auth.getSession();
    if (error || !data.session?.access_token) {
      setShareLoading(false);
      setShareMessage("Sessione non valida.");
      return;
    }
    const response = await fetch("/api/services/share-link", {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${data.session.access_token}`
      },
      body: JSON.stringify({
        service_id: selectedService.id
      })
    });
    if (!response.ok) {
      setShareLoading(false);
      setShareMessage("Revoca non riuscita.");
      return;
    }
    setShareUrlByServiceId((prev) => ({ ...prev, [selectedService.id]: "" }));
    setShareLoading(false);
    setShareMessage("Link revocato.");
  };
  const selectedTimeline = useMemo(() => {
    if (!selectedService) return [];

    const usersById = new Map(memberships.map((item) => [item.user_id, item.full_name]));
    const serviceStatusEvents = statusEvents
      .filter((event) => event.service_id === selectedService.id)
      .sort((a, b) => a.at.localeCompare(b.at));

    const assignment = assignments.find((item) => item.service_id === selectedService.id);
    const assignedStatusEvent = [...serviceStatusEvents].reverse().find((event) => event.status === "assigned");
    const assignedDriverName = assignment?.driver_user_id ? usersById.get(assignment.driver_user_id) ?? assignment.driver_user_id : "Non assegnato";

    const assignmentEvent = assignment
      ? [
          {
            id: `assignment-${assignment.id}`,
            at:
              assignment.created_at ??
              assignedStatusEvent?.at ??
              `${selectedService.date}T${selectedService.time.length === 5 ? `${selectedService.time}:00` : selectedService.time}`,
            type: "assignment" as const,
            title: "Assignment updated",
            detail: `Driver: ${assignedDriverName} | Vehicle: ${assignment.vehicle_label}`,
            by: assignedStatusEvent?.by_user_id ? usersById.get(assignedStatusEvent.by_user_id) ?? assignedStatusEvent.by_user_id : "operator"
          }
        ]
      : [];

    const linkedInbound = inboundEmails.filter((email) => {
      const byNotes = selectedService.notes.includes(email.id);
      const byParsedFields =
        email.parsed_json.customer_name === selectedService.customer_name &&
        email.parsed_json.date === selectedService.date &&
        email.parsed_json.time === selectedService.time;
      return byNotes || byParsedFields;
    });

    const communicationEvents = linkedInbound.map((email) => ({
      id: `communication-${email.id}`,
      at: email.created_at,
      type: "communication" as const,
      title: "Inbound communication",
      detail: email.raw_text.slice(0, 140),
      by: "email/inbox"
    }));

    const statusTimelineEvents = serviceStatusEvents.map((event) => ({
      id: `status-${event.id}`,
      at: event.at,
      type: "status" as const,
      title: `Status -> ${event.status}`,
      detail: `Service status changed to ${event.status}`,
      by: event.by_user_id ? usersById.get(event.by_user_id) ?? event.by_user_id : "system"
    }));

    return [...statusTimelineEvents, ...assignmentEvent, ...communicationEvents].sort((a, b) => b.at.localeCompare(a.at));
  }, [selectedService, memberships, statusEvents, assignments, inboundEmails]);
  const sortedDates = [...new Set(services.map((service) => service.date))].sort();
  const defaultDateFrom = sortedDates[0] ?? new Date().toISOString().slice(0, 10);
  const defaultDateTo = sortedDates[sortedDates.length - 1] ?? defaultDateFrom;

  if (services.length === 0) {
    return <div className="card p-4 text-sm text-muted">Nessun servizio oggi.</div>;
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-text">Services list</h2>
        <ExportServicesButton defaultDateFrom={defaultDateFrom} defaultDateTo={defaultDateTo} />
      </div>
      <div className="card grid gap-3 p-3 md:grid-cols-6">
        <select
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value as ServiceStatus | "all")}
          className="input-saas"
        >
          <option value="all">Stato: tutti</option>
          <option value="needs_review">needs_review</option>
          <option value="new">new</option>
          <option value="assigned">assigned</option>
          <option value="partito">partito</option>
          <option value="arrivato">arrivato</option>
          <option value="completato">completato</option>
          <option value="cancelled">cancelled</option>
        </select>
        <select
          value={serviceTypeFilter}
          onChange={(event) => setServiceTypeFilter(event.target.value as ServiceType | "all")}
          className="input-saas"
        >
          <option value="all">Tipo: tutti</option>
          <option value="transfer">transfer</option>
          <option value="bus_tour">bus_tour</option>
        </select>
        <select
          value={vesselFilter}
          onChange={(event) => setVesselFilter(event.target.value)}
          className="input-saas"
        >
          <option value="all">Nave: tutte</option>
          {vessels.map((vessel) => (
            <option key={vessel} value={vessel}>
              {vessel}
            </option>
          ))}
        </select>
        <select
          value={zoneFilter}
          onChange={(event) => setZoneFilter(event.target.value)}
          className="input-saas"
        >
          <option value="all">Zona: tutte</option>
          {zones.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </select>
        <select
          value={driverFilter}
          onChange={(event) => setDriverFilter(event.target.value)}
          className="input-saas"
        >
          <option value="all">Driver: tutti</option>
          {drivers.map((driver) => (
            <option key={driver.user_id} value={driver.user_id}>
              {driver.full_name}
            </option>
          ))}
        </select>
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Cerca cliente/telefono/nave"
          className="input-saas"
        />
      </div>

      {filtered.length === 0 ? (
        <div className="card p-4 text-sm text-muted">Nessun risultato per i filtri impostati.</div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="sticky top-0 z-10 border-b border-border bg-white text-left text-muted">
              <tr>
                <th className="px-4 py-3">Orario</th>
                <th className="px-4 py-3">Cliente</th>
                <th className="px-4 py-3">Tipo</th>
                <th className="px-4 py-3">Nave</th>
                <th className="px-4 py-3">Zona</th>
                <th className="px-4 py-3">Driver</th>
                <th className="px-4 py-3">Stato</th>
                <th className="px-4 py-3">Azione</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((service) => {
                const hotel = hotels.find((item) => item.id === service.hotel_id);
                const assignment = assignedMap.get(service.id);
                const driverName =
                  memberships.find((member) => member.user_id === assignment?.driver_user_id)?.full_name ?? "Non assegnato";
                return (
                  <tr key={service.id} className="border-t border-border/50 odd:bg-white even:bg-slate-50/60 hover:bg-blue-50/80">
                    <td className="px-4 py-3">{service.time}</td>
                    <td className="px-4 py-3">{service.customer_name}</td>
                    <td className="px-4 py-3">
                      <span className="rounded-full bg-blue-100 px-2 py-1 text-xs font-semibold uppercase tracking-[0.08em] text-blue-700">
                        {service.service_type ?? "transfer"}
                      </span>
                    </td>
                    <td className="px-4 py-3">{service.vessel}</td>
                    <td className="px-4 py-3">{hotel?.zone ?? "N/D"}</td>
                    <td className="px-4 py-3">{driverName}</td>
                    <td className="px-4 py-3">
                      <span className={statusClass(service.status)}>{service.status}</span>
                      {isUndeliveredReminder(service) ? (
                        <span className="ml-2 inline-flex rounded-full bg-amber-100 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-amber-700">
                          Non consegnato
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => setSelectedServiceId(service.id)}
                        title="Open"
                        className="inline-flex items-center gap-2 rounded-full border border-border bg-white px-3 py-1.5 text-xs font-medium text-text hover:bg-slate-100 hover:scale-105"
                      >
                        <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary" />
                        Open
                        <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
                          <path d="M4 10h10" />
                          <path d="M10 6l4 4-4 4" />
                        </svg>
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {selectedService ? (
        <aside className="card space-y-3 p-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold">Dettagli servizio</h3>
            <button type="button" onClick={() => setSelectedServiceId(null)} className="text-sm text-muted">
              Chiudi
            </button>
          </div>
          <p className="text-sm">Cliente: {selectedService.customer_name}</p>
          <p className="text-sm">Tipo: {selectedService.service_type ?? "transfer"}</p>
          <p className="text-sm">Nave: {selectedService.vessel}</p>
          <p className="text-sm">Hotel: {hotels.find((item) => item.id === selectedService.hotel_id)?.name ?? "N/D"}</p>
          {(selectedService.service_type ?? "transfer") === "bus_tour" ? (
            <>
              <p className="text-sm">Tour: {selectedService.tour_name ?? "N/D"}</p>
              <p className="text-sm">Meeting point: {selectedService.meeting_point ?? "N/D"}</p>
              <p className="text-sm">Capacity: {selectedService.capacity ?? "N/D"}</p>
              <p className="text-sm">Bus plate: {selectedService.bus_plate ?? "N/D"}</p>
            </>
          ) : null}
          <p className="text-sm">Note: {selectedService.notes}</p>
          <div className="space-y-2 rounded-xl border border-border bg-surface-2 p-3">
            <p className="text-sm font-semibold">Condivisione WhatsApp</p>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn-secondary" disabled={shareLoading} onClick={() => void handleGenerateShareLink()}>
                {shareLoading ? "..." : "Genera link WhatsApp"}
              </button>
              <button type="button" className="btn-secondary" disabled={shareLoading || !selectedShareUrl} onClick={() => void handleRevokeShareLink()}>
                Revoca link
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={!selectedShareUrl}
                onClick={() => {
                  if (!selectedShareUrl) return;
                  openWhatsAppShare(selectedShareUrl, selectedService);
                }}
              >
                Apri WhatsApp
              </button>
              <button
                type="button"
                className="btn-secondary"
                disabled={!selectedShareUrl}
                onClick={() => {
                  if (!selectedShareUrl) return;
                  void navigator.clipboard.writeText(selectedShareUrl);
                  setShareMessage("Link copiato.");
                }}
              >
                Copia link
              </button>
            </div>
            {selectedShareUrl ? <p className="break-all text-xs text-muted">{selectedShareUrl}</p> : <p className="text-xs text-muted">Nessun link attivo.</p>}
            {shareMessage ? <p className="text-xs text-muted">{shareMessage}</p> : null}
          </div>
          <h4 className="text-sm font-semibold">Timeline</h4>
          <Timeline events={selectedTimeline} />
        </aside>
      ) : null}
    </section>
  );
}
