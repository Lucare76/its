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
import type { PdfImportDetail, PdfImportUiStatus } from "@/lib/server/pdf-imports";
import { findBusStopsByCity, findNearestBusStop } from "@/lib/bus-lines-catalog";

type BookingKind = "transfer_port_hotel" | "transfer_airport_hotel" | "transfer_train_hotel" | "bus_city_hotel" | "excursion";
type OperationalServiceType = "transfer_station_hotel" | "transfer_airport_hotel" | "transfer_port_hotel" | "transfer_hotel_port" | "excursion" | "ferry_transfer" | "bus_line" | "";

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

type BusSuggestion = {
  lineCode: string;
  lineName: string;
  stop: {
    city: string;
    time: string;
    pickupNote: string | null;
  };
  delta?: number;
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
  if (normalized === "train" || normalized === "hydrofoil" || normalized === "ferry" || normalized === "road_transfer" || normalized === "bus" || normalized === "unknown") {
    return normalized;
  }
  return "";
}

function normalizeOperationalServiceType(value: unknown): OperationalServiceType | null {
  const normalized = text(value).trim();
  if (
    normalized === "transfer_station_hotel" ||
    normalized === "transfer_airport_hotel" ||
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

function isValidClockTime(value: string) {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(value.trim());
}

function formFromRow(row: PdfImportDetail | null): ReviewForm {
  const source = (row?.effective_normalized ?? {}) as Record<string, unknown>;
  const dedupe = (row?.dedupe ?? {}) as Record<string, unknown>;
  return {
    customer_full_name: text(source.customer_full_name),
    billing_party_name: text(source.billing_party_name),
    customer_phone: text(source.customer_phone),
    customer_email: text(source.customer_email),
    arrival_date: toDisplayDate(source.arrival_date),
    outbound_time: text(source.outbound_time),
    departure_date: toDisplayDate(source.departure_date),
    return_time: text(source.return_time),
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

function qualityMeta(value?: string | null) {
  if (value === "high") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (value === "medium") return "border-amber-200 bg-amber-50 text-amber-800";
  return "border-slate-200 bg-slate-100 text-slate-700";
}

function qualityLabel(value?: string | null) {
  if (value === "high") return "Alta";
  if (value === "medium") return "Media";
  return "Bassa";
}

function isOcrHeavyCase(row: PdfImportDetail | null) {
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

function serviceTypeLabel(value?: string | null, variant?: string | null) {
  if (variant === "ferry_naples_transfer") return "Formula Medmar";
  switch (value) {
    case "transfer_station_hotel":
      return "Transfer stazione/hotel";
    case "transfer_airport_hotel":
      return "Transfer aeroporto/hotel";
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

function originalValue(row: PdfImportDetail | null, key: keyof ReviewForm) {
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

function isBusLikeForm(form: Pick<ReviewForm, "transport_mode" | "service_type" | "booking_kind">) {
  return (
    form.transport_mode === "bus" ||
    form.service_type === "bus_line" ||
    form.service_type === "excursion" ||
    form.booking_kind === "bus_city_hotel" ||
    form.booking_kind === "excursion"
  );
}

export function PdfAdvancedReview({
  row,
  onClose,
  onReload,
  onLowConfidence,
  showDebug
}: {
  row: PdfImportDetail;
  onClose: () => void;
  onReload: () => Promise<void>;
  onLowConfidence?: () => void;
  showDebug: boolean;
}) {
  const [reviewForm, setReviewForm] = useState<ReviewForm>(formFromRow(row));
  const [busy, setBusy] = useState<"save" | "confirm" | "ignore" | "delete" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showTechnicalDetails, setShowTechnicalDetails] = useState(row.status !== "confirmed");

  useEffect(() => {
    setReviewForm(formFromRow(row));
    setShowTechnicalDetails(row.status !== "confirmed");
    if (row.review_recommended && onLowConfidence) onLowConfidence();
  }, [row, onLowConfidence]);

  const changedFields = useMemo(() => {
    const keys = Object.keys(reviewForm) as Array<keyof ReviewForm>;
    return keys.filter((key) => reviewForm[key].trim() !== originalValue(row, key).trim());
  }, [reviewForm, row]);

  const busSuggestions = useMemo(() => {
    if (!row || !isBusLikeForm(reviewForm)) return [] as BusSuggestion[];
    const city = reviewForm.arrival_place.trim() || text(row.effective_normalized.arrival_place).trim();
    if (!city) return [] as BusSuggestion[];
    const time = reviewForm.outbound_time.trim() || text(row.effective_normalized.outbound_time).trim() || null;
    const nearest = findNearestBusStop(city, time);
    const all = findBusStopsByCity(city).slice(0, 5);
    const deduped = [
      ...(nearest ? [nearest] : []),
      ...all.filter((item) => !nearest || `${item.lineCode}-${item.stop.city}-${item.stop.time}` !== `${nearest.lineCode}-${nearest.stop.city}-${nearest.stop.time}`)
    ];
    return deduped as BusSuggestion[];
  }, [reviewForm, row]);

  const tokenFetch = async (url: string, body: unknown) => {
    if (!hasSupabaseEnv || !supabase) throw new Error("Supabase non configurato.");
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error("Sessione non valida.");
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body)
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result?.ok) throw new Error(result?.error ?? "Operazione fallita.");
    return result as Record<string, unknown>;
  };

  const saveReview = async () => {
    setBusy("save");
    setError(null);
    setMessage(null);
    if (reviewForm.outbound_time.trim() && !isValidClockTime(reviewForm.outbound_time)) {
      setError("L'orario andata deve essere valido nel formato HH:MM.");
      setBusy(null);
      return;
    }
    if (reviewForm.return_time.trim() && !isValidClockTime(reviewForm.return_time)) {
      setError("L'orario ritorno deve essere valido nel formato HH:MM.");
      setBusy(null);
      return;
    }
    try {
      await tokenFetch("/api/email/pdf-imports/review", {
        inbound_email_id: row.inbound_email_id,
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
      });
      setMessage("Modifiche review salvate.");
      await onReload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Errore salvataggio.");
    } finally {
      setBusy(null);
    }
  };

  const runAction = async (kind: "confirm" | "ignore" | "delete") => {
    setBusy(kind);
    setError(null);
    setMessage(null);
    try {
      const endpoint =
        kind === "confirm"
          ? "/api/email/confirm-pdf"
          : kind === "ignore"
            ? "/api/email/pdf-imports/ignore"
            : "/api/email/pdf-imports/delete";
      const result = await tokenFetch(endpoint, { inbound_email_id: row.inbound_email_id });
      setMessage(
        kind === "confirm"
          ? result.outcome === "imported"
            ? "Import PDF confermato."
            : result.duplicate
              ? `Import fermato: duplicato gia presente (${String(result.existing_service_id ?? "service esistente")}).`
              : "Operazione completata."
          : kind === "ignore"
            ? "Import PDF scartato."
            : "Import PDF eliminato."
      );
      await onReload();
      if (kind !== "confirm") onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Errore operazione.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex h-full flex-col bg-[linear-gradient(180deg,#f8fafc_0%,#ffffff_14%)]">
      <div className="sticky top-0 z-10 border-b border-slate-200 bg-white/90 px-5 py-4 backdrop-blur">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] uppercase tracking-[0.18em] text-slate-400">PDF Advanced Review</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className={`inline-flex rounded-full border px-2 py-1 text-xs font-semibold ${statusMeta(row.status).className}`}>{statusMeta(row.status).label}</span>
              <span className="inline-flex rounded-full border border-sky-200 bg-sky-50 px-2 py-1 text-xs font-semibold text-sky-700">
                {bookingKindLabel(text(row.effective_normalized.booking_kind), text(row.effective_normalized.service_variant))}
              </span>
              {row.review_recommended ? (
                <span className="inline-flex rounded-full border border-amber-200 bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-800">Da verificare</span>
              ) : (
                <span className="inline-flex rounded-full border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-800">OK</span>
              )}
              {row.duplicate ? (
                <span className="inline-flex rounded-full border border-slate-200 bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700">Duplicato</span>
              ) : null}
            </div>
            <h2 className="mt-3 truncate text-xl font-semibold uppercase text-slate-900">{row.customer ?? "Cliente da verificare"}</h2>
            <p className="mt-1 text-sm text-slate-500">{row.agency ?? "Agenzia non rilevata"} · creato {formatIsoDateTimeShort(row.created_at)}</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-600 shadow-sm hover:bg-slate-50">Chiudi</button>
        </div>
        <div className="mt-4 grid gap-2 sm:grid-cols-3">
          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2">
            <p className="text-[11px] uppercase tracking-[0.12em] text-slate-400">Parsing</p>
            <p className="mt-1 text-sm font-semibold text-slate-900">{parserLabel(row.parser_key)}</p>
            <p className="text-xs text-slate-500">{parserModeLabel(row.parser_mode)}</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2">
            <p className="text-[11px] uppercase tracking-[0.12em] text-slate-400">Confidence</p>
            <p className="mt-1 text-sm font-semibold text-slate-900">{qualityLabel(row.parsing_quality)}</p>
            <p className="text-xs text-slate-500">{row.missing_fields.length} campi incerti</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2">
            <p className="text-[11px] uppercase tracking-[0.12em] text-slate-400">Service</p>
            <p className="mt-1 text-sm font-semibold text-slate-900">{row.linked_service_id ?? "Non creato"}</p>
            <p className="text-xs text-slate-500">{row.linked_service_status ?? "stato non disponibile"}</p>
          </div>
        </div>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-5 py-5">
        {message ? <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{message}</div> : null}
        {error ? <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</div> : null}

        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_1px_0_rgba(15,23,42,0.03)]">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="font-semibold text-slate-900">Riepilogo operativo</p>
              <p className="mt-1 text-xs text-slate-600">Vista sintetica per decidere subito se approvare, correggere o ignorare.</p>
            </div>
            <button type="button" onClick={() => setShowTechnicalDetails((current) => !current)} className="btn-secondary px-3 py-2 text-xs">
              {showTechnicalDetails ? "Nascondi debug" : "Mostra debug"}
            </button>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"><p className="text-xs uppercase tracking-[0.06em] text-slate-500">Cliente</p><p className="mt-1 font-medium uppercase text-slate-800">{row.customer ?? "Cliente da verificare"}</p></div>
            <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"><p className="text-xs uppercase tracking-[0.06em] text-slate-500">Agenzia</p><p className="mt-1 font-medium text-slate-800">{row.agency ?? "Agenzia non rilevata"}</p></div>
            <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"><p className="text-xs uppercase tracking-[0.06em] text-slate-500">Data servizio</p><p className="mt-1 font-medium text-slate-800">{formatIsoDateShort(text(row.effective_normalized.arrival_date) || row.arrival_date)}</p></div>
            <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"><p className="text-xs uppercase tracking-[0.06em] text-slate-500">Destinazione</p><p className="mt-1 font-medium uppercase text-slate-800">{text(row.effective_normalized.hotel_or_destination) || row.hotel_or_destination || "N/D"}</p></div>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_1px_0_rgba(15,23,42,0.03)]">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="font-semibold text-slate-900">Review campi</p>
              <p className="mt-1 text-xs text-slate-500">Le modifiche aggiornano i `reviewed_values` e marcano la review manuale.</p>
            </div>
            {changedFields.length > 0 ? <span className="rounded-full border border-indigo-200 bg-indigo-50 px-2 py-1 text-xs font-semibold text-indigo-700">{changedFields.length} campi modificati</span> : null}
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <label className="space-y-1"><span className="text-xs font-semibold uppercase tracking-[0.06em] text-slate-600">Cliente</span><input className="input-saas" value={reviewForm.customer_full_name} onChange={(event) => setReviewForm((current) => ({ ...current, customer_full_name: event.target.value }))} /></label>
            <label className="space-y-1"><span className="text-xs font-semibold uppercase tracking-[0.06em] text-slate-600">Agenzia fatturazione</span><input className="input-saas" value={reviewForm.billing_party_name} onChange={(event) => setReviewForm((current) => ({ ...current, billing_party_name: event.target.value }))} /></label>
            <label className="space-y-1"><span className="text-xs font-semibold uppercase tracking-[0.06em] text-slate-600">Data arrivo</span><input className="input-saas" value={reviewForm.arrival_date} onChange={(event) => setReviewForm((current) => ({ ...current, arrival_date: event.target.value }))} /></label>
            <label className="space-y-1"><span className="text-xs font-semibold uppercase tracking-[0.06em] text-slate-600">{getOutwardTimeLabel(reviewContext(reviewForm))}</span><input type="time" step="300" className="input-saas" value={reviewForm.outbound_time} onChange={(event) => setReviewForm((current) => ({ ...current, outbound_time: event.target.value }))} /></label>
            <label className="space-y-1 md:col-span-2"><span className="text-xs font-semibold uppercase tracking-[0.06em] text-slate-600">Hotel / destinazione</span><input className="input-saas" value={reviewForm.hotel_or_destination} onChange={(event) => setReviewForm((current) => ({ ...current, hotel_or_destination: event.target.value }))} /></label>
            <label className="space-y-1"><span className="text-xs font-semibold uppercase tracking-[0.06em] text-slate-600">Passeggeri</span><input className="input-saas" value={reviewForm.passengers} onChange={(event) => setReviewForm((current) => ({ ...current, passengers: event.target.value }))} /></label>
            <label className="space-y-1"><span className="text-xs font-semibold uppercase tracking-[0.06em] text-slate-600">Numero pratica</span><input className="input-saas" value={reviewForm.practice_number} onChange={(event) => setReviewForm((current) => ({ ...current, practice_number: event.target.value }))} /></label>
            <label className="space-y-1"><span className="text-xs font-semibold uppercase tracking-[0.06em] text-slate-600">Data ritorno</span><input className="input-saas" value={reviewForm.departure_date} onChange={(event) => setReviewForm((current) => ({ ...current, departure_date: event.target.value }))} /></label>
            <label className="space-y-1"><span className="text-xs font-semibold uppercase tracking-[0.06em] text-slate-600">{getReturnTimeLabel(reviewContext(reviewForm))}</span><input type="time" step="300" className="input-saas" value={reviewForm.return_time} onChange={(event) => setReviewForm((current) => ({ ...current, return_time: event.target.value }))} /></label>
            <label className="space-y-1 md:col-span-2"><span className="text-xs font-semibold uppercase tracking-[0.06em] text-slate-600">Note</span><textarea rows={2} className="input-saas resize-none" value={reviewForm.notes} onChange={(event) => setReviewForm((current) => ({ ...current, notes: event.target.value }))} /></label>
          </div>
          {busSuggestions.length > 0 ? (
            <div className="mt-4 rounded-2xl border border-sky-200 bg-sky-50/60 p-3">
              <p className="font-semibold text-slate-900">Suggerimenti bus</p>
              <div className="mt-2 space-y-2">
                {busSuggestions.map((item, index) => (
                  <button
                    key={`${item.lineCode}-${item.stop.city}-${item.stop.time}-${index}`}
                    type="button"
                    className="block w-full rounded-lg border border-sky-100 bg-white px-3 py-2 text-left text-sm hover:bg-sky-50"
                    onClick={() =>
                      setReviewForm((current) => ({
                        ...current,
                        arrival_place: item.stop.city,
                        outbound_time: item.stop.time,
                        notes: [current.notes, item.stop.pickupNote].filter(Boolean).join(" | ")
                      }))
                    }
                  >
                    <p className="font-medium text-slate-800">{item.lineName} · {item.stop.city} · {item.stop.time}</p>
                    <p className="text-xs text-slate-600">{item.stop.pickupNote ?? "Punto pickup non specificato"}</p>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        {showTechnicalDetails ? (
          <div className="space-y-4">
            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3 text-sm">
                <p className="font-semibold text-slate-800">Parsing</p>
                <div className="mt-2 space-y-1 text-slate-700">
                  <p>Parser: {parserLabel(row.parser_key)} ({parserModeLabel(row.parser_mode)})</p>
                  <p>Qualita: <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${qualityMeta(row.parsing_quality)}`}>{row.parsing_quality ?? "low"}</span></p>
                  <p>Confidence parser: {row.parser_selection_confidence ?? "N/D"}</p>
                  <p>Reason: {row.parser_selection_reason ?? "N/D"}</p>
                  <p>Fallback: {row.fallback_reason ?? "N/D"}</p>
                </div>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3 text-sm">
                <p className="font-semibold text-slate-800">Campi deboli</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {row.missing_fields.length > 0 ? row.missing_fields.map((field) => <span key={field} className="inline-flex rounded-full border border-amber-200 bg-white px-2 py-1 text-xs text-amber-800">{field}</span>) : <span className="text-xs">Nessun campo critico mancante.</span>}
                </div>
                {row.possible_existing_matches.length > 0 ? <p className="mt-3 text-xs text-rose-700">Possibili pratiche esistenti rilevate: verifica prima di confermare.</p> : null}
                {isOcrHeavyCase(row) ? <p className="mt-2 text-xs text-amber-700">OCR rumoroso: review manuale consigliata.</p> : null}
              </div>
            </div>
            {showDebug ? (
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <p className="font-semibold text-slate-800">Raw parsing</p>
                  <span className="text-xs text-slate-400">Solo admin</span>
                </div>
                <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-white p-3 text-[11px] text-slate-700">{JSON.stringify({
                  raw_inbound_parser: row.raw_inbound_parser,
                  raw_transfer_parser: row.raw_transfer_parser,
                  parser_logs: row.parser_logs,
                  fields_found: row.fields_found,
                  status_events: row.status_events
                }, null, 2)}</pre>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="sticky bottom-0 border-t border-slate-200 bg-white/95 px-5 py-4 backdrop-blur">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => void saveReview()} disabled={busy !== null} className="btn-secondary px-3 py-2 text-xs disabled:opacity-50">
            {busy === "save" ? "Salvo..." : "Salva modifiche"}
          </button>
          <button type="button" onClick={() => void runAction("confirm")} disabled={busy !== null || !(row.status === "draft" || row.status === "preview")} className="btn-primary px-3 py-2 text-xs disabled:opacity-50">
            {busy === "confirm" ? "Confermo..." : "Approva servizio"}
          </button>
          <button type="button" onClick={() => void runAction("ignore")} disabled={busy !== null || row.status === "confirmed" || row.status === "ignored"} className="btn-secondary px-3 py-2 text-xs disabled:opacity-50">
            {busy === "ignore" ? "Scarto..." : "Ignora"}
          </button>
          <button type="button" onClick={() => { if (!window.confirm("Eliminare questo PDF importato e l'eventuale servizio collegato?")) return; void runAction("delete"); }} disabled={busy !== null} className="btn-secondary px-3 py-2 text-xs text-rose-700 disabled:opacity-50">
            {busy === "delete" ? "Elimino..." : "Elimina"}
          </button>
          <span className="ml-auto text-[11px] text-slate-400">Review manuale solo quando serve, conferma diretta quando il parsing è pulito.</span>
        </div>
      </div>
    </div>
  );
}
