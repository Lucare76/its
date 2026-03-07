"use client";

import { useEffect, useMemo, useState } from "react";
import { parseInboundEmail } from "@/lib/email-parser";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";
import { useDemoStore } from "@/lib/use-demo-store";
import type { Hotel, InboundEmail, Service, ServiceType } from "@/lib/types";
import { serviceCreateSchema } from "@/lib/validation";

const vessels = ["Caremar", "Alilauro", "Medmar", "Porto da verificare"];

export default function InboxPage() {
  const { state, loading: demoLoading, createService } = useDemoStore();
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [actorUserId, setActorUserId] = useState<string | null>(null);
  const [inboundEmails, setInboundEmails] = useState<InboundEmail[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [hotels, setHotels] = useState<Hotel[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [serviceType, setServiceType] = useState<ServiceType>("transfer");
  const [templateKey, setTemplateKey] = useState("agency-default");
  const [message, setMessage] = useState("Seleziona una email in arrivo.");
  const [submitting, setSubmitting] = useState(false);
  const [hasLoadedInbox, setHasLoadedInbox] = useState(false);

  useEffect(() => {
    if (!message) return;
    const timeout = window.setTimeout(() => setMessage(""), 2500);
    return () => window.clearTimeout(timeout);
  }, [message]);

  useEffect(() => {
    let active = true;
    const client = supabase;

    const loadSupabaseData = async () => {
      const forceDemoMode = typeof window !== "undefined" && window.localStorage.getItem("it-force-demo-login") === "true";
      if (forceDemoMode || !hasSupabaseEnv || !client) {
        if (!active) return;
        setInboundEmails(state.inboundEmails);
        setServices(state.services);
        setHotels(state.hotels);
        setHasLoadedInbox(true);
        return;
      }

      const { data: userData, error: userError } = await client.auth.getUser();
      if (userError || !userData.user || !active) {
        if (active) {
          setMessage("Sessione non valida. Rifai login.");
          setHasLoadedInbox(true);
        }
        return;
      }
      setActorUserId(userData.user.id);

      const { data: membership, error: membershipError } = await client
        .from("memberships")
        .select("tenant_id")
        .eq("user_id", userData.user.id)
        .maybeSingle();

      if (membershipError || !membership?.tenant_id || !active) {
        if (active) {
          setMessage("Membership tenant non trovata.");
          setHasLoadedInbox(true);
        }
        return;
      }
      setTenantId(membership.tenant_id);

      const [emailsResult, servicesResult, hotelsResult] = await Promise.all([
        client.from("inbound_emails").select("*").eq("tenant_id", membership.tenant_id).order("created_at", { ascending: false }),
        client.from("services").select("*").eq("tenant_id", membership.tenant_id).order("created_at", { ascending: false }),
        client.from("hotels").select("*").eq("tenant_id", membership.tenant_id).order("name", { ascending: true })
      ]);

      if (!active) return;
      if (emailsResult.error || servicesResult.error || hotelsResult.error) {
        setMessage("Errore caricamento inbox.");
        setHasLoadedInbox(true);
        return;
      }

      setInboundEmails((emailsResult.data ?? []) as InboundEmail[]);
      setServices((servicesResult.data ?? []) as Service[]);
      setHotels((hotelsResult.data ?? []) as Hotel[]);
      setHasLoadedInbox(true);
    };

    void loadSupabaseData();
    return () => {
      active = false;
    };
  }, [state.hotels, state.inboundEmails, state.services]);

  const isLoading = hasSupabaseEnv ? !hasLoadedInbox : demoLoading;
  const selectedEmail = useMemo(
    () => inboundEmails.find((email) => email.id === selectedId) ?? inboundEmails[0] ?? null,
    [inboundEmails, selectedId]
  );

  const parsedSuggestion = useMemo(() => {
    if (!selectedEmail) return null;
    return parseInboundEmail(selectedEmail.raw_text, templateKey, selectedEmail.extracted_text ?? null);
  }, [selectedEmail, templateKey]);

  const linkedDraftService = useMemo(() => {
    if (!selectedEmail) return null;
    const fromParsed = (selectedEmail.parsed_json as Record<string, unknown>)?.draft_service_id;
    if (typeof fromParsed === "string") {
      const hit = services.find((service) => service.id === fromParsed);
      if (hit) return hit;
    }
    return services.find((service) => service.inbound_email_id === selectedEmail.id) ?? null;
  }, [selectedEmail, services]);

  const confidenceBadgeClass = (level: string | undefined) => {
    if (level === "high") return "bg-emerald-100 text-emerald-700";
    if (level === "medium") return "bg-amber-100 text-amber-700";
    return "bg-slate-100 text-slate-600";
  };

  const handleSubmit = async (formData: FormData) => {
    if (!selectedEmail) return;
    setSubmitting(true);

    const rawStops = String(formData.get("stops") ?? "");
    const parsedStops = rawStops
      .split(/\r?\n|,/)
      .map((item) => item.trim())
      .filter(Boolean);

    const payload = {
      date: String(formData.get("date") || parsedSuggestion?.date || new Date().toISOString().slice(0, 10)),
      time: String(formData.get("time") || parsedSuggestion?.time || "09:00"),
      service_type: String(formData.get("service_type") ?? "transfer"),
      direction: String(formData.get("direction") || "arrival"),
      vessel: String(formData.get("vessel") || parsedSuggestion?.vessel || "Porto da verificare"),
      pax: Number(formData.get("pax") || parsedSuggestion?.pax || 1),
      hotel_id: String(formData.get("hotel_id") || hotels[0]?.id || ""),
      customer_name: String(formData.get("customer_name") || parsedSuggestion?.customer_name || "Cliente da verificare"),
      phone: String(formData.get("phone") || parsedSuggestion?.phone || "N/D"),
      notes: String(formData.get("notes") || `[inbound:${selectedEmail.id}]`),
      tour_name: String(formData.get("tour_name") ?? ""),
      capacity: formData.get("capacity") ? Number(formData.get("capacity")) : null,
      meeting_point: String(formData.get("meeting_point") ?? ""),
      stops: parsedStops.length > 0 ? parsedStops : [],
      bus_plate: String(formData.get("bus_plate") ?? ""),
      status: "new"
    };

    const parsed = serviceCreateSchema.safeParse(payload);
    if (!parsed.success) {
      setSubmitting(false);
      setMessage(parsed.error.errors[0]?.message ?? "Dati non validi.");
      return;
    }

    const client = supabase;
    if (!hasSupabaseEnv || !client || !tenantId) {
      createService({ ...parsed.data, inbound_email_id: selectedEmail.id, is_draft: false });
      setSubmitting(false);
      setMessage("Servizio creato (demo locale).");
      return;
    }

    let serviceId = linkedDraftService?.id ?? null;
    if (linkedDraftService) {
      const { error: updateError } = await client
        .from("services")
        .update({
          ...parsed.data,
          inbound_email_id: selectedEmail.id,
          is_draft: false
        })
        .eq("id", linkedDraftService.id)
        .eq("tenant_id", tenantId);
      if (updateError) {
        setSubmitting(false);
        setMessage("Errore aggiornamento draft.");
        return;
      }
    } else {
      const { data: insertedService, error: insertError } = await client
        .from("services")
        .insert({
          ...parsed.data,
          tenant_id: tenantId,
          inbound_email_id: selectedEmail.id,
          is_draft: false
        })
        .select("id")
        .single();
      if (insertError || !insertedService?.id) {
        setSubmitting(false);
        setMessage("Errore creazione servizio.");
        return;
      }
      serviceId = insertedService.id;
    }

    const nextParsedJson = {
      ...(selectedEmail.parsed_json as Record<string, unknown>),
      linked_service_id: serviceId,
      review_status: "confirmed",
      confirmed_at: new Date().toISOString()
    };
    await client.from("inbound_emails").update({ parsed_json: nextParsedJson }).eq("id", selectedEmail.id).eq("tenant_id", tenantId);

    if (actorUserId && serviceId) {
      await client.from("status_events").insert({
        tenant_id: tenantId,
        service_id: serviceId,
        status: "new",
        by_user_id: actorUserId
      });
    }

    const [emailsResult, servicesResult] = await Promise.all([
      client.from("inbound_emails").select("*").eq("tenant_id", tenantId).order("created_at", { ascending: false }),
      client.from("services").select("*").eq("tenant_id", tenantId).order("created_at", { ascending: false })
    ]);
    setInboundEmails((emailsResult.data ?? []) as InboundEmail[]);
    setServices((servicesResult.data ?? []) as Service[]);

    setSubmitting(false);
    setMessage(linkedDraftService ? "Draft aggiornato e confermato." : "Servizio creato e collegato alla email.");
  };

  if (isLoading) return <div className="card p-4 text-sm text-slate-500">Caricamento inbox...</div>;

  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold">Email in arrivo</h1>
      <div className="grid gap-4 lg:grid-cols-[380px_1fr]">
        <aside className="card max-h-[640px] space-y-2 overflow-y-auto p-3">
          {inboundEmails.length === 0 ? (
            <p className="text-sm text-slate-500">Nessuna email inbound.</p>
          ) : (
            inboundEmails.map((email) => {
              const linkedServiceId =
                (email.parsed_json as Record<string, unknown>)?.linked_service_id ??
                (email.parsed_json as Record<string, unknown>)?.draft_service_id;
              return (
                <button
                  key={email.id}
                  type="button"
                  onClick={() => setSelectedId(email.id)}
                  className="w-full rounded-lg border border-slate-200 p-2 text-left text-sm hover:bg-slate-50"
                >
                  <p className="font-medium">{email.parsed_json.subject ?? "No subject"}</p>
                  <p className="text-xs text-slate-600">{email.parsed_json.from_email ?? "N/D"}</p>
                  <p className="truncate text-xs text-slate-500">{email.raw_text}</p>
                  {typeof linkedServiceId === "string" ? (
                    <p className="mt-1 text-xs text-blue-700">linked service: {linkedServiceId.slice(0, 8)}...</p>
                  ) : null}
                </button>
              );
            })
          )}
        </aside>

        <div className="card space-y-3 p-4">
          {!selectedEmail ? (
            <p className="text-sm text-slate-500">Seleziona una email.</p>
          ) : (
            <>
              <div className="grid gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700 md:grid-cols-2">
                <p>From: {selectedEmail.parsed_json.from_email ?? "N/D"}</p>
                <p>Subject: {selectedEmail.parsed_json.subject ?? "N/D"}</p>
                <label className="md:col-span-2">
                  Template parser
                  <select value={templateKey} onChange={(event) => setTemplateKey(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-xs">
                    <option value="agency-default">agency-default</option>
                    <option value="agency-compact">agency-compact</option>
                  </select>
                </label>
              </div>

              <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs text-slate-700">
                <p className="font-semibold text-slate-800">Suggerimenti parser (best effort)</p>
                <div className="mt-2 grid gap-2 md:grid-cols-2">
                  {[
                    { label: "Data", value: parsedSuggestion?.date ?? "N/D", confidence: parsedSuggestion?.confidence?.date },
                    { label: "Ora", value: parsedSuggestion?.time ?? "N/D", confidence: parsedSuggestion?.confidence?.time },
                    { label: "Pax", value: parsedSuggestion?.pax?.toString() ?? "N/D", confidence: parsedSuggestion?.confidence?.pax },
                    { label: "Cliente", value: parsedSuggestion?.customer_name ?? "N/D", confidence: parsedSuggestion?.confidence?.customer_name },
                    { label: "Hotel", value: parsedSuggestion?.hotel ?? parsedSuggestion?.dropoff ?? "N/D", confidence: parsedSuggestion?.confidence?.hotel ?? parsedSuggestion?.confidence?.dropoff },
                    { label: "Porto/Pickup", value: parsedSuggestion?.pickup ?? "N/D", confidence: parsedSuggestion?.confidence?.pickup },
                    { label: "Nave", value: parsedSuggestion?.vessel ?? "N/D", confidence: parsedSuggestion?.confidence?.vessel },
                    { label: "Telefono", value: parsedSuggestion?.phone ?? "N/D", confidence: parsedSuggestion?.confidence?.phone }
                  ].map((item) => (
                    <div key={item.label} className="rounded border border-blue-200 bg-white p-2">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500">{item.label}</p>
                      <p className="mt-0.5 text-xs text-slate-800">{item.value}</p>
                      <span className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${confidenceBadgeClass(item.confidence)}`}>
                        {item.confidence ?? "low"}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="grid gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700 md:grid-cols-2">
                <div className="space-y-1">
                  <p className="font-semibold text-slate-800">Body text</p>
                  <pre className="max-h-44 overflow-auto whitespace-pre-wrap rounded border border-slate-200 bg-white p-2">{selectedEmail.raw_text}</pre>
                </div>
                <div className="space-y-1">
                  <p className="font-semibold text-slate-800">Extracted text (PDF)</p>
                  <pre className="max-h-44 overflow-auto whitespace-pre-wrap rounded border border-slate-200 bg-white p-2">{selectedEmail.extracted_text ?? "Nessun testo estratto."}</pre>
                </div>
              </div>

              {linkedDraftService ? (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
                  Draft rilevato: {linkedDraftService.id} {linkedDraftService.is_draft ? "(needs review)" : "(gia confermato)"}
                </div>
              ) : null}

              <form action={handleSubmit} className="grid gap-3 md:grid-cols-2">
                <input name="date" defaultValue={linkedDraftService?.date ?? parsedSuggestion?.date ?? new Date().toISOString().slice(0, 10)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                <input name="time" defaultValue={linkedDraftService?.time ?? parsedSuggestion?.time ?? "09:00"} className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                <select name="direction" defaultValue={linkedDraftService?.direction ?? "arrival"} className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
                  <option value="arrival">arrival</option>
                  <option value="departure">departure</option>
                </select>
                <select name="service_type" value={serviceType} onChange={(event) => setServiceType(event.target.value as ServiceType)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
                  <option value="transfer">transfer</option>
                  <option value="bus_tour">bus_tour</option>
                </select>
                <select name="vessel" defaultValue={linkedDraftService?.vessel ?? parsedSuggestion?.vessel ?? vessels[0]} className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
                  {vessels.map((vessel) => (
                    <option key={vessel} value={vessel}>
                      {vessel}
                    </option>
                  ))}
                </select>
                <input name="customer_name" defaultValue={linkedDraftService?.customer_name ?? parsedSuggestion?.customer_name ?? "Cliente da verificare"} className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                <input name="phone" defaultValue={linkedDraftService?.phone ?? parsedSuggestion?.phone ?? "N/D"} className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                <input name="pax" type="number" min={1} max={16} defaultValue={linkedDraftService?.pax ?? parsedSuggestion?.pax ?? 1} className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                <select name="hotel_id" defaultValue={linkedDraftService?.hotel_id ?? hotels[0]?.id ?? ""} className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
                  {hotels.map((hotel) => (
                    <option key={hotel.id} value={hotel.id}>
                      {hotel.name} - {hotel.zone}
                    </option>
                  ))}
                </select>
                <input name="notes" defaultValue={linkedDraftService?.notes ?? `[inbound:${selectedEmail.id}]`} className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />

                {serviceType === "bus_tour" ? (
                  <>
                    <input name="tour_name" defaultValue={linkedDraftService?.tour_name ?? ""} placeholder="Nome tour" className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                    <input name="capacity" type="number" min={1} defaultValue={linkedDraftService?.capacity ?? ""} placeholder="Capacita" className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                    <input name="meeting_point" defaultValue={linkedDraftService?.meeting_point ?? ""} placeholder="Meeting point" className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                    <textarea name="stops" rows={2} defaultValue={(linkedDraftService?.stops ?? []).join(", ")} placeholder="Stops" className="rounded-lg border border-slate-300 px-3 py-2 text-sm md:col-span-2" />
                    <input name="bus_plate" defaultValue={linkedDraftService?.bus_plate ?? ""} placeholder="Bus plate" className="rounded-lg border border-slate-300 px-3 py-2 text-sm md:col-span-2" />
                  </>
                ) : null}

                <button type="submit" disabled={submitting} className="rounded-lg bg-brand-600 px-4 py-2 text-sm text-white md:col-span-2 disabled:opacity-60">
                  {submitting ? "Salvataggio..." : linkedDraftService ? "Aggiorna servizio draft" : "Crea servizio"}
                </button>
              </form>
            </>
          )}
          {message ? <p className="text-sm text-slate-600">{message}</p> : null}
        </div>
      </div>
    </section>
  );
}
