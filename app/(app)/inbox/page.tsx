"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { DateInput } from "@/components/ui";
import { PdfAdvancedReview } from "@/components/pdf/PdfAdvancedReview";
import { getInboxPdfParsingSignal, isInboxPdfReviewOpen, isInboxPdfTestNoise } from "@/lib/pdf/parser";
import type { PdfImportDetail } from "@/lib/server/pdf-imports";
import { hasSupabaseEnv, supabase, getToken} from "@/lib/supabase/client";
import { ensureSupabaseClientReady, getClientSessionContext } from "@/lib/supabase/client-session";
import type { Hotel, InboundEmail, Membership, Service } from "@/lib/types";
import { bookingListTransportTimes } from "@/lib/booking-list-display";
import { derivePortCarrier, getPickupRule, listAvailableDepartures, normalizeZonaIschia } from "@/lib/departure-pickup-rules";
import { dedupeAppend } from "@/lib/collection-utils";

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
  pickup_hotel: string;
};

type GlobalBookingSearchResult = Partial<Service> & {
  id: string;
  date: string;
  time: string;
  status: Service["status"];
  direction: Service["direction"];
  pax: number;
  customer_name: string;
  phone: string | null;
  hotel_name?: string | null;
  owner_label?: string | null;
  cancellation?: {
    cancelled_at?: string | null;
    operator_name?: string | null;
    reason?: string | null;
    note?: string | null;
  } | null;
};

const CANCEL_REASONS = [
  "Cliente ha annullato",
  "Cliente ha modificato autonomamente",
  "Cambio data/orario",
  "Prenotazione duplicata",
  "Errore di inserimento",
  "Altro",
] as const;

const HARD_DELETE_REASONS = ["Prenotazione di test", "Inserimento errato", "Altro"] as const;

const EMPTY_FORM: FormState = {
  cliente_nome: "", cliente_cellulare: "", n_pax: "1",
  hotel: "", data_arrivo: "", orario_arrivo: "",
  data_partenza: "", orario_partenza: "",
  tipo_servizio: "transfer_station_hotel",
  treno_andata: "", treno_ritorno: "",
  citta_partenza: "", totale_pratica: "",
  note: "", numero_pratica: "", agenzia: "",
  pickup_hotel: "",
};

const TIPO_LABELS: Record<string, string> = {
  transfer_station_hotel: "Transfer Stazione / Hotel",
  transfer_airport_hotel: "Transfer Aeroporto / Hotel",
  transfer_port_hotel: "Transfer Porto / Hotel",
  bus_city_hotel: "Bus Città / Hotel",
  excursion: "Escursione"
};

// ─── Helpers ────────────────────────────────────────────────────────────────

// Prima guardava solo tipo_servizio, assumendo Medmar per ogni transfer
// porto<->hotel: un vettore SNAV estratto in treno_andata/treno_ritorno
// (vedi lo stesso criterio già usato in agency-aleste-viaggi.ts:673) veniva
// comunque etichettato "MEDMAR" nel badge/copia rapida, dato reale ignorato.
function isMedmar(form: FormState): boolean {
  const isPortTransfer = form.tipo_servizio === "transfer_port_hotel" || form.tipo_servizio === "transfer_hotel_port";
  if (!isPortTransfer) return false;
  const carrier = `${form.treno_andata} ${form.treno_ritorno}`.toUpperCase();
  return !carrier.includes("SNAV");
}

async function copyToClipboard(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; }
  catch { return false; }
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
    agenzia: f.agenzia ?? "",
    pickup_hotel: f.pickup_hotel ?? "",
  };
}

function text(value: unknown) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function serviceCustomerLabel(service: Pick<Service, "customer_name"> & Partial<Service>) {
  const joined = [service.customer_first_name, service.customer_last_name]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .join(" ");
  return service.customer_name?.trim() || joined || "Cliente N/D";
}

function isRecurringShuttleService(service: {
  booking_service_kind?: unknown;
  service_type_code?: unknown;
  route_kind?: unknown;
  vessel?: unknown;
}) {
  const markers = [
    service.booking_service_kind,
    service.service_type_code,
    service.route_kind,
    service.vessel,
  ].map((value) => (typeof value === "string" ? value.trim().toLowerCase() : ""));
  return markers.some((value) => value === "navetta" || value === "shuttle_hotel" || value === "shuttle");
}

function serviceOwnerLabel(service: Pick<Service, "agency_id" | "billing_party_name"> & Partial<Service>, agencyNameById: Map<string, string>) {
  return service.billing_party_name ?? (service.agency_id ? agencyNameById.get(service.agency_id) : null) ?? "Privato";
}

function formatShortTime(value: string | null | undefined) {
  return value ? value.slice(0, 5) : "";
}

function addIsoDays(isoDate: string, days: number) {
  const [year, month, day] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(year, (month ?? 1) - 1, day ?? 1));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
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
    agenzia: text(normalized.billing_party_name || normalized.agency_name),
    pickup_hotel: "",
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

// ─── Duplicati: tipi + helper UI ───────────────────────────────────────────
// Mirror di HydratedDuplicateMatch (lib/server/agency-pdf-import.ts).
type DupMatch = {
  service_id: string;
  match_reason: string;
  status: string;
  is_draft: boolean;
  customer_name: string | null;
  phone: string | null;
  date: string | null;
  pax: number | null;
  hotel_id: string | null;
  hotel_name: string | null;
  agency_name: string | null;
  billing_party_name: string | null;
  practice_number: string | null;
  outbound_time: string | null;
  return_time: string | null;
  arrival_time: string | null;
  departure_time: string | null;
  transport_code: string | null;
  notes: string | null;
};

type IncomingSummary = {
  customer_name: string;
  date: string;
  hotel: string;
  pax: string;
  phone: string;
  agency: string;
  practice_number: string;
  arrival_time: string;
  return_time: string;
  transport_code: string;
};

function incomingSummaryFromForm(f: FormState): IncomingSummary {
  const trains = [f.treno_andata, f.treno_ritorno].map((s) => (s ?? "").trim()).filter(Boolean).join(" / ");
  return {
    customer_name: (f.cliente_nome ?? "").trim(),
    date: (f.data_arrivo ?? "").trim(),
    hotel: (f.hotel ?? "").trim(),
    pax: (f.n_pax ?? "").trim(),
    phone: (f.cliente_cellulare ?? "").trim(),
    agency: (f.agenzia ?? "").trim(),
    practice_number: (f.numero_pratica ?? "").trim(),
    arrival_time: (f.orario_arrivo ?? "").trim(),
    return_time: (f.orario_partenza ?? "").trim(),
    transport_code: trains,
  };
}

const DUP_REASON_LABEL: Record<string, string> = {
  practice_number: "stesso numero pratica",
  phone: "stesso telefono",
  customer_name: "stesso nome cliente",
  pdf_hash: "stesso file PDF",
  pdf_text_hash: "stesso testo PDF",
  pdf_dedupe: "stessa chiave import",
  pdf_composite: "stesso cliente + data + hotel",
};

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
  const [hotelSuggestOpen, setHotelSuggestOpen] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);
  const [approvedServiceId, setApprovedServiceId] = useState<string | null>(null);
  const approvalInFlightRef = useRef(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [authRole, setAuthRole] = useState<import("@/lib/types").UserRole | null>(null);
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
  // Pannello "prenotazione già esistente" (MODIFICA / AGGIUNGI / ANNULLA).
  // Popolato quando /api/email/inbox-approve o /api/pdf/claude-save-draft
  // rispondono 409 { duplicate:true, matches:[...] }.
  const [dupModal, setDupModal] = useState<{
    source: "approve" | "pdf";
    matches: DupMatch[];
    certainId: string | null;
    incoming: IncomingSummary;
    form: FormState;
  } | null>(null);
  const [dupBusy, setDupBusy] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [agencyFilter, setAgencyFilter] = useState<string>("");
  const [agenciesMap, setAgenciesMap] = useState<Map<string, string>>(new Map());
  const [searchResults, setSearchResults] = useState<GlobalBookingSearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [bookingFilter, setBookingFilter] = useState<"all" | "today" | "tomorrow" | "week" | "arrival" | "departure" | "review">("all");
  const [expandedServiceId, setExpandedServiceId] = useState<string | null>(null);
  const [deletingServiceId, setDeletingServiceId] = useState<string | null>(null);
  const [cancelDialogService, setCancelDialogService] = useState<GlobalBookingSearchResult | null>(null);
  const [cancelReason, setCancelReason] = useState<(typeof CANCEL_REASONS)[number]>("Cliente ha annullato");
  const [cancelNote, setCancelNote] = useState("");
  // "leg" = solo la tratta selezionata; "practice" = intera pratica A/R (entrambe le gambe collegate da linked_service_id).
  const [cancelScope, setCancelScope] = useState<"leg" | "practice">("leg");
  const [cancellingServiceId, setCancellingServiceId] = useState<string | null>(null);
  const [hardDeleteDialogService, setHardDeleteDialogService] = useState<GlobalBookingSearchResult | null>(null);
  const [hardDeleteReason, setHardDeleteReason] = useState<(typeof HARD_DELETE_REASONS)[number]>("Prenotazione di test");
  const [hardDeleteNote, setHardDeleteNote] = useState("");
  const [hardDeleteConfirmStep, setHardDeleteConfirmStep] = useState<1 | 2>(1);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [aiUsageStats, setAiUsageStats] = useState<{
    month_cost_usd: number;
    month_cost_eur: number;
    last_import: { cost_usd: number; cost_eur: number; failed: boolean; created_at: string } | null;
  } | null>(null);
  const [emailsHasMore, setEmailsHasMore] = useState(false);
  const [loadingMoreEmails, setLoadingMoreEmails] = useState(false);
  const nextEmailPageRef = useRef(2);

  const handleCopy = (text: string, field: string) => {
    void copyToClipboard(text).then(() => {
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 1800);
    });
  };

  function setField(field: keyof FormState, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  // Suggerimento pickup/traghetto live per transfer_port_hotel (fix: prima
  // invisibile in Inbox — il calcolo esisteva solo server-side al momento
  // dell'approvazione, senza possibilità per l'operatore di vederlo/correggerlo
  // prima). Stessa regola esatta di app/api/email/inbox-approve/route.ts
  // (getPickupRule + derivePortCarrier), condivisa via lib/departure-pickup-rules.ts
  // — nessuna logica duplicata, solo eseguita anche qui per il preview.
  const portTransferCarrier = useMemo(
    () => derivePortCarrier(form.treno_ritorno) ?? derivePortCarrier(form.treno_andata),
    [form.treno_ritorno, form.treno_andata]
  );
  const portTransferZona = useMemo(() => {
    const match = hotels.find((h) => h.name.trim().toLowerCase() === form.hotel.trim().toLowerCase());
    return normalizeZonaIschia(match?.zone ?? null);
  }, [hotels, form.hotel]);
  const portTransferDepartures = useMemo(() => {
    if (form.tipo_servizio !== "transfer_port_hotel" || !portTransferCarrier) return [];
    return listAvailableDepartures(form.agenzia || "unknown", portTransferCarrier, portTransferZona);
  }, [form.tipo_servizio, form.agenzia, portTransferCarrier, portTransferZona]);
  const portTransferPickupSuggestion = useMemo(() => {
    if (form.tipo_servizio !== "transfer_port_hotel" || !portTransferCarrier || !form.orario_partenza) return null;
    return getPickupRule(form.agenzia || "unknown", portTransferCarrier, form.orario_partenza, portTransferZona);
  }, [form.tipo_servizio, form.agenzia, portTransferCarrier, form.orario_partenza, portTransferZona]);

  // Sprint Performance 11: Inbox usa la propria route leggera invece di
  // /api/ops/dispatch-data (pensata per il Dispatch: storico servizi, assignments,
  // vehicles, driver registry completi — dati che Inbox non usa, vedi audit).
  // loadData ricarica sempre la prima pagina (usata da boot, refresh import,
  // delete, approvazione, upload PDF); loadMoreEmails accoda le pagine successive.
  const loadData = async (token: string) => {
    const response = await fetch("/api/ops/inbox-data?page=1", {
      headers: { Authorization: `Bearer ${token}` }
    });
    const body = (await response.json().catch(() => null)) as {
      ok?: boolean; error?: string; tenant_id?: string;
      services?: unknown[]; hotels?: unknown[];
      drivers?: unknown[]; inbound_emails?: unknown[];
      has_more?: boolean;
    } | null;
    if (!response.ok || !body?.ok) throw new Error(String(body?.error ?? "Errore caricamento inbox."));

    setTenantId(typeof body.tenant_id === "string" ? body.tenant_id : null);
    setInboundEmails((body.inbound_emails ?? []) as InboundEmail[]);
    setServices((body.services ?? []) as Service[]);
    setHotels((body.hotels ?? []) as Hotel[]);
    setDrivers(((body.drivers ?? []) as Membership[]).filter((m) => m.role === "driver"));
    setEmailsHasMore(Boolean(body.has_more));
    nextEmailPageRef.current = 2;
    if ((body.inbound_emails ?? []).length > 0) {
      setSelectedId(((body.inbound_emails ?? []) as InboundEmail[])[0]?.id ?? null);
    }
  };

  const loadMoreEmails = async () => {
    if (!accessToken || loadingMoreEmails || !emailsHasMore) return;
    setLoadingMoreEmails(true);
    try {
      const page = nextEmailPageRef.current;
      const response = await fetch(`/api/ops/inbox-data?page=${page}`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      const body = (await response.json().catch(() => null)) as {
        ok?: boolean; error?: string;
        services?: unknown[]; inbound_emails?: unknown[]; has_more?: boolean;
      } | null;
      if (!response.ok || !body?.ok) {
        setMessage(String(body?.error ?? "Errore caricamento altre email."));
        return;
      }
      const newEmails = (body.inbound_emails ?? []) as InboundEmail[];
      setInboundEmails((current) => dedupeAppend(current, newEmails));
      const newServices = (body.services ?? []) as Service[];
      setServices((current) => dedupeAppend(current, newServices));
      setEmailsHasMore(Boolean(body.has_more));
      nextEmailPageRef.current = page + 1;
    } finally {
      setLoadingMoreEmails(false);
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
        const clientReady = await ensureSupabaseClientReady();
        if (!clientReady) throw new Error("Sessione non valida.");
        const supabaseSession = await supabase.auth.getSession();
        const token = supabaseSession.data.session?.access_token;
        if (!token) throw new Error("Sessione non valida.");
        setAccessToken(token);
        await loadData(token);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Errore caricamento inbox.");
      } finally {
        if (active) setHasLoadedInbox(true);
      }

      await loadAiUsageStats();
    };
    void boot();
    return () => { active = false; };
  }, []);

  // Costo AI: caricamento separato e non bloccante, la card resta vuota se fallisce.
  const loadAiUsageStats = async () => {
    if (!supabase) return;
    try {
      const supabaseSession = await supabase.auth.getSession();
      const token = supabaseSession.data.session?.access_token;
      if (!token) return;
      const response = await fetch("/api/ops/ai-usage-stats", {
        headers: { Authorization: `Bearer ${token}` }
      });
      const body = (await response.json().catch(() => null)) as {
        ok?: boolean;
        month_cost_usd?: number;
        month_cost_eur?: number;
        last_import?: { cost_usd: number; cost_eur: number; failed: boolean; created_at: string } | null;
      } | null;
      if (response.ok && body?.ok) {
        setAiUsageStats({
          month_cost_usd: body.month_cost_usd ?? 0,
          month_cost_eur: body.month_cost_eur ?? 0,
          last_import: body.last_import ?? null
        });
      }
    } catch {
      // Non bloccante: se fallisce, la card costo AI resta nascosta.
    }
  };

  useEffect(() => {
    if (!supabase || !tenantId) return;
    supabase.from("agencies").select("id, name").eq("tenant_id", tenantId)
      .then(({ data: rows }) => {
        if (rows) setAgenciesMap(new Map((rows as Array<{ id: string; name: string }>).map((a) => [a.id, a.name])));
      });
  }, [tenantId]);

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
      void loadAiUsageStats();
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
      const body = (await response.json().catch(() => null)) as {
        ok?: boolean; inbound_email_id?: string; duplicate?: boolean; error?: string;
        matches?: DupMatch[]; certain_service_id?: string | null;
      } | null;
      if (response.status === 409 && body?.duplicate) {
        if (Array.isArray(body.matches) && body.matches.length > 0) {
          // Stessa prenotazione da un altro canale → pannello MODIFICA/AGGIUNGI.
          setDupModal({
            source: "pdf",
            matches: body.matches,
            certainId: body.certain_service_id ?? null,
            incoming: incomingSummaryFromForm(pdfEditForm),
            form: pdfEditForm,
          });
        } else {
          // Solo pdf_hash: stesso identico file → avviso semplice esistente.
          setPdfDuplicateWarning(body.error ?? "PDF già importato.");
        }
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
  }, [selectedEmail]);

  const filteredInboundEmails = useMemo(() => {
    if (inboxFilter === "all") return inboundEmails;
    return inboundEmails.filter((email) => {
      const status = (email.parsed_json as Record<string, unknown>)?.review_status;
      const confirmed = status === "confirmed" || status === "ready_operational";
      const parsedJson = (email.parsed_json as Record<string, unknown>) ?? null;
      if (inboxFilter === "confirmed") return confirmed;
      if (confirmed) return false;
      // Pipeline IMAP+Claude (email-test-import.ts, source:"imap-claude") non usa
      // lo shape pdf_import su cui e' costruita isInboxPdfReviewOpen: senza questo
      // riconoscimento diretto, le email importate da quella pipeline restavano
      // invisibili sotto "Da approvare" (visibili solo in "Tutte", mai in nessuna
      // tab specifica) pur essendo genuinamente in attesa di revisione operatore.
      if (status === "needs_operator_review") return true;
      return !isInboxPdfTestNoise({ subject: email.subject, parsedJson }) && isInboxPdfReviewOpen(parsedJson);
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

  const hotelSuggestions = useMemo(() => {
    const query = form.hotel.trim().toLowerCase();
    if (!query) return [];
    return hotels.filter((h) => h.name.toLowerCase().includes(query)).slice(0, 8);
  }, [form.hotel, hotels]);
  const hotelExactMatch = hotels.some((h) => h.name.trim().toLowerCase() === form.hotel.trim().toLowerCase());

  useEffect(() => {
    const query = searchQuery.trim();
    const agency = agencyFilter.trim();
    if (!accessToken || (query.length < 1 && agency.length < 1)) {
      setSearchResults([]);
      setSearchLoading(false);
      setSearchError(null);
      return;
    }

    let active = true;
    setSearchLoading(true);
    setSearchError(null);
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ limit: "50" });
        if (query) params.set("q", query);
        if (agency) params.set("agency", agency);
        const res = await fetch(`/api/ops/search?${params.toString()}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        const body = (await res.json().catch(() => null)) as { ok?: boolean; results?: GlobalBookingSearchResult[]; error?: string } | null;
        if (active) {
          if (!res.ok || !body?.ok) {
            setSearchResults([]);
            setSearchError(body?.error ?? "Ricerca non disponibile.");
          } else {
            setSearchResults(body.results ?? []);
            setSearchError(null);
          }
        }
      } catch (searchRequestError) {
        if (active) {
          setSearchResults([]);
          setSearchError(searchRequestError instanceof Error ? searchRequestError.message : "Ricerca non disponibile.");
        }
      } finally {
        if (active) setSearchLoading(false);
      }
    }, 180);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [accessToken, searchQuery, agencyFilter]);

  const pdfUploadStatus = useMemo(() => {
    if (pdfUploadSaving) return "Salvataggio in corso...";
    if (pdfUploadLoading) return "Analisi Claude in corso...";
    if (pdfUploadPreview) return "Anteprima parser pronta.";
    if (pdfUploadFile) return `File selezionato: ${pdfUploadFile.name}`;
    return "Seleziona un PDF da importare.";
  }, [pdfUploadFile, pdfUploadLoading, pdfUploadPreview, pdfUploadSaving]);

  const refreshMailboxImports = async () => {
    if (!supabase || !tenantId) return;
    const token = await getToken();
    if (!token) { setMessage("Sessione non valida."); return; }
    setImportRefreshing(true);
    // force=1: l'operatore ha premuto "Aggiorna" esplicitamente, quindi
    // ignoriamo il cooldown (vuole un controllo reale ora). Il lock di
    // concorrenza resta comunque attivo: se un import è già in corso su
    // un'altra sessione, la richiesta torna "skipped_in_progress" senza
    // aprire una seconda connessione IMAP.
    const response = await fetch("/api/email/operational-import?force=1", {
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
    void loadAiUsageStats();
    setImportRefreshing(false);
    if (body?.status === "skipped_in_progress") {
      setMessage("Import email già in corso (avviato da un'altra sessione/scheduler). Riprova tra qualche secondo.");
    } else if (body?.status === "skipped_recent") {
      setMessage("Import email già eseguito da poco: nessuna nuova connessione aperta.");
    } else {
      setMessage(
        `Import eseguito. Email trovate: ${body?.unreadFound ?? 0}, PDF: ${body?.pdfFound ?? 0}, importate: ${body?.draftsCreated ?? 0}, duplicate: ${body?.duplicateWarnings ?? 0}.`
      );
    }
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

  const approveEmail = async (confirmDuplicate = false) => {
    if (!selectedEmail || !tenantId || approvalInFlightRef.current) return;
    approvalInFlightRef.current = true;
    const token = await getToken();
    if (!token) {
      approvalInFlightRef.current = false;
      setApproveError("Sessione scaduta.");
      return;
    }
    setSubmitting(true);
    setApproveError(null);
    try {
      const res = await fetch("/api/email/inbox-approve", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({
          inbound_email_id: selectedEmail.id,
          form,
          ...(confirmDuplicate ? { confirm_duplicate: true } : {}),
        })
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean; service_id?: string; error?: string;
        duplicate?: boolean; matches?: DupMatch[]; certain_service_id?: string | null;
      };
      if (res.status === 409 && body.duplicate && Array.isArray(body.matches) && body.matches.length > 0) {
        setDupModal({
          source: "approve",
          matches: body.matches,
          certainId: body.certain_service_id ?? null,
          incoming: incomingSummaryFromForm(form),
          form,
        });
        return;
      }
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
      approvalInFlightRef.current = false;
      setSubmitting(false);
    }
  };

  // ── Azioni pannello duplicati ──────────────────────────────────────────────
  const dupAddAnyway = async () => {
    if (!dupModal || dupBusy) return;
    setDupBusy(true);
    try {
      const src = dupModal.source;
      setDupModal(null);
      if (src === "approve") {
        await approveEmail(true);
      } else {
        await createDraftFromUploadedPdf(true);
      }
    } finally {
      setDupBusy(false);
    }
  };

  const dupModifyExisting = async (matchId: string) => {
    if (!dupModal || dupBusy) return;
    setDupBusy(true);
    setApproveError(null);
    try {
      const token = await getToken();
      if (!token) { setApproveError("Sessione non valida."); return; }
      const f = dupModal.form;
      const match = dupModal.matches.find((m) => m.service_id === matchId) ?? null;

      // Solo campi realmente presenti nella nuova comunicazione: mai null/"".
      const patch: Record<string, unknown> = {};
      const put = (key: string, value: string | null | undefined) => {
        const s = (value ?? "").trim();
        if (s) patch[key] = s;
      };
      put("customer_name", f.cliente_nome);
      put("phone", f.cliente_cellulare);
      const paxNum = Number(f.n_pax);
      if (Number.isFinite(paxNum) && paxNum > 0) patch.pax = Math.min(999, Math.trunc(paxNum));
      put("time", f.orario_arrivo);
      put("arrival_time", f.orario_arrivo);
      put("departure_time", f.orario_partenza);
      put("arrival_date", f.data_arrivo);
      put("departure_date", f.data_partenza);
      put("meeting_point", f.citta_partenza);
      const trains = [f.treno_andata, f.treno_ritorno].map((s) => (s ?? "").trim()).filter(Boolean).join(" / ");
      if (trains) patch.transport_code = trains;
      // Numero pratica: vive nel marker [practice:...] dentro notes → swap mirato.
      const newPractice = (f.numero_pratica ?? "").trim();
      if (newPractice && match?.notes) {
        patch.notes = /\[practice:[^\]]+\]/.test(match.notes)
          ? match.notes.replace(/\[practice:[^\]]+\]/, `[practice:${newPractice}]`)
          : `${match.notes} | [practice:${newPractice}]`;
      }

      const patchRes = await fetch(`/api/ops/services/${matchId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(patch),
      });
      if (!patchRes.ok) {
        const pb = (await patchRes.json().catch(() => null)) as { error?: string } | null;
        setApproveError(pb?.error ?? `Modifica non riuscita (HTTP ${patchRes.status}).`);
        return;
      }

      // Flusso email: collega la email al servizio esistente (nessun INSERT).
      if (dupModal.source === "approve" && selectedEmail) {
        await fetch("/api/email/inbox-approve", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ inbound_email_id: selectedEmail.id, form: f, link_to_service_id: matchId }),
        });
      }

      await loadData(token);
      if (dupModal.source === "pdf") setPdfUploadOpen(false);
      setDupModal(null);
      setMessage("Prenotazione esistente aggiornata con i dati della nuova comunicazione.");
    } catch (e) {
      setApproveError(e instanceof Error ? e.message : "Errore di rete.");
    } finally {
      setDupBusy(false);
    }
  };

  const openCancelDialog = (service: GlobalBookingSearchResult) => {
    setCancelDialogService(service);
    setCancelReason("Cliente ha annullato");
    setCancelNote("");
    setCancelScope("leg");
  };

  const cancelBooking = async () => {
    if (!cancelDialogService || cancellingServiceId) return;
    const customer = serviceCustomerLabel(cancelDialogService);
    const token = await getToken();
    if (!token) { setMessage("Sessione scaduta."); return; }
    setCancellingServiceId(cancelDialogService.id);
    try {
      const res = await fetch(`/api/ops/services/${cancelDialogService.id}/cancel`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ reason: cancelReason, note: cancelNote, scope: cancelScope }),
      });
      const body = (await res.json().catch(() => null)) as {
        error?: string;
        cancelled_at?: string;
        operator_name?: string | null;
        reason?: string | null;
        note?: string | null;
        service_ids?: string[];
      } | null;
      if (!res.ok) {
        setMessage(body?.error ?? "Cancellazione prenotazione non riuscita.");
        return;
      }
      const cancellation = {
        cancelled_at: body?.cancelled_at ?? new Date().toISOString(),
        operator_name: body?.operator_name ?? null,
        reason: body?.reason ?? cancelReason,
        note: body?.note ?? (cancelNote.trim() || null),
      };
      // service_ids include entrambe le gambe quando scope="practice" (RPC atomica lato server):
      // aggiorna localmente OGNI id restituito, non solo quello selezionato in dialogo.
      const affectedIds = new Set(body?.service_ids?.length ? body.service_ids : [cancelDialogService.id]);
      setSearchResults((current) => current.map((row) => affectedIds.has(row.id) ? { ...row, status: "cancelled", cancellation } : row));
      setServices((current) => current.map((row) => affectedIds.has(row.id) ? { ...row, status: "cancelled" } : row));
      setCancelDialogService(null);
      setMessage(
        cancelScope === "practice"
          ? `Pratica A/R di ${customer} cancellata operativamente (entrambe le tratte).`
          : `Prenotazione di ${customer} cancellata operativamente.`
      );
    } finally {
      setCancellingServiceId(null);
    }
  };

  const openHardDeleteDialog = (service: GlobalBookingSearchResult) => {
    setHardDeleteDialogService(service);
    setHardDeleteReason("Prenotazione di test");
    setHardDeleteNote("");
    setHardDeleteConfirmStep(1);
  };

  const hardDeleteBooking = async () => {
    if (!hardDeleteDialogService || deletingServiceId) return;
    if (authRole !== "admin" && authRole !== "supervisor") return;
    if (hardDeleteConfirmStep === 1) {
      setHardDeleteConfirmStep(2);
      return;
    }
    const customer = serviceCustomerLabel(hardDeleteDialogService);
    const token = await getToken();
    if (!token) { setMessage("Sessione scaduta."); return; }
    setDeletingServiceId(hardDeleteDialogService.id);
    try {
      const res = await fetch(`/api/ops/services/${hardDeleteDialogService.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          reason: hardDeleteReason,
          note: hardDeleteNote,
          confirmation: "ELIMINA_DEFINITIVAMENTE",
        }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setMessage(body?.error ?? "Eliminazione definitiva non riuscita.");
        return;
      }
      setSearchResults((current) => current.filter((row) => row.id !== hardDeleteDialogService.id));
      setServices((current) => current.filter((row) => row.id !== hardDeleteDialogService.id));
      setHardDeleteDialogService(null);
      setMessage(`Prenotazione di ${customer} eliminata definitivamente.`);
    } finally {
      setDeletingServiceId(null);
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

  const today = new Date().toISOString().slice(0, 10);
  const activeServices = services.filter((service) => service.status !== "cancelled" && !service.is_draft && !isRecurringShuttleService(service));
  const todayServices = activeServices.filter((service) => service.date === today);
  const arrivalCount = todayServices.filter((service) => service.direction === "arrival").length;
  const departureCount = todayServices.filter((service) => service.direction === "departure").length;
  const reviewCount = inboundEmails.filter((email) => {
    const parsedJson = (email.parsed_json as Record<string, unknown>) ?? null;
    return !isInboxPdfTestNoise({ subject: email.subject, parsedJson }) && isInboxPdfReviewOpen(parsedJson);
  }).length;
  const tomorrow = addIsoDays(today, 1);
  const weekEnd = addIsoDays(today, 7);
  const hasBookingSearch = Boolean(searchQuery.trim() || agencyFilter.trim());
  const bookingSource: GlobalBookingSearchResult[] = hasBookingSearch
    ? searchResults.filter((service) => !isRecurringShuttleService(service))
    : [];
  const visibleBookings = bookingSource.filter((service) => {
    const serviceDate = service.arrival_date ?? service.departure_date ?? service.date;
    if (bookingFilter === "today") return serviceDate === today;
    if (bookingFilter === "tomorrow") return serviceDate === tomorrow;
    if (bookingFilter === "week") return serviceDate >= today && serviceDate <= weekEnd;
    if (bookingFilter === "arrival") return service.direction === "arrival";
    if (bookingFilter === "departure") return service.direction === "departure";
    if (bookingFilter === "review") return service.status === "needs_review" || service.status === "new";
    return true;
  }).slice(0, 30);

  return (
    <section className="mx-auto max-w-[1400px] space-y-5" data-testid="pdf-imports-page">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold flex-1">Prenotazioni</h1>
        <Link href="/services/new" className="btn-primary px-4 py-2 text-sm">
          + Nuova prenotazione
        </Link>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {[
          { label: "Oggi", value: todayServices.length, tone: "bg-blue-50 text-blue-700", icon: "▣" },
          { label: "Arrivi", value: arrivalCount, tone: "bg-emerald-50 text-emerald-700", icon: "↓" },
          { label: "Partenze", value: departureCount, tone: "bg-violet-50 text-violet-700", icon: "↑" },
          { label: "Da verificare", value: reviewCount, tone: "bg-amber-50 text-amber-700", icon: "◷" },
          { label: "Totale attive", value: activeServices.length, tone: "bg-rose-50 text-rose-700", icon: "◎" },
        ].map((item) => (
          <article key={item.label} className="pms-panel flex items-center gap-3 p-4">
            <span className={`inline-flex h-11 w-11 items-center justify-center rounded-xl text-xl font-bold ${item.tone}`}>{item.icon}</span>
            <div>
              <p className="text-xs font-semibold text-slate-500">{item.label}</p>
              <p className="text-2xl font-extrabold leading-tight text-slate-950">{item.value}</p>
            </div>
          </article>
        ))}
      </div>

      {aiUsageStats ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <article className="pms-panel flex items-center gap-3 p-4">
            <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-xl font-bold text-indigo-700">🤖</span>
            <div>
              <p className="text-xs font-semibold text-slate-500">Costo AI mese corrente</p>
              <p className="text-2xl font-extrabold leading-tight text-slate-950">
                €{aiUsageStats.month_cost_eur.toFixed(2)}
                <span className="ml-1.5 text-sm font-medium text-slate-400">(${aiUsageStats.month_cost_usd.toFixed(2)})</span>
              </p>
            </div>
          </article>
          <article className="pms-panel flex items-center gap-3 p-4">
            <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-teal-50 text-xl font-bold text-teal-700">📄</span>
            <div>
              <p className="text-xs font-semibold text-slate-500">Costo ultima importazione AI</p>
              <p className="text-2xl font-extrabold leading-tight text-slate-950">
                {aiUsageStats.last_import ? (
                  aiUsageStats.last_import.failed ? (
                    <span className="text-rose-600">Fallita</span>
                  ) : (
                    <>
                      €{aiUsageStats.last_import.cost_eur.toFixed(4)}
                      <span className="ml-1.5 text-sm font-medium text-slate-400">(${aiUsageStats.last_import.cost_usd.toFixed(4)})</span>
                    </>
                  )
                ) : (
                  "—"
                )}
              </p>
            </div>
          </article>
        </div>
      ) : null}

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="min-w-0 flex-1">
          <input type="text" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Cerca per nome, codice prenotazione, telefono, hotel, agenzia..." className="input-saas w-full" />
        </div>
        <div className="flex flex-wrap gap-2">
          {([
            ["today", "Oggi"], ["tomorrow", "Domani"], ["week", "Questa settimana"],
            ["arrival", "Arrivi"], ["departure", "Partenze"], ["review", "Da verificare"], ["all", "Filtri"],
          ] as const).map(([value, label]) => (
            <button key={value} type="button" onClick={() => setBookingFilter(value)}
              className={bookingFilter === value ? "btn-primary px-4 py-2 text-sm" : "btn-secondary px-4 py-2 text-sm"}>{label}</button>
          ))}
        </div>
      </div>

      <div className="space-y-3">
        {searchLoading ? <div className="pms-panel p-6 text-sm text-slate-500">Ricerca in corso...</div> : null}
        {!searchLoading && searchError ? <div className="pms-panel border border-rose-200 bg-rose-50 p-6 text-sm text-rose-700">Errore ricerca: {searchError}</div> : null}
        {!searchLoading && !searchError && !hasBookingSearch ? <div className="pms-panel p-8 text-center text-sm text-slate-500">Cerca una prenotazione per nome, codice, telefono, hotel o agenzia.</div> : null}
        {!searchLoading && !searchError && hasBookingSearch && visibleBookings.length === 0 ? <div className="pms-panel p-8 text-center text-sm text-slate-500">Nessuna prenotazione trovata.</div> : null}
        {!searchLoading && visibleBookings.map((service, index) => {
          const expanded = expandedServiceId === service.id || (expandedServiceId === null && index === 0);
          const transportTimes = bookingListTransportTimes(service);
          const hotelName = service.hotel_name?.trim() || hotels.find((hotel) => hotel.id === service.hotel_id)?.name || "Struttura non indicata";
          const isCancelled = service.status === "cancelled";
          const statusOk = ["completato", "arrivato", "assigned"].includes(service.status);
          const canHardDelete = authRole === "admin" || authRole === "supervisor";
          return (
            <article key={service.id} className="pms-panel overflow-hidden">
              <div className={`grid items-center gap-4 p-4 ${expanded ? "lg:grid-cols-[minmax(0,1fr)_190px]" : "lg:grid-cols-[minmax(280px,1fr)_1fr_1fr_auto]"}`}>
                <div className="flex min-w-0 items-start gap-3">
                  <button type="button" onClick={() => setExpandedServiceId(expanded ? "" : service.id)} className="mt-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-slate-200 text-slate-600">{expanded ? "⌃" : "⌄"}</button>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2"><p className="font-extrabold text-slate-900">{serviceCustomerLabel(service)}</p><span className="rounded bg-slate-100 px-2 py-1 font-mono text-[10px] text-slate-500">#{service.id.slice(0, 8).toUpperCase()}</span>{service.booking_service_kind === "bus_city_hotel" ? <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-700">🚌 Bus</span> : null}{isCancelled ? <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-bold text-rose-700">CANCELLATA</span> : null}</div>
                    <p className="mt-1 text-xs text-slate-500">☎ {service.phone || "—"}　·　{service.pax} pax　 <span className="font-bold text-indigo-600">{service.owner_label ?? serviceOwnerLabel(service, agenciesMap)}</span></p>
                    <p className="mt-1 text-xs font-semibold text-slate-700">Hotel: {hotelName}</p>
                    {isCancelled ? <p className="mt-1 text-xs text-rose-700">Cancellata{service.cancellation?.cancelled_at ? ` il ${new Intl.DateTimeFormat("it-IT", { dateStyle: "short", timeStyle: "short" }).format(new Date(service.cancellation.cancelled_at))}` : ""}{service.cancellation?.operator_name ? ` da ${service.cancellation.operator_name}` : ""}{service.cancellation?.reason ? ` - ${service.cancellation.reason}` : ""}{service.cancellation?.note ? ` (${service.cancellation.note})` : ""}</p> : null}
                  </div>
                </div>
                {!expanded && <><p className="text-xs text-slate-600"><strong className="text-blue-700">Arrivo</strong>　{transportTimes?.outwardDate ?? service.arrival_date ?? service.date}<br />{transportTimes?.outwardLabel}: {transportTimes?.outwardTime ?? service.arrival_time ?? "—"}</p><p className="text-xs text-slate-600"><strong className="text-violet-700">Partenza</strong>　{transportTimes?.returnDate ?? service.departure_date ?? "—"}<br />Pickup {transportTimes?.returnPickupTime ?? service.departure_time ?? "—"}</p></>}
                <div className={expanded ? "text-right" : "flex items-center justify-end gap-2"}>
                  <span className={`rounded-full px-3 py-1 text-[11px] font-semibold ${isCancelled ? "bg-rose-100 text-rose-700" : statusOk ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>{isCancelled ? "CANCELLATA" : service.status}</span>
                  {!expanded ? <Link href={`/services/${service.id}/edit`} className="btn-secondary px-3 py-2 text-xs">Dettagli</Link> : null}
                </div>
              </div>
              {expanded ? (
                <div className="grid gap-4 border-t border-slate-100 px-4 pb-4 pt-1 lg:grid-cols-[minmax(0,1fr)_190px]">
                  <div className="grid overflow-hidden rounded-xl border border-slate-200 md:grid-cols-2">
                    <div className="space-y-2 bg-blue-50/50 p-5 text-sm text-slate-700"><p className="font-extrabold text-blue-700">↓　ARRIVO</p><p>▣　{transportTimes?.outwardDate ?? service.arrival_date ?? service.date}</p><p>◷　{transportTimes?.outwardLabel}: <strong>{transportTimes?.outwardTime ?? "—"}</strong></p>{transportTimes?.outwardPickupPoint ? <p>⌖　Punto di carico: <strong>{transportTimes.outwardPickupPoint}</strong></p> : null}{transportTimes?.outwardArrivalTime ? <p>◷　Arrivo indicativo: <strong>{transportTimes.outwardArrivalTime}</strong></p> : null}{transportTimes?.outwardCompany ? <p>⚓　Compagnia: <strong>{transportTimes.outwardCompany}</strong></p> : null}{transportTimes?.outwardRoute ? <p>↔　Tratta nave: <strong>{transportTimes.outwardRoute}</strong></p> : null}{transportTimes?.outwardArrivalPort ? <p>⌖　Porto di arrivo: <strong>{transportTimes.outwardArrivalPort}</strong></p> : null}<p>⌖　{hotelName}</p></div>
                    <div className="space-y-2 border-l border-slate-200 bg-violet-50/50 p-5 text-sm text-slate-700"><p className="font-extrabold text-violet-700">↑　PARTENZA</p><p>▣　{transportTimes?.returnDate ?? service.departure_date ?? "—"}</p><p>◷　Pickup hotel: <strong>{transportTimes?.returnPickupTime ?? "—"}</strong></p><p>◷　{transportTimes?.returnLabel}: <strong>{transportTimes?.returnTime ?? "—"}</strong></p>{transportTimes?.returnCompany ? <p>⚓　Compagnia: <strong>{transportTimes.returnCompany}</strong></p> : null}{transportTimes?.returnRoute ? <p>↔　Tratta nave: <strong>{transportTimes.returnRoute}</strong></p> : null}{transportTimes?.returnDeparturePort ? <p>⌖　Porto di partenza: <strong>{transportTimes.returnDeparturePort}</strong></p> : null}</div>
                  </div>
                  <div className="flex flex-col gap-2 border-l border-slate-200 pl-4"><Link href={`/services/${service.id}/edit`} className="btn-primary">Dettagli</Link>{!isCancelled ? <Link href={`/services/${service.id}/edit`} className="btn-secondary">✎ Modifica</Link> : null}{!isCancelled ? <Link href={`/dispatch?q=${encodeURIComponent(serviceCustomerLabel(service))}&date=${encodeURIComponent(service.date)}`} className="btn-secondary flex min-h-[42px] items-center justify-center text-center">⇄ Cambio operativo</Link> : null}{!isCancelled ? <button type="button" onClick={() => openCancelDialog(service)} disabled={cancellingServiceId !== null} className="btn-secondary text-rose-600">{cancellingServiceId === service.id ? "Cancello..." : "Cancella prenotazione"}</button> : null}{canHardDelete ? <button type="button" onClick={() => openHardDeleteDialog(service)} disabled={deletingServiceId !== null} className="btn-secondary text-rose-700">{deletingServiceId === service.id ? "Elimino..." : "Elimina definitivamente"}</button> : null}</div>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>

      {cancelDialogService ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4">
          <div className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-2xl">
            <h2 className="text-lg font-extrabold text-slate-950">Cancella prenotazione</h2>
            <p className="mt-1 text-sm text-slate-600">
              La pratica di {serviceCustomerLabel(cancelDialogService)} resterà nello storico e sarà esclusa dalle operazioni attive.
            </p>
            {cancelDialogService.linked_service_id ? (
              <div className="mt-4 space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
                <p className="text-sm font-semibold text-slate-700">
                  {cancelDialogService.practice_number ? `Pratica A/R ${cancelDialogService.practice_number}` : "Prenotazione andata/ritorno"} — cosa vuoi cancellare?
                </p>
                <label className="flex items-start gap-2 text-sm text-slate-700">
                  <input type="radio" name="cancel-scope" className="mt-1" checked={cancelScope === "leg"} onChange={() => setCancelScope("leg")} />
                  <span>
                    <span className="block font-semibold">Cancella solo questa tratta</span>
                    <span className="block text-xs text-slate-500">L&apos;altra tratta della stessa pratica resta invariata.</span>
                  </span>
                </label>
                <label className="flex items-start gap-2 text-sm text-slate-700">
                  <input type="radio" name="cancel-scope" className="mt-1" checked={cancelScope === "practice"} onChange={() => setCancelScope("practice")} />
                  <span>
                    <span className="block font-semibold">Cancella intera pratica A/R</span>
                    <span className="block text-xs text-slate-500">Cancella sia andata sia ritorno.</span>
                  </span>
                </label>
              </div>
            ) : null}
            <label className="mt-4 block text-sm font-semibold text-slate-700">
              Motivo*
              <select value={cancelReason} onChange={(event) => setCancelReason(event.target.value as (typeof CANCEL_REASONS)[number])} className="input-saas mt-1 w-full">
                {CANCEL_REASONS.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
              </select>
            </label>
            <label className="mt-3 block text-sm font-semibold text-slate-700">
              Note
              <textarea value={cancelNote} onChange={(event) => setCancelNote(event.target.value)} className="input-saas mt-1 min-h-[90px] w-full" placeholder="Dettaglio facoltativo..." />
            </label>
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button type="button" className="btn-secondary px-4 py-2 text-sm" onClick={() => setCancelDialogService(null)} disabled={cancellingServiceId !== null}>Annulla</button>
              <button type="button" className="btn-primary bg-rose-600 px-4 py-2 text-sm hover:bg-rose-700" onClick={() => void cancelBooking()} disabled={cancellingServiceId !== null}>
                {cancellingServiceId === cancelDialogService.id ? "Cancellazione..." : "Ok, risolto / cancella"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {hardDeleteDialogService ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4">
          <div className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-2xl">
            <h2 className="text-lg font-extrabold text-slate-950">Elimina definitivamente</h2>
            <p className="mt-1 text-sm text-rose-700">
              Questa azione rimuove la pratica di {serviceCustomerLabel(hardDeleteDialogService)} dal database operativo. Usa questa opzione solo per test o inserimenti errati.
            </p>
            <label className="mt-4 block text-sm font-semibold text-slate-700">
              Motivo*
              <select value={hardDeleteReason} onChange={(event) => setHardDeleteReason(event.target.value as (typeof HARD_DELETE_REASONS)[number])} className="input-saas mt-1 w-full">
                {HARD_DELETE_REASONS.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
              </select>
            </label>
            <label className="mt-3 block text-sm font-semibold text-slate-700">
              Note
              <textarea value={hardDeleteNote} onChange={(event) => setHardDeleteNote(event.target.value)} className="input-saas mt-1 min-h-[90px] w-full" placeholder={hardDeleteReason === "Altro" ? "Obbligatorio per Altro..." : "Dettaglio facoltativo..."} />
            </label>
            {hardDeleteConfirmStep === 2 ? (
              <p className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-800">
                Conferma finale: dopo questo click la prenotazione verrà eliminata definitivamente.
              </p>
            ) : null}
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button type="button" className="btn-secondary px-4 py-2 text-sm" onClick={() => setHardDeleteDialogService(null)} disabled={deletingServiceId !== null}>Annulla</button>
              <button type="button" className="btn-primary bg-rose-600 px-4 py-2 text-sm hover:bg-rose-700" onClick={() => void hardDeleteBooking()} disabled={deletingServiceId !== null}>
                {deletingServiceId === hardDeleteDialogService.id ? "Eliminazione..." : hardDeleteConfirmStep === 1 ? "Continua" : "Elimina definitivamente"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

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
          <button type="button" onClick={openPdfUploadModal} className="inbox-import-pill" data-testid="pdf-upload-open">
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
              const needsParsingReview = !isInboxPdfTestNoise({ subject: email.subject, parsedJson: pj }) && isInboxPdfReviewOpen(pj);
              return (
                <button key={email.id} type="button" onClick={() => setSelectedId(email.id)}
                  data-testid={`pdf-import-row-${email.id}`}
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
          {emailsHasMore ? (
            <button type="button" onClick={() => void loadMoreEmails()} disabled={loadingMoreEmails}
              className="btn-secondary w-full py-2 text-xs disabled:opacity-50">
              {loadingMoreEmails ? "Carico..." : "Carica altre"}
            </button>
          ) : null}
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
                    <p className="mt-1 text-xs">Servizio: {serviceCustomerLabel(linkedService)} · {linkedService.date}</p>
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
                    <button type="button" onClick={() => void openPdfAdvancedReview()} className="btn-secondary ml-auto px-3 py-1.5 text-xs" data-testid="pdf-review-open">
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
                      <label className="relative text-xs font-medium text-slate-600 sm:col-span-2">
                        Hotel *
                        <input value={form.hotel}
                          onChange={(e) => { setField("hotel", e.target.value); setHotelSuggestOpen(true); }}
                          onFocus={() => setHotelSuggestOpen(true)}
                          onBlur={() => setTimeout(() => setHotelSuggestOpen(false), 150)}
                          autoComplete="off"
                          className={`mt-1 input-saas w-full ${!form.hotel ? "border-amber-300 bg-amber-50" : ""}`}
                          placeholder="Nome hotel" />
                        {hotelSuggestOpen && form.hotel.trim() !== "" && (
                          <div className="absolute z-10 mt-1 w-full rounded-lg border border-slate-200 bg-white p-1 shadow-lg">
                            {hotelSuggestions.length > 0 ? (
                              hotelSuggestions.map((h) => (
                                <button key={h.id} type="button"
                                  onMouseDown={(e) => e.preventDefault()}
                                  onClick={() => { setField("hotel", h.name); setHotelSuggestOpen(false); }}
                                  className="block w-full rounded-md px-2 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-100">
                                  {h.name}
                                </button>
                              ))
                            ) : !hotelExactMatch ? (
                              <p className="px-2 py-1.5 text-xs text-slate-500">
                                Nessun hotel esistente trovato — verrà creato automaticamente <strong>&quot;{form.hotel.trim()}&quot;</strong> al momento dell&apos;approvazione.
                              </p>
                            ) : null}
                          </div>
                        )}
                      </label>
                      <label className="text-xs font-medium text-slate-600">
                        Data arrivo *
                        <DateInput value={toDateValue(form.data_arrivo)}
                          onChange={(iso) => setField("data_arrivo", iso)}
                          className={`mt-1 input-saas w-full ${!form.data_arrivo ? "border-amber-300 bg-amber-50" : ""}`} />
                      </label>
                      <label className="text-xs font-medium text-slate-600">
                        Orario arrivo
                        <input value={form.orario_arrivo} onChange={(e) => setField("orario_arrivo", e.target.value)}
                          className="mt-1 input-saas w-full" placeholder="HH:MM" />
                      </label>
                      <label className="text-xs font-medium text-slate-600">
                        Data partenza
                        <DateInput value={toDateValue(form.data_partenza)}
                          onChange={(iso) => setField("data_partenza", iso)}
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

                    {form.tipo_servizio === "transfer_port_hotel" && (
                      <div className="mt-1 grid gap-3 rounded-lg border border-slate-100 bg-slate-50 p-3 sm:grid-cols-2">
                        <label className="text-xs font-medium text-slate-600">
                          Traghetto
                          {portTransferCarrier ? (
                            portTransferDepartures.length > 0 ? (
                              <select
                                className="mt-1 input-saas w-full"
                                value={form.orario_partenza}
                                onChange={(e) => setField("orario_partenza", e.target.value)}
                              >
                                <option value="">— Seleziona corsa —</option>
                                {portTransferDepartures.map((rule) => (
                                  <option key={`${rule.t_from}-${rule.pickup}`} value={rule.t_from}>
                                    {rule.boat_co} {rule.t_from} ({rule.porto_p} → {rule.porto_a}) — pickup {rule.pickup}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <p className="mt-1 text-xs text-amber-600">
                                Compagnia {portTransferCarrier.toUpperCase()} rilevata, ma nessuna corsa nota per la zona{" "}
                                {form.hotel ? `dell'hotel "${form.hotel}"` : "(imposta prima l'hotel)"}.
                              </p>
                            )
                          ) : (
                            <p className="mt-1 text-xs text-slate-500">
                              Nessuna compagnia rilevata da N. mezzo andata/ritorno (cerca &quot;SNAV&quot; o &quot;MEDMAR&quot;).
                            </p>
                          )}
                        </label>
                        <label className="text-xs font-medium text-slate-600">
                          Orario pickup hotel
                          <div className="mt-1 flex gap-1">
                            <input
                              value={form.pickup_hotel}
                              onChange={(e) => setField("pickup_hotel", e.target.value)}
                              className="input-saas flex-1"
                              placeholder="HH:MM"
                            />
                            {portTransferPickupSuggestion?.pickup && form.pickup_hotel !== portTransferPickupSuggestion.pickup ? (
                              <button
                                type="button"
                                onClick={() => setField("pickup_hotel", portTransferPickupSuggestion.pickup)}
                                title="Usa il pickup suggerito"
                                className="whitespace-nowrap rounded-lg border border-emerald-300 bg-emerald-50 px-2 text-xs font-medium text-emerald-700 hover:bg-emerald-100"
                              >
                                Usa {portTransferPickupSuggestion.pickup}
                              </button>
                            ) : null}
                          </div>
                          {!form.pickup_hotel && !portTransferPickupSuggestion ? (
                            <p className="mt-1 text-xs text-slate-500">
                              Nessun suggerimento automatico (orario partenza non coincide con una corsa nota) — inserisci l&apos;orario manualmente.
                            </p>
                          ) : null}
                        </label>
                      </div>
                    )}
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
                <DateInput value={escursioneDate}
                  onChange={async (iso) => {
                    setEscursioneDate(iso);
                    const token = await getToken();
                    if (!token) return;
                    const res = await fetch(`/api/ops/escursioni?date=${iso}`, { headers: { Authorization: `Bearer ${token}` } });
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
                    data-testid="pdf-upload-input"
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
                <p className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600" data-testid="pdf-upload-status">
                  {pdfUploadStatus}
                </p>

                <button
                  type="button"
                  onClick={() => void previewUploadedPdf()}
                  className="btn-primary w-full py-2.5 text-sm"
                  data-testid="pdf-upload-preview"
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
                            <DateInput className="mt-1 input-saas w-full" value={pdfEditForm.data_arrivo}
                              onChange={(iso) => setPdfEditForm(p => ({ ...p, data_arrivo: iso }))} />
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
                            <DateInput className="mt-1 input-saas w-full" value={pdfEditForm.data_partenza}
                              onChange={(iso) => setPdfEditForm(p => ({ ...p, data_partenza: iso }))} />
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
                          data-testid="pdf-upload-draft"
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

      {/* ── Pannello "prenotazione già esistente": MODIFICA / AGGIUNGI / ANNULLA ── */}
      {dupModal ? (() => {
        const single = dupModal.matches.length === 1 ? dupModal.matches[0] : null;
        const inc = dupModal.incoming;
        const diffRow = (label: string, oldV: string | null | undefined, newV: string | null | undefined) => {
          const o = (oldV ?? "").trim();
          const n = (newV ?? "").trim();
          if (!o && !n) return null;
          const changed = n !== "" && o !== n;
          return (
            <div key={label} className={`grid grid-cols-[110px_1fr_1fr] gap-2 px-3 py-1.5 text-xs ${changed ? "bg-amber-50" : ""}`}>
              <span className="font-semibold text-slate-500">{label}</span>
              <span className="text-slate-500 line-through decoration-slate-300">{o || "—"}</span>
              <span className={changed ? "font-semibold text-amber-800" : "text-slate-700"}>{n || "—"}</span>
            </div>
          );
        };
        return (
          <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/45 p-4" onClick={() => !dupBusy && setDupModal(null)}>
            <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
              <div className="text-center text-3xl">{dupModal.certainId ? "⚠️" : "🔎"}</div>
              <h3 className="mt-1 text-center text-base font-bold text-slate-800">
                {dupModal.certainId ? "Prenotazione già esistente" : "Possibile duplicato"}
              </h3>
              <p className="mt-1 text-center text-xs text-slate-500">
                {dupModal.certainId
                  ? "Una prenotazione che sembra la stessa è già a sistema. Scegli come procedere."
                  : "Una o più prenotazioni potrebbero coincidere. Verifica prima di procedere."}
              </p>

              <div className="mt-4 space-y-3">
                {dupModal.matches.map((m) => (
                  <div key={m.service_id} className="rounded-xl border border-slate-200 p-3">
                    <div className="flex items-center justify-between">
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600">
                        {DUP_REASON_LABEL[m.match_reason] ?? m.match_reason}
                      </span>
                      <span className="text-[10px] font-semibold uppercase text-slate-400">
                        {m.is_draft ? "bozza" : m.status || "—"}
                      </span>
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-slate-600">
                      <span><span className="font-semibold text-slate-500">Cliente:</span> {m.customer_name ?? "—"}</span>
                      <span><span className="font-semibold text-slate-500">Data:</span> {m.date ?? "—"}</span>
                      <span><span className="font-semibold text-slate-500">Hotel:</span> {m.hotel_name ?? "—"}</span>
                      <span><span className="font-semibold text-slate-500">Pax:</span> {m.pax ?? "—"}</span>
                      <span><span className="font-semibold text-slate-500">Telefono:</span> {m.phone ?? "—"}</span>
                      <span><span className="font-semibold text-slate-500">Agenzia:</span> {m.agency_name ?? m.billing_party_name ?? "—"}</span>
                      <span><span className="font-semibold text-slate-500">Pratica:</span> {m.practice_number ?? "—"}</span>
                      <span><span className="font-semibold text-slate-500">Mezzo:</span> {m.transport_code ?? "—"}</span>
                    </div>
                    <button
                      type="button"
                      disabled={dupBusy}
                      onClick={() => void dupModifyExisting(m.service_id)}
                      className="mt-2 w-full rounded-lg bg-slate-800 py-2 text-xs font-bold text-white hover:bg-slate-700 disabled:opacity-50"
                    >
                      {dupBusy ? "Aggiorno..." : "Modifica questa prenotazione"}
                    </button>
                  </div>
                ))}
              </div>

              {single ? (
                <div className="mt-4 overflow-hidden rounded-xl border border-slate-200">
                  <div className="grid grid-cols-[110px_1fr_1fr] gap-2 bg-slate-50 px-3 py-1.5 text-[10px] font-bold uppercase text-slate-400">
                    <span>Campo</span><span>Esistente</span><span>Nuovi dati</span>
                  </div>
                  {diffRow("Pratica", single.practice_number, inc.practice_number)}
                  {diffRow("Arrivo", single.arrival_time ?? single.outbound_time, inc.arrival_time)}
                  {diffRow("Ritorno", single.return_time ?? single.departure_time, inc.return_time)}
                  {diffRow("Mezzo", single.transport_code, inc.transport_code)}
                  {diffRow("Pax", single.pax != null ? String(single.pax) : "", inc.pax)}
                  {diffRow("Telefono", single.phone, inc.phone)}
                  {diffRow("Hotel", single.hotel_name, inc.hotel)}
                  {diffRow("Cliente", single.customer_name, inc.customer_name)}
                  {diffRow("Data", single.date, inc.date)}
                </div>
              ) : null}

              <p className="mt-4 text-center text-[11px] text-slate-400">
                &ldquo;Modifica&rdquo; aggiorna la prenotazione esistente coi nuovi dati. &ldquo;Aggiungi comunque&rdquo; crea una nuova prenotazione.
              </p>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  disabled={dupBusy}
                  onClick={() => setDupModal(null)}
                  className="flex-1 rounded-xl border border-slate-200 py-2.5 text-sm font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                >
                  Annulla
                </button>
                <button
                  type="button"
                  disabled={dupBusy}
                  onClick={() => void dupAddAnyway()}
                  className="flex-1 rounded-xl bg-amber-600 py-2.5 text-sm font-bold text-white hover:bg-amber-700 disabled:opacity-50"
                >
                  {dupBusy ? "..." : "Aggiungi comunque"}
                </button>
              </div>
            </div>
          </div>
        );
      })() : null}
    </section>
  );
}
