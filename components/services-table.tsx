"use client";

import { useEffect, useMemo, useState } from "react";
import { ExportServicesButton } from "@/components/export-services-button";
import { Timeline } from "@/components/timeline";
import { DataTable, EmptyState, FilterBar } from "@/components/ui";
import { getBrowserAppUrl } from "@/lib/app-url";
import {
  formatIsoDateShort,
  formatServiceSlot,
  getCustomerFullName,
  getOutboundTime,
  getOutwardReferenceLabel,
  getOutwardTimeLabel,
  getReturnReferenceLabel,
  getReturnTime,
  getReturnTimeLabel,
  getTransportReferenceOutward,
  getTransportReferenceReturn
} from "@/lib/service-display";
import { getServiceOperationalSource, getServicePdfOperationalMeta } from "@/lib/service-pdf-metadata";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";
import type { Assignment, Hotel, InboundEmail, Membership, Service, ServiceStatus, ServiceType, StatusEvent } from "@/lib/types";
import { SERVICE_STATUS_LABELS, SERVICE_TYPE_LABELS } from "@/lib/ui-labels";

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
  const [sourceFilter, setSourceFilter] = useState<"all" | "pdf" | "agency" | "manual">("all");
  const [reviewedFilter, setReviewedFilter] = useState<"all" | "yes" | "no">("all");
  const [agencyFilter, setAgencyFilter] = useState<string>("all");
  const [qualityFilter, setQualityFilter] = useState<"all" | "low">("all");
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
  const pdfMetaByServiceId = useMemo(
    () => new Map(services.map((service) => [service.id, getServicePdfOperationalMeta(service, inboundEmails)])),
    [inboundEmails, services]
  );
  const sourceByServiceId = useMemo(
    () => new Map(services.map((service) => [service.id, getServiceOperationalSource(service, inboundEmails)])),
    [inboundEmails, services]
  );
  const agencies = [...new Set(services.map((service) => pdfMetaByServiceId.get(service.id)?.agencyName).filter(Boolean))] as string[];
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
      const pdfMeta = pdfMetaByServiceId.get(service.id);
      const byServiceType = serviceTypeFilter === "all" || (service.service_type ?? "transfer") === serviceTypeFilter;
      const byDriver = driverFilter === "all" || assignment?.driver_user_id === driverFilter;
      const serviceSource = sourceByServiceId.get(service.id) ?? "manual";
      const bySource = sourceFilter === "all" || serviceSource === sourceFilter;
      const byReviewed =
        reviewedFilter === "all" ||
        (reviewedFilter === "yes" ? Boolean(pdfMeta?.manualReview) : Boolean(pdfMeta?.isPdf && !pdfMeta.manualReview));
      const byAgency = agencyFilter === "all" || pdfMeta?.agencyName === agencyFilter;
      const byQuality = qualityFilter === "all" || (pdfMeta?.isPdf && pdfMeta.parsingQuality === "low");
      return byServiceType && byDriver && bySource && byReviewed && byAgency && byQuality;
    });
  }, [agencyFilter, assignedMap, baseServices, driverFilter, pdfMetaByServiceId, qualityFilter, reviewedFilter, serviceTypeFilter, sourceByServiceId, sourceFilter]);

  const selectedService = selectedServiceId ? services.find((item) => item.id === selectedServiceId) : null;
  const selectedShareUrl = useMemo(() => {
    if (!selectedService) return "";
    const fromAction = shareUrlByServiceId[selectedService.id];
    if (fromAction) return fromAction;
    if (!selectedService.share_token) return "";
    const base = getBrowserAppUrl();
    if (!base) return "";
    return `${base}/share/service/${selectedService.share_token}`;
  }, [selectedService, shareUrlByServiceId]);

  const openWhatsAppShare = (shareUrl: string, service: Service) => {
    const hotelName = hotels.find((item) => item.id === service.hotel_id)?.name ?? "Hotel da confermare";
    const text = [
      "Dettagli transfer Ischia:",
      formatServiceSlot(service),
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
              `${selectedService.date}T${(getOutboundTime(selectedService) ?? selectedService.time).length === 5 ? `${getOutboundTime(selectedService) ?? selectedService.time}:00` : getOutboundTime(selectedService) ?? selectedService.time}`,
            type: "assignment" as const,
            title: "Assegnazione aggiornata",
            detail: `Autista: ${assignedDriverName} | Veicolo: ${assignment.vehicle_label}`,
            by: assignedStatusEvent?.by_user_id ? usersById.get(assignedStatusEvent.by_user_id) ?? assignedStatusEvent.by_user_id : "operator"
          }
        ]
      : [];

    const linkedInbound = inboundEmails.filter((email) => {
      const byNotes = selectedService.notes.includes(email.id);
      const byParsedFields =
        email.parsed_json.customer_name === getCustomerFullName(selectedService) &&
        email.parsed_json.date === selectedService.date &&
        email.parsed_json.time === (getOutboundTime(selectedService) ?? selectedService.time);
      return byNotes || byParsedFields;
    });

    const communicationEvents = linkedInbound.map((email) => ({
      id: `communication-${email.id}`,
      at: email.created_at,
      type: "communication" as const,
      title: "Comunicazione in ingresso",
      detail: email.raw_text.slice(0, 140),
      by: "email/inbox"
    }));

    const statusTimelineEvents = serviceStatusEvents.map((event) => ({
      id: `status-${event.id}`,
      at: event.at,
      type: "status" as const,
      title: `Stato -> ${event.status}`,
      detail: `Stato servizio aggiornato a ${event.status}`,
      by: event.by_user_id ? usersById.get(event.by_user_id) ?? event.by_user_id : "system"
    }));

    return [...statusTimelineEvents, ...assignmentEvent, ...communicationEvents].sort((a, b) => b.at.localeCompare(a.at));
  }, [selectedService, memberships, statusEvents, assignments, inboundEmails]);
  const sortedDates = [...new Set(services.map((service) => service.date))].sort();
  const defaultDateFrom = sortedDates[0] ?? new Date().toISOString().slice(0, 10);
  const defaultDateTo = sortedDates[sortedDates.length - 1] ?? defaultDateFrom;
  const serviceMeta = (service: Service) => {
    const hotel = hotels.find((item) => item.id === service.hotel_id);
    const assignment = assignedMap.get(service.id);
    const driverName = memberships.find((member) => member.user_id === assignment?.driver_user_id)?.full_name ?? "Non assegnato";
      const pdfMeta = pdfMetaByServiceId.get(service.id);
      const source = sourceByServiceId.get(service.id) ?? "manual";
      return { hotel, driverName, pdfMeta, source };
    };

  if (services.length === 0) {
    return <EmptyState title="Nessun servizio oggi." compact />;
  }

  return (
    <section className="page-section">
      <div className="section-head">
        <h2 className="section-title text-base">Lista servizi</h2>
        <ExportServicesButton defaultDateFrom={defaultDateFrom} defaultDateTo={defaultDateTo} />
      </div>
      <FilterBar colsClassName="md:grid-cols-9">
        <select
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value as ServiceStatus | "all")}
          className="input-saas"
        >
          <option value="all">Stato: tutti</option>
          <option value="needs_review">{SERVICE_STATUS_LABELS.needs_review}</option>
          <option value="new">{SERVICE_STATUS_LABELS.new}</option>
          <option value="assigned">{SERVICE_STATUS_LABELS.assigned}</option>
          <option value="partito">{SERVICE_STATUS_LABELS.partito}</option>
          <option value="arrivato">{SERVICE_STATUS_LABELS.arrivato}</option>
          <option value="completato">{SERVICE_STATUS_LABELS.completato}</option>
          <option value="cancelled">{SERVICE_STATUS_LABELS.cancelled}</option>
        </select>
        <select
          value={serviceTypeFilter}
          onChange={(event) => setServiceTypeFilter(event.target.value as ServiceType | "all")}
          className="input-saas"
        >
          <option value="all">Tipo: tutti</option>
          <option value="transfer">{SERVICE_TYPE_LABELS.transfer}</option>
          <option value="bus_tour">{SERVICE_TYPE_LABELS.bus_tour}</option>
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
        <select data-testid="services-source-filter" value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value as "all" | "pdf" | "agency" | "manual")} className="input-saas">
          <option value="all">Origine: tutte</option>
          <option value="pdf">Solo PDF</option>
          <option value="agency">Solo agenzia</option>
          <option value="manual">Solo manuali</option>
        </select>
        <select data-testid="services-reviewed-filter" value={reviewedFilter} onChange={(event) => setReviewedFilter(event.target.value as "all" | "yes" | "no")} className="input-saas">
          <option value="all">Reviewed: tutti</option>
          <option value="yes">Reviewed si</option>
          <option value="no">Reviewed no</option>
        </select>
        <select data-testid="services-agency-filter" value={agencyFilter} onChange={(event) => setAgencyFilter(event.target.value)} className="input-saas">
          <option value="all">Agenzia: tutte</option>
          {agencies.map((agency) => (
            <option key={agency} value={agency}>
              {agency}
            </option>
          ))}
        </select>
        <select data-testid="services-quality-filter" value={qualityFilter} onChange={(event) => setQualityFilter(event.target.value as "all" | "low")} className="input-saas">
          <option value="all">Qualita: tutte</option>
          <option value="low">Qualita low</option>
        </select>
        <input
          data-testid="services-search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Cerca cliente/telefono/nave"
          className="input-saas"
        />
      </FilterBar>

      {filtered.length === 0 ? (
        <EmptyState title="Nessun risultato per i filtri impostati." compact />
      ) : (
        <>
          <div className="space-y-2 md:hidden">
            <p className="text-xs text-muted">Risultati: {filtered.length}</p>
            {filtered.map((service) => {
              const { hotel, driverName, pdfMeta, source } = serviceMeta(service);
              return (
                <article key={`mobile-${service.id}`} className="card space-y-2 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-semibold">{formatServiceSlot(service)} - {getCustomerFullName(service)}</p>
                    <span className={statusClass(service.status)}>{SERVICE_STATUS_LABELS[service.status]}</span>
                  </div>
                  <p className="text-xs text-muted">
                    {SERVICE_TYPE_LABELS[(service.service_type ?? "transfer") as ServiceType]} | {service.vessel}
                  </p>
                  <p className="text-xs text-muted">
                    Hotel: {hotel?.name ?? "N/D"} ({hotel?.zone ?? "N/D"}) | Driver: {driverName}
                  </p>
                  {source === "pdf" && pdfMeta ? (
                    <div className="flex flex-wrap gap-1">
                      <span className="rounded-full bg-blue-100 px-2 py-1 text-[10px] font-semibold uppercase text-blue-700">PDF</span>
                      {pdfMeta.manualReview ? <span className="rounded-full bg-emerald-100 px-2 py-1 text-[10px] font-semibold uppercase text-emerald-700">Reviewed</span> : null}
                      {pdfMeta.reviewRecommended ? <span className="rounded-full bg-amber-100 px-2 py-1 text-[10px] font-semibold uppercase text-amber-700">Attenzione</span> : null}
                    </div>
                  ) : source === "agency" ? (
                    <div className="flex flex-wrap gap-1">
                      <span className="rounded-full bg-violet-100 px-2 py-1 text-[10px] font-semibold uppercase text-violet-700">Agenzia</span>
                    </div>
                  ) : null}
                  <button type="button" onClick={() => setSelectedServiceId(service.id)} className="btn-secondary w-full px-3 py-1.5 text-xs">
                    Apri dettagli
                  </button>
                </article>
              );
            })}
          </div>
          <div className="hidden md:block">
            <DataTable
              toolbar={
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs text-muted">Risultati: {filtered.length}</p>
                  <p className="text-xs text-muted">Scorri orizzontalmente per vedere tutte le colonne.</p>
                </div>
              }
              stickyActions={
                selectedService ? (
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs text-muted">Dettaglio aperto: {getCustomerFullName(selectedService)}</p>
                    <button type="button" className="btn-secondary px-3 py-1 text-xs" onClick={() => setSelectedServiceId(null)}>
                      Chiudi dettaglio
                    </button>
                  </div>
                ) : null
              }
            >
              <thead>
                <tr>
                  <th className="px-4 py-3">Andata/Ritorno</th>
                  <th className="px-4 py-3">Cliente</th>
                  <th className="px-4 py-3">Tipo</th>
                  <th className="px-4 py-3">Nave</th>
                  <th className="px-4 py-3">Zona</th>
                  <th className="px-4 py-3">Origine</th>
                  <th className="px-4 py-3">Riferimento</th>
                  <th className="px-4 py-3">Driver</th>
                  <th className="px-4 py-3">Stato</th>
                  <th className="px-4 py-3">Azione</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((service) => {
                  const { hotel, driverName, pdfMeta, source } = serviceMeta(service);
                  return (
                    <tr key={service.id}>
                      <td className="whitespace-nowrap px-4 py-3">{formatServiceSlot(service)}</td>
                      <td className="px-4 py-3">
                        <p className="line-clamp-2 max-w-[220px] text-safe-wrap" title={getCustomerFullName(service)}>
                          {getCustomerFullName(service)}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        <span className="rounded-full bg-blue-100 px-2 py-1 text-xs font-semibold uppercase tracking-[0.08em] text-blue-700">
                          {SERVICE_TYPE_LABELS[(service.service_type ?? "transfer") as ServiceType]}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <p className="line-clamp-2 max-w-[200px] text-safe-wrap" title={service.vessel}>
                          {service.vessel}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        <p className="line-clamp-2 max-w-[180px] text-safe-wrap" title={hotel?.zone ?? "N/D"}>
                          {hotel?.zone ?? "N/D"}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        {source === "pdf" && pdfMeta ? (
                          <div className="flex flex-wrap gap-1">
                            <span className="rounded-full bg-blue-100 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-blue-700">PDF</span>
                            {pdfMeta.manualReview ? <span className="rounded-full bg-emerald-100 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-emerald-700">Reviewed</span> : null}
                            {pdfMeta.reviewRecommended ? <span className="rounded-full bg-amber-100 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-amber-700">Attenzione</span> : null}
                          </div>
                        ) : source === "agency" ? (
                          <span className="rounded-full bg-violet-100 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-violet-700">Agenzia</span>
                        ) : (
                          <span className="text-xs text-muted">Manuale</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="max-w-[200px] text-xs text-slate-700">
                          {source === "pdf" ? (
                            <>
                              <p className="truncate" title={pdfMeta?.externalReference ?? ""}>{pdfMeta?.externalReference ?? "-"}</p>
                              <p className="truncate text-slate-500" title={pdfMeta?.agencyName ?? ""}>{pdfMeta?.agencyName ?? "-"}</p>
                              <p className="truncate text-slate-500">{pdfMeta?.parserKey ?? "parser n/d"} | {pdfMeta?.parsingQuality ?? "n/d"}</p>
                            </>
                          ) : source === "agency" ? (
                            <>
                              <p className="truncate" title={service.booking_service_kind ?? ""}>{service.booking_service_kind ?? "agency booking"}</p>
                              <p className="truncate text-slate-500">{service.customer_email ?? "email n/d"}</p>
                            </>
                          ) : (
                            <p className="truncate text-slate-500">Inserimento operatore</p>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <p className="line-clamp-2 max-w-[200px] text-safe-wrap" title={driverName}>
                          {driverName}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        <span className={statusClass(service.status)}>{SERVICE_STATUS_LABELS[service.status]}</span>
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
                          title="Apri"
                          className="btn-secondary whitespace-nowrap px-3 py-1.5 text-xs"
                        >
                          <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary" />
                          Apri
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
            </DataTable>
          </div>
        </>
      )}

      {selectedService ? (
        <aside className="card space-y-3 p-4 md:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold">Dettagli servizio</h3>
            <button type="button" onClick={() => setSelectedServiceId(null)} className="text-sm text-muted">
              Chiudi
            </button>
          </div>
          {(() => {
            const pdfMeta = pdfMetaByServiceId.get(selectedService.id);
            const source = sourceByServiceId.get(selectedService.id) ?? "manual";
            return source === "pdf" && pdfMeta ? (
              <div className="flex flex-wrap gap-2">
                <span className="rounded-full bg-blue-100 px-2 py-1 text-xs font-semibold uppercase text-blue-700">PDF</span>
                <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold uppercase text-slate-700">{pdfMeta.parserKey ?? "parser n/d"}</span>
                <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold uppercase text-slate-700">{pdfMeta.parsingQuality ?? "n/d"}</span>
                {pdfMeta.manualReview ? <span className="rounded-full bg-emerald-100 px-2 py-1 text-xs font-semibold uppercase text-emerald-700">Reviewed</span> : null}
              </div>
            ) : source === "agency" ? (
              <div className="flex flex-wrap gap-2">
                <span className="rounded-full bg-violet-100 px-2 py-1 text-xs font-semibold uppercase text-violet-700">Agenzia</span>
              </div>
            ) : null;
          })()}
          <p className="text-sm">Cliente: {getCustomerFullName(selectedService)}</p>
          <p className="text-sm">Data andata: {formatIsoDateShort(selectedService.arrival_date ?? selectedService.date)}</p>
          <p className="text-sm">{getOutwardTimeLabel(selectedService)}: {getOutboundTime(selectedService) ?? "N/D"}</p>
          {selectedService.departure_date || getReturnTime(selectedService) ? (
            <p className="text-sm">{`${formatIsoDateShort(selectedService.departure_date)} ${getReturnTimeLabel(selectedService)}: ${getReturnTime(selectedService) ?? ""}`.trim()}</p>
          ) : null}
          {getTransportReferenceOutward(selectedService) ? (
            <p className="text-sm">{getOutwardReferenceLabel(selectedService)}: {getTransportReferenceOutward(selectedService)}</p>
          ) : null}
          {getTransportReferenceReturn(selectedService) ? (
            <p className="text-sm">{getReturnReferenceLabel(selectedService)}: {getTransportReferenceReturn(selectedService)}</p>
          ) : null}
          {selectedService.source_total_amount_cents ? (
            <p className="text-sm">Costo PDF: {(selectedService.source_total_amount_cents / 100).toFixed(2)} {selectedService.source_amount_currency ?? "EUR"}</p>
          ) : null}
          {selectedService.source_price_per_pax_cents ? (
            <p className="text-sm">Costo PDF/pax: {(selectedService.source_price_per_pax_cents / 100).toFixed(2)} {selectedService.source_amount_currency ?? "EUR"}</p>
          ) : null}
          {selectedService.billing_party_name ? <p className="text-sm">Agenzia fatturazione: {selectedService.billing_party_name}</p> : null}
          <p className="text-sm">Tipo: {selectedService.service_type_code ?? selectedService.service_type ?? "transfer"}</p>
          <p className="text-sm">Nave: {selectedService.vessel}</p>
          <p className="text-sm">Hotel: {hotels.find((item) => item.id === selectedService.hotel_id)?.name ?? "N/D"}</p>
          {(() => {
            const pdfMeta = pdfMetaByServiceId.get(selectedService.id);
            const source = sourceByServiceId.get(selectedService.id) ?? "manual";
            return source === "pdf" && pdfMeta ? (
              <>
                <p className="text-sm">Agenzia: {pdfMeta.agencyName ?? "N/D"}</p>
                <p className="text-sm">External ref: {pdfMeta.externalReference ?? "N/D"}</p>
                <p className="text-sm">Import state: {pdfMeta.importState ?? "N/D"}</p>
              </>
            ) : source === "agency" ? (
              <>
                <p className="text-sm">Origine: booking agenzia</p>
                <p className="text-sm">Booking kind: {selectedService.booking_service_kind ?? "N/D"}</p>
                <p className="text-sm">Email cliente: {selectedService.customer_email ?? "N/D"}</p>
              </>
            ) : null;
          })()}
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

