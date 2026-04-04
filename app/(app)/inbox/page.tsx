"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { PdfAdvancedReview } from "@/components/pdf/PdfAdvancedReview";
import { getInboxPdfParsingSignal } from "@/lib/pdf/parser";
import type { PdfImportDetail } from "@/lib/server/pdf-imports";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";
import { getClientSessionContext } from "@/lib/supabase/client-session";
import type { Hotel, InboundEmail, Membership, Service } from "@/lib/types";

// ─── Tipi ──────────────────────────────────────────────────────────────────

type FormState = {
  cliente_nome: string;
  cliente_cellulare: string;
  n_pax: string;
  hotel: string;
  data_arrivo: string;
  orario_arrivo: string;
  data_partenza: string;
  orario_partenza: string;
  tipo_servizio: string;
  treno_andata: string;
  treno_ritorno: string;
  citta_partenza: string;
  totale_pratica: string;
  note: string;
  numero_pratica: string;
  agenzia: string;
};

const EMPTY_FORM: FormState = {
  cliente_nome: "", cliente_cellulare: "", n_pax: "1",
  hotel: "", data_arrivo: "", orario_arrivo: "",
  data_partenza: "", orario_partenza: "",
  tipo_servizio: "transfer_station_hotel",
  treno_andata: "", treno_ritorno: "",
  citta_partenza: "", totale_pratica: "",
  note: "", numero_pratica: "", agenzia: ""
};

const TIPO_LABELS: Record<string, string> = {
  transfer_station_hotel: "Transfer Stazione / Hotel",
  transfer_airport_hotel: "Transfer Aeroporto / Hotel",
  transfer_port_hotel: "Transfer Porto / Hotel",
  bus_city_hotel: "Bus Città / Hotel",
  excursion: "Escursione"
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function isMedmar(form: FormState): boolean {
  return form.tipo_servizio === "transfer_port_hotel" || form.tipo_servizio === "transfer_hotel_port";
}

async function copyToClipboard(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; }
  catch { return false; }
}

async function getToken(): Promise<string | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const [, base64 = ""] = result.split(",");
      resolve(base64);
    };
    reader.onerror = () => reject(new Error("Lettura file non riuscita."));
    reader.readAsDataURL(file);
  });
}

function claudeExtractedToForm(claudeExtracted: Record<string, unknown> | null): FormState {
  if (!claudeExtracted?.form) return EMPTY_FORM;
  const f = claudeExtracted.form as Partial<FormState>;
  return {
    cliente_nome: f.cliente_nome ?? "",
    cliente_cellulare: f.cliente_cellulare ?? "",
    n_pax: f.n_pax ?? "1",
    hotel: f.hotel ?? "",
    data_arrivo: f.data_arrivo ?? "",
    orario_arrivo: f.orario_arrivo ?? "",
    data_partenza: f.data_partenza ?? "",
    orario_partenza: f.orario_partenza ?? "",
    tipo_servizio: f.tipo_servizio ?? "transfer_station_hotel",
    treno_andata: f.treno_andata ?? "",
    treno_ritorno: f.treno_ritorno ?? "",
    citta_partenza: f.citta_partenza ?? "",
    totale_pratica: f.totale_pratica ?? "",
    note: f.note ?? "",
    numero_pratica: f.numero_pratica ?? "",
    agenzia: f.agenzia ?? ""
  };
}

function text(value: unknown) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

// Converte qualsiasi stringa data in formato YYYY-MM-DD per <input type="date">
// Se non riconoscibile restituisce "" (campo vuoto, l'utente la inserisce manualmente)
function toDateValue(raw: string): string {
  if (!raw) return "";
  // Già ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  // DD/MM/YYYY o D/M/YYYY
  const dmy = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (dmy) {
    const [, d, m, y] = dmy;
    const year = y!.length === 2 ? `20${y}` : y;
    return `${year}-${m!.padStart(2, "0")}-${d!.padStart(2, "0")}`;
  }
  return "";
}

function normalizedPdfToForm(normalized: Record<string, unknown> | null): FormState {
  if (!normalized) return EMPTY_FORM;
  const serviceType = text(normalized.service_type).trim();
  const bookingKind = text(normalized.booking_kind).trim();
  const tipo_servizio =
    serviceType ||
    (bookingKind === "transfer_airport_hotel"
      ? "transfer_airport_hotel"
      : bookingKind === "transfer_port_hotel"
        ? "transfer_port_hotel"
        : bookingKind === "excursion"
          ? "excursion"
          : "transfer_station_hotel");

  return {
    cliente_nome: text(normalized.customer_full_name),
    cliente_cellulare: text(normalized.customer_phone),
    n_pax: text(normalized.passengers || "1"),
    hotel: text(normalized.hotel_or_destination),
    data_arrivo: text(normalized.arrival_date),
    orario_arrivo: text(normalized.outbound_time),
    data_partenza: text(normalized.departure_date),
    orario_partenza: text(normalized.return_time),
    tipo_servizio,
    treno_andata: text(normalized.train_arrival_number || normalized.transport_reference_outward),
    treno_ritorno: text(normalized.train_departure_number || normalized.transport_reference_return),
    citta_partenza: text(normalized.arrival_place || normalized.bus_city_origin),
    totale_pratica: (() => {
      const cents = Number(normalized.source_total_amount_cents);
      if (!Number.isFinite(cents) || cents <= 0) return "";
      return (cents / 100).toFixed(2);
    })(),
    note: text(normalized.notes),
    numero_pratica: text((normalized.dedupe_components as Record<string, unknown> | undefined)?.practice_number ?? normalized.external_reference),
    agenzia: text(normalized.billing_party_name || normalized.agency_name)
  };
}

function inboxParsedToForm(parsedJson: Record<string, unknown> | null): FormState {
  const effectiveNormalized = (parsedJson?.pdf_import as Record<string, unknown> | undefined)?.effective_normalized as Record<string, unknown> | undefined;
  if (effectiveNormalized && Object.keys(effectiveNormalized).length > 0) {
    return normalizedPdfToForm(effectiveNormalized);
  }

  const normalized = (parsedJson?.pdf_import as Record<string, unknown> | undefined)?.normalized as Record<string, unknown> | undefined;
  if (normalized && Object.keys(normalized).length > 0) {
    return normalizedPdfToForm(normalized);
  }

  const claudeExtracted = (parsedJson?.claude_extracted as Record<string, unknown> | undefined) ?? null;
  return claudeExtractedToForm(claudeExtracted);
}

function hasInboxStructuredData(parsedJson: Record<string, unknown> | null): boolean {
  if (!parsedJson) return false;
  const pdfImport = parsedJson.pdf_import as Record<string, unknown> | undefined;
  const effectiveNormalized = pdfImport?.effective_normalized as Record<string, unknown> | undefined;
  if (effectiveNormalized && Object.keys(effectiveNormalized).length > 0) return true;
  const normalized = pdfImport?.normalized as Record<string, unknown> | undefined;
  if (normalized && Object.keys(normalized).length > 0) return true;
  const claudeExtracted = parsedJson.claude_extracted as Record<string, unknown> | undefined;
  return Boolean(claudeExtracted);
}

// ─── Componente ─────────────────────────────────────────────────────────────

export default function InboxPage() {
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [inboundEmails, setInboundEmails] = useState<InboundEmail[]>([]);
  const [hotels, setHotels] = useState<Hotel[]>([]);
  const [drivers, setDrivers] = useState<Membership[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [blockingNotice, setBlockingNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [importRefreshing, setImportRefreshing] = useState(false);
  const [hasLoadedInbox, setHasLoadedInbox] = useState(false);
  const [inboxFilter, setInboxFilter] = useState<"all" | "needs_review" | "confirmed">("needs_review");
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [approveError, setApproveError] = useState<string | null>(null);
  const [approvedServiceId, setApprovedServiceId] = useState<string | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [authRole, setAuthRole] = useState<"admin" | "operator" | "driver" | "agency" | "supervisor" | null>(null);
  const [pdfAdvancedOpen, setPdfAdvancedOpen] = useState(false);
  const [pdfAdvancedLoading, setPdfAdvancedLoading] = useState(false);
  const [pdfAdvancedError, setPdfAdvancedError] = useState<string | null>(null);
  const [pdfAdvancedRow, setPdfAdvancedRow] = useState<PdfImportDetail | null>(null);

  // Smista come escursione
  const [escursioneOpen, setEscursioneOpen] = useState(false);
  const [escursioneParsing, setEscursioneParsing] = useState(false);
  const [escursioneError, setEscursioneError] = useState<string | null>(null);
  type EscBooking = { customer_name: string; pax: number; hotel_name: string | null; agency_name: string | null; phone: string | null; excursion_name: string | null; excursion_date: string | null; notes: string | null; unit_id: string; confirmed: boolean };
  const [escursioneBookings, setEscursioneBookings] = useState<EscBooking[]>([]);
  const [escursioneUnits, setEscursioneUnits] = useState<Array<{ id: string; label: string; excursion_line_id: string }>>([]);
  const [escursioneLines, setEscursioneLines] = useState<Array<{ id: string; name: string }>>([]);
  const [escursioneDate, setEscursioneDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [escursioneSaving, setEscursioneSaving] = useState(false);
  const [pdfUploadOpen, setPdfUploadOpen] = useState(false);
  const [pdfUploadFile, setPdfUploadFile] = useState<File | null>(null);
  const [pdfUploadSubject, setPdfUploadSubject] = useState("");
  const [pdfUploadSender, setPdfUploadSender] = useState("agency@example.com");
  const [pdfUploadBody, setPdfUploadBody] = useState("");
  const [pdfUploadLoading, setPdfUploadLoading] = useState(false);
  const [pdfUploadSaving, setPdfUploadSaving] = useState(false);
  const [pdfUploadError, setPdfUploadError] = useState<string | null>(null);
  const [pdfUploadPreview, setPdfUploadPreview] = useState<Record<string, unknown> | null>(null);
  const [pdfEditForm, setPdfEditForm] = useState<FormState>(EMPTY_FORM);
  const [pdfDuplicateWarning, setPdfDuplicateWarning] = useState<string | null>(null);

  const handleCopy = (text: string, field: string) => {
    void copyToClipboard(text).then(() => {
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 1800);
    });
  };

  function setField(field: keyof FormState, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  const loadData = async (token: string) => {
    const response = await fetch("/api/ops/dispatch-data", {
      headers: { Authorization: `Bearer ${token}` }
    });
    const body = (await response.json().catch(() => null)) as {
      ok?: boolean; error?: string; tenant_id?: string;
      services?: unknown[]; hotels?: unknown[];
      memberships?: unknown[]; inbound_emails?: unknown[];
    } | null;
    if (!response.ok || !body?.ok) throw new Error(String(body?.error ?? "Errore caricamento inbox."));

    setTenantId(typeof body.tenant_id === "string" ? body.tenant_id : null);
    setInboundEmails((body.inbound_emails ?? []) as InboundEmail[]);
    setServices((body.services ?? []) as Service[]);
    setHotels((body.hotels ?? []) as Hotel[]);
    setDrivers(((body.memberships ?? []) as Membership[]).filter((m) => m.role === "driver"));
    if ((body.inbound_emails ?? []).length > 0) {
      setSelectedId(((body.inbound_emails ?? []) as InboundEmail[])[0]?.id ?? null);
    }
  };

  useEffect(() => {
    let active = true;
    const boot = async () => {
      const session = await getClientSessionContext();
      if (session.mode === "demo" || !hasSupabaseEnv || !supabase || !session.userId || !session.tenantId || !active) {
        if (active) {
          setBlockingNotice("Inbox disponibile solo con login Supabase reale e tenant configurato.");
          setHasLoadedInbox(true);
        }
        return;
      }
      setBlockingNotice(null);
      setAuthRole(session.role);
      try {
        const supabaseSession = await supabase.auth.getSession();
        const token = supabaseSession.data.session?.access_token;
        if (!token) throw new Error("Sessione non valida.");
        await loadData(token);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Errore caricamento inbox.");
      } finally {
        if (active) setHasLoadedInbox(true);
      }
    };
    void boot();
    return () => { active = false; };
  }, []);

  const loadPdfAdvancedDetail = async (inboundEmailId: string) => {
    if (!supabase) throw new Error("Supabase non configurato.");
    const token = await getToken();
    if (!token) throw new Error("Sessione non valida.");
    const response = await fetch("/api/email/pdf-imports", {
      headers: { Authorization: `Bearer ${token}` }
    });
    const body = (await response.json().catch(() => null)) as { ok?: boolean; rows?: PdfImportDetail[]; error?: string } | null;
    if (!response.ok || !body?.ok) throw new Error(body?.error ?? "Caricamento review PDF fallito.");
    const match = (body.rows ?? []).find((row) => row.inbound_email_id === inboundEmailId) ?? null;
    if (!match) throw new Error("Dettaglio parsing non disponibile per questa email.");
    return match;
  };

  const openPdfAdvancedReview = async () => {
    if (!selectedEmail) return;
    setPdfAdvancedOpen(true);
    setPdfAdvancedLoading(true);
    setPdfAdvancedError(null);
    try {
      const row = await loadPdfAdvancedDetail(selectedEmail.id);
      setPdfAdvancedRow(row);
    } catch (err) {
      setPdfAdvancedError(err instanceof Error ? err.message : "Errore apertura review.");
      setPdfAdvancedRow(null);
    } finally {
      setPdfAdvancedLoading(false);
    }
  };

  const openPdfUploadModal = () => {
    setPdfUploadOpen(true);
    setPdfUploadFile(null);
    setPdfUploadSubject("");
    setPdfUploadSender("agency@example.com");
    setPdfUploadBody("");
    setPdfUploadLoading(false);
    setPdfUploadSaving(false);
    setPdfUploadError(null);
    setPdfUploadPreview(null);
  };

  const previewUploadedPdf = async () => {
    if (!pdfUploadFile) {
      setPdfUploadError("Seleziona un PDF da importare.");
      return;
    }
    const token = await getToken();
    if (!token) {
      setPdfUploadError("Sessione non valida.");
      return;
    }

    setPdfUploadLoading(true);
    setPdfUploadError(null);
    setPdfUploadPreview(null);
    try {
      const formData = new FormData();
      formData.append("file", pdfUploadFile);
      formData.append("subject", pdfUploadSubject || `Import PDF ${pdfUploadFile.name}`);
      formData.append("from_email", pdfUploadSender || "agency@example.com");
      formData.append("body_text", pdfUploadBody);

      const response = await fetch("/api/email/preview-pdf", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData
      });
      const body = (await response.json().catch(() => null)) as { ok?: boolean; normalized?: Record<string, unknown>; claude_extracted?: Record<string, unknown>; error?: string } | null;
      if (!response.ok || !body?.ok) {
        throw new Error(body?.error ?? "Anteprima PDF non riuscita.");
      }
      // Nuovo formato Claude: { claude_extracted: { agency, form, raw_json } }
      // Vecchio formato: { normalized: {...} }
      const previewData = body.claude_extracted ? { claude_extracted: body.claude_extracted } : (body.normalized ?? null);
      setPdfUploadPreview(previewData);
      const computed = body.claude_extracted
        ? claudeExtractedToForm(body.claude_extracted as Record<string, unknown>)
        : normalizedPdfToForm(body.normalized ?? null);
      setPdfEditForm(computed);
    } catch (error) {
      setPdfUploadError(error instanceof Error ? error.message : "Anteprima PDF non riuscita.");
    } finally {
      setPdfUploadLoading(false);
    }
  };

  const createDraftFromUploadedPdf = async (force = false) => {
    if (!pdfUploadFile || !pdfUploadPreview) {
      setPdfUploadError("Esegui prima l'anteprima del PDF.");
      return;
    }
    const token = await getToken();
    if (!token) {
      setPdfUploadError("Sessione non valida.");
      return;
    }

    setPdfUploadSaving(true);
    setPdfUploadError(null);
    setPdfDuplicateWarning(null);
    try {
      const pdfBase64 = await fileToBase64(pdfUploadFile);
      const detectedAgency = String((pdfUploadPreview?.claude_extracted as Record<string,unknown> | undefined)?.agency ?? "manual_upload");
      const response = await fetch("/api/pdf/claude-save-draft", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          form: pdfEditForm,
          pdf_base64: pdfBase64,
          filename: pdfUploadFile.name,
          agency: detectedAgency,
          force
        })
      });
      const body = (await response.json().catch(() => null)) as { ok?: boolean; inbound_email_id?: string; duplicate?: boolean; error?: string } | null;
      if (response.status === 409 && body?.duplicate) {
        setPdfDuplicateWarning(body.error ?? "PDF già importato.");
        return;
      }
      if (!response.ok || !body?.ok || !body?.inbound_email_id) {
        throw new Error(body?.error ?? "Creazione bozza da PDF non riuscita.");
      }

      await loadData(token);
      setSelectedId(body.inbound_email_id);
      setPdfUploadOpen(false);
      setMessage(`PDF importato. Bozza creata in Inbox per ${pdfUploadFile.name}.`);
    } catch (error) {
      setPdfUploadError(error instanceof Error ? error.message : "Creazione bozza da PDF non riuscita.");
    } finally {
      setPdfUploadSaving(false);
    }
  };

  const selectedEmail = useMemo(
    () => inboundEmails.find((e) => e.id === selectedId) ?? inboundEmails[0] ?? null,
    [inboundEmails, selectedId]
  );

  // Quando cambia email selezionata, pre-popola il form prima dal parser normalizzato e solo in fallback da Claude.
  useEffect(() => {
    if (!selectedEmail) { setForm(EMPTY_FORM); setApproveError(null); setApprovedServiceId(null); return; }
    const parsedJson = selectedEmail.parsed_json as Record<string, unknown>;
    setForm(inboxParsedToForm(parsedJson));
    setApproveError(null);
    setApprovedServiceId(null);
  }, [selectedId, selectedEmail?.id]);

  const filteredInboundEmails = useMemo(() => {
    if (inboxFilter === "all") return inboundEmails;
    return inboundEmails.filter((email) => {
      const status = (email.parsed_json as Record<string, unknown>)?.review_status;
      const confirmed = status === "confirmed" || status === "ready_operational";
      return inboxFilter === "confirmed" ? confirmed : !confirmed;
    });
  }, [inboundEmails, inboxFilter]);

  const linkedService = useMemo(() => {
    if (!selectedEmail) return null;
    const parsedJson = selectedEmail.parsed_json as Record<string, unknown>;
    const id = parsedJson?.linked_service_id ?? parsedJson?.draft_service_id;
    if (typeof id === "string") return services.find((s) => s.id === id) ?? null;
    return services.find((s) => s.inbound_email_id === selectedEmail.id) ?? null;
  }, [selectedEmail, services]);

  const isConfirmed = useMemo(() => {
    if (!selectedEmail) return false;
    const status = (selectedEmail.parsed_json as Record<string, unknown>)?.review_status;
    return status === "confirmed" || status === "ready_operational";
  }, [selectedEmail]);

  const parsingSignal = useMemo(() => {
    if (!selectedEmail) return null;
    return getInboxPdfParsingSignal((selectedEmail.parsed_json as Record<string, unknown>) ?? null);
  }, [selectedEmail]);

  const hasStructuredData = useMemo(() => {
    if (!selectedEmail) return false;
    return hasInboxStructuredData((selectedEmail.parsed_json as Record<string, unknown>) ?? null);
  }, [selectedEmail]);

  const canApprove = form.cliente_nome.trim() !== "" && form.hotel.trim() !== "" && form.data_arrivo.trim() !== "";

  const refreshMailboxImports = async () => {
    if (!supabase || !tenantId) return;
    const token = await getToken();
    if (!token) { setMessage("Sessione non valida."); return; }
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
      `Import eseguito. Email trovate: ${body?.unreadFound ?? 0}, PDF: ${body?.pdfFound ?? 0}, importate: ${body?.draftsCreated ?? 0}, duplicate: ${body?.duplicateWarnings ?? 0}.`
    );
  };

  const deleteEmail = async () => {
    if (!selectedEmail || !tenantId || !supabase) return;
    if (!confirm("Eliminare questa email? L'operazione non è reversibile.")) return;
    const token = await getToken();
    if (!token) return;
    const { error } = await supabase
      .from("inbound_emails")
      .delete()
      .eq("id", selectedEmail.id)
      .eq("tenant_id", tenantId);
    if (error) { setApproveError(error.message); return; }
    await loadData(token);
    setMessage("Email eliminata.");
  };

  const approveEmail = async () => {
    if (!selectedEmail || !tenantId) return;
    const token = await getToken();
    if (!token) { setApproveError("Sessione scaduta."); return; }
    setSubmitting(true);
    setApproveError(null);
    try {
      const res = await fetch("/api/email/inbox-approve", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ inbound_email_id: selectedEmail.id, form })
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; service_id?: string; error?: string };
      if (!res.ok || !body.ok) {
        setApproveError(body.error ?? `Errore HTTP ${res.status}`);
      } else {
        setApprovedServiceId(body.service_id ?? "ok");
        await loadData(token);
        setMessage(`Servizio approvato e confermato. ID: ${body.service_id?.slice(0, 8)}...`);
      }
    } catch (e) {
      setApproveError(e instanceof Error ? e.message : "Errore di rete.");
    } finally {
      setSubmitting(false);
    }
  };

  const openEscursionePanel = async () => {
    if (!selectedEmail) return;
    setEscursioneOpen(true);
    setEscursioneBookings([]);
    setEscursioneError(null);
    setEscursioneParsing(true);
    const token = await getToken();
    if (!token) { setEscursioneParsing(false); return; }

    // Carica units + lines per la data selezionata
    const dataRes = await fetch(`/api/ops/escursioni?date=${escursioneDate}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const dataBody = await dataRes.json().catch(() => null);
    if (dataBody?.ok) {
      setEscursioneUnits(dataBody.units ?? []);
      setEscursioneLines(dataBody.lines ?? []);
    }

    // Estrai passeggeri con Claude
    const text = selectedEmail.body_text ?? selectedEmail.raw_text ?? "";
    const res = await fetch("/api/email/import-escursioni", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ text, date: escursioneDate }),
    });
    const body = await res.json().catch(() => null);
    setEscursioneParsing(false);
    if (!body?.ok) { setEscursioneError(body?.error ?? "Errore analisi."); return; }
    const defaultUnit = (dataBody?.units ?? [])[0]?.id ?? "";
    setEscursioneBookings((body.bookings ?? []).map((b: Omit<EscBooking, "unit_id" | "confirmed">) => ({
      ...b, unit_id: defaultUnit, confirmed: true,
    })));
  };

  const confirmEscursioneImport = async () => {
    const token = await getToken();
    if (!token) return;
    setEscursioneSaving(true);
    const toImport = escursioneBookings.filter((b) => b.confirmed && b.unit_id);
    for (const b of toImport) {
      await fetch("/api/ops/escursioni", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          action: "add_passenger",
          date: escursioneDate,
          excursion_unit_id: b.unit_id,
          customer_name: b.customer_name,
          pax: b.pax,
          hotel_name: b.hotel_name || null,
          agency_name: b.agency_name || null,
          phone: b.phone || null,
          notes: b.notes || null,
          pickup_time: null,
        }),
      });
    }
    setEscursioneSaving(false);
    setEscursioneOpen(false);
    setMessage(`${toImport.length} passeggeri importati in Escursioni.`);
  };

  if (!hasLoadedInbox) {
    return <div className="card p-4 text-sm text-slate-500">Caricamento posta in arrivo...</div>;
  }

  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold">Prenotazioni</h1>

      {blockingNotice && (
        <article className="card space-y-2 border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-semibold">{blockingNotice}</p>
          <div className="flex gap-2">
            <Link href="/login" className="btn-secondary px-3 py-1.5 text-xs">Vai al login</Link>
            <Link href="/onboarding" className="btn-primary px-3 py-1.5 text-xs">Vai a onboarding</Link>
          </div>
        </article>
      )}

      <article className="card flex flex-wrap items-center justify-between gap-4 p-4">
        <div className="min-w-[240px] flex-1">
          <h2 className="text-sm font-semibold uppercase tracking-[0.1em] text-slate-600">Importa</h2>
          <p className="text-xs text-slate-500">Importa nuove richieste da email, PDF o file Excel del cliente senza uscire dal flusso operativo.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => void refreshMailboxImports()} className="inbox-import-pill" disabled={importRefreshing}>
            {importRefreshing ? "Importo..." : "Da email"}
          </button>
          <button type="button" onClick={openPdfUploadModal} className="inbox-import-pill">
            Da PDF
          </button>
          <Link href="/excel-import" className="inbox-import-pill">
            Da Excel
          </Link>
        </div>
      </article>

      <div className={`grid gap-4 ${filteredInboundEmails.length > 0 ? "lg:grid-cols-[minmax(300px,360px)_1fr]" : ""}`}>
        {/* Lista email */}
        <aside className="card max-h-[680px] space-y-2 overflow-y-auto p-3">
          <div className="mb-1 flex flex-wrap gap-1.5">
            {(["needs_review", "confirmed", "all"] as const).map((f) => (
              <button key={f} type="button" onClick={() => setInboxFilter(f)}
                className={inboxFilter === f ? "btn-primary px-2 py-1 text-xs" : "btn-secondary px-2 py-1 text-xs"}>
                {f === "needs_review" ? "Da approvare" : f === "confirmed" ? "Approvate" : "Tutte"}
              </button>
            ))}
          </div>
          {filteredInboundEmails.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-5">
              <p className="text-sm font-medium text-slate-700">Nessuna email nel filtro attuale.</p>
              <p className="mt-1 text-xs text-slate-500">Usa Importa per caricare nuove richieste da email, PDF o file Excel.</p>
            </div>
          ) : (
            filteredInboundEmails.map((email) => {
              const pj = email.parsed_json as Record<string, unknown>;
              const confirmed = pj?.review_status === "confirmed" || pj?.review_status === "ready_operational";
              const hasClaude = !!pj?.claude_extracted;
              const hasStructured = hasInboxStructuredData(pj);
              const parsing = getInboxPdfParsingSignal(pj);
              const isSelected = email.id === (selectedEmail?.id ?? null);
              const needsParsingReview = parsing.hasPdfImport && !parsing.confirmed && (parsing.reviewRecommended || parsing.missingFieldsCount > 0);
              return (
                <button key={email.id} type="button" onClick={() => setSelectedId(email.id)}
                  className={`w-full rounded-lg border p-2.5 text-left text-sm transition ${
                    isSelected
                      ? "border-blue-300 bg-blue-50"
                      : needsParsingReview
                        ? "border-amber-300 bg-amber-50/40 hover:bg-amber-50"
                        : "border-slate-200 hover:bg-slate-50"
                  }`}>
                  <p className="truncate font-medium text-slate-800">{pj.subject as string ?? "Nessun oggetto"}</p>
                  <p className="truncate text-xs text-slate-500">{pj.from_email as string ?? "N/D"}</p>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${confirmed ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>
                      {confirmed ? "approvata" : "da approvare"}
                    </span>
                    {hasClaude && (
                      <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-semibold text-blue-700">Claude AI</span>
                    )}
                    {!hasClaude && hasStructured ? (
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-700">Parsing PDF</span>
                    ) : null}
                    {parsing.hasPdfImport ? (
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                          parsing.reviewRecommended || parsing.missingFieldsCount > 0
                            ? "bg-amber-100 text-amber-700"
                            : "bg-emerald-100 text-emerald-700"
                        }`}
                      >
                        {parsing.reviewRecommended || parsing.missingFieldsCount > 0 ? "⚠️ Da verificare" : "✅ OK"}
                      </span>
                    ) : null}
                    {parsing.duplicate ? (
                      <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-semibold text-slate-700">Duplicato</span>
                    ) : null}
                    {parsing.duplicateServiceAlert ? (
                      <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-semibold text-rose-700">⚠ Pratica già esistente</span>
                    ) : null}
                  </div>
                </button>
              );
            })
          )}
        </aside>

        {/* Pannello dettaglio */}
        {filteredInboundEmails.length > 0 ? (
        <div className="card space-y-4 p-4">
          {!selectedEmail ? (
            <p className="text-sm text-slate-500">Seleziona una email.</p>
          ) : (
            <>
              {/* Header email */}
              <div className="grid gap-1.5 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600 md:grid-cols-2">
                <p><span className="font-semibold">Da:</span> {(selectedEmail.parsed_json as Record<string, unknown>).from_email as string ?? "N/D"}</p>
                <p><span className="font-semibold">Oggetto:</span> {(selectedEmail.parsed_json as Record<string, unknown>).subject as string ?? "N/D"}</p>
              </div>

              {/* Già approvata */}
              {isConfirmed && (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
                  <p className="font-semibold">Email già approvata</p>
                  {linkedService && (
                    <p className="mt-1 text-xs">Servizio: {linkedService.customer_name} · {linkedService.date}</p>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Link href="/arrivals" className="btn-primary px-3 py-1.5 text-xs">Vai agli Arrivi</Link>
                    <Link href="/departures" className="btn-secondary px-3 py-1.5 text-xs">Vai alle Partenze</Link>
                    <button type="button" onClick={() => void deleteEmail()}
                      className="ml-auto rounded-lg border border-rose-200 bg-white px-3 py-1.5 text-xs font-medium text-rose-600 hover:bg-rose-50">
                      Elimina
                    </button>
                  </div>
                </div>
              )}

              {/* Appena approvata in questa sessione */}
              {approvedServiceId && !isConfirmed && (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
                  <p className="font-semibold">Servizio creato e confermato</p>
                  <div className="mt-2 flex gap-2">
                    <Link href="/arrivals" className="btn-primary px-3 py-1.5 text-xs">Vai agli Arrivi</Link>
                    <Link href="/departures" className="btn-secondary px-3 py-1.5 text-xs">Vai alle Partenze</Link>
                  </div>
                </div>
              )}

              {/* Form Claude pre-compilato */}
              {!isConfirmed && !approvedServiceId && (
                <>
                  {/* Badge Claude */}
                  {hasStructuredData && (
                    <div className="flex items-center gap-2">
                      <span className="rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-700">
                        Dati precompilati dal parsing PDF
                      </span>
                      {form.numero_pratica && (
                        <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-600">
                          Pratica {form.numero_pratica}
                        </span>
                      )}
                      <span className="ml-auto text-[11px] text-slate-400">Verifica i campi e approva</span>
                    </div>
                  )}
                  {parsingSignal?.duplicateServiceAlert && (
                    <div className="flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2.5">
                      <span className="text-sm font-semibold text-rose-700">⚠ Pratica già esistente</span>
                      <span className="text-xs text-rose-600">Un servizio con questo nome e data è già presente. Vuoi procedere comunque?</span>
                    </div>
                  )}
                  {parsingSignal?.hasPdfImport ? (
                    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                      <span
                        className={`rounded-full px-2 py-1 text-[11px] font-semibold ${
                          parsingSignal.reviewRecommended || parsingSignal.missingFieldsCount > 0
                            ? "bg-amber-100 text-amber-700"
                            : "bg-emerald-100 text-emerald-700"
                        }`}
                      >
                        {parsingSignal.reviewRecommended || parsingSignal.missingFieldsCount > 0 ? "⚠️ Da verificare" : "✅ OK"}
                      </span>
                      {parsingSignal.missingFieldsCount > 0 ? (
                        <span className="text-[11px] text-slate-500">{parsingSignal.missingFieldsCount} campi incerti</span>
                      ) : null}
                      <button type="button" onClick={() => void openPdfAdvancedReview()} className="btn-secondary ml-auto px-3 py-1.5 text-xs">
                        🔍 Dettaglio parsing
                      </button>
                    </div>
                  ) : null}
                  {!hasStructuredData && (
                    <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                      Nessun parsing strutturato disponibile per questa email. Compila manualmente i campi.
                    </p>
                  )}

                  {approveError && (
                    <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{approveError}</div>
                  )}

                  {/* Badge MEDMAR */}
                  {isMedmar(form) && (
                    <div className="flex items-center gap-2 rounded-xl border border-blue-300 bg-blue-50 px-4 py-3">
                      <span className="text-lg">⚓</span>
                      <div className="flex-1">
                        <p className="text-sm font-semibold text-blue-800">Transfer via Porto — MEDMAR / Traghetto</p>
                        <p className="text-xs text-blue-600">
                          {form.citta_partenza ? `Partenza da ${form.citta_partenza}` : "Porto di partenza da verificare"}
                          {form.orario_arrivo ? ` · Arrivo ${form.orario_arrivo}` : ""}
                          {form.orario_partenza ? ` · Partenza ${form.orario_partenza}` : ""}
                        </p>
                      </div>
                    </div>
                  )}

                  {/* Cliente */}
                  <section className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">Cliente</p>
                    <div className="grid gap-3 sm:grid-cols-3">
                      <label className="text-xs font-medium text-slate-600">
                        Nome *
                        <div className="mt-1 flex gap-1">
                          <input value={form.cliente_nome} onChange={(e) => setField("cliente_nome", e.target.value)}
                            className={`input-saas flex-1 ${!form.cliente_nome ? "border-amber-300 bg-amber-50" : ""}`}
                            placeholder="Nome cognome" />
                          {form.cliente_nome && (
                            <button type="button" onClick={() => handleCopy(form.cliente_nome, "nome")}
                              title="Copia nome"
                              className="rounded-lg border border-slate-200 bg-slate-50 px-2 text-xs hover:bg-slate-100">
                              {copiedField === "nome" ? "✓" : "⎘"}
                            </button>
                          )}
                        </div>
                      </label>
                      <label className="text-xs font-medium text-slate-600">
                        Cellulare
                        <div className="mt-1 flex gap-1">
                          <input value={form.cliente_cellulare} onChange={(e) => setField("cliente_cellulare", e.target.value)}
                            className="input-saas flex-1" placeholder="3281234567" />
                          {form.cliente_cellulare && (
                            <button type="button" onClick={() => handleCopy(form.cliente_cellulare, "tel")}
                              title="Copia telefono"
                              className="rounded-lg border border-slate-200 bg-slate-50 px-2 text-xs hover:bg-slate-100">
                              {copiedField === "tel" ? "✓" : "⎘"}
                            </button>
                          )}
                        </div>
                      </label>
                      <label className="text-xs font-medium text-slate-600">
                        N. Pax
                        <input type="number" min="1" max="99" value={form.n_pax} onChange={(e) => setField("n_pax", e.target.value)}
                          className="mt-1 input-saas w-full" />
                      </label>
                    </div>

                    {/* Sezione copia rapida per biglietti MEDMAR */}
                    {isMedmar(form) && (form.cliente_nome || form.cliente_cellulare) && (
                      <div className="mt-2 rounded-lg border border-blue-200 bg-blue-50 p-3">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-blue-600 mb-2">Copia per prenotazione biglietti</p>
                        <div className="flex flex-wrap gap-2">
                          {form.cliente_nome && (
                            <button type="button" onClick={() => handleCopy(form.cliente_nome, "medmar-nome")}
                              className="flex items-center gap-1.5 rounded-lg border border-blue-300 bg-white px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100">
                              {copiedField === "medmar-nome" ? "✓ Copiato" : `⎘ ${form.cliente_nome}`}
                            </button>
                          )}
                          {form.cliente_cellulare && (
                            <button type="button" onClick={() => handleCopy(form.cliente_cellulare, "medmar-tel")}
                              className="flex items-center gap-1.5 rounded-lg border border-blue-300 bg-white px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100">
                              {copiedField === "medmar-tel" ? "✓ Copiato" : `⎘ ${form.cliente_cellulare}`}
                            </button>
                          )}
                          {form.n_pax && (
                            <button type="button" onClick={() => handleCopy(form.n_pax, "medmar-pax")}
                              className="flex items-center gap-1.5 rounded-lg border border-blue-300 bg-white px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100">
                              {copiedField === "medmar-pax" ? "✓ Copiato" : `⎘ ${form.n_pax} pax`}
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </section>

                  {/* Soggiorno */}
                  <section className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">Soggiorno</p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="text-xs font-medium text-slate-600 sm:col-span-2">
                        Hotel *
                        <input value={form.hotel} onChange={(e) => setField("hotel", e.target.value)}
                          className={`mt-1 input-saas w-full ${!form.hotel ? "border-amber-300 bg-amber-50" : ""}`}
                          placeholder="Nome hotel" />
                      </label>
                      <label className="text-xs font-medium text-slate-600">
                        Data arrivo *
                        <input type="date" value={toDateValue(form.data_arrivo)}
                          onChange={(e) => setField("data_arrivo", e.target.value)}
                          className={`mt-1 input-saas w-full ${!form.data_arrivo ? "border-amber-300 bg-amber-50" : ""}`} />
                      </label>
                      <label className="text-xs font-medium text-slate-600">
                        Orario arrivo
                        <input value={form.orario_arrivo} onChange={(e) => setField("orario_arrivo", e.target.value)}
                          className="mt-1 input-saas w-full" placeholder="HH:MM" />
                      </label>
                      <label className="text-xs font-medium text-slate-600">
                        Data partenza
                        <input type="date" value={toDateValue(form.data_partenza)}
                          onChange={(e) => setField("data_partenza", e.target.value)}
                          className="mt-1 input-saas w-full" />
                      </label>
                      <label className="text-xs font-medium text-slate-600">
                        Orario partenza
                        <input value={form.orario_partenza} onChange={(e) => setField("orario_partenza", e.target.value)}
                          className="mt-1 input-saas w-full" placeholder="HH:MM" />
                      </label>
                    </div>
                  </section>

                  {/* Trasporto */}
                  <section className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">Trasporto</p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="text-xs font-medium text-slate-600 sm:col-span-2">
                        Tipo servizio
                        <select value={form.tipo_servizio} onChange={(e) => setField("tipo_servizio", e.target.value)} className="mt-1 input-saas w-full">
                          {Object.entries(TIPO_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                        </select>
                      </label>
                      <label className="text-xs font-medium text-slate-600">
                        N. mezzo andata
                        <input value={form.treno_andata} onChange={(e) => setField("treno_andata", e.target.value)}
                          className="mt-1 input-saas w-full" placeholder="Es. 9919" />
                      </label>
                      <label className="text-xs font-medium text-slate-600">
                        N. mezzo ritorno
                        <input value={form.treno_ritorno} onChange={(e) => setField("treno_ritorno", e.target.value)}
                          className="mt-1 input-saas w-full" placeholder="Es. 9940" />
                      </label>
                      <label className="text-xs font-medium text-slate-600">
                        {form.tipo_servizio === "bus_city_hotel" ? "Fermata bus / indirizzo prelevamento" : "Città / stazione partenza"}
                        <input value={form.citta_partenza} onChange={(e) => setField("citta_partenza", e.target.value)}
                          className="mt-1 input-saas w-full" placeholder={form.tipo_servizio === "bus_city_hotel" ? "Es. Largo Mazzoni difronte SMEA" : "Es. Torino P. Nuova"} />
                      </label>
                      <label className="text-xs font-medium text-slate-600">
                        Totale pratica (€)
                        <input type="number" min="0" step="0.01" value={form.totale_pratica} onChange={(e) => setField("totale_pratica", e.target.value)}
                          className="mt-1 input-saas w-full" placeholder="Es. 104.00" />
                      </label>
                    </div>
                  </section>

                  {/* Note */}
                  <section className="rounded-xl border border-slate-200 bg-white p-4 space-y-2">
                    <label className="text-xs font-medium text-slate-600">
                      Note operative
                      <textarea rows={2} value={form.note} onChange={(e) => setField("note", e.target.value)}
                        className="mt-1 input-saas w-full resize-none" placeholder="Note aggiuntive..." />
                    </label>
                  </section>

                  {/* Pulsante approva + smista escursione + elimina */}
                  <div className="flex flex-wrap items-center gap-3">
                    {form.tipo_servizio === "excursion" ? (
                      <>
                        <div className="flex items-center gap-2 rounded-xl border-2 border-violet-300 bg-violet-50 px-4 py-2.5">
                          <span className="text-base">🎯</span>
                          <div>
                            <p className="text-xs font-bold text-violet-800">Rilevata escursione</p>
                            <p className="text-[11px] text-violet-600">Claude ha riconosciuto una prenotazione escursione</p>
                          </div>
                        </div>
                        <button type="button" onClick={() => void openEscursionePanel()}
                          disabled={submitting}
                          className="rounded-lg bg-violet-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-violet-700 shadow-sm disabled:opacity-50">
                          🎯 Smista → Escursione
                        </button>
                        <button type="button" onClick={() => void approveEmail()}
                          disabled={submitting || !canApprove}
                          className="rounded-lg border border-slate-200 px-4 py-2.5 text-sm text-slate-500 hover:bg-slate-50 disabled:opacity-50">
                          {submitting ? "..." : "Crea servizio transfer"}
                        </button>
                      </>
                    ) : (
                      <>
                        <button type="button" onClick={() => void approveEmail()}
                          disabled={submitting || !canApprove}
                          className="btn-primary px-6 py-2.5 text-sm disabled:opacity-50">
                          {submitting ? "Approvazione..." : "Approva e crea servizio"}
                        </button>
                        <button type="button" onClick={() => void openEscursionePanel()}
                          disabled={submitting}
                          className="rounded-lg border border-violet-200 bg-violet-50 px-4 py-2.5 text-sm font-medium text-violet-700 hover:bg-violet-100 disabled:opacity-50">
                          🎯 Smista → Escursione
                        </button>
                      </>
                    )}
                    <p className="text-xs text-slate-400">Il servizio apparirà in Arrivi e Partenze</p>
                    <button type="button" onClick={() => void deleteEmail()}
                      disabled={submitting}
                      className="ml-auto rounded-lg border border-rose-200 bg-rose-50 px-4 py-2 text-sm font-medium text-rose-600 hover:bg-rose-100 disabled:opacity-50">
                      Elimina
                    </button>
                  </div>
                </>
              )}

              {/* Testo email raw */}
              <details className="rounded-lg border border-slate-200">
                <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-slate-500 hover:bg-slate-50">Testo email originale</summary>
                <pre className="max-h-44 overflow-auto whitespace-pre-wrap rounded-b-lg bg-slate-50 p-3 text-xs text-slate-700">{selectedEmail.raw_text}</pre>
              </details>
            </>
          )}

          {message && <p className="text-sm text-slate-500">{message}</p>}
          {drivers.length > 0 && <p className="text-xs text-slate-400">Driver disponibili: {drivers.length}</p>}
        </div>
        ) : null}
      </div>

      {/* Pannello laterale: smista come escursione */}
      {escursioneOpen && (
        <div className="fixed inset-0 z-[80] flex justify-end bg-slate-950/30 backdrop-blur-[1px]">
          <div className="flex h-full w-full max-w-lg flex-col border-l border-slate-200 bg-white shadow-2xl">
            <div className="flex items-center gap-3 border-b border-slate-100 px-5 py-4">
              <span className="text-xl">🎯</span>
              <div className="flex-1">
                <p className="font-bold text-slate-900">Smista come Escursione</p>
                <p className="text-xs text-slate-500">{selectedEmail?.subject ?? ""}</p>
              </div>
              <button onClick={() => setEscursioneOpen(false)} className="text-slate-400 hover:text-slate-700">✕</button>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
              {/* Selettore data */}
              <div className="flex items-center gap-2">
                <label className="text-xs font-medium text-slate-500">Data escursione:</label>
                <input type="date" value={escursioneDate}
                  onChange={async (e) => {
                    setEscursioneDate(e.target.value);
                    const token = await getToken();
                    if (!token) return;
                    const res = await fetch(`/api/ops/escursioni?date=${e.target.value}`, { headers: { Authorization: `Bearer ${token}` } });
                    const body = await res.json().catch(() => null);
                    if (body?.ok) { setEscursioneUnits(body.units ?? []); setEscursioneLines(body.lines ?? []); }
                  }}
                  className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm" />
              </div>

              {escursioneParsing && <p className="text-sm text-slate-400">Analisi in corso con Claude...</p>}
              {escursioneError && <p className="text-xs text-rose-600">{escursioneError}</p>}

              {!escursioneParsing && escursioneBookings.length === 0 && !escursioneError && (
                <p className="text-sm text-slate-400">Nessuna prenotazione estratta.</p>
              )}

              {escursioneBookings.map((b, i) => (
                <div key={i} className={`rounded-xl border p-3 ${b.confirmed ? "border-violet-200 bg-violet-50" : "border-slate-200 bg-slate-50 opacity-50"}`}>
                  <div className="flex items-start gap-2">
                    <input type="checkbox" checked={b.confirmed}
                      onChange={(e) => setEscursioneBookings((prev) => prev.map((x, j) => j === i ? { ...x, confirmed: e.target.checked } : x))}
                      className="mt-0.5 h-4 w-4 accent-violet-600" />
                    <div className="flex-1 space-y-1 text-xs">
                      <p><strong>{b.customer_name}</strong> · {b.pax} pax</p>
                      {b.hotel_name && <p className="text-slate-500">🏨 {b.hotel_name}</p>}
                      {b.agency_name && <p className="text-slate-500">🏢 {b.agency_name}</p>}
                      {b.excursion_name && <p className="text-slate-500">🗺 {b.excursion_name}</p>}
                      {b.phone && <p className="text-slate-400">📞 {b.phone}</p>}
                      {b.notes && <p className="text-slate-400">{b.notes}</p>}
                      <select
                        value={b.unit_id}
                        onChange={(e) => setEscursioneBookings((prev) => prev.map((x, j) => j === i ? { ...x, unit_id: e.target.value } : x))}
                        className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs">
                        <option value="">— Assegna bus —</option>
                        {escursioneUnits.map((u) => {
                          const lineName = escursioneLines.find((l) => l.id === u.excursion_line_id)?.name ?? "";
                          return <option key={u.id} value={u.id}>{lineName} · {u.label}</option>;
                        })}
                      </select>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="border-t border-slate-100 px-5 py-4 flex justify-between gap-2">
              <button onClick={() => setEscursioneOpen(false)} className="rounded-lg border border-slate-200 px-4 py-2 text-sm text-slate-600">Annulla</button>
              <button
                disabled={escursioneSaving || escursioneBookings.filter((b) => b.confirmed && b.unit_id).length === 0}
                onClick={() => void confirmEscursioneImport()}
                className="rounded-lg bg-violet-600 px-5 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-40">
                {escursioneSaving ? "Salvataggio..." : `✅ Importa ${escursioneBookings.filter((b) => b.confirmed && b.unit_id).length} in Escursioni`}
              </button>
            </div>
          </div>
        </div>
      )}

      {pdfAdvancedOpen ? (
        <div className="fixed inset-0 z-[80] flex justify-end bg-slate-950/30 backdrop-blur-[1px]">
          <div className="h-full w-full max-w-[960px] border-l border-slate-200 bg-white shadow-2xl">
            {pdfAdvancedLoading ? (
              <div className="flex h-full items-center justify-center text-sm text-slate-500">Caricamento review avanzata...</div>
            ) : pdfAdvancedError ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{pdfAdvancedError}</p>
                <button type="button" onClick={() => setPdfAdvancedOpen(false)} className="btn-secondary px-3 py-2 text-xs">Chiudi</button>
              </div>
            ) : pdfAdvancedRow ? (
              <PdfAdvancedReview
                row={pdfAdvancedRow}
                showDebug={authRole === "admin"}
                onClose={() => setPdfAdvancedOpen(false)}
                onLowConfidence={() => {}}
                onReload={async () => {
                  const token = await getToken();
                  if (token) {
                    await loadData(token);
                  }
                  const refreshed = await loadPdfAdvancedDetail(pdfAdvancedRow.inbound_email_id);
                  setPdfAdvancedRow(refreshed);
                }}
              />
            ) : null}
          </div>
        </div>
      ) : null}

      {pdfUploadOpen ? (
        <div className="fixed inset-0 z-[81] flex items-center justify-center bg-slate-950/35 p-4 backdrop-blur-[1px]">
          <div className="w-full max-w-5xl rounded-3xl border border-slate-200 bg-white shadow-2xl">
            <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
              <div className="space-y-1">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">Da PDF</p>
                <h3 className="text-xl font-semibold text-slate-900">Importa PDF con Claude AI</h3>
                <p className="text-sm text-slate-500">Carica il PDF, Claude estrae i dati in automatico. Verifica e crea la bozza con un click.</p>
              </div>
              <button type="button" onClick={() => setPdfUploadOpen(false)} className="btn-secondary px-3 py-2 text-xs">
                Chiudi
              </button>
            </div>

            <div className="grid gap-6 px-6 py-5 lg:grid-cols-[320px_1fr]">
              <div className="space-y-4">
                {/* Drop zone PDF */}
                <label className="block cursor-pointer">
                  <input
                    type="file"
                    accept="application/pdf,.pdf"
                    className="sr-only"
                    onChange={(event) => {
                      setPdfUploadFile(event.target.files?.[0] ?? null);
                      setPdfUploadPreview(null);
                      setPdfUploadError(null);
                      setPdfEditForm(EMPTY_FORM);
                    }}
                  />
                  <div className={`flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed px-4 py-8 text-center transition-colors ${pdfUploadFile ? "border-emerald-400 bg-emerald-50" : "border-slate-300 bg-slate-50 hover:border-slate-400"}`}>
                    <span className="text-2xl">{pdfUploadFile ? "📄" : "📂"}</span>
                    {pdfUploadFile ? (
                      <>
                        <p className="text-sm font-semibold text-emerald-700">{pdfUploadFile.name}</p>
                        <p className="text-xs text-slate-500">{(pdfUploadFile.size / 1024).toFixed(0)} KB — clicca per cambiare</p>
                      </>
                    ) : (
                      <>
                        <p className="text-sm font-medium text-slate-700">Clicca per scegliere il PDF</p>
                        <p className="text-xs text-slate-400">Max 8 MB</p>
                      </>
                    )}
                  </div>
                </label>

                {/* Oggetto (opzionale, aiuta Claude) */}
                <label className="block text-xs font-medium text-slate-600">
                  Riferimento / oggetto
                  <input
                    value={pdfUploadSubject}
                    onChange={(event) => setPdfUploadSubject(event.target.value)}
                    className="mt-1 input-saas w-full"
                    placeholder="es. Pratica 24/001234 — opzionale"
                  />
                </label>

                {/* Testo aggiuntivo collassato */}
                <details className="rounded-xl border border-slate-200">
                  <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-slate-500 hover:text-slate-700">
                    + Testo aggiuntivo (opzionale)
                  </summary>
                  <textarea
                    rows={4}
                    value={pdfUploadBody}
                    onChange={(event) => setPdfUploadBody(event.target.value)}
                    className="w-full rounded-b-xl border-t border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 outline-none placeholder:text-slate-400"
                    placeholder="Incolla qui il testo dell’email se vuoi dare più contesto a Claude."
                  />
                </details>

                {pdfUploadError && !pdfUploadPreview ? (
                  <p className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{pdfUploadError}</p>
                ) : null}

                <button
                  type="button"
                  onClick={() => void previewUploadedPdf()}
                  className="btn-primary w-full py-2.5 text-sm"
                  disabled={!pdfUploadFile || pdfUploadLoading || pdfUploadSaving}
                >
                  {pdfUploadLoading ? "Analisi Claude in corso..." : pdfUploadPreview ? "Rianalizza PDF" : "Analizza con Claude AI"}
                </button>
              </div>

              <div className="flex flex-col rounded-2xl border border-slate-200 bg-slate-50">
                {!pdfUploadPreview ? (
                  <div className="flex h-full min-h-[400px] flex-col items-center justify-center gap-3 text-center p-6">
                    <span className="text-4xl opacity-25">🤖</span>
                    <p className="text-sm font-medium text-slate-400">Seleziona un PDF e premi<br/><span className="text-slate-600">Analizza con Claude AI</span></p>
                    <p className="text-xs text-slate-400">I campi appariranno qui — potrai modificarli prima di salvare</p>
                  </div>
                ) : (
                  <div className="flex flex-col gap-0">
                    {/* Header risultato */}
                    <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-4 py-3">
                      <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-[11px] font-semibold text-emerald-700">✓ Estrazione completata</span>
                      {(pdfUploadPreview?.claude_extracted as Record<string,unknown> | undefined)?.agency ? (
                        <span className="rounded-full bg-sky-100 px-2.5 py-1 text-[11px] font-semibold text-sky-700">
                          {String((pdfUploadPreview.claude_extracted as Record<string,unknown>).agency)}
                        </span>
                      ) : null}
                      <span className="ml-auto text-xs text-slate-400">{pdfUploadFile?.name ?? "PDF"}</span>
                    </div>

                    {/* Form editabile */}
                    <div className="overflow-y-auto max-h-[480px] p-4 space-y-4">

                      {/* Cliente */}
                      <div>
                        <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">Cliente</p>
                        <div className="grid gap-2 sm:grid-cols-3">
                          <label className="sm:col-span-2 block text-xs font-medium text-slate-600">
                            Nome e cognome
                            <input className="mt-1 input-saas w-full" value={pdfEditForm.cliente_nome}
                              onChange={(e) => setPdfEditForm(p => ({ ...p, cliente_nome: e.target.value }))} />
                          </label>
                          <label className="block text-xs font-medium text-slate-600">
                            Cellulare
                            <input className="mt-1 input-saas w-full" value={pdfEditForm.cliente_cellulare}
                              onChange={(e) => setPdfEditForm(p => ({ ...p, cliente_cellulare: e.target.value }))} />
                          </label>
                        </div>
                      </div>

                      {/* Struttura + Tipo */}
                      <div>
                        <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">Struttura e servizio</p>
                        <div className="grid gap-2 sm:grid-cols-3">
                          <label className="sm:col-span-2 block text-xs font-medium text-slate-600">
                            Hotel / destinazione
                            <input className="mt-1 input-saas w-full" value={pdfEditForm.hotel}
                              onChange={(e) => setPdfEditForm(p => ({ ...p, hotel: e.target.value }))} />
                          </label>
                          <label className="block text-xs font-medium text-slate-600">
                            Passeggeri
                            <input type="number" min={1} max={99} className="mt-1 input-saas w-full" value={pdfEditForm.n_pax}
                              onChange={(e) => setPdfEditForm(p => ({ ...p, n_pax: e.target.value }))} />
                          </label>
                          <label className="sm:col-span-2 block text-xs font-medium text-slate-600">
                            Tipo servizio
                            <select className="mt-1 input-saas w-full" value={pdfEditForm.tipo_servizio}
                              onChange={(e) => setPdfEditForm(p => ({ ...p, tipo_servizio: e.target.value }))}>
                              {Object.entries(TIPO_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                            </select>
                          </label>
                          <label className="block text-xs font-medium text-slate-600">
                            Totale (€)
                            <input className="mt-1 input-saas w-full" value={pdfEditForm.totale_pratica}
                              onChange={(e) => setPdfEditForm(p => ({ ...p, totale_pratica: e.target.value }))} />
                          </label>
                        </div>
                      </div>

                      {/* Andata */}
                      <div>
                        <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">Andata (arrivo a Ischia)</p>
                        {pdfEditForm.tipo_servizio === "bus_city_hotel" && (
                          <label className="block text-xs font-medium text-slate-600 mb-2">
                            Fermata bus / Meeting point
                            <input className="mt-1 input-saas w-full" placeholder="Es. Largo Mazzoni difronte SMEA — Roma Tiburtina" value={pdfEditForm.citta_partenza}
                              onChange={(e) => setPdfEditForm(p => ({ ...p, citta_partenza: e.target.value }))} />
                          </label>
                        )}
                        <div className="grid gap-2 sm:grid-cols-4">
                          <label className="sm:col-span-2 block text-xs font-medium text-slate-600">
                            Data
                            <input type="date" className="mt-1 input-saas w-full" value={pdfEditForm.data_arrivo}
                              onChange={(e) => setPdfEditForm(p => ({ ...p, data_arrivo: e.target.value }))} />
                          </label>
                          <label className="block text-xs font-medium text-slate-600">
                            Ora
                            <input className="mt-1 input-saas w-full" placeholder="10:30" value={pdfEditForm.orario_arrivo}
                              onChange={(e) => setPdfEditForm(p => ({ ...p, orario_arrivo: e.target.value }))} />
                          </label>
                          {pdfEditForm.tipo_servizio !== "bus_city_hotel" && (
                          <label className="block text-xs font-medium text-slate-600">
                            N° mezzo
                            <input className="mt-1 input-saas w-full" placeholder="IC 730" value={pdfEditForm.treno_andata}
                              onChange={(e) => setPdfEditForm(p => ({ ...p, treno_andata: e.target.value }))} />
                          </label>
                          )}
                        </div>
                      </div>

                      {/* Ritorno */}
                      <div>
                        <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">Ritorno (partenza da Ischia)</p>
                        {pdfEditForm.tipo_servizio === "bus_city_hotel" && (
                          <div className="mb-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
                            <span className="font-medium text-slate-700">Fermata bus / Meeting point: </span>
                            {pdfEditForm.citta_partenza || <span className="italic">non specificata</span>}
                          </div>
                        )}
                        <div className="grid gap-2 sm:grid-cols-4">
                          <label className="sm:col-span-2 block text-xs font-medium text-slate-600">
                            Data
                            <input type="date" className="mt-1 input-saas w-full" value={pdfEditForm.data_partenza}
                              onChange={(e) => setPdfEditForm(p => ({ ...p, data_partenza: e.target.value }))} />
                          </label>
                          <label className="block text-xs font-medium text-slate-600">
                            Ora
                            <input className="mt-1 input-saas w-full" placeholder="08:00" value={pdfEditForm.orario_partenza}
                              onChange={(e) => setPdfEditForm(p => ({ ...p, orario_partenza: e.target.value }))} />
                          </label>
                          {pdfEditForm.tipo_servizio !== "bus_city_hotel" && (
                          <label className="block text-xs font-medium text-slate-600">
                            N° mezzo
                            <input className="mt-1 input-saas w-full" placeholder="IC 731" value={pdfEditForm.treno_ritorno}
                              onChange={(e) => setPdfEditForm(p => ({ ...p, treno_ritorno: e.target.value }))} />
                          </label>
                          )}
                        </div>
                      </div>

                      {/* Agenzia + Pratica */}
                      <div>
                        <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">Agenzia</p>
                        <div className="grid gap-2 sm:grid-cols-2">
                          <label className="block text-xs font-medium text-slate-600">
                            Nome agenzia
                            <input className="mt-1 input-saas w-full" value={pdfEditForm.agenzia}
                              onChange={(e) => setPdfEditForm(p => ({ ...p, agenzia: e.target.value }))} />
                          </label>
                          <label className="block text-xs font-medium text-slate-600">
                            N° pratica
                            <input className="mt-1 input-saas w-full" value={pdfEditForm.numero_pratica}
                              onChange={(e) => setPdfEditForm(p => ({ ...p, numero_pratica: e.target.value }))} />
                          </label>
                        </div>
                      </div>

                      {/* Note */}
                      <label className="block text-xs font-medium text-slate-600">
                        Note
                        <textarea rows={2} className="mt-1 input-saas w-full resize-none" value={pdfEditForm.note}
                          onChange={(e) => setPdfEditForm(p => ({ ...p, note: e.target.value }))} />
                      </label>

                    </div>

                    {/* Bottone conferma in fondo */}
                    <div className="border-t border-slate-200 p-4 space-y-2">
                      {pdfDuplicateWarning ? (
                        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
                          <p className="text-xs font-semibold text-amber-800">⚠ PDF già importato</p>
                          <p className="mt-0.5 text-xs text-amber-700">{pdfDuplicateWarning}</p>
                          <div className="mt-2 flex gap-2">
                            <button type="button" onClick={() => void createDraftFromUploadedPdf(true)}
                              className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700">
                              Salva comunque
                            </button>
                            <button type="button" onClick={() => setPdfDuplicateWarning(null)}
                              className="rounded-lg border border-amber-300 px-3 py-1.5 text-xs font-semibold text-amber-700 hover:bg-amber-100">
                              Annulla
                            </button>
                          </div>
                        </div>
                      ) : null}
                      {pdfUploadError ? (
                        <p className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{pdfUploadError}</p>
                      ) : null}
                      {!pdfDuplicateWarning ? (
                        <button
                          type="button"
                          onClick={() => void createDraftFromUploadedPdf()}
                          className="btn-primary w-full py-2.5 text-sm"
                          disabled={pdfUploadLoading || pdfUploadSaving}
                        >
                          {pdfUploadSaving ? "Salvataggio in corso..." : "✓ Conferma e crea servizio"}
                        </button>
                      ) : null}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
