"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { parseInboundEmail } from "@/lib/email-parser";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";
import { getClientSessionContext } from "@/lib/supabase/client-session";
import type { Hotel, InboundEmail, Membership, Service, ServiceType } from "@/lib/types";
import { serviceCreateSchema } from "@/lib/validation";

const vessels = ["Caremar", "Alilauro", "Medmar", "Porto da verificare"];

export default function InboxPage() {
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [actorUserId, setActorUserId] = useState<string | null>(null);
  const [inboundEmails, setInboundEmails] = useState<InboundEmail[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [hotels, setHotels] = useState<Hotel[]>([]);
  const [drivers, setDrivers] = useState<Membership[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [serviceType, setServiceType] = useState<ServiceType>("transfer");
  const [message, setMessage] = useState("Seleziona una email in arrivo.");
  const [blockingNotice, setBlockingNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [importRefreshing, setImportRefreshing] = useState(false);
  const [pdfUploading, setPdfUploading] = useState(false);
  const [pdfUploadStatus, setPdfUploadStatus] = useState("");
  const [hasLoadedInbox, setHasLoadedInbox] = useState(false);
  const [inboxFilter, setInboxFilter] = useState<"all" | "needs_review" | "confirmed">("needs_review");

  const loadData = async (token: string) => {
    const response = await fetch("/api/ops/dispatch-data", {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });
    const body = (await response.json().catch(() => null)) as
      | {
          ok?: boolean;
          error?: string;
          tenant_id?: string;
          user_id?: string;
          services?: unknown[];
          hotels?: unknown[];
          memberships?: unknown[];
          inbound_emails?: unknown[];
        }
      | null;
    if (!response.ok || !body?.ok) {
      throw new Error(String(body?.error ?? "Errore caricamento inbox."));
    }

    const nextTenantId = typeof body.tenant_id === "string" ? body.tenant_id : null;
    const nextUserId = typeof body.user_id === "string" ? body.user_id : null;
    const nextInboundEmails = (body.inbound_emails ?? []) as InboundEmail[];
    const nextServices = (body.services ?? []) as Service[];
    const nextHotels = (body.hotels ?? []) as Hotel[];
    const nextMemberships = (body.memberships ?? []) as Membership[];

    setTenantId(nextTenantId);
    setActorUserId(nextUserId);
    setInboundEmails(nextInboundEmails);
    setServices(nextServices);
    setHotels(nextHotels);
    setDrivers(nextMemberships.filter((item) => item.role === "driver"));
    if (nextInboundEmails.length > 0) {
      setSelectedId(nextInboundEmails[0]?.id ?? null);
    }
  };

  useEffect(() => {
    let active = true;
    const boot = async () => {
      const session = await getClientSessionContext();
      if (session.mode === "demo" || !hasSupabaseEnv || !supabase || !session.userId || !session.tenantId || !active) {
        if (active) {
          setBlockingNotice("Inbox disponibile solo con login Supabase reale e tenant configurato.");
          setMessage("Inbox disponibile solo con login Supabase reale e tenant configurato.");
          setHasLoadedInbox(true);
        }
        return;
      }
      setBlockingNotice(null);
      try {
        const supabaseSession = await supabase.auth.getSession();
        const token = supabaseSession.data.session?.access_token;
        if (!token) {
          throw new Error("Sessione non valida.");
        }
        await loadData(token);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Errore caricamento inbox.");
      } finally {
        setHasLoadedInbox(true);
      }
    };
    void boot();
    return () => {
      active = false;
    };
  }, []);

  const selectedEmail = useMemo(
    () => inboundEmails.find((email) => email.id === selectedId) ?? inboundEmails[0] ?? null,
    [inboundEmails, selectedId]
  );
  const parsedSuggestion = useMemo(
    () => (selectedEmail ? parseInboundEmail(selectedEmail.raw_text, "agency-default", selectedEmail.extracted_text ?? null) : null),
    [selectedEmail]
  );
  const linkedDraftService = useMemo(() => {
    if (!selectedEmail) return null;
    const parsedDraftId = (selectedEmail.parsed_json as Record<string, unknown>)?.draft_service_id;
    if (typeof parsedDraftId === "string") {
      const hit = services.find((service) => service.id === parsedDraftId);
      if (hit) return hit;
    }
    return services.find((service) => service.inbound_email_id === selectedEmail.id) ?? null;
  }, [selectedEmail, services]);
  const filteredInboundEmails = useMemo(() => {
    if (inboxFilter === "all") return inboundEmails;
    return inboundEmails.filter((email) => {
      const confirmed = (email.parsed_json as Record<string, unknown>)?.review_status === "confirmed";
      return inboxFilter === "confirmed" ? confirmed : !confirmed;
    });
  }, [inboundEmails, inboxFilter]);
  const isLoading = !hasLoadedInbox;

  const confidenceBadgeClass = (level: string | undefined) => {
    if (level === "high") return "bg-emerald-100 text-emerald-700";
    if (level === "medium") return "bg-amber-100 text-amber-700";
    return "bg-slate-100 text-slate-600";
  };

  const confidenceLabel = (level: string | undefined) => {
    if (level === "high") return "alta";
    if (level === "medium") return "media";
    return "bassa";
  };

  const refreshMailboxImports = async () => {
    if (!supabase || !tenantId) return;
    const session = await supabase.auth.getSession();
    const token = session.data.session?.access_token;
    if (!token) {
      setMessage("Sessione non valida.");
      return;
    }
    setImportRefreshing(true);
    const response = await fetch("/api/email/operational-import", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` }
    });
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok) {
      setImportRefreshing(false);
      setMessage(String(body?.error ?? "Import mailbox non riuscito."));
      return;
    }
    await loadData(token);
    setImportRefreshing(false);
    setMessage(
      `Mailbox import eseguito. Unread: ${body?.unreadFound ?? 0}, PDF: ${body?.pdfFound ?? 0}, draft creati: ${body?.draftsCreated ?? 0}, duplicati: ${body?.duplicateWarnings ?? 0}.`
    );
  };

  const uploadPdfAndCreateDraft = async (file: File) => {
    if (!supabase || !tenantId) {
      setPdfUploadStatus("Tenant non disponibile.");
      return;
    }
    const session = await supabase.auth.getSession();
    const token = session.data.session?.access_token;
    if (!token) {
      setPdfUploadStatus("Sessione non valida.");
      return;
    }
    setPdfUploading(true);
    const form = new FormData();
    form.append("file", file);
    form.append("subject", `Import PDF manuale ${file.name}`);
    form.append("body_text", "Import manuale da upload PDF in inbox.");
    const response = await fetch("/api/email/import-pdf", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form
    });
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    const inboundId = String(body?.inbound_email_id ?? body?.id ?? "");
    if (!response.ok || !inboundId) {
      setPdfUploading(false);
      setPdfUploadStatus(String(body?.error ?? "Import PDF non riuscito."));
      return;
    }
    await loadData(token);
    setSelectedId(inboundId);
    setPdfUploading(false);
    setPdfUploadStatus(`PDF importato. Draft: ${String(body?.draft_service_id ?? "N/D")}.`);
    setMessage(`PDF importato. Draft creato: ${String(body?.draft_service_id ?? "N/D")}.`);
  };

  const confirmDraftQuick = async () => {
    if (!selectedEmail || !tenantId || !supabase) return;
    const payload = {
      date: linkedDraftService?.date ?? parsedSuggestion?.date ?? new Date().toISOString().slice(0, 10),
      time: linkedDraftService?.time ?? parsedSuggestion?.time ?? "09:00",
      service_type: (linkedDraftService?.service_type ?? "transfer") as ServiceType,
      direction: linkedDraftService?.direction ?? "arrival",
      vessel: linkedDraftService?.vessel ?? parsedSuggestion?.vessel ?? "Porto da verificare",
      pax: linkedDraftService?.pax ?? parsedSuggestion?.pax ?? 1,
      hotel_id: linkedDraftService?.hotel_id ?? hotels[0]?.id ?? "",
      customer_name: linkedDraftService?.customer_name ?? parsedSuggestion?.customer_name ?? "Cliente da verificare",
      phone: linkedDraftService?.phone ?? parsedSuggestion?.phone ?? "N/D",
      notes: linkedDraftService?.notes ?? `[inbound:${selectedEmail.id}]`,
      tour_name: linkedDraftService?.tour_name ?? "",
      capacity: linkedDraftService?.capacity ?? null,
      meeting_point: linkedDraftService?.meeting_point ?? "",
      stops: linkedDraftService?.stops ?? [],
      bus_plate: linkedDraftService?.bus_plate ?? "",
      status: "new" as const
    };
    const parsed = serviceCreateSchema.safeParse(payload);
    if (!parsed.success) {
      setMessage(parsed.error.errors[0]?.message ?? "Conferma rapida non valida.");
      return;
    }
    setSubmitting(true);
    const updateResult = linkedDraftService
      ? await supabase.from("services").update({ ...parsed.data, inbound_email_id: selectedEmail.id, is_draft: false }).eq("id", linkedDraftService.id).eq("tenant_id", tenantId)
      : await supabase.from("services").insert({ ...parsed.data, tenant_id: tenantId, inbound_email_id: selectedEmail.id, is_draft: false });
    if (updateResult.error) {
      setSubmitting(false);
      setMessage(updateResult.error.message);
      return;
    }
    await supabase
      .from("inbound_emails")
      .update({ parsed_json: { ...(selectedEmail.parsed_json as Record<string, unknown>), review_status: "confirmed", confirmed_at: new Date().toISOString() } })
      .eq("id", selectedEmail.id)
      .eq("tenant_id", tenantId);
    if (actorUserId && linkedDraftService?.id) {
      await supabase.from("status_events").insert({ tenant_id: tenantId, service_id: linkedDraftService.id, status: "new", by_user_id: actorUserId });
    }
    await loadData(tenantId);
    setSubmitting(false);
    setMessage("Draft confermato rapidamente.");
  };

  const handleSubmit = async (formData: FormData) => {
    if (!selectedEmail || !tenantId || !supabase) return;
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
      stops: String(formData.get("stops") ?? "").split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean),
      bus_plate: String(formData.get("bus_plate") ?? ""),
      status: "new"
    };
    const parsed = serviceCreateSchema.safeParse(payload);
    if (!parsed.success) {
      setMessage(parsed.error.errors[0]?.message ?? "Dati non validi.");
      return;
    }
    setSubmitting(true);
    const result = linkedDraftService
      ? await supabase.from("services").update({ ...parsed.data, inbound_email_id: selectedEmail.id, is_draft: false }).eq("id", linkedDraftService.id).eq("tenant_id", tenantId)
      : await supabase.from("services").insert({ ...parsed.data, tenant_id: tenantId, inbound_email_id: selectedEmail.id, is_draft: false });
    if (result.error) {
      setSubmitting(false);
      setMessage(result.error.message);
      return;
    }
    await supabase
      .from("inbound_emails")
      .update({ parsed_json: { ...(selectedEmail.parsed_json as Record<string, unknown>), review_status: "confirmed", confirmed_at: new Date().toISOString() } })
      .eq("id", selectedEmail.id)
      .eq("tenant_id", tenantId);
    await loadData(tenantId);
    setSubmitting(false);
    setMessage(linkedDraftService ? "Draft aggiornato e confermato." : "Servizio creato e collegato alla email.");
  };

  if (isLoading) {
    return <div className="card p-4 text-sm text-slate-500">Caricamento posta in arrivo...</div>;
  }

  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold">Email in arrivo</h1>
      {blockingNotice ? (
        <article className="card space-y-2 border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-semibold">{blockingNotice}</p>
          <div className="flex gap-2">
            <Link href="/login" className="btn-secondary px-3 py-1.5 text-xs">Vai al login</Link>
            <Link href="/onboarding" className="btn-primary px-3 py-1.5 text-xs">Vai a onboarding</Link>
          </div>
        </article>
      ) : null}

      <article className="card flex flex-wrap items-center justify-between gap-3 p-4">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-[0.1em] text-slate-600">Import operativo mailbox</h2>
          <p className="text-xs text-slate-600">Importa unread da Gmail e crea draft PDF reali nel gestionale.</p>
        </div>
        <button type="button" onClick={() => void refreshMailboxImports()} className="btn-secondary px-3 py-2 text-xs" disabled={importRefreshing}>
          {importRefreshing ? "Importo..." : "Importa da Gmail"}
        </button>
      </article>

      <article className="card space-y-2 p-4">
        <h2 className="text-sm font-semibold uppercase tracking-[0.1em] text-slate-600">Import manuale PDF</h2>
        <label className="inline-flex w-fit cursor-pointer rounded-lg border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50">
          {pdfUploading ? "Upload in corso..." : "Carica PDF e crea draft"}
          <input
            type="file"
            accept="application/pdf,.pdf"
            className="hidden"
            disabled={pdfUploading}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              void uploadPdfAndCreateDraft(file);
              event.currentTarget.value = "";
            }}
          />
        </label>
        {pdfUploadStatus ? <p className="text-xs text-slate-700">{pdfUploadStatus}</p> : null}
      </article>

      <div className="grid gap-4 lg:grid-cols-[minmax(320px,380px)_1fr]">
        <aside className="card max-h-[640px] space-y-2 overflow-y-auto p-3">
          <div className="mb-1 flex flex-wrap gap-2">
            <button type="button" onClick={() => setInboxFilter("needs_review")} className={inboxFilter === "needs_review" ? "btn-primary px-2 py-1 text-xs" : "btn-secondary px-2 py-1 text-xs"}>Da revisionare</button>
            <button type="button" onClick={() => setInboxFilter("confirmed")} className={inboxFilter === "confirmed" ? "btn-primary px-2 py-1 text-xs" : "btn-secondary px-2 py-1 text-xs"}>Confermate</button>
            <button type="button" onClick={() => setInboxFilter("all")} className={inboxFilter === "all" ? "btn-primary px-2 py-1 text-xs" : "btn-secondary px-2 py-1 text-xs"}>Tutte</button>
          </div>
          {filteredInboundEmails.length === 0 ? (
            <p className="text-sm text-slate-500">Nessuna email inbound.</p>
          ) : (
            filteredInboundEmails.map((email) => {
              const linkedServiceId = (email.parsed_json as Record<string, unknown>)?.linked_service_id ?? (email.parsed_json as Record<string, unknown>)?.draft_service_id;
              const confirmed = (email.parsed_json as Record<string, unknown>)?.review_status === "confirmed";
              return (
                <button key={email.id} type="button" onClick={() => setSelectedId(email.id)} className="w-full rounded-lg border border-slate-200 p-2 text-left text-sm hover:bg-slate-50">
                  <p className="truncate font-medium">{email.parsed_json.subject ?? "Nessun oggetto"}</p>
                  <p className="truncate text-xs text-slate-600">{email.parsed_json.from_email ?? "N/D"}</p>
                  <p className={`mt-1 text-[11px] font-semibold ${confirmed ? "text-emerald-700" : "text-amber-700"}`}>{confirmed ? "confermata" : "da revisionare"}</p>
                  {typeof linkedServiceId === "string" ? <p className="mt-1 text-xs text-blue-700">servizio: {linkedServiceId.slice(0, 8)}...</p> : null}
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
                <p>Da: {selectedEmail.parsed_json.from_email ?? "N/D"}</p>
                <p>Oggetto: {selectedEmail.parsed_json.subject ?? "N/D"}</p>
              </div>

              <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs text-slate-700">
                <p className="font-semibold text-slate-800">Suggerimenti parser</p>
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
                        {confidenceLabel(item.confidence)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="grid gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700 md:grid-cols-2">
                <div>
                  <p className="font-semibold text-slate-800">Testo email</p>
                  <pre className="max-h-44 overflow-auto whitespace-pre-wrap rounded border border-slate-200 bg-white p-2">{selectedEmail.raw_text}</pre>
                </div>
                <div>
                  <p className="font-semibold text-slate-800">Testo estratto (PDF)</p>
                  <pre className="max-h-44 overflow-auto whitespace-pre-wrap rounded border border-slate-200 bg-white p-2">{selectedEmail.extracted_text ?? "Nessun testo estratto."}</pre>
                </div>
              </div>

              {linkedDraftService ? (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
                  Draft rilevato: {linkedDraftService.id}
                  <div className="mt-2">
                    <button type="button" onClick={() => void confirmDraftQuick()} disabled={submitting} className="btn-primary px-3 py-1.5 text-xs disabled:opacity-60">
                      {submitting ? "Conferma..." : "Conferma rapida draft"}
                    </button>
                  </div>
                </div>
              ) : null}

              <form action={handleSubmit} className="grid gap-3 md:grid-cols-2">
                <input name="date" defaultValue={linkedDraftService?.date ?? parsedSuggestion?.date ?? new Date().toISOString().slice(0, 10)} className="input-saas" />
                <input name="time" defaultValue={linkedDraftService?.time ?? parsedSuggestion?.time ?? "09:00"} className="input-saas" />
                <select name="direction" defaultValue={linkedDraftService?.direction ?? "arrival"} className="input-saas">
                  <option value="arrival">arrivo</option>
                  <option value="departure">partenza</option>
                </select>
                <select name="service_type" value={serviceType} onChange={(event) => setServiceType(event.target.value as ServiceType)} className="input-saas">
                  <option value="transfer">transfer</option>
                  <option value="bus_tour">bus_tour</option>
                </select>
                <select name="vessel" defaultValue={linkedDraftService?.vessel ?? parsedSuggestion?.vessel ?? vessels[0]} className="input-saas">
                  {vessels.map((vessel) => (
                    <option key={vessel} value={vessel}>{vessel}</option>
                  ))}
                </select>
                <input name="customer_name" defaultValue={linkedDraftService?.customer_name ?? parsedSuggestion?.customer_name ?? "Cliente da verificare"} className="input-saas" />
                <input name="phone" defaultValue={linkedDraftService?.phone ?? parsedSuggestion?.phone ?? "N/D"} className="input-saas" />
                <input name="pax" type="number" min={1} max={16} defaultValue={linkedDraftService?.pax ?? parsedSuggestion?.pax ?? 1} className="input-saas" />
                <select name="hotel_id" defaultValue={linkedDraftService?.hotel_id ?? hotels[0]?.id ?? ""} className="input-saas">
                  {hotels.map((hotel) => (
                    <option key={hotel.id} value={hotel.id}>{hotel.name} - {hotel.zone}</option>
                  ))}
                </select>
                <input name="notes" defaultValue={linkedDraftService?.notes ?? `[inbound:${selectedEmail.id}]`} className="input-saas" />
                {serviceType === "bus_tour" ? (
                  <>
                    <input name="tour_name" defaultValue={linkedDraftService?.tour_name ?? ""} placeholder="Nome tour" className="input-saas" />
                    <input name="capacity" type="number" min={1} defaultValue={linkedDraftService?.capacity ?? ""} placeholder="Capacita" className="input-saas" />
                    <input name="meeting_point" defaultValue={linkedDraftService?.meeting_point ?? ""} placeholder="Punto di incontro" className="input-saas" />
                    <textarea name="stops" rows={2} defaultValue={(linkedDraftService?.stops ?? []).join(", ")} placeholder="Fermate" className="input-saas md:col-span-2" />
                    <input name="bus_plate" defaultValue={linkedDraftService?.bus_plate ?? ""} placeholder="Targa bus" className="input-saas md:col-span-2" />
                  </>
                ) : null}
                <button type="submit" disabled={submitting} className="btn-primary md:col-span-2 disabled:opacity-60">
                  {submitting ? "Salvataggio..." : linkedDraftService ? "Aggiorna servizio draft" : "Crea servizio"}
                </button>
              </form>
            </>
          )}
          {message ? <p className="text-sm text-slate-600">{message}</p> : null}
          {drivers.length > 0 ? <p className="text-xs text-slate-500">Driver disponibili: {drivers.length}</p> : null}
        </div>
      </div>
    </section>
  );
}
