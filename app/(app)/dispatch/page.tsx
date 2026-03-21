"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { PageHeader, SectionCard } from "@/components/ui";
import { calculateDriverSuggestions } from "@/lib/dispatch-driver-scoring";
import { formatServiceSlot, getCustomerFullName } from "@/lib/service-display";
import { getServiceOperationalSource, getServicePdfOperationalMeta } from "@/lib/service-pdf-metadata";
import { getE2ETestSessionOverride } from "@/lib/supabase/client-session";
import { supabase } from "@/lib/supabase/client";
import type { Assignment, Hotel, InboundEmail, Membership, Service } from "@/lib/types";
import { assignmentSchema } from "@/lib/validation";

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
    return {
      access_token: parsed.access_token,
      refresh_token: parsed.refresh_token
    };
  } catch {
    return null;
  }
}

async function ensureSupabaseClientReady() {
  if (!supabase) return false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const { data: sessionData } = await supabase.auth.getSession();
    if (sessionData.session?.access_token) {
      return true;
    }
    const storedSession = readStoredSupabaseSession();
    if (storedSession) {
      const restored = await supabase.auth.setSession({
        access_token: storedSession.access_token,
        refresh_token: storedSession.refresh_token
      });
      if (!restored.error && restored.data.session?.access_token) {
        return true;
      }
    }
    await new Promise((resolve) => window.setTimeout(resolve, 200));
  }
  return false;
}

export default function DispatchPage() {
  const searchParams = useSearchParams();
  const [serviceId, setServiceId] = useState<string>("");
  const [driverId, setDriverId] = useState<string>("");
  const [vehicleLabel, setVehicleLabel] = useState("Mercedes Vito - AA123BB");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("Assegnazione interna opzionale: il servizio è già operativo anche senza driver.");
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [actorUserId, setActorUserId] = useState<string | null>(null);
  const [services, setServices] = useState<Service[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [hotels, setHotels] = useState<Hotel[]>([]);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [inboundEmails, setInboundEmails] = useState<InboundEmail[]>([]);
  const [sourceFilter, setSourceFilter] = useState<"all" | "pdf" | "agency" | "manual">("all");
  const [reviewFilter, setReviewFilter] = useState<"all" | "yes" | "no">("all");
  const [qualityFilter, setQualityFilter] = useState<"all" | "low">("all");

  useEffect(() => {
    let active = true;

    const loadSupabaseTenantData = async (accessToken: string, nextTenantId: string) => {
      if (!supabase) return false;
      const response = await fetch("/api/ops/dispatch-data", {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      const payload = (await response.json().catch(() => null)) as
        | {
            ok?: boolean;
            error?: string;
            services?: Service[];
            assignments?: Assignment[];
            hotels?: Hotel[];
            memberships?: Membership[];
            inbound_emails?: InboundEmail[];
          }
        | null;
      if (!active) return false;
      if (!response.ok || !payload?.ok) {
        return false;
      }
      setServices((payload.services ?? []) as Service[]);
      setAssignments((payload.assignments ?? []) as Assignment[]);
      setHotels((payload.hotels ?? []) as Hotel[]);
      setMemberships((payload.memberships ?? []) as Membership[]);
      setInboundEmails((payload.inbound_emails ?? []) as InboundEmail[]);
      return true;
    };

    const load = async () => {
      if (!supabase) {
        setLoading(false);
        setMessage("Sessione non valida. Rifai login.");
        return;
      }

      const clientReady = await ensureSupabaseClientReady();
      if (!clientReady) {
        setLoading(false);
        setMessage("Sessione non valida. Rifai login.");
        return;
      }

      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData.session?.access_token ?? null;
      const userId = sessionData.session?.user?.id ?? null;
      const e2eOverride = getE2ETestSessionOverride();
      const resolvedUserId = e2eOverride?.userId ?? userId;
      const resolvedTenantId = e2eOverride?.tenantId ?? null;
      if (!resolvedUserId || !accessToken) {
        setLoading(false);
        setMessage("Sessione non valida. Rifai login.");
        return;
      }

      let nextTenantId = resolvedTenantId;
      if (!nextTenantId) {
        const tenantResponse = await fetch("/api/onboarding/tenant", {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        const tenantBody = (await tenantResponse.json().catch(() => null)) as
          | { hasTenant?: boolean; tenant?: { id?: string | null } | null; error?: string }
          | null;
        nextTenantId = tenantBody?.hasTenant ? tenantBody.tenant?.id ?? null : null;
      }
      if (!nextTenantId) {
        setLoading(false);
        setMessage("Tenant non configurato per questo utente. Completa onboarding.");
        return;
      }

      setTenantId(nextTenantId);
      setActorUserId(resolvedUserId);

      const ok = await loadSupabaseTenantData(accessToken, nextTenantId);
      if (!ok) {
        setMessage("Errore caricamento dispatch.");
      }
      setLoading(false);

      const channel = supabase
        .channel(`dispatch-live-${nextTenantId}`)
        .on("postgres_changes", { event: "*", schema: "public", table: "services", filter: `tenant_id=eq.${nextTenantId}` }, () => {
          void loadSupabaseTenantData(accessToken, nextTenantId);
        })
        .on("postgres_changes", { event: "*", schema: "public", table: "assignments", filter: `tenant_id=eq.${nextTenantId}` }, () => {
          void loadSupabaseTenantData(accessToken, nextTenantId);
        })
        .subscribe();

      return channel;
    };

    let activeChannel: ReturnType<NonNullable<typeof supabase>["channel"]> | null = null;
    void load().then((channel) => {
      if (!active || !channel) return;
      activeChannel = channel;
    });

    return () => {
      active = false;
      if (activeChannel && supabase) {
        void supabase.removeChannel(activeChannel);
      }
    };
  }, []);

  const tenantMemberships = tenantId ? memberships.filter((member) => member.tenant_id === tenantId) : memberships;
  const drivers = tenantMemberships.filter((member) => member.role === "driver");
  const tenantServices = tenantId ? services.filter((service) => service.tenant_id === tenantId) : services;
  const tenantAssignments = tenantId ? assignments.filter((assignment) => assignment.tenant_id === tenantId) : assignments;
  const assignmentByServiceId = new Map(tenantAssignments.map((assignment) => [assignment.service_id, assignment]));
  const servicesToAssign = tenantServices.filter((service) => service.status === "new" || service.status === "assigned");
  const tenantHotels = tenantId ? hotels.filter((hotel) => hotel.tenant_id === tenantId) : hotels;
  const hotelsById = new Map(tenantHotels.map((hotel) => [hotel.id, hotel]));
  const pdfMetaByServiceId = new Map(tenantServices.map((service) => [service.id, getServicePdfOperationalMeta(service, inboundEmails)]));
  const sourceByServiceId = new Map(tenantServices.map((service) => [service.id, getServiceOperationalSource(service, inboundEmails)]));

  const sortedServices = [...servicesToAssign]
    .filter((service) => {
      const meta = pdfMetaByServiceId.get(service.id);
      const source = sourceByServiceId.get(service.id) ?? "manual";
      const bySource = sourceFilter === "all" || source === sourceFilter;
      const byReview = reviewFilter === "all" || (reviewFilter === "yes" ? Boolean(meta?.manualReview) : Boolean(meta?.isPdf && !meta.manualReview));
      const byQuality = qualityFilter === "all" || (meta?.isPdf && meta.parsingQuality === "low");
      return bySource && byReview && byQuality;
    })
    .sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return a.time.localeCompare(b.time);
    });

  const requestedServiceId = searchParams.get("serviceId");
  const selectedService =
    sortedServices.find((service) => service.id === serviceId) ??
    sortedServices.find((service) => service.id === requestedServiceId) ??
    sortedServices[0] ??
    null;
  const selectedServiceZone = selectedService ? hotelsById.get(selectedService.hotel_id)?.zone ?? null : null;
  const suggestions = calculateDriverSuggestions({
    drivers,
    assignments: tenantAssignments,
    services: tenantServices,
    hotels: tenantHotels,
    selectedService
  }).slice(0, 3);
  const selectedAssignment = selectedService ? assignmentByServiceId.get(selectedService.id) : null;
  const resolvedDriverId = driverId || selectedAssignment?.driver_user_id || "";
  const resolvedVehicleLabel =
    vehicleLabel || selectedAssignment?.vehicle_label || (selectedService ? suggestedVehicleByPax(selectedService.pax) : "");
  const assignedServicesCount = tenantAssignments.length;
  const dispatchPendingCount = servicesToAssign.filter((service) => !assignmentByServiceId.has(service.id)).length;
  const reviewedPdfCount = servicesToAssign.filter((service) => pdfMetaByServiceId.get(service.id)?.manualReview).length;

  const runAssign = async (nextServiceId: string, nextDriverId: string, nextVehicleLabel: string) => {
    setSaving(true);

    const payload = {
      service_id: nextServiceId,
      driver_user_id: nextDriverId || null,
      vehicle_label: nextVehicleLabel
    };
    const parsed = assignmentSchema.safeParse(payload);
    if (!parsed.success) {
      setSaving(false);
      setMessage(parsed.error.errors[0]?.message ?? "Dati dispatch non validi.");
      return;
    }

    if (!tenantId || !actorUserId || !supabase) {
      setSaving(false);
      setMessage("Tenant non trovato.");
      return;
    }

    const existing = tenantAssignments.find((item) => item.service_id === parsed.data.service_id && item.tenant_id === tenantId);
    if (existing) {
      const { error: updateAssignmentError } = await supabase
        .from("assignments")
        .update({ driver_user_id: parsed.data.driver_user_id ?? null, vehicle_label: parsed.data.vehicle_label })
        .eq("id", existing.id)
        .eq("tenant_id", tenantId);
      if (updateAssignmentError) {
        setSaving(false);
        setMessage(`Errore salvataggio: ${updateAssignmentError.message}`);
        return;
      }
    } else {
      const { error: insertAssignmentError } = await supabase.from("assignments").insert({
        tenant_id: tenantId,
        service_id: parsed.data.service_id,
        driver_user_id: parsed.data.driver_user_id ?? null,
        vehicle_label: parsed.data.vehicle_label
      });
      if (insertAssignmentError) {
        setSaving(false);
        setMessage(`Errore salvataggio: ${insertAssignmentError.message}`);
        return;
      }
    }

    const { error: updateServiceError } = await supabase
      .from("services")
      .update({ status: "assigned" })
      .eq("id", parsed.data.service_id)
      .eq("tenant_id", tenantId)
      .neq("status", "assigned");

    if (updateServiceError) {
      setSaving(false);
      setMessage(`Errore salvataggio: ${updateServiceError.message}`);
      return;
    }

    const { data: existingEvent, error: eventReadError } = await supabase
      .from("status_events")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("service_id", parsed.data.service_id)
      .eq("status", "assigned")
      .maybeSingle();

    if (eventReadError) {
      setSaving(false);
      setMessage(`Errore salvataggio: ${eventReadError.message}`);
      return;
    }

    if (!existingEvent) {
      const { error: eventInsertError } = await supabase.from("status_events").insert({
        tenant_id: tenantId,
        service_id: parsed.data.service_id,
        status: "assigned",
        by_user_id: actorUserId
      });
      if (eventInsertError) {
        setSaving(false);
        setMessage(`Errore salvataggio: ${eventInsertError.message}`);
        return;
      }
    }

    setAssignments((prev) => {
      const withoutCurrent = prev.filter((item) => item.service_id !== parsed.data.service_id);
      return [
        ...withoutCurrent,
        {
          id: existing?.id ?? crypto.randomUUID(),
          tenant_id: tenantId,
          service_id: parsed.data.service_id,
          driver_user_id: parsed.data.driver_user_id ?? null,
          vehicle_label: parsed.data.vehicle_label
        }
      ];
    });
    setServices((prev) =>
      prev.map((item) => (item.id === parsed.data.service_id ? { ...item, status: "assigned" } : item))
    );
    setSaving(false);
    setMessage("Assegnazione salvata.");
  };

  const submit = (formData: FormData) => {
    const nextServiceId = String(formData.get("service_id"));
    const nextDriverId = String(formData.get("driver_user_id"));
    const nextVehicleLabel = String(formData.get("vehicle_label"));
    void runAssign(nextServiceId, nextDriverId, nextVehicleLabel);
  };

  if (loading) return <div className="card p-4 text-sm text-slate-500">Caricamento assegnazioni...</div>;

  return (
    <section className="mx-auto max-w-3xl page-section">
      <PageHeader
        title="Dispatch e Assegnazione"
        subtitle="Supporto interno per driver e mezzo. Non blocca l'operativo."
        breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "Dispatch" }]}
      />
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <SectionCard title="Da gestire internamente" subtitle="Servizi nuovi o gia assegnabili">
          <p className="text-3xl font-semibold text-text">{servicesToAssign.length}</p>
          <p className="mt-1 text-sm text-muted">{dispatchPendingCount} ancora senza scheda interna</p>
        </SectionCard>
        <SectionCard title="Schede dispatch create" subtitle="Servizi con mezzo e/o autista già salvati">
          <p className="text-3xl font-semibold text-text">{assignedServicesCount}</p>
          <p className="mt-1 text-sm text-muted">Dato interno, non blocca l&apos;operativo</p>
        </SectionCard>
        <SectionCard title="PDF gia revisionati" subtitle="Servizi PDF con review manuale eseguita">
          <p className="text-3xl font-semibold text-text">{reviewedPdfCount}</p>
          <p className="mt-1 text-sm text-muted">Utile per decidere cosa organizzare per primo</p>
        </SectionCard>
      </div>
      <form action={submit} className="card grid gap-5 p-4 md:p-7">
        <h2 className="text-base">Dettagli assegnazione</h2>
        <p className="text-sm text-muted">Questa schermata serve solo a Ischia Transfer per l&apos;organizzazione interna successiva.</p>
        <div className="grid gap-3 md:grid-cols-3">
          <select data-testid="dispatch-source-filter" value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value as "all" | "pdf" | "agency" | "manual")} className="input-saas">
            <option value="all">Origine: tutte</option>
            <option value="pdf">Solo PDF</option>
            <option value="agency">Solo agenzia</option>
            <option value="manual">Solo manuali</option>
          </select>
          <select data-testid="dispatch-review-filter" value={reviewFilter} onChange={(event) => setReviewFilter(event.target.value as "all" | "yes" | "no")} className="input-saas">
            <option value="all">Reviewed: tutti</option>
            <option value="yes">Reviewed si</option>
            <option value="no">Reviewed no</option>
          </select>
          <select data-testid="dispatch-quality-filter" value={qualityFilter} onChange={(event) => setQualityFilter(event.target.value as "all" | "low")} className="input-saas">
            <option value="all">Qualita: tutte</option>
            <option value="low">Qualita low</option>
          </select>
        </div>
        <label className="text-sm">
          Servizio
          <select
            data-testid="dispatch-service-select"
            name="service_id"
            value={selectedService?.id ?? ""}
            onChange={(event) => {
              setServiceId(event.target.value);
              setDriverId("");
              const changed = sortedServices.find((service) => service.id === event.target.value);
              if (changed) {
                const existing = assignmentByServiceId.get(changed.id);
                setVehicleLabel(existing?.vehicle_label ?? suggestedVehicleByPax(changed.pax));
              }
            }}
            className="input-saas mt-1 w-full"
          >
            {sortedServices.map((service) => (
              <option key={service.id} value={service.id}>
                {formatServiceSlot(service)} - {getCustomerFullName(service)} [{service.service_type ?? "transfer"}] ({service.status}){" "}
                {sourceByServiceId.get(service.id) === "pdf"
                  ? `| PDF ${pdfMetaByServiceId.get(service.id)?.externalReference ?? ""}`
                  : sourceByServiceId.get(service.id) === "agency"
                    ? `| AGENZIA ${service.booking_service_kind ?? ""}`
                    : ""}
              </option>
            ))}
          </select>
        </label>
        {selectedService ? (
          <article data-testid="dispatch-priority-panel" className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
            <p className="font-semibold text-slate-800">Priorita operativa</p>
            <p className="mt-1">
              {formatServiceSlot(selectedService)} | {hotelsById.get(selectedService.hotel_id)?.name ?? "Hotel N/D"} | {selectedService.vessel}
            </p>
            {(() => {
              const meta = pdfMetaByServiceId.get(selectedService.id);
              const source = sourceByServiceId.get(selectedService.id) ?? "manual";
              return source === "pdf" && meta ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  <span data-testid="dispatch-priority-badge-pdf" className="rounded-full bg-blue-100 px-2 py-1 font-semibold uppercase text-blue-700">PDF</span>
                  {meta.manualReview ? <span data-testid="dispatch-priority-badge-reviewed" className="rounded-full bg-emerald-100 px-2 py-1 font-semibold uppercase text-emerald-700">Reviewed</span> : null}
                  <span data-testid="dispatch-priority-quality" className="rounded-full bg-slate-100 px-2 py-1 font-semibold uppercase text-slate-700">{meta.parsingQuality ?? "n/d"}</span>
                  <span data-testid="dispatch-priority-external-ref" className="rounded-full bg-slate-100 px-2 py-1 font-semibold uppercase text-slate-700">{meta.externalReference ?? "rif. n/d"}</span>
                  {meta.reviewRecommended ? <span data-testid="dispatch-priority-review-warning" className="rounded-full bg-amber-100 px-2 py-1 font-semibold uppercase text-amber-700">Verifica consigliata</span> : null}
                </div>
              ) : source === "agency" ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  <span className="rounded-full bg-violet-100 px-2 py-1 font-semibold uppercase text-violet-700">Agenzia</span>
                  <span className="rounded-full bg-slate-100 px-2 py-1 font-semibold uppercase text-slate-700">{selectedService.booking_service_kind ?? "booking"}</span>
                  <span className="rounded-full bg-slate-100 px-2 py-1 font-semibold uppercase text-slate-700">{selectedService.customer_email ?? "email n/d"}</span>
                </div>
              ) : null;
            })()}
          </article>
        ) : null}
        <label className="text-sm">
          Autista
          <select name="driver_user_id" value={resolvedDriverId} onChange={(event) => setDriverId(event.target.value)} className="input-saas mt-1 w-full">
            <option value="">Nessun autista assegnato per ora</option>
            {drivers.map((driver) => (
              <option key={driver.user_id} value={driver.user_id}>
                {driver.full_name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          Mezzo
          <input name="vehicle_label" value={resolvedVehicleLabel} onChange={(event) => setVehicleLabel(event.target.value)} className="input-saas mt-1 w-full" />
        </label>
        <button type="submit" disabled={saving} className="btn-primary px-5 py-3 text-base disabled:opacity-50">
          {saving ? "Salvataggio..." : resolvedDriverId ? "Conferma assegnazione" : "Salva scheda interna"}
        </button>
      </form>
      <SectionCard title="Autisti suggeriti (Primi 3)" className="space-y-0">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          {selectedService ? (
            <p className="text-xs text-muted text-safe-wrap">
              Zona pickup: {selectedServiceZone ?? "N/D"} | Servizio: {getCustomerFullName(selectedService)}
            </p>
          ) : null}
        </div>
        <article className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
          Criteri scoring: 1) prossimita hotel/zona pickup, 2) carico lavoro giornaliero (assegnazioni), 3) disponibilita
          (job in corso e conflitti orari). Nessuna assegnazione automatica: i suggerimenti sono solo di supporto.
        </article>
        {suggestions.length === 0 ? (
          <p className="text-sm text-muted">Nessun suggerimento disponibile.</p>
        ) : (
          <div className="space-y-2">
            {suggestions.map((item, index) => (
              <article key={item.userId} className="rounded-xl border border-border bg-white px-3 py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold">
                    #{index + 1} {item.fullName}
                  </p>
                  <p className="text-sm text-muted">
                    Score {item.score} (prox {item.proximityScore} | load {item.loadScore} | avail {item.availabilityScore})
                  </p>
                </div>
                <ul className="mt-1 text-xs text-muted">
                  {item.reasons.map((reason) => (
                    <li key={reason}>- {reason}</li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        )}
      </SectionCard>
      <p className="text-sm text-muted">{message}</p>
    </section>
  );
}
