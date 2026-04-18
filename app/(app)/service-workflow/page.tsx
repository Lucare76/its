"use client";

import { useEffect, useMemo, useState } from "react";
import { EmptyState, PageHeader, SectionCard } from "@/components/ui";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";
import { useTenantOperationalData } from "@/lib/supabase/use-tenant-operational-data";
import type { ServiceStatus } from "@/lib/types";

const statusLabels: Array<{ status: ServiceStatus; label: string; detail: string }> = [
  { status: "needs_review", label: "Da verificare", detail: "Servizi che richiedono ancora controllo operatore." },
  { status: "new", label: "Pronti operativi", detail: "Servizi confermati e pronti per entrare nell'operativo." },
  { status: "assigned", label: "Presi in carico", detail: "Servizi con scheda interna o assegnazione parziale." },
  { status: "partito", label: "In corso", detail: "Servizi avviati e attivi in giornata." },
  { status: "arrivato", label: "Arrivati", detail: "Servizi conclusi lato arrivo ma non ancora chiusi." },
  { status: "completato", label: "Chiusi", detail: "Servizi chiusi amministrativamente." },
  { status: "problema", label: "Con problema", detail: "Servizi che richiedono intervento operativo." },
  { status: "cancelled", label: "Annullati", detail: "Servizi annullati e fuori dal lotto operativo." }
];

function formatDateLabel(dateIso: string) {
  const [year, month, day] = dateIso.split("-");
  return day && month && year ? `${day}/${month}/${year.slice(2)}` : dateIso;
}

function appendInternalTags(notes: string, extraNote: string, markHandled: boolean) {
  const nextParts = [notes ?? ""];
  if (markHandled && !notes.includes("[dispatch:handled-internally]")) {
    nextParts.push("[dispatch:handled-internally]");
  }
  if (extraNote.trim()) {
    nextParts.push(`[internal_note:${extraNote.trim()}]`);
  }
  return nextParts.filter(Boolean).join(" ").trim();
}

export default function ServiceWorkflowPage() {
  const { data, loading, errorMessage, liveConnected, tenantId, userId, refresh } = useTenantOperationalData();
  const [selectedServiceId, setSelectedServiceId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [savingStatus, setSavingStatus] = useState<ServiceStatus | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [internalNote, setInternalNote] = useState("");
  const [bulkInternalNote, setBulkInternalNote] = useState("");
  const [savingInternalAction, setSavingInternalAction] = useState(false);
  const [bulkLoading, setBulkLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState<"all" | ServiceStatus>("all");
  const [query, setQuery] = useState("");
  const [assigningDriver, setAssigningDriver] = useState(false);
  const [driverSelectId, setDriverSelectId] = useState<string>("");
  const [vehicleSelectLabel, setVehicleSelectLabel] = useState<string>("");
  const [vehicles, setVehicles] = useState<Array<{ id: string; label: string; plate: string | null; habitual_driver_user_id: string | null }>>([]);

  // Carica veicoli attivi del tenant
  useEffect(() => {
    if (!hasSupabaseEnv || !supabase || !tenantId) return;
    void supabase
      .from("vehicle_records")
      .select("id, label, plate, habitual_driver_user_id")
      .eq("tenant_id", tenantId)
      .eq("active", true)
      .order("label")
      .then(({ data: v }) => {
        if (v) setVehicles(v as typeof vehicles);
      });
  }, [tenantId]);

  const workflow = useMemo(() => {
    const counts = new Map<ServiceStatus, number>();
    for (const item of statusLabels) counts.set(item.status, 0);

    let withoutPricing = 0;
    let remindersFailed = 0;
    let internalOnly = 0;
    let futureOperational = 0;

    for (const service of data.services) {
      counts.set(service.status, (counts.get(service.status) ?? 0) + 1);
      if (!service.applied_pricing_rule_id) withoutPricing += 1;
      if (service.reminder_status === "failed") remindersFailed += 1;
      if (!service.notes.includes("[dispatch:handled-internally]")) internalOnly += 1;
      if (service.status === "new" || service.status === "assigned") futureOperational += 1;
    }

    return {
      counts,
      withoutPricing,
      remindersFailed,
      internalOnly,
      futureOperational
    };
  }, [data.services]);

  const filteredServices = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return [...data.services]
      .filter((service) => (statusFilter === "all" ? true : service.status === statusFilter))
      .filter((service) => {
        if (!normalizedQuery) return true;
        const haystack = [
          service.customer_name,
          service.billing_party_name ?? "",
          service.booking_service_kind ?? "",
          service.service_type_code ?? "",
          service.notes ?? ""
        ]
          .join(" ")
          .toLowerCase();
        return haystack.includes(normalizedQuery);
      })
      .sort((left, right) => {
        const leftDate = `${left.date}T${left.time || "00:00"}`;
        const rightDate = `${right.date}T${right.time || "00:00"}`;
        return rightDate.localeCompare(leftDate);
      });
  }, [data.services, query, statusFilter]);

  const visibleServices = filteredServices.slice(0, 40);
  const selectedService = data.services.find((item) => item.id === selectedServiceId) ?? visibleServices[0] ?? null;

  const drivers = useMemo(
    () => data.memberships.filter((m) => m.role === "driver"),
    [data.memberships]
  );

  const currentAssignment = useMemo(
    () => selectedService ? data.assignments.find((a) => a.service_id === selectedService.id) ?? null : null,
    [data.assignments, selectedService]
  );

  // Precompila i select quando cambia il servizio selezionato
  useEffect(() => {
    setDriverSelectId(currentAssignment?.driver_user_id ?? "");
    setVehicleSelectLabel(currentAssignment?.vehicle_label ?? "");
  }, [currentAssignment]);

  const assignDriver = async () => {
    if (!selectedService || !tenantId || !hasSupabaseEnv || !supabase) return;
    setAssigningDriver(true);
    setMessage("Salvataggio assegnazione...");
    try {
      if (!driverSelectId) {
        await supabase.from("assignments").delete().eq("service_id", selectedService.id).eq("tenant_id", tenantId);
        setMessage("Assegnazione rimossa.");
      } else if (currentAssignment) {
        await supabase.from("assignments")
          .update({ driver_user_id: driverSelectId, vehicle_label: vehicleSelectLabel })
          .eq("id", currentAssignment.id).eq("tenant_id", tenantId);
        setMessage("Assegnazione aggiornata.");
      } else {
        await supabase.from("assignments").insert({
          tenant_id: tenantId,
          service_id: selectedService.id,
          driver_user_id: driverSelectId,
          vehicle_label: vehicleSelectLabel,
        });
        setMessage("Autista assegnato.");
      }
      await refresh();
    } catch {
      setMessage("Errore durante l'assegnazione.");
    } finally {
      setAssigningDriver(false);
    }
  };

  const recentEvents = !selectedService
    ? []
    : [...data.statusEvents]
        .filter((item) => item.service_id === selectedService.id)
        .sort((left, right) => right.at.localeCompare(left.at))
        .slice(0, 6);

  const selectedCount = selectedIds.length;

  const toggleSelected = (serviceId: string) => {
    setSelectedIds((current) => (current.includes(serviceId) ? current.filter((item) => item !== serviceId) : [...current, serviceId]));
  };

  const selectVisible = () => {
    setSelectedIds((current) => Array.from(new Set([...current, ...visibleServices.map((service) => service.id)])));
  };

  const clearSelection = () => {
    setSelectedIds([]);
  };

  const updateStatus = async (status: ServiceStatus) => {
    if (!selectedService || !tenantId || !userId || !hasSupabaseEnv || !supabase) return;
    setSavingStatus(status);
    setMessage(`Aggiornamento stato ${status} in corso...`);

    const { error: serviceError } = await supabase.from("services").update({ status }).eq("id", selectedService.id).eq("tenant_id", tenantId);
    if (serviceError) {
      setSavingStatus(null);
      setMessage(serviceError.message);
      return;
    }

    const { error: eventError } = await supabase.from("status_events").insert({
      tenant_id: tenantId,
      service_id: selectedService.id,
      status,
      by_user_id: userId
    });
    if (eventError) {
      setSavingStatus(null);
      setMessage(eventError.message);
      return;
    }

    await refresh();
    setSavingStatus(null);
    setMessage(`Servizio aggiornato a ${status}.`);
  };

  const saveInternalAction = async () => {
    if (!selectedService || !tenantId || !userId || !hasSupabaseEnv || !supabase) return;
    setSavingInternalAction(true);
    setMessage("Salvataggio nota interna e presa in carico...");

    const nextStatus = selectedService.status === "new" ? "assigned" : selectedService.status;
    const nextNotes = appendInternalTags(selectedService.notes ?? "", internalNote, true);

    const { error: serviceError } = await supabase
      .from("services")
      .update({ notes: nextNotes, status: nextStatus })
      .eq("id", selectedService.id)
      .eq("tenant_id", tenantId);

    if (serviceError) {
      setSavingInternalAction(false);
      setMessage(serviceError.message);
      return;
    }

    const { error: eventError } = await supabase.from("status_events").insert({
      tenant_id: tenantId,
      service_id: selectedService.id,
      status: nextStatus,
      by_user_id: userId
    });

    if (eventError) {
      setSavingInternalAction(false);
      setMessage(eventError.message);
      return;
    }

    setInternalNote("");
    await refresh();
    setSavingInternalAction(false);
    setMessage("Scheda interna aggiornata.");
  };

  const runBulkStatus = async (status: ServiceStatus) => {
    if (!tenantId || !userId || !hasSupabaseEnv || !supabase || selectedIds.length === 0) return;
    setBulkLoading(true);
    setMessage(`Aggiornamento massivo a ${status} in corso...`);

    const { error: updateError } = await supabase.from("services").update({ status }).in("id", selectedIds).eq("tenant_id", tenantId);
    if (updateError) {
      setBulkLoading(false);
      setMessage(updateError.message);
      return;
    }

    const events = selectedIds.map((serviceId) => ({
      tenant_id: tenantId,
      service_id: serviceId,
      status,
      by_user_id: userId
    }));
    const { error: eventError } = await supabase.from("status_events").insert(events);
    if (eventError) {
      setBulkLoading(false);
      setMessage(eventError.message);
      return;
    }

    await refresh();
    clearSelection();
    setBulkLoading(false);
    setMessage(`Aggiornati ${events.length} servizi a ${status}.`);
  };

  const markBulkHandledInternally = async () => {
    if (!tenantId || !userId || !hasSupabaseEnv || !supabase || selectedIds.length === 0) return;
    setBulkLoading(true);
    setMessage("Presa in carico massiva in corso...");

    const selectedServices = data.services.filter((service) => selectedIds.includes(service.id));
    for (const service of selectedServices) {
      const nextStatus = service.status === "new" ? "assigned" : service.status;
      const nextNotes = appendInternalTags(service.notes ?? "", bulkInternalNote, true);
      const { error: serviceError } = await supabase
        .from("services")
        .update({ notes: nextNotes, status: nextStatus })
        .eq("id", service.id)
        .eq("tenant_id", tenantId);

      if (serviceError) {
        setBulkLoading(false);
        setMessage(serviceError.message);
        return;
      }
    }

    const events = selectedServices.map((service) => ({
      tenant_id: tenantId,
      service_id: service.id,
      status: service.status === "new" ? "assigned" : service.status,
      by_user_id: userId
    }));
    const { error: eventError } = await supabase.from("status_events").insert(events);
    if (eventError) {
      setBulkLoading(false);
      setMessage(eventError.message);
      return;
    }

    setBulkInternalNote("");
    await refresh();
    clearSelection();
    setBulkLoading(false);
    setMessage(`Presa in carico aggiornata su ${events.length} servizi.`);
  };

  return (
    <section className="page-section">
      <PageHeader
        title="Workflow Servizi"
        subtitle="Vista unica dello stato operativo dei servizi, con selezione multipla e azioni massive per lavorare i lotti operativi."
        breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "Workflow Servizi" }]}
      />

      {errorMessage ? <EmptyState title="Workflow non disponibile" description={errorMessage} compact /> : null}
      {message ? <p className="text-sm text-muted">{message}</p> : null}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <SectionCard title="Servizi totali" subtitle={liveConnected ? "Realtime attivo" : "Realtime non connesso"} loading={loading}>
          <p className="text-3xl font-semibold text-text">{data.services.length}</p>
          <p className="mt-1 text-sm text-muted">{workflow.futureOperational} nel flusso operativo aperto</p>
        </SectionCard>
        <SectionCard title="Senza regola tariffaria" subtitle="Da completare lato pricing" loading={loading}>
          <p className="text-3xl font-semibold text-text">{workflow.withoutPricing}</p>
          <p className="mt-1 text-sm text-muted">Servizi ancora senza pricing rule applicata</p>
        </SectionCard>
        <SectionCard title="Reminder falliti" subtitle="Richiedono controllo" loading={loading}>
          <p className="text-3xl font-semibold text-text">{workflow.remindersFailed}</p>
          <p className="mt-1 text-sm text-muted">Servizi con reminder o notifiche da ripetere</p>
        </SectionCard>
        <SectionCard title="Gestione interna" subtitle="Perimetro Ischia Transfer" loading={loading}>
          <p className="text-3xl font-semibold text-text">{workflow.internalOnly}</p>
          <p className="mt-1 text-sm text-muted">Servizi ancora da lavorare internamente</p>
        </SectionCard>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.05fr_0.95fr]">
        <SectionCard title="Funnel stati servizio" subtitle="Lettura rapida del flusso end-to-end" loading={loading} loadingLines={6}>
          <div className="space-y-3">
            {statusLabels.map((item) => (
              <article key={item.status} className="rounded-2xl border border-border bg-surface/80 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-text">{item.label}</p>
                    <p className="text-xs text-muted">{item.detail}</p>
                  </div>
                  <span className="rounded-full bg-white px-3 py-1 text-sm font-semibold text-text shadow-sm">
                    {workflow.counts.get(item.status) ?? 0}
                  </span>
                </div>
              </article>
            ))}
          </div>
        </SectionCard>

        <SectionCard title="Controlli rapidi lotto" subtitle="Filtra i servizi, seleziona un lotto e applica azioni massive." loading={loading} loadingLines={6}>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="text-sm">
              Cerca cliente / agenzia
              <input className="input-saas mt-1" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Nome cliente, agenzia, tipo servizio" />
            </label>
            <label className="text-sm">
              Stato
              <select className="input-saas mt-1" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as "all" | ServiceStatus)}>
                <option value="all">tutti</option>
                {statusLabels.map((item) => (
                  <option key={item.status} value={item.status}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className="btn-secondary px-3 py-2 text-xs" onClick={selectVisible}>
              Seleziona visibili
            </button>
            <button type="button" className="btn-secondary px-3 py-2 text-xs" onClick={clearSelection}>
              Pulisci selezione
            </button>
            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] uppercase tracking-[0.12em] text-slate-700">
              {selectedCount} selezionati
            </span>
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            {(["assigned", "partito", "arrivato", "completato", "problema", "cancelled"] as ServiceStatus[]).map((status) => (
              <button
                key={status}
                type="button"
                className="btn-secondary px-3 py-2 text-xs disabled:opacity-50"
                disabled={bulkLoading || selectedCount === 0}
                onClick={() => void runBulkStatus(status)}
              >
                {bulkLoading ? "..." : `Massivo ${status}`}
              </button>
            ))}
          </div>

          <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-3">
            <label className="text-sm">
              Nota interna massiva
              <textarea
                className="input-saas mt-1 min-h-[92px]"
                value={bulkInternalNote}
                onChange={(event) => setBulkInternalNote(event.target.value)}
                placeholder="Nota comune da aggiungere al lotto selezionato"
              />
            </label>
            <div className="mt-3">
              <button type="button" className="btn-primary" disabled={bulkLoading || selectedCount === 0} onClick={() => void markBulkHandledInternally()}>
                {bulkLoading ? "Salvataggio..." : "Segna lotto preso in carico"}
              </button>
            </div>
          </div>
        </SectionCard>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.1fr_0.9fr]">
        <SectionCard title="Lotto servizi filtrati" subtitle="Selezione singola o multipla dei servizi su cui lavorare." loading={loading} loadingLines={8}>
          {visibleServices.length === 0 ? (
            <EmptyState title="Nessun servizio nel filtro" description="Cambia filtro o query per vedere i servizi del lotto." compact />
          ) : (
            <div className="space-y-2">
              {visibleServices.map((service) => (
                <article
                  key={service.id}
                  className={`rounded-2xl border p-3 ${selectedService?.id === service.id ? "border-primary bg-blue-50/40" : "border-border bg-surface/80"}`}
                >
                  <div className="flex items-start gap-3">
                    <input type="checkbox" className="mt-1 h-4 w-4" checked={selectedIds.includes(service.id)} onChange={() => toggleSelected(service.id)} />
                    <button type="button" onClick={() => setSelectedServiceId(service.id)} className="flex-1 text-left">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <p className="text-sm font-semibold text-text">{service.customer_name}</p>
                          <p className="text-xs text-muted">
                            {formatDateLabel(service.date)} {service.time} - {(service.billing_party_name ?? "Privato").toUpperCase()}
                          </p>
                          <p className="text-xs text-muted">
                            {service.service_type_code ?? service.booking_service_kind ?? "N/D"} - {service.pax} pax
                          </p>
                        </div>
                        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] uppercase tracking-[0.12em] text-slate-700">
                          {service.status}
                        </span>
                      </div>
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard title="Dettaglio servizio selezionato" subtitle="Azioni puntuali, nota interna e storico eventi del servizio." loading={loading} loadingLines={8}>
          {!selectedService ? (
            <EmptyState title="Nessun servizio selezionato" description="Scegli un servizio dal lotto per vedere i dettagli." compact />
          ) : (
            <div className="space-y-4">
              <article className="rounded-2xl border border-border bg-surface/80 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-text">{selectedService.customer_name}</p>
                    <p className="text-xs text-muted">
                      {selectedService.service_type_code ?? selectedService.booking_service_kind ?? "N/D"} - {selectedService.pax} pax
                    </p>
                  </div>
                  <span className="rounded-full bg-white px-2.5 py-1 text-[11px] uppercase tracking-[0.12em] text-slate-700 shadow-sm">
                    {selectedService.status}
                  </span>
                </div>
                <div className="mt-3 grid gap-2 text-sm text-text md:grid-cols-2">
                  <p><span className="text-muted">Data:</span> {formatDateLabel(selectedService.date)}</p>
                  <p><span className="text-muted">Ora:</span> {selectedService.time}</p>
                  <p><span className="text-muted">Agenzia:</span> {(selectedService.billing_party_name ?? "Privato").toUpperCase()}</p>
                  <p><span className="text-muted">Telefono:</span> {selectedService.phone}</p>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {(["new", "assigned", "partito", "arrivato", "completato", "problema"] as ServiceStatus[]).map((status) => (
                    <button
                      key={status}
                      type="button"
                      className="btn-secondary px-3 py-2 text-xs disabled:opacity-50"
                      onClick={() => void updateStatus(status)}
                      disabled={savingStatus !== null}
                    >
                      {savingStatus === status ? "..." : status}
                    </button>
                  ))}
                </div>
              </article>

              {/* Assegnazione autista + veicolo */}
              <div className="rounded-2xl border border-slate-200 bg-white p-3 space-y-3">
                <p className="text-sm font-semibold text-text">Assegna autista e veicolo</p>
                {currentAssignment?.driver_user_id && (
                  <div className="flex flex-wrap gap-3 rounded-xl bg-slate-50 px-3 py-2 text-xs">
                    <span className="text-muted">Autista: <span className="font-semibold text-text">{drivers.find((d) => d.user_id === currentAssignment.driver_user_id)?.full_name ?? "—"}</span></span>
                    {currentAssignment.vehicle_label && (
                      <span className="text-muted">Veicolo: <span className="font-semibold text-text">{currentAssignment.vehicle_label}</span></span>
                    )}
                  </div>
                )}
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="text-xs text-muted">
                    Autista
                    <select
                      className="input-saas mt-1 w-full"
                      value={driverSelectId}
                      onChange={(e) => {
                        const id = e.target.value;
                        setDriverSelectId(id);
                        // Auto-suggerisci il veicolo abituale del driver
                        const habitual = vehicles.find((v) => v.habitual_driver_user_id === id);
                        if (habitual) setVehicleSelectLabel(habitual.label);
                      }}
                    >
                      <option value="">— nessuno —</option>
                      {drivers.map((d) => (
                        <option key={d.user_id} value={d.user_id}>{d.full_name}</option>
                      ))}
                    </select>
                  </label>
                  <label className="text-xs text-muted">
                    Veicolo
                    <select
                      className="input-saas mt-1 w-full"
                      value={vehicleSelectLabel}
                      onChange={(e) => setVehicleSelectLabel(e.target.value)}
                    >
                      <option value="">— nessuno —</option>
                      {vehicles.map((v) => (
                        <option key={v.id} value={v.label}>
                          {v.label}{v.plate ? ` (${v.plate})` : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <button
                  type="button"
                  className="btn-primary w-full text-sm disabled:opacity-50"
                  disabled={assigningDriver}
                  onClick={() => void assignDriver()}
                >
                  {assigningDriver ? "Salvataggio…" : "Salva assegnazione"}
                </button>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-white p-3">
                <label className="text-sm">
                  Nota interna operativa
                  <textarea
                    className="input-saas mt-1 min-h-[92px]"
                    value={internalNote}
                    onChange={(event) => setInternalNote(event.target.value)}
                    placeholder="Appunti interni, passaggi di presa in carico, promemoria operatore"
                  />
                </label>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button type="button" className="btn-primary" disabled={savingInternalAction} onClick={() => void saveInternalAction()}>
                    {savingInternalAction ? "Salvataggio..." : "Segna preso in carico"}
                  </button>
                  <span className="text-xs text-muted">
                    Stato attuale: {selectedService.status} {selectedService.notes.includes("[dispatch:handled-internally]") ? "- gestione interna gia marcata" : ""}
                  </span>
                </div>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-white p-3">
                <p className="text-sm font-semibold text-text">Ultimi eventi stato</p>
                <div className="mt-2 space-y-2">
                  {recentEvents.length === 0 ? (
                    <p className="text-xs text-muted">Nessun evento registrato.</p>
                  ) : (
                    recentEvents.map((event) => (
                      <div key={event.id} className="rounded-xl border border-slate-100 bg-slate-50 px-3 py-2 text-xs text-slate-700">
                        <p className="font-medium uppercase tracking-[0.08em]">{event.status}</p>
                        <p>{new Date(event.at).toLocaleString("it-IT")}</p>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}
        </SectionCard>
      </div>
    </section>
  );
}
