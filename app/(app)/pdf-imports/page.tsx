"use client";

import { useEffect, useMemo, useState } from "react";
import {
  formatIsoDateShort,
  formatIsoDateTimeShort,
  getOutwardReferenceLabel,
  getOutwardTimeLabel,
  getReturnReferenceLabel,
  getReturnTimeLabel,
  getTransportMode
} from "@/lib/service-display";
import type { TransportMode } from "@/lib/types";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";
import { getClientSessionContext } from "@/lib/supabase/client-session";

type PdfImportUiStatus = "preview" | "draft" | "confirmed" | "duplicate" | "ignored" | "failed";
type BookingKind = "transfer_port_hotel" | "transfer_airport_hotel" | "transfer_train_hotel" | "bus_city_hotel" | "excursion";
type OperationalServiceType = "transfer_station_hotel" | "transfer_port_hotel" | "transfer_hotel_port" | "excursion" | "ferry_transfer" | "bus_line" | "";

type PdfImportRow = {
  inbound_email_id: string;
  created_at: string;
  status: PdfImportUiStatus;
  agency: string | null;
  customer: string | null;
  arrival_date: string | null;
  hotel_or_destination: string | null;
  parser_key: string | null;
  parser_mode: "dedicated" | "fallback" | "stub" | null;
  parser_selection_confidence: string | null;
  parser_selection_reason: string | null;
  fallback_reason: string | null;
  parsing_quality: string | null;
  review_recommended: boolean;
  external_reference: string | null;
  linked_service_id: string | null;
  linked_service_is_draft: boolean;
  duplicate: boolean;
  fields_found_count: number;
  missing_fields_count: number;
  parser_logs: string[];
  fields_found: string[];
  missing_fields: string[];
  normalized: Record<string, unknown>;
  original_normalized: Record<string, unknown>;
  reviewed_values: Record<string, unknown> | null;
  effective_normalized: Record<string, unknown>;
  dedupe: Record<string, unknown>;
  raw_inbound_parser: Record<string, unknown> | null;
  raw_transfer_parser: Record<string, unknown> | null;
  subject: string | null;
  from_email: string | null;
  extracted_text_preview: string | null;
  linked_service_status: string | null;
  has_manual_review: boolean;
  reviewed_by: string | null;
  reviewed_at: string | null;
  possible_existing_matches: Array<{
    service_id: string;
    status: string;
    is_draft: boolean;
    customer_name: string | null;
    phone: string | null;
    date: string | null;
    match_reason: string;
  }>;
  status_events: Array<{ id: string; status: string; at: string }>;
};

type ReviewForm = {
  customer_full_name: string;
  billing_party_name: string;
  customer_phone: string;
  customer_email: string;
  arrival_date: string;
  outbound_time: string;
  departure_date: string;
  return_time: string;
  arrival_place: string;
  hotel_or_destination: string;
  passengers: string;
  source_total_amount_cents: string;
  source_price_per_pax_cents: string;
  source_amount_currency: string;
  booking_kind: BookingKind;
  service_type: OperationalServiceType;
  transport_mode: TransportMode | "";
  train_arrival_number: string;
  train_departure_number: string;
  practice_number: string;
  ns_reference: string;
  notes: string;
};

type UploadPreview = {
  filename: string;
  parser_key: string | null;
  reliability: string | null;
  agency_name: string | null;
  billing_party_name: string | null;
  customer: string | null;
  hotel_or_destination: string | null;
  external_reference: string | null;
  service_type: OperationalServiceType | null;
  service_variant: string | null;
  transport_mode: TransportMode | null;
  source_total_amount_cents: number | null;
  source_price_per_pax_cents: number | null;
  source_amount_currency: string | null;
  outbound_time: string | null;
  return_time: string | null;
  train_arrival_number: string | null;
  train_departure_number: string | null;
  missing_fields: string[];
};

function text(value: unknown) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function isIsoDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

function toDisplayDate(value: unknown) {
  const normalized = text(value).trim();
  if (!normalized) return "";
  if (isIsoDate(normalized)) return formatIsoDateShort(normalized);
  return normalized;
}

function toIsoDateFromDisplay(value: string) {
  const normalized = value.trim();
  if (!normalized) return "";
  if (isIsoDate(normalized)) return normalized;
  const match = normalized.match(/^(\d{2})\/(\d{2})\/(\d{2})$/);
  if (!match) return normalized;
  return `20${match[3]}-${match[2]}-${match[1]}`;
}

function normalizeTransportMode(value: unknown): TransportMode | "" {
  const normalized = text(value).trim();
  if (
    normalized === "train" ||
    normalized === "hydrofoil" ||
    normalized === "ferry" ||
    normalized === "road_transfer" ||
    normalized === "bus" ||
    normalized === "unknown"
  ) {
    return normalized;
  }
  return "";
}

function normalizeOperationalServiceType(value: unknown): OperationalServiceType | null {
  const normalized = text(value).trim();
  if (
    normalized === "transfer_station_hotel" ||
    normalized === "transfer_port_hotel" ||
    normalized === "transfer_hotel_port" ||
    normalized === "excursion" ||
    normalized === "ferry_transfer" ||
    normalized === "bus_line"
  ) {
    return normalized;
  }
  return null;
}

function centsToAmountInput(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return "";
  return (numeric / 100).toFixed(2);
}

function amountInputToCents(value: string) {
  const normalized = value.replace(",", ".").trim();
  if (!normalized) return null;
  const numeric = Number(normalized);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return Math.round(numeric * 100);
}

function formFromRow(row: PdfImportRow | null): ReviewForm {
  const source = (row?.effective_normalized ?? {}) as Record<string, unknown>;
  const dedupe = (row?.dedupe ?? {}) as Record<string, unknown>;
  return {
    customer_full_name: text(source.customer_full_name),
    billing_party_name: text(source.billing_party_name),
    customer_phone: text(source.customer_phone),
    customer_email: text(source.customer_email),
    arrival_date: toDisplayDate(source.arrival_date),
    outbound_time: text(source.outbound_time || source.arrival_time),
    departure_date: toDisplayDate(source.departure_date),
    return_time: text(source.return_time || source.departure_time),
    arrival_place: text(source.arrival_place),
    hotel_or_destination: text(source.hotel_or_destination),
    passengers: text(source.passengers || "1"),
    source_total_amount_cents: centsToAmountInput(source.source_total_amount_cents),
    source_price_per_pax_cents: centsToAmountInput(source.source_price_per_pax_cents),
    source_amount_currency: text(source.source_amount_currency || "EUR"),
    booking_kind: (text(source.booking_kind) || "transfer_port_hotel") as BookingKind,
    service_type: (text(source.service_type) || "") as OperationalServiceType,
    transport_mode: normalizeTransportMode(source.transport_mode || getTransportMode(source as never)),
    train_arrival_number: text(source.train_arrival_number),
    train_departure_number: text(source.train_departure_number),
    practice_number: text(dedupe.practice_number),
    ns_reference: text(dedupe.ns_reference),
    notes: text(source.notes)
  };
}

function statusMeta(status: PdfImportUiStatus) {
  switch (status) {
    case "draft":
      return { label: "Draft", className: "border-amber-200 bg-amber-50 text-amber-800" };
    case "confirmed":
      return { label: "Confermato", className: "border-emerald-200 bg-emerald-50 text-emerald-800" };
    case "duplicate":
      return { label: "Duplicato", className: "border-slate-200 bg-slate-100 text-slate-700" };
    case "ignored":
      return { label: "Scartato", className: "border-rose-200 bg-rose-50 text-rose-800" };
    case "failed":
      return { label: "Errore", className: "border-red-200 bg-red-50 text-red-800" };
    default:
      return { label: "Preview", className: "border-blue-200 bg-blue-50 text-blue-800" };
  }
}

function qualityMeta(value?: string | null) {
  if (value === "high") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (value === "medium") return "border-amber-200 bg-amber-50 text-amber-800";
  return "border-slate-200 bg-slate-100 text-slate-700";
}

function parserModeLabel(value?: string | null) {
  if (value === "dedicated") return "dedicated";
  if (value === "fallback") return "fallback";
  if (value === "stub") return "stub";
  return "n/d";
}

function parserLabel(value?: string | null) {
  switch (value) {
    case "agency_aleste_viaggi":
      return "Aleste Viaggi";
    case "agency_rossella_sosandra":
      return "Sosandra / Rossella";
    case "agency_bus_operations":
      return "Bus operations";
    case "agency_dimhotels_voucher":
      return "Dimhotels / Snav";
    case "agency_default":
      return "Fallback generico";
    default:
      return value ?? "N/D";
  }
}

function isOcrHeavyCase(row: PdfImportRow | null) {
  if (!row) return false;
  if (row.parser_key === "agency_dimhotels_voucher") return true;
  return row.parser_logs.some((item) => /ocr rumoroso|voucher ocr/i.test(item));
}

function bookingKindLabel(value?: string | null, variant?: string | null) {
  if (variant === "ferry_naples_transfer") return "Formula Medmar";
  switch (value) {
    case "transfer_train_hotel":
      return "Transfer stazione/hotel";
    case "transfer_port_hotel":
      return "Transfer porto/hotel";
    case "transfer_airport_hotel":
      return "Transfer aeroporto/hotel";
    case "bus_city_hotel":
      return "Linea bus";
    case "excursion":
      return "Escursione";
    default:
      return "Tipo non rilevato";
  }
}

function serviceVariantLabel(value?: string | null) {
  switch (value) {
    case "train_station_hotel":
      return "Tariffa: stazione/hotel";
    case "ferry_naples_transfer":
      return "Tariffa: Formula Medmar";
    case "auto_ischia_hotel":
      return "Tariffa: auto Ischia/hotel A/R";
    default:
      return null;
  }
}

function serviceTypeLabel(value?: string | null, variant?: string | null) {
  if (variant === "ferry_naples_transfer") return "Formula Medmar";
  switch (value) {
    case "transfer_station_hotel":
      return "Transfer stazione/hotel";
    case "transfer_port_hotel":
      return "Transfer porto/hotel";
    case "transfer_hotel_port":
      return "Transfer hotel/porto-stazione";
    case "excursion":
      return "Escursione";
    case "ferry_transfer":
      return "Traghetto + transfer";
    case "bus_line":
      return "Linea bus";
    default:
      return null;
  }
}

function reviewContext(form: Pick<ReviewForm, "transport_mode" | "service_type" | "booking_kind" | "train_arrival_number" | "train_departure_number">) {
  return {
    transport_mode: form.transport_mode || null,
    service_type_code: form.service_type || null,
    booking_service_kind: form.booking_kind || null,
    train_arrival_number: form.train_arrival_number || null,
    train_departure_number: form.train_departure_number || null
  };
}

function uploadPreviewContext(preview: UploadPreview) {
  return {
    transport_mode: preview.transport_mode || null,
    service_type_code: preview.service_type || null,
    train_arrival_number: preview.train_arrival_number || null,
    train_departure_number: preview.train_departure_number || null
  };
}

function canConfirm(row: PdfImportRow) {
  return row.status === "draft" || row.status === "preview";
}

function canIgnore(row: PdfImportRow) {
  return row.status !== "confirmed" && row.status !== "ignored";
}

function canDelete(row: PdfImportRow) {
  return row.status !== "confirmed" && (row.linked_service_id === null || row.linked_service_is_draft);
}

function canEdit(row: PdfImportRow) {
  return row.status === "draft" && row.linked_service_is_draft;
}

function originalValue(row: PdfImportRow | null, key: keyof ReviewForm) {
  if (!row) return "";
  if (key === "practice_number") return text(row.dedupe.practice_number);
  if (key === "ns_reference") return text(row.dedupe.ns_reference);
  if (key === "arrival_date" || key === "departure_date") {
    return toDisplayDate((row.original_normalized ?? {})[key]);
  }
  if (key === "source_total_amount_cents" || key === "source_price_per_pax_cents") {
    return centsToAmountInput((row.original_normalized ?? {})[key]);
  }
  return text((row.original_normalized ?? {})[key]);
}

function fieldMissing(row: PdfImportRow | null, key: string) {
  return Boolean(row?.missing_fields.includes(key));
}

export default function PdfImportsPage() {
  const [rows, setRows] = useState<PdfImportRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<"all" | PdfImportUiStatus>("all");
  const [search, setSearch] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [reviewForm, setReviewForm] = useState<ReviewForm>(formFromRow(null));
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadBusy, setUploadBusy] = useState<"preview" | "draft" | null>(null);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [uploadPreview, setUploadPreview] = useState<UploadPreview | null>(null);

  const loadRows = async () => {
    setLoading(true);
    setError(null);
    setMessage(null);
    try {
      const session = await getClientSessionContext();
      if (session.mode === "demo" || !hasSupabaseEnv || !supabase) {
        throw new Error("Pagina disponibile solo con login Supabase reale.");
      }
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error("Sessione non valida.");

      const response = await fetch("/api/email/pdf-imports", {
        headers: { Authorization: `Bearer ${token}` }
      });
      const body = (await response.json().catch(() => null)) as { ok?: boolean; rows?: PdfImportRow[]; error?: string } | null;
      if (!response.ok || !body?.ok) {
        throw new Error(body?.error ?? "Caricamento import PDF fallito.");
      }
      setRows(body.rows ?? []);
      setSelectedId((current) => current ?? body.rows?.[0]?.inbound_email_id ?? null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Errore caricamento.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadRows();
  }, []);

  const filteredRows = useMemo(() => {
    const query = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (statusFilter !== "all" && row.status !== statusFilter) return false;
      if (!query) return true;
      const haystack = [row.customer, row.agency, row.external_reference, row.hotel_or_destination, row.arrival_date, row.inbound_email_id]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [rows, search, statusFilter]);

  const selected = useMemo(
    () => filteredRows.find((row) => row.inbound_email_id === selectedId) ?? filteredRows[0] ?? null,
    [filteredRows, selectedId]
  );

  useEffect(() => {
    if (!selected && filteredRows[0]) {
      setSelectedId(filteredRows[0].inbound_email_id);
    }
  }, [filteredRows, selected]);

  useEffect(() => {
    setReviewForm(formFromRow(selected));
  }, [selected]);

  const stats = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    return {
      drafts: rows.filter((row) => row.status === "draft").length,
      confirmedToday: rows.filter((row) => row.status === "confirmed" && row.created_at.slice(0, 10) === today).length,
      duplicates: rows.filter((row) => row.status === "duplicate").length,
      failed: rows.filter((row) => row.status === "failed").length
    };
  }, [rows]);

  const changedFields = useMemo(() => {
    if (!selected) return [] as string[];
    const keys = Object.keys(reviewForm) as Array<keyof ReviewForm>;
    return keys.filter((key) => reviewForm[key].trim() !== originalValue(selected, key).trim());
  }, [reviewForm, selected]);

  const runAction = async (kind: "confirm" | "ignore" | "delete", inboundEmailId: string) => {
    setBusyId(inboundEmailId);
    setMessage(null);
    setError(null);
    try {
      if (!hasSupabaseEnv || !supabase) throw new Error("Supabase non configurato.");
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error("Sessione non valida.");
      const endpoint =
        kind === "confirm"
          ? "/api/email/confirm-pdf"
          : kind === "ignore"
            ? "/api/email/pdf-imports/ignore"
            : "/api/email/pdf-imports/delete";
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ inbound_email_id: inboundEmailId })
      });
      const body = (await response.json().catch(() => null)) as
        | { ok?: boolean; error?: string; outcome?: string; duplicate?: boolean; existing_service_id?: string | null }
        | null;
      if (!response.ok || !body?.ok) {
        throw new Error(body?.error ?? `Operazione ${kind} fallita.`);
      }
      setMessage(
        kind === "confirm"
          ? body.outcome === "imported"
            ? "Import PDF confermato."
            : body.duplicate
              ? `Import fermato: duplicato gia presente (${body.existing_service_id ?? "service esistente"}).`
              : "Operazione completata."
          : kind === "ignore"
            ? "Import PDF scartato."
            : "Import PDF eliminato."
      );
      if (kind === "delete") {
        setSelectedId(null);
      }
      await loadRows();
      if (kind !== "delete") {
        setSelectedId(inboundEmailId);
      }
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Errore operazione.");
    } finally {
      setBusyId(null);
    }
  };

  const saveReview = async () => {
    if (!selected) return;
    setBusyId(selected.inbound_email_id);
    setError(null);
    setMessage(null);
    try {
      if (!hasSupabaseEnv || !supabase) throw new Error("Supabase non configurato.");
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error("Sessione non valida.");
      const response = await fetch("/api/email/pdf-imports/review", {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          inbound_email_id: selected.inbound_email_id,
          reviewed_values: {
            ...reviewForm,
            passengers: Number(reviewForm.passengers || 1),
            source_total_amount_cents: amountInputToCents(reviewForm.source_total_amount_cents),
            source_price_per_pax_cents: amountInputToCents(reviewForm.source_price_per_pax_cents),
            source_amount_currency: reviewForm.source_amount_currency || null,
            customer_email: reviewForm.customer_email || null,
            customer_full_name: reviewForm.customer_full_name || null,
            billing_party_name: reviewForm.billing_party_name || null,
            arrival_date: toIsoDateFromDisplay(reviewForm.arrival_date) || null,
            departure_date: toIsoDateFromDisplay(reviewForm.departure_date) || null,
            return_time: reviewForm.return_time || null,
            arrival_place: reviewForm.arrival_place || null,
            hotel_or_destination: reviewForm.hotel_or_destination || null,
            service_type: reviewForm.service_type || null,
            transport_mode: reviewForm.transport_mode || null,
            practice_number: reviewForm.practice_number || null,
            ns_reference: reviewForm.ns_reference || null,
            train_arrival_number: reviewForm.train_arrival_number || null,
            train_departure_number: reviewForm.train_departure_number || null,
            outbound_time: reviewForm.outbound_time || null,
            notes: reviewForm.notes || null
          }
        })
      });
      const body = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!response.ok || !body?.ok) {
        throw new Error(body?.error ?? "Salvataggio review fallito.");
      }
      setMessage("Modifiche review salvate.");
      await loadRows();
      setSelectedId(selected.inbound_email_id);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Errore salvataggio.");
    } finally {
      setBusyId(null);
    }
  };

  const runUpload = async (mode: "preview" | "draft") => {
    if (!uploadFile) {
      setUploadStatus("Seleziona prima un PDF.");
      return;
    }
    setUploadBusy(mode);
    setError(null);
    setMessage(null);
    setUploadStatus(mode === "preview" ? "Anteprima parser in corso..." : "Creazione draft in corso...");
    try {
      if (!hasSupabaseEnv || !supabase) throw new Error("Supabase non configurato.");
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error("Sessione non valida.");

      const form = new FormData();
      form.append("file", uploadFile);
      form.append("subject", `Import PDF manuale ${uploadFile.name}`);
      form.append("body_text", "Import manuale da area pdf-imports.");

      const response = await fetch(mode === "preview" ? "/api/email/preview-pdf" : "/api/email/import-pdf", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form
      });
      const body = (await response.json().catch(() => null)) as
        | {
            ok?: boolean;
            error?: string;
            id?: string | null;
            inbound_email_id?: string | null;
            duplicate?: boolean;
            existing_service_id?: string | null;
            preview?: { reliability?: string | null; missing_fields?: string[] } | null;
            normalized?: Record<string, unknown> | null;
          }
        | null;
      if (!response.ok || !body?.ok) {
        throw new Error(body?.error ?? `Operazione ${mode} fallita.`);
      }

      if (mode === "preview") {
        const normalized = (body.normalized ?? {}) as Record<string, unknown>;
        setUploadPreview({
          filename: uploadFile.name,
          parser_key: text(normalized.parser_key) || null,
          reliability: text(body.preview?.reliability) || null,
          agency_name: text(normalized.agency_name) || null,
          billing_party_name: text(normalized.billing_party_name) || null,
          customer: text(normalized.customer_full_name) || null,
          hotel_or_destination: text(normalized.hotel_or_destination) || null,
          external_reference: text(normalized.external_reference) || null,
          service_type: normalizeOperationalServiceType(normalized.service_type),
          service_variant: text(normalized.service_variant) || null,
          transport_mode: normalizeTransportMode(normalized.transport_mode) || null,
          source_total_amount_cents: Number.isFinite(Number(normalized.source_total_amount_cents)) ? Number(normalized.source_total_amount_cents) : null,
          source_price_per_pax_cents: Number.isFinite(Number(normalized.source_price_per_pax_cents)) ? Number(normalized.source_price_per_pax_cents) : null,
          source_amount_currency: text(normalized.source_amount_currency) || null,
          outbound_time: text(normalized.outbound_time) || null,
          return_time: text(normalized.return_time) || null,
          train_arrival_number: text(normalized.train_arrival_number) || null,
          train_departure_number: text(normalized.train_departure_number) || null,
          missing_fields: Array.isArray(body.preview?.missing_fields) ? body.preview?.missing_fields ?? [] : []
        });
        setUploadStatus("Anteprima parser pronta.");
        return;
      }

      const inboundEmailId = body.inbound_email_id ?? body.id ?? null;
      await loadRows();
      if (inboundEmailId) {
        setSelectedId(inboundEmailId);
      }
      if (body.duplicate) {
        setMessage("PDF gia presente: import fermato per duplicato.");
      } else {
        setMessage("Draft PDF creato correttamente.");
      }
      setUploadStatus(
        body.duplicate
          ? `Duplicato rilevato. Service esistente: ${body.existing_service_id ?? "N/D"}.`
          : `Draft creato da ${uploadFile.name}.`
      );
    } catch (uploadError) {
      const nextError = uploadError instanceof Error ? uploadError.message : "Errore upload PDF.";
      setError(nextError);
      setUploadStatus(nextError);
    } finally {
      setUploadBusy(null);
    }
  };

  return (
    <section className="space-y-4">
      <div data-testid="pdf-imports-page" className="card space-y-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.14em] text-muted">Operazioni PDF</p>
            <h1 className="mt-1 text-2xl">Import PDF agenzie</h1>
            <p className="mt-1 text-sm text-muted">Review manuale dei draft prima della conferma finale.</p>
          </div>
          <button data-testid="pdf-imports-refresh" type="button" onClick={() => void loadRows()} className="btn-secondary px-3 py-2 text-xs" disabled={loading}>
            {loading ? "Aggiorno..." : "Aggiorna"}
          </button>
        </div>

        <div className="grid gap-3 md:grid-cols-4">
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-3"><p className="text-xs uppercase tracking-[0.08em] text-amber-700">Da revisionare</p><p className="mt-2 text-2xl font-semibold text-amber-900">{stats.drafts}</p></div>
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3"><p className="text-xs uppercase tracking-[0.08em] text-emerald-700">Confermati oggi</p><p className="mt-2 text-2xl font-semibold text-emerald-900">{stats.confirmedToday}</p></div>
          <div className="rounded-xl border border-slate-200 bg-slate-100 p-3"><p className="text-xs uppercase tracking-[0.08em] text-slate-600">Duplicati</p><p className="mt-2 text-2xl font-semibold text-slate-800">{stats.duplicates}</p></div>
          <div className="rounded-xl border border-red-200 bg-red-50 p-3"><p className="text-xs uppercase tracking-[0.08em] text-red-700">Errori parsing</p><p className="mt-2 text-2xl font-semibold text-red-900">{stats.failed}</p></div>
        </div>

        <div className="grid gap-3 md:grid-cols-[180px_1fr]">
          <select data-testid="pdf-imports-status-filter" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as "all" | PdfImportUiStatus)} className="input-saas">
            <option value="all">Tutti gli stati</option>
            <option value="draft">Draft</option>
            <option value="confirmed">Confermati</option>
            <option value="duplicate">Duplicati</option>
            <option value="ignored">Scartati</option>
            <option value="failed">Errori</option>
            <option value="preview">Preview</option>
          </select>
          <input data-testid="pdf-imports-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Cerca per cliente, pratica, hotel, agenzia" className="input-saas" />
        </div>

        {message ? <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{message}</div> : null}
        {error ? <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</div> : null}
      </div>

      <div className="card space-y-4 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.14em] text-muted">Upload diretto</p>
            <h2 className="mt-1 text-lg font-semibold">Carica PDF da questa pagina</h2>
            <p className="mt-1 text-sm text-muted">Puoi fare prima un’anteprima parser oppure creare subito il draft da revisionare.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button data-testid="pdf-upload-preview" type="button" onClick={() => void runUpload("preview")} disabled={!uploadFile || uploadBusy !== null} className="btn-secondary px-3 py-2 text-xs disabled:opacity-50">
              {uploadBusy === "preview" ? "Anteprima..." : "Anteprima parser"}
            </button>
            <button data-testid="pdf-upload-draft" type="button" onClick={() => void runUpload("draft")} disabled={!uploadFile || uploadBusy !== null} className="btn-primary px-3 py-2 text-xs disabled:opacity-50">
              {uploadBusy === "draft" ? "Creo draft..." : "Crea draft"}
            </button>
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-[1fr_1fr]">
          <label className="space-y-1">
            <span className="text-xs font-semibold uppercase tracking-[0.06em] text-slate-600">File PDF</span>
            <input
              data-testid="pdf-upload-input"
              type="file"
              accept="application/pdf,.pdf"
              onChange={(event) => {
                const file = event.target.files?.[0] ?? null;
                setUploadFile(file);
                setUploadPreview(null);
                setUploadStatus(file ? `File selezionato: ${file.name}` : null);
              }}
              className="input-saas"
            />
          </label>
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
            <p className="font-semibold text-slate-800">Stato upload</p>
            <p data-testid="pdf-upload-status" className="mt-2">{uploadStatus ?? "Nessun file selezionato."}</p>
          </div>
        </div>

        {uploadPreview ? (
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm">
              <p className="font-semibold text-slate-800">Anteprima parser</p>
              <div className="mt-2 space-y-1 text-slate-700">
                <p>File: {uploadPreview.filename}</p>
                <p>Parser: {parserLabel(uploadPreview.parser_key)}</p>
                <p>Quality: {uploadPreview.reliability ?? "N/D"}</p>
                <p>Agenzia: {uploadPreview.agency_name ?? "N/D"}</p>
                <p>Agenzia fatturazione: {uploadPreview.billing_party_name ?? uploadPreview.agency_name ?? "N/D"}</p>
                <p>Cliente: {uploadPreview.customer ?? "N/D"}</p>
                <p>Hotel/destinazione: {uploadPreview.hotel_or_destination ?? "N/D"}</p>
                <p>Riferimento: {uploadPreview.external_reference ?? "N/D"}</p>
                <p>Service type: {serviceTypeLabel(uploadPreview.service_type, uploadPreview.service_variant) ?? "N/D"}</p>
                <p>Costo PDF: {centsToAmountInput((uploadPreview as unknown as { source_total_amount_cents?: number | null }).source_total_amount_cents) || "N/D"} {(uploadPreview as unknown as { source_amount_currency?: string | null }).source_amount_currency ?? "EUR"}</p>
                <p>Costo per pax: {centsToAmountInput((uploadPreview as unknown as { source_price_per_pax_cents?: number | null }).source_price_per_pax_cents) || "N/D"} {(uploadPreview as unknown as { source_amount_currency?: string | null }).source_amount_currency ?? "EUR"}</p>
                <p>{getOutwardTimeLabel(uploadPreviewContext(uploadPreview))}: {uploadPreview.outbound_time ?? "N/D"}</p>
                {uploadPreview.return_time ? <p>{getReturnTimeLabel(uploadPreviewContext(uploadPreview))}: {uploadPreview.return_time}</p> : null}
                {uploadPreview.train_arrival_number ? <p>{getOutwardReferenceLabel(uploadPreviewContext(uploadPreview))}: {uploadPreview.train_arrival_number}</p> : null}
                {uploadPreview.train_departure_number ? <p>{getReturnReferenceLabel(uploadPreviewContext(uploadPreview))}: {uploadPreview.train_departure_number}</p> : null}
                {uploadPreview.parser_key === "agency_dimhotels_voucher" ? (
                  <p className="text-xs text-amber-700">Voucher scannerizzato: classificazione utile, ma review manuale consigliata sui campi estratti.</p>
                ) : null}
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm">
              <p className="font-semibold text-slate-800">Campi da verificare</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {uploadPreview.missing_fields.length > 0 ? uploadPreview.missing_fields.map((field) => (
                  <span key={field} className="inline-flex rounded-full border border-amber-200 bg-white px-2 py-1 text-xs text-amber-800">{field}</span>
                )) : <span className="text-xs">Nessun campo critico mancante.</span>}
              </div>
            </div>
          </div>
        ) : null}
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(420px,560px)_1fr]">
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50">
                <tr className="text-left text-xs uppercase tracking-[0.08em] text-slate-500">
                  <th className="px-3 py-3">Stato</th><th className="px-3 py-3">Cliente</th><th className="px-3 py-3">Arrivo</th><th className="px-3 py-3">Hotel</th><th className="px-3 py-3">Parser</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {loading ? <tr><td colSpan={5} className="px-3 py-6 text-center text-sm text-slate-500">Caricamento in corso...</td></tr> : null}
                {!loading && filteredRows.length === 0 ? <tr><td colSpan={5} className="px-3 py-6 text-center text-sm text-slate-500">Nessun import PDF trovato.</td></tr> : null}
                {!loading && filteredRows.map((row) => {
                  const active = row.inbound_email_id === selected?.inbound_email_id;
                  return (
                    <tr
                      key={row.inbound_email_id}
                      data-testid={`pdf-import-row-${row.inbound_email_id}`}
                      className={active ? "bg-blue-50/50" : "hover:bg-slate-50"}
                      onClick={() => setSelectedId(row.inbound_email_id)}
                    >
                      <td className="px-3 py-3 align-top"><span className={`inline-flex rounded-full border px-2 py-1 text-xs font-semibold ${statusMeta(row.status).className}`}>{statusMeta(row.status).label}</span></td>
                      <td className="px-3 py-3 align-top"><p className="font-medium text-slate-800">{row.customer ?? "Cliente da verificare"}</p><p className="text-xs text-slate-500">{row.agency ?? "Agenzia non rilevata"}</p><p className="mt-1 text-[11px] text-slate-500">{row.external_reference ?? "Rif. non disponibile"}</p></td>
                      <td className="px-3 py-3 align-top text-slate-700">{formatIsoDateShort(row.arrival_date)}</td>
                      <td className="px-3 py-3 align-top text-slate-700">{row.hotel_or_destination ?? "N/D"}</td>
                      <td className="px-3 py-3 align-top"><p className="text-slate-700">{parserLabel(row.parser_key)}</p><div className="mt-1 flex flex-wrap gap-1"><span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${qualityMeta(row.parsing_quality)}`}>{row.parsing_quality ?? "low"}</span><span className="inline-flex rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-semibold text-slate-700">{parserModeLabel(row.parser_mode)}</span>{isOcrHeavyCase(row) ? <span className="inline-flex rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-800">OCR rumoroso</span> : null}</div></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div data-testid="pdf-import-detail" className="card space-y-4 p-4">
          {!selected ? <p className="text-sm text-slate-500">Seleziona un import PDF per vedere il dettaglio.</p> : (
            <>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span data-testid="pdf-import-status-badge" className={`inline-flex rounded-full border px-2 py-1 text-xs font-semibold ${statusMeta(selected.status).className}`}>{statusMeta(selected.status).label}</span>
                    <span className="inline-flex rounded-full border border-sky-200 bg-sky-50 px-2 py-1 text-xs font-semibold text-sky-700">
                      {bookingKindLabel(text(selected.effective_normalized.booking_kind), text(selected.effective_normalized.service_variant))}
                    </span>
                    {serviceTypeLabel(text(selected.effective_normalized.service_type), text(selected.effective_normalized.service_variant)) ? (
                      <span className="inline-flex rounded-full border border-violet-200 bg-violet-50 px-2 py-1 text-xs font-semibold text-violet-700">
                        {serviceTypeLabel(text(selected.effective_normalized.service_type), text(selected.effective_normalized.service_variant))}
                      </span>
                    ) : null}
                    {serviceVariantLabel(text(selected.effective_normalized.service_variant)) ? (
                      <span className="inline-flex rounded-full border border-teal-200 bg-teal-50 px-2 py-1 text-xs font-semibold text-teal-700">
                        {serviceVariantLabel(text(selected.effective_normalized.service_variant))}
                      </span>
                    ) : null}
                    {selected.has_manual_review ? <span className="inline-flex rounded-full border border-indigo-200 bg-indigo-50 px-2 py-1 text-xs font-semibold text-indigo-700">Review manuale</span> : null}
                    {selected.duplicate ? <span className="inline-flex rounded-full border border-slate-300 bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700">Deduplicato</span> : null}
                    {selected.possible_existing_matches.length > 0 ? (
                      <span className="inline-flex rounded-full border border-rose-200 bg-rose-50 px-2 py-1 text-xs font-semibold text-rose-700">
                        Possibile modifica pratica esistente
                      </span>
                    ) : null}
                  </div>
                  <h2 className="mt-2 text-xl">{selected.customer ?? "Cliente da verificare"}</h2>
                  <p className="text-sm text-slate-500">{selected.agency ?? "Agenzia non rilevata"} | creato {formatIsoDateTimeShort(selected.created_at)}</p>
                  {selected.reviewed_at ? <p className="text-xs text-slate-500">Review salvata: {formatIsoDateTimeShort(selected.reviewed_at)}</p> : null}
                  {selected.review_recommended ? <p className="text-xs text-amber-700">Review manuale consigliata: parser {parserModeLabel(selected.parser_mode)} o qualita non alta.</p> : null}
                  {isOcrHeavyCase(selected) ? <p className="text-xs text-rose-700">Voucher scannerizzato con OCR rumoroso: usa la review manuale come fonte finale, soprattutto per nome, hotel, telefono, date e orari.</p> : null}
                </div>
                <div className="flex flex-wrap gap-2">
                  {canEdit(selected) ? <button data-testid="pdf-review-save" type="button" onClick={() => void saveReview()} disabled={busyId === selected.inbound_email_id} className="btn-secondary px-3 py-2 text-xs disabled:opacity-50">{busyId === selected.inbound_email_id ? "Salvo..." : "Salva modifiche"}</button> : null}
                  {canEdit(selected) ? <button type="button" onClick={() => setReviewForm(formFromRow(selected))} disabled={busyId === selected.inbound_email_id} className="btn-secondary px-3 py-2 text-xs disabled:opacity-50">Annulla</button> : null}
                  <button data-testid="pdf-confirm-import" type="button" onClick={() => void runAction("confirm", selected.inbound_email_id)} disabled={!canConfirm(selected) || busyId === selected.inbound_email_id} className="btn-primary px-3 py-2 text-xs disabled:opacity-50">{busyId === selected.inbound_email_id ? "Operazione..." : "Conferma import"}</button>
                  <button data-testid="pdf-ignore-import" type="button" onClick={() => void runAction("ignore", selected.inbound_email_id)} disabled={!canIgnore(selected) || busyId === selected.inbound_email_id} className="btn-secondary px-3 py-2 text-xs disabled:opacity-50">Scarta</button>
                  <button
                    type="button"
                    onClick={() => {
                      if (!canDelete(selected)) return;
                      if (!window.confirm("Eliminare questo PDF importato e l'eventuale draft collegato?")) return;
                      void runAction("delete", selected.inbound_email_id);
                    }}
                    disabled={!canDelete(selected) || busyId === selected.inbound_email_id}
                    className="btn-secondary px-3 py-2 text-xs text-rose-700 disabled:opacity-50"
                  >
                    Elimina
                  </button>
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm">
                  <p className="font-semibold text-slate-800">Flusso e dedupe</p>
                  <div className="mt-2 space-y-1 text-slate-700">
                    <p>Parser: {parserLabel(selected.parser_key)} ({parserModeLabel(selected.parser_mode)})</p>
                    <p>Parser confidence: {selected.parser_selection_confidence ?? "N/D"}</p>
                    <p>Parser reason: {selected.parser_selection_reason ?? "N/D"}</p>
                    <p>Fallback reason: {selected.fallback_reason ?? "N/D"}</p>
                    <p>Inbound email id: {selected.inbound_email_id}</p>
                    <p>Service id: {selected.linked_service_id ?? "Non creato"}</p>
                    <p>Service status: {selected.linked_service_status ?? "N/D"}</p>
                    <p>Dedupe key: {text(selected.dedupe.key) || "N/D"}</p>
                    <p>Practice number: {text(selected.dedupe.practice_number) || "N/D"}</p>
                    <p>NS reference: {text(selected.dedupe.ns_reference) || "N/D"}</p>
                    <p>Composite key: {text(selected.dedupe.composite_key) || "N/D"}</p>
                  </div>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm">
                  <p className="font-semibold text-slate-800">Campi deboli</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {selected.missing_fields.length > 0 ? selected.missing_fields.map((field) => <span key={field} className="inline-flex rounded-full border border-amber-200 bg-white px-2 py-1 text-xs text-amber-800">{field}</span>) : <span className="text-xs">Nessun campo critico mancante.</span>}
                  </div>
                  {changedFields.length > 0 ? <div className="mt-3 flex flex-wrap gap-2">{changedFields.map((field) => <span key={field} className="inline-flex rounded-full border border-indigo-200 bg-indigo-50 px-2 py-1 text-xs text-indigo-800">{field} corretto</span>)}</div> : null}
                </div>
              </div>

              {selected.possible_existing_matches.length > 0 ? (
                <div className="rounded-xl border border-rose-200 bg-rose-50/60 p-4">
                  <p className="font-semibold text-slate-900">Possibili pratiche gia esistenti</p>
                  <p className="mt-1 text-xs text-slate-600">Trovate per numero pratica, telefono o nome cliente. Verifica se questo PDF e una modifica o una nuova pratica.</p>
                  <div className="mt-3 space-y-2">
                    {selected.possible_existing_matches.map((item) => (
                      <div key={`${item.service_id}-${item.match_reason}`} className="rounded-lg border border-rose-200 bg-white px-3 py-2 text-sm text-slate-700">
                        <p className="font-medium text-slate-800">{item.customer_name ?? "Cliente N/D"} | {item.status || "stato N/D"}</p>
                        <p className="text-xs text-slate-600">Motivo: {item.match_reason} | Data: {formatIsoDateShort(item.date)} | Telefono: {item.phone || "N/D"}</p>
                        <p className="text-xs text-slate-500">Service id: {item.service_id}{item.is_draft ? " | draft" : ""}</p>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {canEdit(selected) ? (
                <div className="rounded-xl border border-indigo-200 bg-indigo-50/60 p-4">
                  <p className="font-semibold text-slate-900">Review prima della conferma</p>
                  <p className="mt-1 text-xs text-slate-600">Il parser originale resta salvato. Qui modifichi solo i valori reviewed usati al confirm finale.</p>
                  <div className="mt-3 grid gap-3 md:grid-cols-2">
                    {([
                      ["customer_full_name", "Nome completo"],
                      ["billing_party_name", "Agenzia fatturazione"],
                      ["customer_phone", "Telefono"],
                      ["customer_email", "Email"],
                      ["arrival_date", "Data andata"],
                      ["outbound_time", getOutwardTimeLabel(reviewContext(reviewForm))],
                      ["departure_date", "Data ritorno"],
                      ["return_time", getReturnTimeLabel(reviewContext(reviewForm))],
                      ["arrival_place", "Porto / meeting point"],
                      ["hotel_or_destination", "Hotel / destinazione"],
                      ["passengers", "Passeggeri"],
                      ["source_total_amount_cents", "Costo totale PDF"],
                      ["source_price_per_pax_cents", "Costo PDF per pax"],
                      ["source_amount_currency", "Valuta costo"],
                      ["train_arrival_number", getOutwardReferenceLabel(reviewContext(reviewForm))],
                      ["train_departure_number", getReturnReferenceLabel(reviewContext(reviewForm))],
                      ["practice_number", "Numero pratica"],
                      ["ns_reference", "Riferimento pratica"]
                    ] as Array<[keyof ReviewForm, string]>).map(([key, label]) => {
                      const original = originalValue(selected, key);
                      const currentValue = text(reviewForm[key]);
                      const changed = currentValue.trim() !== original.trim();
                      const missing = fieldMissing(selected, key);
                      return (
                        <label key={key} className="space-y-1">
                          <span className="text-xs font-semibold uppercase tracking-[0.06em] text-slate-600">{label}</span>
                          <input
                            data-testid={`pdf-review-field-${key}`}
                            value={currentValue}
                            onChange={(event) => setReviewForm((current) => ({ ...current, [key]: event.target.value }))}
                            className={`input-saas ${missing ? "border-amber-300 bg-amber-50" : ""}`}
                          />
                          <p className="text-[11px] text-slate-500">Parser: {original || "vuoto"}</p>
                          {changed ? <p className="text-[11px] text-indigo-700">Corretto: {currentValue || "vuoto"}</p> : null}
                        </label>
                      );
                    })}

                    <label className="space-y-1">
                      <span className="text-xs font-semibold uppercase tracking-[0.06em] text-slate-600">Booking kind</span>
                      <select data-testid="pdf-review-field-booking_kind" value={reviewForm.booking_kind} onChange={(event) => setReviewForm((current) => ({ ...current, booking_kind: event.target.value as BookingKind }))} className="input-saas">
                        <option value="transfer_port_hotel">transfer_port_hotel</option>
                        <option value="transfer_airport_hotel">transfer_airport_hotel</option>
                        <option value="transfer_train_hotel">transfer_train_hotel</option>
                        <option value="bus_city_hotel">bus_city_hotel</option>
                        <option value="excursion">excursion</option>
                      </select>
                      <p className="text-[11px] text-slate-500">Parser: {originalValue(selected, "booking_kind") || "vuoto"}</p>
                    </label>

                    <label className="space-y-1">
                      <span className="text-xs font-semibold uppercase tracking-[0.06em] text-slate-600">Service type</span>
                      <select value={reviewForm.service_type} onChange={(event) => setReviewForm((current) => ({ ...current, service_type: event.target.value as OperationalServiceType }))} className="input-saas">
                        <option value="">non rilevato</option>
                        <option value="transfer_station_hotel">transfer_station_hotel</option>
                        <option value="transfer_port_hotel">transfer_port_hotel</option>
                        <option value="transfer_hotel_port">transfer_hotel_port</option>
                        <option value="excursion">excursion</option>
                        <option value="ferry_transfer">ferry_transfer</option>
                        <option value="bus_line">bus_line</option>
                      </select>
                      <p className="text-[11px] text-slate-500">Parser: {originalValue(selected, "service_type") || "vuoto"}</p>
                    </label>

                    <label className="space-y-1">
                      <span className="text-xs font-semibold uppercase tracking-[0.06em] text-slate-600">Mezzo di riferimento</span>
                      <select value={reviewForm.transport_mode} onChange={(event) => setReviewForm((current) => ({ ...current, transport_mode: event.target.value as TransportMode | "" }))} className="input-saas">
                        <option value="train">treno</option>
                        <option value="hydrofoil">aliscafo</option>
                        <option value="ferry">traghetto</option>
                        <option value="road_transfer">transfer stradale</option>
                        <option value="bus">bus</option>
                        <option value="unknown">non definito</option>
                      </select>
                      <p className="text-[11px] text-slate-500">Parser: {text(selected.effective_normalized.transport_mode) || getTransportMode(selected.effective_normalized as never)}</p>
                    </label>

                    <label className="space-y-1 md:col-span-2">
                      <span className="text-xs font-semibold uppercase tracking-[0.06em] text-slate-600">Note operative</span>
                      <textarea data-testid="pdf-review-field-notes" value={reviewForm.notes} onChange={(event) => setReviewForm((current) => ({ ...current, notes: event.target.value }))} rows={3} className="input-saas" />
                      <p className="text-[11px] text-slate-500">Parser: {originalValue(selected, "notes") || "vuoto"}</p>
                    </label>
                  </div>
                </div>
              ) : null}

              <div className="grid gap-3 md:grid-cols-2">
                <div className="rounded-xl border border-slate-200 bg-white p-3 text-sm">
                  <p className="font-semibold text-slate-800">Effective normalized</p>
                  <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-slate-200 bg-slate-50 p-2 text-xs text-slate-700">{JSON.stringify(selected.effective_normalized, null, 2)}</pre>
                </div>
                <div className="rounded-xl border border-slate-200 bg-white p-3 text-sm">
                  <p className="font-semibold text-slate-800">Original parser values</p>
                  <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-slate-200 bg-slate-50 p-2 text-xs text-slate-700">{JSON.stringify(selected.original_normalized, null, 2)}</pre>
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <div className="rounded-xl border border-slate-200 bg-white p-3 text-sm">
                  <p className="font-semibold text-slate-800">Status events</p>
                  <div className="mt-2 space-y-2">
                    {selected.status_events.length > 0 ? selected.status_events.map((event) => <div key={event.id} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2"><p className="font-medium text-slate-800">{event.status}</p><p className="text-xs text-slate-500">{formatIsoDateTimeShort(event.at)}</p></div>) : <p className="text-xs text-slate-500">Nessun evento stato creato.</p>}
                  </div>
                </div>
                <div className="rounded-xl border border-slate-200 bg-white p-3 text-sm">
                  <p className="font-semibold text-slate-800">Log parser</p>
                  <div className="mt-2 space-y-2">
                    {selected.parser_logs.length > 0 ? selected.parser_logs.map((item, index) => <div key={`${item}-${index}`} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">{item}</div>) : <p className="text-xs text-slate-500">Nessun log disponibile.</p>}
                  </div>
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm">
                  <p className="font-semibold text-slate-800">Raw parser principale</p>
                  <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-slate-200 bg-white p-2 text-xs text-slate-700">{JSON.stringify(selected.raw_transfer_parser ?? selected.normalized, null, 2)}</pre>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm">
                  <p className="font-semibold text-slate-800">Estratto testo PDF</p>
                  <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-slate-200 bg-white p-2 text-xs text-slate-700">{selected.extracted_text_preview ?? "Nessun testo disponibile."}</pre>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
