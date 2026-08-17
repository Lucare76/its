"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ExportServicesButton } from "@/components/export-services-button";
import { WhatsAppButton } from "@/components/whatsapp-button";
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
import { isUndeliveredReminder } from "@/lib/service-reminder";
import { buildServicesListRequest, type ServicesListFilters } from "@/lib/services-list-request";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";
import type { Assignment, Hotel, InboundEmail, Membership, Service, ServiceStatus, ServiceType, StatusEvent } from "@/lib/types";
import { SERVICE_STATUS_LABELS, SERVICE_TYPE_LABELS } from "@/lib/ui-labels";

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 300;

interface ServicesTableProps {
  hotels: Hotel[];
  memberships: Membership[];
  /** Bump to force a reload of the current page/filters (e.g. parent "Aggiorna" button). */
  refreshToken?: number;
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

function getServiceTypeBadgeTone(service: Service) {
  const isExcursion = service.booking_service_kind === "excursion" || service.service_type_code === "excursion";
  if (isExcursion) return "bg-purple-100 text-purple-700";
  if ((service.service_type ?? "transfer") === "bus_tour") return "bg-emerald-100 text-emerald-700";
  return "bg-blue-100 text-blue-700";
}

type ServicesListStats = {
  totale: number;
  needsAttention: number;
  lineeBus: number;
  altriServizi: number;
  daAssegnareInternamente: number;
  promemoriaDaVerificare: number;
};

const EMPTY_STATS: ServicesListStats = {
  totale: 0,
  needsAttention: 0,
  lineeBus: 0,
  altriServizi: 0,
  daAssegnareInternamente: 0,
  promemoriaDaVerificare: 0
};

export function ServicesTable({ hotels, memberships, refreshToken = 0 }: ServicesTableProps) {
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
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(1);

  const [selectedServiceId, setSelectedServiceId] = useState<string | null>(null);
  const [shareLoading, setShareLoading] = useState(false);
  const [shareMessage, setShareMessage] = useState<string>("");
  const [shareUrlByServiceId, setShareUrlByServiceId] = useState<Record<string, string>>({});
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteMessage, setDeleteMessage] = useState<string>("");

  const [pageServices, setPageServices] = useState<Service[]>([]);
  const [pageAssignments, setPageAssignments] = useState<Assignment[]>([]);
  const [pageStatusEvents, setPageStatusEvents] = useState<StatusEvent[]>([]);
  const [pageInboundEmails, setPageInboundEmails] = useState<InboundEmail[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [knownVessels, setKnownVessels] = useState<string[]>([]);
  const [knownAgencies, setKnownAgencies] = useState<string[]>([]);
  const [listStats, setListStats] = useState<ServicesListStats>(EMPTY_STATS);

  const tenantId = memberships[0]?.tenant_id ?? hotels[0]?.tenant_id ?? null;

  useEffect(() => {
    const handle = setTimeout(() => setDebouncedSearch(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [search]);

  const filters: ServicesListFilters = useMemo(
    () => ({
      status: statusFilter,
      serviceType: serviceTypeFilter,
      vessel: vesselFilter,
      zone: zoneFilter,
      driverUserId: driverFilter,
      search: debouncedSearch,
      source: sourceFilter,
      reviewed: reviewedFilter,
      agency: agencyFilter,
      quality: qualityFilter
    }),
    [statusFilter, serviceTypeFilter, vesselFilter, zoneFilter, driverFilter, debouncedSearch, sourceFilter, reviewedFilter, agencyFilter, qualityFilter]
  );
  const latestRequestKeyRef = useRef<string>("");

  useEffect(() => {
    let cancelled = false;
    const { body, requestKey } = buildServicesListRequest({ tenantId: tenantId ?? "", filters, page, pageSize: PAGE_SIZE });
    latestRequestKeyRef.current = requestKey;

    const load = async () => {
      if (!tenantId || !hasSupabaseEnv || !supabase) {
        setListLoading(false);
        return;
      }
      setListLoading(true);
      setListError(null);
      const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
      if (cancelled || latestRequestKeyRef.current !== requestKey) return;
      if (sessionError || !sessionData.session?.access_token) {
        setListError("Sessione non valida.");
        setListLoading(false);
        return;
      }

      const response = await fetch("/api/services/list", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sessionData.session.access_token}`
        },
        body: JSON.stringify(body)
      });
      if (cancelled || latestRequestKeyRef.current !== requestKey) return;

      const responsePayload = (await response.json().catch(() => null)) as {
        services?: Service[];
        assignments?: Assignment[];
        status_events?: StatusEvent[];
        inbound_emails?: InboundEmail[];
        has_more?: boolean;
        stats?: ServicesListStats;
        known_vessels?: string[];
        known_agencies?: string[];
        error?: string;
      } | null;

      if (!response.ok || !responsePayload) {
        setListError(responsePayload?.error ?? "Errore caricamento servizi.");
        setListLoading(false);
        return;
      }

      setPageServices(responsePayload.services ?? []);
      setPageAssignments(responsePayload.assignments ?? []);
      setPageStatusEvents(responsePayload.status_events ?? []);
      setPageInboundEmails(responsePayload.inbound_emails ?? []);
      setHasMore(Boolean(responsePayload.has_more));
      setListStats(responsePayload.stats ?? EMPTY_STATS);
      // Sprint Performance 14A fix: these come from lightweight server-side
      // lookups scoped to the whole filtered dataset, not accumulated from
      // pages the user happened to visit — see
      // lib/server/services-list-aggregates.ts.
      setKnownVessels(responsePayload.known_vessels ?? []);
      setKnownAgencies(responsePayload.known_agencies ?? []);
      setListLoading(false);
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [tenantId, filters, page, reloadToken]);

  const assignedMap = useMemo(() => new Map(pageAssignments.map((item) => [item.service_id, item])), [pageAssignments]);
  const drivers = memberships.filter((member) => member.role === "driver");
  const zones = [...new Set(hotels.map((hotel) => hotel.zone))];
  const pdfMetaByServiceId = useMemo(
    () => new Map(pageServices.map((service) => [service.id, getServicePdfOperationalMeta(service, pageInboundEmails)])),
    [pageInboundEmails, pageServices]
  );
  const sourceByServiceId = useMemo(
    () => new Map(pageServices.map((service) => [service.id, getServiceOperationalSource(service, pageInboundEmails)])),
    [pageInboundEmails, pageServices]
  );

  // Sprint Performance 14A fix: source/reviewed/agency/quality are now
  // applied server-side against the whole filtered dataset (see
  // lib/server/services-list-aggregates.ts), so the page already only
  // contains matching rows — no client-side re-filtering needed here.
  const baseServices = pageServices;
  const filtered = baseServices;

  const selectedService = selectedServiceId ? baseServices.find((item) => item.id === selectedServiceId) : null;
  const filteredOperationalStats = listStats;
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

  const handleDeleteSelectedService = async () => {
    if (!selectedService || !hasSupabaseEnv || !supabase || deleteLoading) return;
    const customerName = getCustomerFullName(selectedService);
    const confirmed = window.confirm(`Eliminare definitivamente la prenotazione di ${customerName}? L'operazione non e reversibile.`);
    if (!confirmed) return;

    setDeleteLoading(true);
    setDeleteMessage("");
    const { data, error } = await supabase.auth.getSession();
    if (error || !data.session?.access_token) {
      setDeleteLoading(false);
      setDeleteMessage("Sessione non valida.");
      return;
    }

    const response = await fetch(`/api/ops/services/${selectedService.id}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${data.session.access_token}`
      }
    });
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    if (!response.ok) {
      setDeleteLoading(false);
      setDeleteMessage(body?.error ?? "Eliminazione non riuscita.");
      return;
    }

    setSelectedServiceId(null);
    setDeleteLoading(false);
    setDeleteMessage("Prenotazione eliminata.");
    // Sprint Performance 14A — FASE B16: reload the CURRENT page/filters only,
    // never fall back to a full-history refetch.
    setReloadToken((value) => value + 1);
  };
  const selectedTimeline = useMemo(() => {
    if (!selectedService) return [];

    const usersById = new Map(memberships.map((item) => [item.user_id, item.full_name]));
    const serviceStatusEvents = pageStatusEvents
      .filter((event) => event.service_id === selectedService.id)
      .sort((a, b) => a.at.localeCompare(b.at));

    const assignment = pageAssignments.find((item) => item.service_id === selectedService.id);
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

    const linkedInbound = pageInboundEmails.filter((email) => {
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
  }, [selectedService, memberships, pageStatusEvents, pageAssignments, pageInboundEmails]);

  const exportDefaults = useMemo(() => {
    const today = new Date();
    const past = new Date(today);
    past.setDate(past.getDate() - 30);
    const future = new Date(today);
    future.setDate(future.getDate() + 30);
    return { from: past.toISOString().slice(0, 10), to: future.toISOString().slice(0, 10) };
  }, []);

  const serviceMeta = (service: Service) => {
    const hotel = hotels.find((item) => item.id === service.hotel_id);
    const assignment = assignedMap.get(service.id);
    const driverName = memberships.find((member) => member.user_id === assignment?.driver_user_id)?.full_name ?? "Non assegnato";
    const pdfMeta = pdfMetaByServiceId.get(service.id);
    const source = sourceByServiceId.get(service.id) ?? "manual";
    return { hotel, driverName, pdfMeta, source };
  };

  const resetOperationalFilters = () => {
    setStatusFilter("all");
    setVesselFilter("all");
    setServiceTypeFilter("all");
    setZoneFilter("all");
    setDriverFilter("all");
    setSourceFilter("all");
    setReviewedFilter("all");
    setAgencyFilter("all");
    setQualityFilter("all");
    setSearch("");
    setPage(1);
  };

  const noServerFiltersActive =
    statusFilter === "all" &&
    vesselFilter === "all" &&
    serviceTypeFilter === "all" &&
    zoneFilter === "all" &&
    driverFilter === "all" &&
    search.trim().length === 0 &&
    sourceFilter === "all" &&
    reviewedFilter === "all" &&
    agencyFilter === "all" &&
    qualityFilter === "all";

  if (listLoading && pageServices.length === 0) {
    return <div className="card p-4 text-sm text-slate-500">Caricamento servizi...</div>;
  }

  if (!listLoading && !listError && page === 1 && !hasMore && baseServices.length === 0 && noServerFiltersActive) {
    return <EmptyState title="Nessun servizio registrato." compact />;
  }

  const paginationControls = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-xs text-muted">
        Pagina {page}
        {hasMore ? "" : " (ultima)"}
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          className="btn-secondary px-3 py-1.5 text-xs disabled:opacity-50"
          disabled={page <= 1 || listLoading}
          onClick={() => setPage((value) => Math.max(1, value - 1))}
        >
          Precedente
        </button>
        <button
          type="button"
          className="btn-secondary px-3 py-1.5 text-xs disabled:opacity-50"
          disabled={!hasMore || listLoading}
          onClick={() => setPage((value) => value + 1)}
        >
          Successiva
        </button>
      </div>
    </div>
  );

  return (
    <section className="space-y-5">
      <div className="flex flex-col gap-3 rounded-[28px] border border-slate-200 bg-white p-4 shadow-[0_18px_45px_rgba(15,23,42,0.06)] lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-xl font-black tracking-tight text-slate-950">Controllo servizi</h2>
          <p className="mt-1 text-sm font-medium text-slate-500">Filtra, verifica e apri le pratiche operative senza caricare tutto il database.</p>
        </div>
        <ExportServicesButton defaultDateFrom={exportDefaults.from} defaultDateTo={exportDefaults.to} />
      </div>
      {listError ? <div className="card border-red-200 bg-red-50 p-3 text-sm text-red-700">{listError}</div> : null}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        <button type="button" onClick={resetOperationalFilters} className="group rounded-3xl border border-slate-200 bg-white p-4 text-left shadow-[0_14px_34px_rgba(15,23,42,0.06)] transition hover:-translate-y-0.5 hover:border-blue-200 hover:shadow-[0_18px_42px_rgba(37,99,235,0.10)]">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-50 text-lg text-blue-700">▣</span>
          <p className="mt-3 text-sm font-bold text-slate-500">Totale visibili</p>
          <p className="text-3xl font-black tracking-tight text-slate-950">{filteredOperationalStats.totale}</p>
          <p className="mt-1 text-xs font-medium text-slate-500">Reset vista completa.</p>
        </button>
        <button
          type="button"
          onClick={() => {
            setSourceFilter("pdf");
            setQualityFilter("low");
            setReviewedFilter("no");
            setPage(1);
          }}
          className="group rounded-3xl border border-slate-200 bg-white p-4 text-left shadow-[0_14px_34px_rgba(15,23,42,0.06)] transition hover:-translate-y-0.5 hover:border-amber-200 hover:shadow-[0_18px_42px_rgba(245,158,11,0.10)]"
        >
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-50 text-lg text-amber-700">!</span>
          <p className="mt-3 text-sm font-bold text-slate-500">Da verificare</p>
          <p className="text-3xl font-black tracking-tight text-amber-700">{filteredOperationalStats.needsAttention}</p>
          <p className="mt-1 text-xs font-medium text-slate-500">PDF o qualità bassa.</p>
        </button>
        <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-[0_14px_34px_rgba(15,23,42,0.06)]">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-cyan-50 text-lg text-cyan-700">▤</span>
          <p className="mt-3 text-sm font-bold text-slate-500">Linea bus</p>
          <p className="text-3xl font-black tracking-tight text-slate-950">{filteredOperationalStats.lineeBus}</p>
          <p className="mt-1 text-xs font-medium text-slate-500">Bus linea / città-hotel.</p>
        </div>
        <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-[0_14px_34px_rgba(15,23,42,0.06)]">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-violet-50 text-lg text-violet-700">↗</span>
          <p className="mt-3 text-sm font-bold text-slate-500">Altri servizi</p>
          <p className="text-3xl font-black tracking-tight text-slate-950">{filteredOperationalStats.altriServizi}</p>
          <p className="mt-1 text-xs font-medium text-slate-500">Nave, aeroporto, stazione.</p>
        </div>
        <button
          type="button"
          onClick={() => {
            setDriverFilter("all");
            setPage(1);
          }}
          className="group rounded-3xl border border-slate-200 bg-white p-4 text-left shadow-[0_14px_34px_rgba(15,23,42,0.06)] transition hover:-translate-y-0.5 hover:border-rose-200 hover:shadow-[0_18px_42px_rgba(244,63,94,0.10)]"
        >
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-rose-50 text-lg text-rose-700">⌁</span>
          <p className="mt-3 text-sm font-bold text-slate-500">Da gestire</p>
          <p className="text-3xl font-black tracking-tight text-slate-950">{filteredOperationalStats.daAssegnareInternamente}</p>
          <p className="mt-1 text-xs font-medium text-slate-500">Senza autista interno.</p>
        </button>
        <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-[0_14px_34px_rgba(15,23,42,0.06)]">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-orange-50 text-lg text-orange-700">◷</span>
          <p className="mt-3 text-sm font-bold text-slate-500">Promemoria</p>
          <p className="text-3xl font-black tracking-tight text-amber-700">{filteredOperationalStats.promemoriaDaVerificare}</p>
          <p className="mt-1 text-xs font-medium text-slate-500">Non consegnati.</p>
        </div>
      </div>
      <FilterBar className="rounded-[28px] border border-slate-200 bg-white p-4 shadow-[0_18px_45px_rgba(15,23,42,0.06)]" colsClassName="lg:grid-cols-4 xl:grid-cols-9">
        <select
          value={statusFilter}
          onChange={(event) => {
            setStatusFilter(event.target.value as ServiceStatus | "all");
            setPage(1);
          }}
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
          onChange={(event) => {
            setServiceTypeFilter(event.target.value as ServiceType | "all");
            setPage(1);
          }}
          className="input-saas"
        >
          <option value="all">Tipo: tutti</option>
          <option value="transfer">{SERVICE_TYPE_LABELS.transfer}</option>
          <option value="bus_tour">{SERVICE_TYPE_LABELS.bus_tour}</option>
        </select>
        <select
          value={vesselFilter}
          onChange={(event) => {
            setVesselFilter(event.target.value);
            setPage(1);
          }}
          className="input-saas"
        >
          <option value="all">Nave: tutte</option>
          {knownVessels.map((vessel) => (
            <option key={vessel} value={vessel}>
              {vessel}
            </option>
          ))}
        </select>
        <select
          value={zoneFilter}
          onChange={(event) => {
            setZoneFilter(event.target.value);
            setPage(1);
          }}
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
          onChange={(event) => {
            setDriverFilter(event.target.value);
            setPage(1);
          }}
          className="input-saas"
        >
          <option value="all">Driver: tutti</option>
          {drivers.map((driver) => (
            <option key={driver.user_id} value={driver.user_id}>
              {driver.full_name}
            </option>
          ))}
        </select>
        <select
          data-testid="services-source-filter"
          value={sourceFilter}
          onChange={(event) => {
            setSourceFilter(event.target.value as "all" | "pdf" | "agency" | "manual");
            setPage(1);
          }}
          className="input-saas"
        >
          <option value="all">Origine: tutte</option>
          <option value="pdf">Solo PDF</option>
          <option value="agency">Solo agenzia</option>
          <option value="manual">Solo manuali</option>
        </select>
        <select
          data-testid="services-reviewed-filter"
          value={reviewedFilter}
          onChange={(event) => {
            setReviewedFilter(event.target.value as "all" | "yes" | "no");
            setPage(1);
          }}
          className="input-saas"
        >
          <option value="all">Reviewed: tutti</option>
          <option value="yes">Reviewed si</option>
          <option value="no">Reviewed no</option>
        </select>
        <select
          data-testid="services-agency-filter"
          value={agencyFilter}
          onChange={(event) => {
            setAgencyFilter(event.target.value);
            setPage(1);
          }}
          className="input-saas"
        >
          <option value="all">Agenzia: tutte</option>
          {knownAgencies.map((agency) => (
            <option key={agency} value={agency}>
              {agency}
            </option>
          ))}
        </select>
        <select
          data-testid="services-quality-filter"
          value={qualityFilter}
          onChange={(event) => {
            setQualityFilter(event.target.value as "all" | "low");
            setPage(1);
          }}
          className="input-saas"
        >
          <option value="all">Qualita: tutte</option>
          <option value="low">Qualita low</option>
        </select>
        <input
          data-testid="services-search"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(1);
          }}
          placeholder="Cerca cliente, telefono, hotel, pax, data, orario..."
          className="input-saas"
        />
      </FilterBar>

      {filtered.length === 0 ? (
        <EmptyState title="Nessun risultato per i filtri impostati." compact />
      ) : (
        <>
          <div className="space-y-3 md:hidden">
            <p className="text-xs text-muted">Risultati pagina: {filtered.length}</p>
            {filtered.map((service) => {
              const { hotel, driverName, pdfMeta, source } = serviceMeta(service);
              return (
                <article key={`mobile-${service.id}`} className="rounded-3xl border border-slate-200 bg-white p-4 shadow-[0_14px_34px_rgba(15,23,42,0.06)]">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-xs font-black text-blue-700">{formatServiceSlot(service)}</p>
                      <p className="mt-1 text-base font-black leading-5 text-slate-950">{getCustomerFullName(service)}</p>
                    </div>
                    <span className={statusClass(service.status)}>{SERVICE_STATUS_LABELS[service.status]}</span>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted">
                    <span className={`rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] ${getServiceTypeBadgeTone(service)}`}>
                      {SERVICE_TYPE_LABELS[(service.service_type ?? "transfer") as ServiceType]}
                    </span>
                    <span>{service.vessel}</span>
                  </div>
                  <p className="text-xs text-muted">
                    Hotel: {hotel?.name ?? "N/D"} ({hotel?.zone ?? "N/D"}) | Driver: {driverName}
                  </p>
                  <p className="text-xs text-muted">Operativo: {service.date} | Pax {service.pax}</p>
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
            {paginationControls}
          </div>
          <div className="hidden md:block">
            <DataTable
              minWidthClassName="min-w-[1180px]"
              loading={listLoading}
              className="overflow-hidden rounded-[28px] border-slate-200 shadow-[0_18px_45px_rgba(15,23,42,0.06)]"
              toolbar={
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-black text-slate-950">Risultati pagina: {filtered.length}</p>
                  <p className="text-xs font-medium text-slate-500">Pagina {page}{hasMore ? "" : " · ultima"}</p>
                </div>
              }
              footer={paginationControls}
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
                  <th className="w-[130px] px-4 py-3">Data / ora</th>
                  <th className="w-[210px] px-4 py-3">Cliente</th>
                  <th className="w-[105px] px-4 py-3">Tipo</th>
                  <th className="w-[150px] px-4 py-3">Mezzo</th>
                  <th className="w-[190px] px-4 py-3">Hotel / zona</th>
                  <th className="w-[105px] px-4 py-3">Origine</th>
                  <th className="w-[165px] px-4 py-3">Riferimento</th>
                  <th className="w-[130px] px-4 py-3">Driver</th>
                  <th className="w-[120px] px-4 py-3">Stato</th>
                  <th className="w-[105px] px-4 py-3 text-right">Azione</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((service) => {
                  const { hotel, driverName, pdfMeta, source } = serviceMeta(service);
                  return (
                    <tr key={service.id} className="transition hover:bg-blue-50/40">
                      <td className="whitespace-nowrap px-4 py-4 text-sm font-black text-blue-700">{formatServiceSlot(service)}</td>
                      <td className="px-4 py-3">
                        <p className="line-clamp-2 text-sm font-black leading-5 text-slate-950" title={getCustomerFullName(service)}>
                          {getCustomerFullName(service)}
                        </p>
                        <div className="mt-0.5 flex items-center gap-1.5">
                          <p className="truncate text-xs text-slate-500">{service.phone || "telefono n/d"} | Pax {service.pax}</p>
                          <WhatsAppButton phone={service.phone_e164 ?? service.phone} name={getCustomerFullName(service)} tenantId={service.tenant_id} />
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex max-w-full rounded px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.04em] ${getServiceTypeBadgeTone(service)}`}>
                          {SERVICE_TYPE_LABELS[(service.service_type ?? "transfer") as ServiceType]}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <p className="line-clamp-2 text-xs leading-5 text-slate-700" title={service.vessel}>
                          {service.vessel}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-xs text-slate-700">
                          <p className="truncate font-medium text-slate-900" title={hotel?.name ?? "N/D"}>
                            {hotel?.name ?? "N/D"}
                          </p>
                          <p className="truncate text-slate-500" title={hotel?.zone ?? "N/D"}>
                            {hotel?.zone ?? "N/D"}
                          </p>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        {source === "pdf" && pdfMeta ? (
                          <div className="flex flex-col items-start gap-1">
                            <span className="rounded bg-blue-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-blue-700">PDF</span>
                            {pdfMeta.manualReview ? <span className="rounded bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-emerald-700">Reviewed</span> : null}
                            {pdfMeta.reviewRecommended ? <span className="rounded bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-amber-700">Attenzione</span> : null}
                          </div>
                        ) : source === "agency" ? (
                          <span className="rounded bg-violet-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-violet-700">Agenzia</span>
                        ) : (
                          <span className="text-xs text-muted">Manuale</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-xs leading-5 text-slate-700">
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
                        <p className="line-clamp-2 text-xs leading-5 text-slate-700" title={driverName}>
                          {driverName}
                        </p>
                      </td>
                      <td className="space-y-1 px-4 py-3">
                        <span className={statusClass(service.status)}>{SERVICE_STATUS_LABELS[service.status]}</span>
                        {isUndeliveredReminder(service) ? (
                          <span className="inline-flex rounded bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-amber-700">
                            Non consegnato
                          </span>
                        ) : null}
                        {pdfMeta?.reviewRecommended ? (
                          <span className="inline-flex rounded bg-orange-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-orange-700">
                            Review
                          </span>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          onClick={() => setSelectedServiceId(service.id)}
                          title="Apri"
                          className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700 shadow-sm transition hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700"
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
            <div className="flex items-center gap-2">
              <a href={`/services/${selectedService.id}/edit`} className="btn-primary px-3 py-1.5 text-xs">
                Modifica
              </a>
              <button
                type="button"
                onClick={() => void handleDeleteSelectedService()}
                disabled={deleteLoading}
                className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-100 disabled:opacity-50"
              >
                {deleteLoading ? "Elimino..." : "Elimina"}
              </button>
              <button type="button" onClick={() => setSelectedServiceId(null)} className="text-sm text-muted">
                Chiudi
              </button>
            </div>
          </div>
          {deleteMessage ? <p className="rounded-xl border border-rose-100 bg-rose-50 px-3 py-2 text-xs text-rose-700">{deleteMessage}</p> : null}
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
          <div className="flex items-center gap-2 text-sm">
            <span>Telefono: {selectedService.phone || "N/D"}</span>
            <WhatsAppButton phone={selectedService.phone_e164 ?? selectedService.phone} name={getCustomerFullName(selectedService)} tenantId={selectedService.tenant_id} size="md" />
          </div>
          <p className="text-sm">Pax: {selectedService.pax}</p>
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
          {selectedService.billing_party_name ? <p className="text-sm">Agenzia fatturazione: {selectedService.billing_party_name.toUpperCase()}</p> : null}
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
