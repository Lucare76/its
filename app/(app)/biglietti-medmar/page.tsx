"use client";

import { useEffect, useMemo, useState, useCallback, useReducer, useRef } from "react";
import Link from "next/link";
import { DateInput } from "@/components/ui";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";
import { getClientSessionContext } from "@/lib/supabase/client-session";
import type { Hotel, Service } from "@/lib/types";
import { getDepartureFerryLabel } from "@/lib/service-display";
import {
  MEDMAR_TICKET_ROUTE_OPTIONS,
  formatSlotLabel,
  type MedmarTicketRouteCode,
} from "@/lib/medmar-ticket-memory";
import {
  medmarPrepareReducer,
  canConfirmIssue,
  isTokenExpired,
  isRetryableIssueFailure,
  serviceIdsMatch,
  shouldAutoPrepareAfterPreflight,
  type MedmarPrepareState,
  type MedmarDeliveryDiagnostics,
} from "@/lib/medmar-issue-flow";
import {
  resolveMedmarGroupDelivery,
  isMedmarDeliveryRetryButtonVisible,
  isMedmarManualFallbackVisible,
  canResendMedmarTicket,
  MEDMAR_DELIVERY_AUTO_RETRY_STATUSES,
} from "@/lib/medmar-delivery-card";
import { extractMedmarPractice, medmarBookingGroupKey } from "@/lib/medmar-booking-group";
import {
  matchesMedmarSearch,
  matchesMedmarSentDateFilter,
  medmarSentDateKey,
  MEDMAR_SENT_DATE_FILTER_OPTIONS,
  MEDMAR_DEFAULT_SENT_DATE_FILTER,
  type MedmarSearchableGroup,
  type MedmarSentDateFilter,
} from "@/lib/medmar-ticket-search";

// ─── Helpers ────────────────────────────────────────────────────────────────

function isMedmarService(s: Service): boolean {
  return (s.vessel ?? "").toLowerCase().includes("medmar");
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  const months = ["gen","feb","mar","apr","mag","giu","lug","ago","set","ott","nov","dic"];
  const days = ["Dom","Lun","Mar","Mer","Gio","Ven","Sab"];
  const dow = new Date(`${iso}T12:00:00Z`).getUTCDay();
  return `${days[dow]} ${d} ${months[Number(m) - 1]} ${y}`;
}

async function copyText(text: string): Promise<void> {
  try { await navigator.clipboard.writeText(text); } catch { /* ignore */ }
}

async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]!);
  }
  return btoa(binary);
}

// ─── Tipi ────────────────────────────────────────────────────────────────────

type BookingGroup = {
  key: string;
  customerName: string;
  phone: string | null;
  agencyName: string | null;
  pax: number;
  arrivo: Service | null;
  partenza: Service | null;
  hotel: string;
  pratica: string;
  refDate: string;
  allServiceIds: string[];
  sentAt: string | null; // medmar_ticket_sent_at del primo servizio
};

type TicketMemoryRecord = {
  id: string;
  route_code: MedmarTicketRouteCode;
  travel_date: string;
  departure_time: string | null;
  issue_date: string | null;
  ticket_number: string | null;
  booking_code: string | null;
  voucher_label: string | null;
  tariff_label: string | null;
  price_cents: number | null;
  quantity: number;
  status: "available" | "matched" | "used" | "expired";
  matched_service_id: string | null;
  photo_path: string | null;
  photo_url: string | null;
  notes: string | null;
  created_at: string;
};

type TicketMemorySlot = {
  key: string;
  route_code: MedmarTicketRouteCode;
  travel_date: string;
  departure_time: string | null;
  available_quantity: number;
  tickets: TicketMemoryRecord[];
  matched_services: Array<{
    service_id: string;
    customer_name: string | null;
    hotel_name: string | null;
    pax: number | null;
    date: string;
    time: string | null;
    direction: "arrival" | "departure";
    vessel: string | null;
    score: number;
    reasons: string[];
  }>;
};

type MedmarPreflightLeg = {
  direction: "outward" | "return";
  route: { from: string; to: string } | null;
  date: string;
  requested_time: string | null;
  matched_departure_time: string | null;
  vessel: string | null;
  id_corsa: number | string | null;
  source: "live" | "local_fallback" | null;
};

type MedmarPassengerTicket = {
  count: number;
  id_biglietto: number | string | null;
  id_log: number | string | null;
  label: string | null;
  unit_price_cents: number | null;
  total_cents: number | null;
};

type MedmarPreflightResult = {
  ok: boolean;
  can_issue: boolean;
  status:
    | "ok" | "no_match" | "ambiguous" | "not_medmar" | "manual_review" | "route_mismatch"
    | "unsupported_passenger_type"
    // Fase 2B.5: bambino/infant classificati e prezzati correttamente, ma emissione volutamente ancora bloccata (vedi passengers/ticket_breakdown sotto).
    | "passenger_payload_pending_verification"
    // Fase 2B.8: controllo temporale ITS proprio (corsa già partita / ordine A/R stesso giorno) — vedi rendering leg sotto.
    | "course_already_departed" | "invalid_same_day_return_order"
    | "medmar_unavailable" | "medmar_auth_expired" | "error";
  customer_name: string | null;
  pratica: string | null;
  pax: number;
  outward: MedmarPreflightLeg | null;
  return: MedmarPreflightLeg | null;
  tariff: {
    id_biglietto: number | string | null;
    id_tariffa: number | string | null;
    label: string | null;
    unit_price_cents: number | null;
    source: "medmar_live" | "ticket_memory" | "unknown";
  } | null;
  taxes: Array<{ label: string; amount_cents: number | null }>;
  expected_total_cents: number | null;
  is_live: boolean;
  warnings: Array<{ code: string; message: string; leg?: "outward" | "return" }>;
  error: string | null;
  passengers: { adults: number; children: number; infants: number; source: "medmar_counts" | "pax_fallback" } | null;
  ticket_breakdown: {
    adult: MedmarPassengerTicket | null;
    child: MedmarPassengerTicket | null;
    infant: MedmarPassengerTicket | null;
    taxes: { count: number; label: string | null; unit_amount_cents: number | null; total_amount_cents: number | null } | null;
  } | null;
};

type MedmarAutoDeliverySummary = {
  status: string;
  warning: string | null;
  recipient_email: string | null;
};

type MedmarIssueResult =
  | {
      ok: true;
      status: "completed";
      medmar_id_prenotazione: string;
      medmar_numero: string;
      final_total_cents: number;
      existing: boolean;
      /** Presente solo dopo il collegamento auto-delivery (Fase auto-delivery): esito dell'invio automatico tentato subito dopo l'emissione. */
      delivery?: MedmarAutoDeliverySummary;
    }
  | {
      ok: false;
      status: string;
      error: string;
      retry_allowed: boolean;
    };

type MedmarPrepareApiResponse =
  | {
      ok: true;
      confirmation_token: string;
      expires_at: string;
      expected_total_cents: number;
      route: { outward: MedmarPreflightLeg | null; return: MedmarPreflightLeg | null };
      pax: number;
      service_ids: string[];
      issuing_enabled: boolean;
      delivery: MedmarDeliveryDiagnostics;
    }
  | { ok: false; status: string; error: string };

/**
 * Risposta di GET /api/services/medmar-delivery-summary — sola lettura, per
 * il box "Credito e biglietti Medmar" (evoluzione del contatore coda,
 * biglietti-medmar PARTE 3 + "Credito e fabbisogno Medmar"). I campi
 * today/queue/oldest_pending/last_delivered/last_error sono il contatore
 * coda originale, invariato; activity/forecast/credit/credit_evaluation
 * sono l'aggiunta.
 */
type MedmarQueueSummary = {
  ok: true;
  tenant_id: string;
  timezone: string;
  as_of: string;
  window_start: string;
  today: { issued: number; delivered: number };
  queue: { awaiting_pdf: number; ready: number; in_progress: number; errors: number };
  oldest_pending: { id: string; status: string; created_at: string } | null;
  last_delivered: { id: string; medmar_numero: string | null; delivered_at: string } | null;
  last_error: { id: string; status: string; last_error_code: string | null; updated_at: string } | null;
  activity: {
    issued_today_count: number;
    issued_today_amount_cents: number;
    delivered_today_count: number;
    delivered_today_amount_cents: number | null;
    last_issued_amount_cents: number | null;
    last_delivered_amount_cents: number | null;
  };
  forecast: {
    upcoming_3d_candidate_services: number;
    upcoming_3d_estimated_tickets: number;
    upcoming_3d_estimated_amount_cents: number | null;
    upcoming_3d_amount_source: "preflight_local" | "historical_average" | "service_price" | "unavailable";
  };
  credit: {
    type: "real" | "manual_estimated" | "env_estimated" | "unavailable";
    initial_credit_cents: number | null;
    total_topups_cents: number | null;
    total_issued_cents: number | null;
    available_cents: number | null;
    safety_threshold_cents: number;
    updated_at: string | null;
  };
  credit_evaluation: {
    status: "sufficient" | "warning" | "insufficient" | "unknown";
    shortfall_cents: number | null;
    safety_threshold_cents: number;
  };
};

// Fase 2B.4: kill switch di fase, indipendente dalla capability
// server-derived "issuing_enabled" restituita da /prepare. Entrambi devono
// essere true perche' la CTA finale sia mai selezionabile — vedi
// canConfirmIssue() in lib/medmar-issue-flow.ts per il gate sui dati, e il
// controllo `!MEDMAR_ISSUING_UI_ENABLED` nel render per il gate di fase.
const MEDMAR_ISSUING_UI_ENABLED = true;

const MEDMAR_TECHNICAL_WARNING_CODES = new Set([
  "island_port_resolved",
  "local_schedule_diagnostic",
  "embedded_return_leg_used",
]);

function isMedmarTechnicalDiagnostic(warning: { code: string }) {
  return MEDMAR_TECHNICAL_WARNING_CODES.has(warning.code);
}

function formatEur(cents: number | null | undefined) {
  if (typeof cents !== "number") return "—";
  return (cents / 100).toLocaleString("it-IT", { style: "currency", currency: "EUR" });
}

async function apiFetch<T>(path: string, token: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options?.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => null) as (T & { ok?: boolean; error?: string }) | null;
  if (!res.ok || !body?.ok) {
    throw new Error(body?.error ?? `Errore HTTP ${res.status}`);
  }
  return body;
}

/**
 * A differenza di apiFetch, NON lancia su risposte non-2xx: prepare/issue
 * restituiscono sempre un body JSON strutturato (ok/status/error) anche su
 * 409/422/403, e la UI ha bisogno di quello status esatto (es.
 * remote_state_unknown, already_in_progress) per l'error UX richiesta —
 * un throw generico lo perderebbe.
 */
async function apiFetchJson<T>(path: string, token: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options?.headers ?? {}),
    },
  });
  const body = (await res.json().catch(() => null)) as T | null;
  if (!body) {
    throw new Error(`Errore HTTP ${res.status}`);
  }
  return body;
}

/** Etichette/tone per il box "Credito e biglietti Medmar" (evoluzione del contatore coda). */
const MEDMAR_CREDIT_TYPE_LABEL: Record<MedmarQueueSummary["credit"]["type"], string> = {
  real: "reale Medmar",
  manual_estimated: "stimato/manuale",
  env_estimated: "stimato/manuale (env)",
  unavailable: "non disponibile",
};

const MEDMAR_CREDIT_STATUS_LABEL: Record<MedmarQueueSummary["credit_evaluation"]["status"], string> = {
  sufficient: "Credito sufficiente",
  warning: "Attenzione: credito vicino alla soglia",
  insufficient: "Credito probabilmente insufficiente",
  unknown: "Credito non valutabile",
};

const MEDMAR_CREDIT_STATUS_TONE: Record<MedmarQueueSummary["credit_evaluation"]["status"], keyof typeof QUEUE_STAT_TONES> = {
  sufficient: "emerald",
  warning: "amber",
  insufficient: "rose",
  unknown: "slate",
};

const MEDMAR_DELIVERY_STATUS_LABEL: Record<string, string> = {
  awaiting_pdf: "PDF Medmar non ancora disponibile. Il sistema riproverà automaticamente.",
  pdf_found: "PDF trovato",
  pdf_cleaned: "PDF pulito",
  delivery_started: "Invio automatico in corso",
  delivery_in_progress: "Invio automatico ancora in corso (ricerca PDF lenta): verifica più tardi",
  delivered: "Biglietto inviato",
  pdf_not_found: "PDF Medmar non ancora disponibile. Il sistema riproverà automaticamente.",
  pdf_ambiguous: "Revisione manuale richiesta (PDF ambiguo)",
  pdf_validation_failed: "Revisione manuale richiesta (PDF non validato)",
  recipient_missing: "Revisione manuale richiesta (destinatario mancante)",
  delivery_failed: "Invio non riuscito",
  delivery_error: "Invio non riuscito (errore interno)",
  delivery_state_unknown: "Stato invio incerto: non reinviare automaticamente",
  manual_review: "Revisione manuale richiesta",
  issuing_attempt_not_found: "Revisione manuale richiesta (emissione non trovata)",
  issuing_not_completed: "Revisione manuale richiesta (emissione non completata)",
  remote_state_unknown_blocked: "Stato invio incerto: non reinviare automaticamente",
};

/** Solo questi stati mostrano il pulsante manuale come fallback: mai per stati terminali o "incerti" (nessun retry automatico su ambiguità). */
const MEDMAR_DELIVERY_RETRYABLE_STATUSES = new Set([
  "pdf_not_found",
  "pdf_ambiguous",
  "pdf_validation_failed",
  "recipient_missing",
  "delivery_failed",
  "delivery_error",
  "manual_review",
]);

function formatDateTimeIt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("it-IT", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function addMinutesIso(iso: string, minutes: number): string {
  const d = new Date(iso);
  d.setMinutes(d.getMinutes() + minutes);
  return d.toISOString();
}

/** Riga letta da medmar_delivery_attempts per popolare la card compatta/i dettagli in lista (sola lettura, nessuna mutazione). */
type MedmarDeliveryAttemptRow = {
  id: string;
  issuing_attempt_id: string;
  service_ids: string[];
  status: string;
  medmar_id_prenotazione: string | null;
  medmar_numero: string | null;
  pdf_mailbox_message_uid: string | null;
  recipient_type: string | null;
  recipient_name: string | null;
  recipient_email: string | null;
  resend_message_id: string | null;
  attempt_count: number;
  last_error_code: string | null;
  last_error_message: string | null;
  delivered_at: string | null;
  updated_at: string;
};

/** Riga letta da medmar_ticket_resends (sola lettura, RLS gia' limita a admin/operator/supervisor del tenant) — PARTE 6 storico reinvii. */
type MedmarTicketResendRow = {
  id: string;
  delivery_attempt_id: string;
  recipient_email: string;
  status: "started" | "sent" | "failed";
  error_message: string | null;
  created_at: string;
  sent_at: string | null;
};

function medmarDeliveryStatusLabel(status: string | undefined, recipient: string | null | undefined): string {
  if (!status) return "—";
  if (status === "delivered" && recipient) return `✅ Biglietto inviato a ${recipient}`;
  return MEDMAR_DELIVERY_STATUS_LABEL[status] ?? status;
}

const QUEUE_STAT_TONES = {
  blue: "border-blue-200 bg-blue-50 text-blue-700",
  amber: "border-amber-200 bg-amber-50 text-amber-700",
  indigo: "border-indigo-200 bg-indigo-50 text-indigo-700",
  slate: "border-slate-200 bg-slate-50 text-slate-700",
  emerald: "border-emerald-200 bg-emerald-50 text-emerald-700",
  rose: "border-rose-200 bg-rose-50 text-rose-700",
} as const;

/** Riquadro compatto del box "Credito e biglietti Medmar": un valore (+ sublabel opzionale, es. importo) + un'etichetta, colore in base allo stato. */
function QueueStatChip({
  label,
  value,
  sublabel,
  tone,
}: {
  label: string;
  value: string | number;
  sublabel?: string;
  tone: keyof typeof QUEUE_STAT_TONES;
}) {
  return (
    <div className={`rounded-xl border px-3 py-2 text-center ${QUEUE_STAT_TONES[tone]}`}>
      <p className="text-lg font-extrabold leading-tight">{value}</p>
      {sublabel && <p className="text-[10px] font-semibold leading-tight">{sublabel}</p>}
      <p className="text-[10px] font-semibold uppercase tracking-wide leading-tight">{label}</p>
    </div>
  );
}

// ─── Componente ─────────────────────────────────────────────────────────────

export default function BigliettiMedmarPage() {
  const [services, setServices] = useState<Service[]>([]);
  const [hotels, setHotels] = useState<Hotel[]>([]);
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dateFrom, setDateFrom] = useState(todayIso());
  const [dateTo, setDateTo] = useState(addDays(todayIso(), 14));
  const [copied, setCopied] = useState<string | null>(null);
  const [sending, setSending] = useState<string | null>(null); // key del gruppo in invio
  const [sentKeys, setSentKeys] = useState<Set<string>>(new Set());
  const [showSent, setShowSent] = useState(false);
  const [medmarSearchQuery, setMedmarSearchQuery] = useState("");
  const [medmarAgencyFilter, setMedmarAgencyFilter] = useState("all");
  const [selectedMedmarGroupKey, setSelectedMedmarGroupKey] = useState<string | null>(null);
  const [medmarSentDateFilter, setMedmarSentDateFilter] = useState<MedmarSentDateFilter>(MEDMAR_DEFAULT_SENT_DATE_FILTER);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [sendModal, setSendModal] = useState<{ group: BookingGroup; pdfFile: File | null } | null>(null);
  const [verifying, setVerifying] = useState<string | null>(null); // key del gruppo in verifica
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [verifyModal, setVerifyModal] = useState<{ group: BookingGroup; result: MedmarPreflightResult } | null>(null);
  const [medmarDelivery, setMedmarDelivery] = useState<{
    phase: "idle" | "sending" | "done";
    status?: string;
    error?: string;
    recipient?: string | null;
    attemptCount?: number;
    lastAttemptAt?: string;
  }>({ phase: "idle" });
  const [medmarPrepareState, dispatchMedmarPrepare] = useReducer(
    medmarPrepareReducer,
    { phase: "idle" } as MedmarPrepareState
  );
  const [deliveryAttempts, setDeliveryAttempts] = useState<MedmarDeliveryAttemptRow[]>([]);
  const [resendsByDeliveryAttemptId, setResendsByDeliveryAttemptId] = useState<Map<string, MedmarTicketResendRow[]>>(new Map());
  const [resendModal, setResendModal] = useState<{ groupKey: string; customerName: string; attempt: MedmarDeliveryAttemptRow } | null>(null);
  const [resendSending, setResendSending] = useState(false);
  const [resendError, setResendError] = useState<string | null>(null);
  const [resendSuccess, setResendSuccess] = useState<string | null>(null);
  const [queueSummary, setQueueSummary] = useState<MedmarQueueSummary | null>(null);
  /** Rif. sempre aggiornato al token corrente, per leggerlo da refreshMedmarData senza doverlo aggiungere alle sue dipendenze (eviterebbe che ogni cambio di token ricrei la funzione e riattivi l'useEffect di caricamento iniziale). */
  const tokenRef = useRef<string | null>(null);
  const [issuingFinalTotalById, setIssuingFinalTotalById] = useState<Map<string, number | null>>(new Map());
  const [expandedDeliveredKeys, setExpandedDeliveredKeys] = useState<Set<string>>(new Set());
  const [retryingKey, setRetryingKey] = useState<string | null>(null);
  const [ticketMemories, setTicketMemories] = useState<TicketMemoryRecord[]>([]);
  const [ticketSlots, setTicketSlots] = useState<TicketMemorySlot[]>([]);
  const [memoryError, setMemoryError] = useState<string | null>(null);
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [memoryModalOpen, setMemoryModalOpen] = useState(false);
  const [memorySubmitting, setMemorySubmitting] = useState(false);
  const [memoryExtracting, setMemoryExtracting] = useState(false);
  const [memoryPhoto, setMemoryPhoto] = useState<File | null>(null);
  const [memoryRawText, setMemoryRawText] = useState("");
  const [memoryForm, setMemoryForm] = useState({
    route_code: "casamicciola_pozzuoli" as MedmarTicketRouteCode,
    travel_date: todayIso(),
    departure_time: "",
    issue_date: todayIso(),
    ticket_number: "",
    booking_code: "",
    voucher_label: "",
    tariff_label: "ADULTO - TARIFFA SPECIALE AR",
    price_eur: "10.25",
    quantity: "1",
    notes: "",
  });

  const handleDelete = async (g: BookingGroup) => {
    if (!supabase || !tenantId) return;
    if (!confirm(`Eliminare la prenotazione di ${g.customerName}? L'operazione non è reversibile.`)) return;
    setDeleting(g.key);
    await supabase.from("services").delete().in("id", g.allServiceIds).eq("tenant_id", tenantId);
    setDeleting(null);
    if (tenantId) void refreshMedmarData(tenantId, dateFrom, dateTo);
  };

  // STEP 1 -> STEP 2: preflight/local validation server-side, SOLO
  // lettura verso Medmar. Nessuna mutazione Medmar puo' partire da questa
  // chiamata (vedi app/api/services/medmar-issue/prepare/route.ts).
  const runPrepareMedmar = useCallback(async (g: BookingGroup) => {
    if (!token) return;
    dispatchMedmarPrepare({ type: "PREPARE_START" });
    try {
      const data = await apiFetchJson<MedmarPrepareApiResponse>("/api/services/medmar-issue/prepare", token, {
        method: "POST",
        body: JSON.stringify({ service_ids: g.allServiceIds }),
      });
      if (data.ok) {
        dispatchMedmarPrepare({
          type: "PREPARE_SUCCESS",
          payload: {
            confirmation_token: data.confirmation_token,
            expires_at: data.expires_at,
            expected_total_cents: data.expected_total_cents,
            route: data.route,
            pax: data.pax,
            issuing_enabled: data.issuing_enabled,
            service_ids: data.service_ids,
            delivery: data.delivery,
          },
        });
      } else {
        dispatchMedmarPrepare({ type: "PREPARE_FAILURE", status: data.status, error: data.error });
      }
    } catch (err) {
      dispatchMedmarPrepare({
        type: "PREPARE_FAILURE",
        status: "prepare_failed",
        error: err instanceof Error ? err.message : "Preparazione emissione non riuscita.",
      });
    }
  }, [token]);

  /**
   * UX 2-click (biglietti-medmar PARTE 1) — CLICK 1: "Emetti biglietto
   * Medmar" fa preflight e, se shouldAutoPrepareAfterPreflight() e' true
   * (can_issue && is_live, vedi lib/medmar-issue-flow.ts), incatena subito
   * la preparazione (POST /prepare) cosi' il modal si apre gia' col
   * riepilogo pronto per il CLICK 2 di conferma — nessun secondo click
   * intermedio a vuoto. Se il preflight fallisce o i dati non bastano, si
   * ferma qui esattamente come prima (nessuna mutazione Medmar possibile).
   */
  const handleVerifyMedmar = async (g: BookingGroup) => {
    if (!token) return;
    setVerifying(g.key);
    setVerifyError(null);
    dispatchMedmarPrepare({ type: "RESET" });
    try {
      const data = await apiFetch<MedmarPreflightResult>("/api/services/medmar-preflight", token, {
        method: "POST",
        body: JSON.stringify({ service_ids: g.allServiceIds }),
      });
      setVerifyModal({ group: g, result: data });
      if (shouldAutoPrepareAfterPreflight(data)) {
        await runPrepareMedmar(g);
      }
    } catch (err) {
      setVerifyError(err instanceof Error ? err.message : "Errore durante la verifica Medmar.");
    } finally {
      setVerifying(null);
    }
  };

  /** Fallback manuale: ripete la preparazione solo dopo un PREPARE_FAILURE (es. errore di rete transitorio) — mai il percorso normale, che e' sempre automatico dal click 1. */
  const handlePrepareMedmar = async () => {
    if (!verifyModal) return;
    if (medmarPrepareState.phase === "preparing" || medmarPrepareState.phase === "prepared") return;
    await runPrepareMedmar(verifyModal.group);
  };

  // STEP 2: consuma il confirmation_token single-use ottenuto da /prepare.
  // Il vero gate di sicurezza e' server-side (token DB-backed + feature
  // flag); questo controllo client-side e' solo UX (evita una chiamata
  // inutile quando gia' sappiamo che non puo' avere successo).
  const handleConfirmIssueMedmar = async () => {
    if (!token || !verifyModal) return;
    if (medmarPrepareState.phase !== "prepared") return;
    if (!serviceIdsMatch(medmarPrepareState.service_ids, verifyModal.group.allServiceIds)) {
      dispatchMedmarPrepare({
        type: "ISSUE_FAILURE",
        status: "confirmation_scope_mismatch",
        error: "La conferma non corrisponde piu' ai servizi selezionati. Ripeti la preparazione.",
        retry_allowed: false,
      });
      return;
    }
    if (isTokenExpired(medmarPrepareState)) {
      dispatchMedmarPrepare({ type: "TOKEN_EXPIRED" });
      return;
    }
    const confirmationToken = medmarPrepareState.confirmation_token;
    dispatchMedmarPrepare({ type: "CONFIRM_START" });
    try {
      const data = await apiFetchJson<MedmarIssueResult>("/api/services/medmar-issue", token, {
        method: "POST",
        body: JSON.stringify({ service_ids: verifyModal.group.allServiceIds, confirmation_token: confirmationToken }),
      });
      if (data.ok) {
        dispatchMedmarPrepare({ type: "ISSUE_SUCCESS", result: data });
        if (data.delivery) {
          setMedmarDelivery({ phase: "done", status: data.delivery.status, error: data.delivery.warning ?? undefined, recipient: data.delivery.recipient_email });
        }
        // PARTE 2: refresh immediato — la card in lista deve riflettere subito
        // l'emissione appena completata (codice/id/prenotazione/stato invio),
        // senza richiedere un refresh manuale del browser.
        if (tenantId) void refreshMedmarData(tenantId, dateFrom, dateTo);
      } else {
        dispatchMedmarPrepare({ type: "ISSUE_FAILURE", status: data.status, error: data.error, retry_allowed: data.retry_allowed });
      }
    } catch (err) {
      dispatchMedmarPrepare({
        type: "ISSUE_FAILURE",
        status: "request_failed",
        error: err instanceof Error ? err.message : "Emissione non riuscita.",
        retry_allowed: false,
      });
    }
  };

  const handleCopy = (text: string, key: string) => {
    void copyText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(null), 1800);
    });
  };

  const loadData = useCallback(async (tid: string, from?: string, to?: string): Promise<Service[]> => {
    if (!supabase) return [];
    const qFrom = /^\d{4}-\d{2}-\d{2}$/.test(from ?? "") ? from! : todayIso();
    const qTo   = /^\d{4}-\d{2}-\d{2}$/.test(to ?? "")   ? to!   : addDays(todayIso(), 14);
    const [servicesRes, hotelsRes] = await Promise.all([
      supabase.from("services")
        .select("*, medmar_ticket_sent_at, medmar_ticket_sent_by")
        .eq("tenant_id", tid)
        .eq("is_draft", false)
        .neq("status", "cancelled")
        .neq("status", "pending_cancellation")
        .gte("date", qFrom)
        .lte("date", qTo)
        .order("date")
        .order("time"),
      supabase.from("hotels").select("id, name").eq("tenant_id", tid).limit(500)
    ]);
    if (servicesRes.error) { setError(servicesRes.error.message); return []; }
    const loadedServices = (servicesRes.data ?? []) as Service[];
    setServices(loadedServices);
    setHotels((hotelsRes.data ?? []) as Hotel[]);
    return loadedServices;
  }, []);

  /**
   * Stato delivery Medmar per la card compatta/dettagli (sola lettura,
   * FASE 1/2/5): legge medmar_delivery_attempts (RLS gia' limita a
   * admin/operator/supervisor del tenant) e, per i soli attempt trovati,
   * medmar_issuing_attempts.final_total_cents da mostrare nei dettagli.
   * Nessuna scrittura, nessun invio.
   */
  const loadMedmarDeliveryStatus = useCallback(async (tid: string, medmarServiceIds: string[]) => {
    if (!supabase || medmarServiceIds.length === 0) {
      setDeliveryAttempts([]);
      setIssuingFinalTotalById(new Map());
      return;
    }
    const attemptsRes = await supabase
      .from("medmar_delivery_attempts")
      .select(
        "id, issuing_attempt_id, service_ids, status, medmar_id_prenotazione, medmar_numero, pdf_mailbox_message_uid, recipient_type, recipient_name, recipient_email, resend_message_id, attempt_count, last_error_code, last_error_message, delivered_at, updated_at"
      )
      .eq("tenant_id", tid)
      .overlaps("service_ids", medmarServiceIds);
    const attempts = (attemptsRes.data ?? []) as MedmarDeliveryAttemptRow[];
    setDeliveryAttempts(attempts);

    // PARTE 6 (storico reinvii): stessa query RLS-protetta usata sopra per delivery_attempts,
    // solo lettura, filtrata sugli id gia' caricati — nessun nuovo endpoint, opzione meno invasiva.
    const deliveredIds = attempts.filter((a) => a.status === "delivered").map((a) => a.id);
    if (deliveredIds.length > 0) {
      const resendsRes = await supabase
        .from("medmar_ticket_resends")
        .select("id, delivery_attempt_id, recipient_email, status, error_message, created_at, sent_at")
        .eq("tenant_id", tid)
        .in("delivery_attempt_id", deliveredIds)
        .order("created_at", { ascending: false });
      const resendRows = (resendsRes.data ?? []) as MedmarTicketResendRow[];
      const map = new Map<string, MedmarTicketResendRow[]>();
      for (const r of resendRows) {
        const list = map.get(r.delivery_attempt_id) ?? [];
        list.push(r);
        map.set(r.delivery_attempt_id, list);
      }
      setResendsByDeliveryAttemptId(map);
    } else {
      setResendsByDeliveryAttemptId(new Map());
    }

    const issuingIds = [...new Set(attempts.map((a) => a.issuing_attempt_id))];
    if (issuingIds.length === 0) {
      setIssuingFinalTotalById(new Map());
      return;
    }
    const issuingRes = await supabase
      .from("medmar_issuing_attempts")
      .select("id, final_total_cents")
      .eq("tenant_id", tid)
      .in("id", issuingIds);
    const rows = (issuingRes.data ?? []) as Array<{ id: string; final_total_cents: number | null }>;
    setIssuingFinalTotalById(new Map(rows.map((r) => [r.id, r.final_total_cents])));
  }, []);

  const loadTicketMemory = useCallback(async (accessToken: string, from?: string, to?: string) => {
    const qFrom = /^\d{4}-\d{2}-\d{2}$/.test(from ?? "") ? from! : todayIso();
    const qTo = /^\d{4}-\d{2}-\d{2}$/.test(to ?? "") ? to! : addDays(todayIso(), 14);
    setMemoryLoading(true);
    setMemoryError(null);
    try {
      const params = new URLSearchParams({ date_from: qFrom, date_to: qTo });
      const data = await apiFetch<{ memories: TicketMemoryRecord[]; slots: TicketMemorySlot[] }>(
        `/api/medmar-ticket-memory?${params.toString()}`,
        accessToken,
      );
      setTicketMemories(data.memories);
      setTicketSlots(data.slots);
    } catch (err) {
      setMemoryError(err instanceof Error ? err.message : "Errore caricamento memoria ticket.");
    } finally {
      setMemoryLoading(false);
    }
  }, []);

  /** Contatore coda Medmar (PARTE 3, sola lettura): GET /api/services/medmar-delivery-summary. Un fallimento qui non deve mai bloccare il resto della pagina. */
  const loadMedmarQueueSummary = useCallback(async (accessToken: string) => {
    try {
      const data = await apiFetch<MedmarQueueSummary>("/api/services/medmar-delivery-summary", accessToken);
      setQueueSummary(data);
    } catch {
      /* contatore best-effort: nessun blocco della pagina se non disponibile */
    }
  }, []);

  /**
   * Ricarica services + hotels e, a valle, lo stato delivery Medmar (sola
   * lettura) per i service medmar caricati, oltre al contatore coda (PARTE
   * 3). Punto unico di refresh: usato sia dai flussi "Cerca"/elimina/invio
   * manuale gia' esistenti, sia dal refresh immediato post-emissione (PARTE
   * 2) aggiunto in handleConfirmIssueMedmar.
   */
  const refreshMedmarData = useCallback(async (tid: string, from?: string, to?: string) => {
    const loadedServices = await loadData(tid, from, to);
    const medmarIds = loadedServices.filter(isMedmarService).map((s) => s.id);
    await loadMedmarDeliveryStatus(tid, medmarIds);
    if (tokenRef.current) void loadMedmarQueueSummary(tokenRef.current);
  }, [loadData, loadMedmarDeliveryStatus, loadMedmarQueueSummary]);

  useEffect(() => {
    tokenRef.current = token;
  }, [token]);

  useEffect(() => {
    let active = true;
    const load = async () => {
      const session = await getClientSessionContext();
      if (!hasSupabaseEnv || !supabase || !session.userId || !session.tenantId) {
        if (active) { setError("Login richiesto."); setLoading(false); }
        return;
      }
      setTenantId(session.tenantId);
      setToken(session.accessToken ?? null);
      await refreshMedmarData(session.tenantId, dateFrom, dateTo);
      if (session.accessToken) {
        await loadTicketMemory(session.accessToken, dateFrom, dateTo);
        // refreshMedmarData qui sopra non ha ancora lo state `token` aggiornato
        // (setToken e' asincrono): richiamato esplicitamente col valore fresco.
        void loadMedmarQueueSummary(session.accessToken);
      }
      if (active) setLoading(false);
    };
    void load();
    return () => { active = false; };
  }, [dateFrom, dateTo, refreshMedmarData, loadTicketMemory, loadMedmarQueueSummary]);

  const hotelsById = useMemo(() => new Map(hotels.map((h) => [h.id, h])), [hotels]);

  const medmarServices = useMemo(() => services.filter(isMedmarService), [services]);

  // Raggruppa per pratica (o nome se non c'è pratica)
  const bookingGroups = useMemo((): BookingGroup[] => {
    const map = new Map<string, BookingGroup>();

    for (const s of medmarServices) {
      const pratica = extractMedmarPractice(s.notes);
      const key = medmarBookingGroupKey(s);
      const hotelName = hotelsById.get(s.hotel_id)?.name ?? "Hotel N/D";
      const isArrival =
        s.direction === "arrival" ||
        s.booking_service_kind === "transfer_port_hotel" ||
        (!s.direction && s.booking_service_kind == null);

      if (!map.has(key)) {
        map.set(key, {
          key,
          customerName: s.customer_name ?? "N/D",
          phone: s.phone && s.phone !== "N/D" ? s.phone : null,
          agencyName: s.billing_party_name?.trim() || null,
          pax: s.pax ?? 1,
          arrivo: null,
          partenza: null,
          hotel: hotelName,
          pratica,
          refDate: s.date ?? "",
          allServiceIds: [],
          sentAt: s.medmar_ticket_sent_at ?? null,
        });
      }

      const group = map.get(key)!;
      group.allServiceIds.push(s.id);

      if (s.phone && s.phone !== "N/D") group.phone = s.phone;
      if (s.billing_party_name?.trim()) group.agencyName = s.billing_party_name.trim();

      if (isArrival) {
        if (!group.arrivo || (s.date ?? "") < (group.arrivo.date ?? "")) {
          group.arrivo = s;
        }
      } else {
        if (!group.partenza || (s.date ?? "") > (group.partenza.date ?? "")) {
          group.partenza = s;
        }
      }

      group.refDate = group.arrivo?.date ?? group.partenza?.date ?? s.date ?? "";
      group.hotel = hotelName;
      group.pax = Math.max(group.pax, s.pax ?? 1);
      // Se almeno un servizio è già inviato, considera il gruppo inviato
      if (s.medmar_ticket_sent_at) group.sentAt = s.medmar_ticket_sent_at;
    }

    return [...map.values()].sort((a, b) => a.refDate.localeCompare(b.refDate));
  }, [medmarServices, hotelsById]);

  const visibleGroups = useMemo(
    () => showSent ? bookingGroups : bookingGroups.filter((g) => g.sentAt == null && !sentKeys.has(g.key)),
    [bookingGroups, showSent, sentKeys]
  );

  const medmarAgencyOptions = useMemo(() => {
    const agencies = new Set<string>();
    for (const group of visibleGroups) {
      agencies.add(group.agencyName?.trim() || "Privato");
    }
    return [...agencies].sort((a, b) => a.localeCompare(b, "it"));
  }, [visibleGroups]);

  /**
   * Ricerca + filtro data (biglietti-medmar PARTE ricerca/filtri): la
   * ricerca si applica a tutti i gruppi visibili (pending inclusi — e'
   * comportamento atteso di una ricerca), il filtro data invece si applica
   * SOLO ai gruppi gia' inviati/delivered (isSent), cosi' pending/errori
   * restano sempre visibili indipendentemente dal filtro data selezionato.
   */
  const medmarFilteredGroups = useMemo(() => {
    const todayKey = todayIso();
    return visibleGroups.filter((g) => {
      const deliveryInfo = resolveMedmarGroupDelivery(g.allServiceIds, deliveryAttempts, g.sentAt);
      const attempt = deliveryInfo.attempt;
      const isSent = g.sentAt != null || sentKeys.has(g.key) || deliveryInfo.isCompact;

      const searchable: MedmarSearchableGroup = {
        key: g.key,
        customerName: g.customerName,
        hotel: g.hotel,
        pratica: g.pratica,
        phone: g.phone,
        agencyName: g.arrivo?.billing_party_name ?? g.partenza?.billing_party_name ?? null,
        allServiceIds: g.allServiceIds,
        medmarNumero: attempt?.medmar_numero ?? null,
        medmarIdPrenotazione: attempt?.medmar_id_prenotazione ?? null,
        recipientEmail: attempt?.recipient_email ?? null,
        recipientName: attempt?.recipient_name ?? null,
      };
      if (!matchesMedmarSearch(searchable, medmarSearchQuery)) return false;
      if (medmarAgencyFilter !== "all" && (g.agencyName?.trim() || "Privato") !== medmarAgencyFilter) return false;

      if (isSent) {
        const dateKey = medmarSentDateKey(attempt?.delivered_at, attempt?.updated_at ?? g.sentAt);
        if (!matchesMedmarSentDateFilter(dateKey, medmarSentDateFilter, todayKey)) return false;
      }

      return true;
    });
  }, [visibleGroups, deliveryAttempts, sentKeys, medmarSearchQuery, medmarAgencyFilter, medmarSentDateFilter]);

  const byDate = useMemo(() => {
    const map = new Map<string, BookingGroup[]>();
    for (const g of medmarFilteredGroups) {
      const k = g.refDate || "senza-data";
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(g);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [medmarFilteredGroups]);

  const selectedMedmarGroup = useMemo(
    () => medmarFilteredGroups.find((group) => group.key === selectedMedmarGroupKey) ?? medmarFilteredGroups[0] ?? null,
    [medmarFilteredGroups, selectedMedmarGroupKey],
  );

  const activeTicketSlots = useMemo(
    () => ticketSlots.filter((slot) => slot.available_quantity > 0),
    [ticketSlots],
  );

  const expiredMemoryCount = useMemo(
    () => ticketMemories.filter((ticket) => ticket.status === "expired").length,
    [ticketMemories],
  );

  const handleExtractMemoryFromPhoto = async () => {
    if (!token || !memoryPhoto) {
      setMemoryError("Carica prima la foto del biglietto.");
      return;
    }
    setMemoryExtracting(true);
    setMemoryError(null);
    try {
      const imageBase64 = await fileToBase64(memoryPhoto);
      const data = await apiFetch<{
        extracted: {
          route_code: MedmarTicketRouteCode | null;
          travel_date: string | null;
          departure_time: string | null;
          issue_date: string | null;
          ticket_number: string | null;
          booking_code: string | null;
          voucher_label: string | null;
          tariff_label: string | null;
          price_cents: number | null;
          quantity: number | null;
          raw_text: string;
        };
      }>(
        "/api/medmar-ticket-memory/extract",
        token,
        {
          method: "POST",
          body: JSON.stringify({
            image_base64: imageBase64,
            mime_type: memoryPhoto.type || "image/jpeg",
          }),
        },
      );

      setMemoryRawText(data.extracted.raw_text || "");
      setMemoryForm((prev) => ({
        ...prev,
        route_code: data.extracted.route_code ?? prev.route_code,
        travel_date: data.extracted.travel_date ?? prev.travel_date,
        departure_time: data.extracted.departure_time ?? prev.departure_time,
        issue_date: data.extracted.issue_date ?? prev.issue_date,
        ticket_number: data.extracted.ticket_number ?? prev.ticket_number,
        booking_code: data.extracted.booking_code ?? prev.booking_code,
        voucher_label: data.extracted.voucher_label ?? prev.voucher_label,
        tariff_label: data.extracted.tariff_label ?? prev.tariff_label,
        price_eur: typeof data.extracted.price_cents === "number"
          ? (data.extracted.price_cents / 100).toFixed(2)
          : prev.price_eur,
        quantity: data.extracted.quantity ? String(data.extracted.quantity) : prev.quantity,
      }));
    } catch (err) {
      setMemoryError(err instanceof Error ? err.message : "Errore lettura foto ticket.");
    } finally {
      setMemoryExtracting(false);
    }
  };

  const handleMemorySubmit = async () => {
    if (!supabase || !tenantId || !token) return;
    if (!memoryPhoto) {
      setMemoryError("Carica la foto del biglietto.");
      return;
    }
    setMemorySubmitting(true);
    setMemoryError(null);
    try {
      const safeName = memoryPhoto.name.replace(/[^a-zA-Z0-9._-]+/g, "_");
      const storagePath = `medmar-ticket-memory/${tenantId}/${Date.now()}-${safeName}`;
      const upload = await supabase.storage.from("service-photos").upload(storagePath, memoryPhoto, {
        contentType: memoryPhoto.type,
        upsert: false,
      });
      if (upload.error) throw new Error(upload.error.message);
      const photoUrl = supabase.storage.from("service-photos").getPublicUrl(storagePath).data.publicUrl;
      const priceFloat = Number(memoryForm.price_eur.replace(",", "."));
      await apiFetch(
        "/api/medmar-ticket-memory",
        token,
        {
          method: "POST",
          body: JSON.stringify({
            route_code: memoryForm.route_code,
            travel_date: memoryForm.travel_date,
            departure_time: memoryForm.departure_time || null,
            issue_date: memoryForm.issue_date || null,
            ticket_number: memoryForm.ticket_number || null,
            booking_code: memoryForm.booking_code || null,
            voucher_label: memoryForm.voucher_label || null,
            tariff_label: memoryForm.tariff_label || null,
            price_cents: Number.isFinite(priceFloat) ? Math.round(priceFloat * 100) : null,
            quantity: Math.max(1, Number(memoryForm.quantity) || 1),
            notes: memoryForm.notes || null,
            photo_path: storagePath,
            photo_url: photoUrl,
          }),
        },
      );
      await loadTicketMemory(token, dateFrom, dateTo);
      setMemoryModalOpen(false);
      setMemoryPhoto(null);
      setMemoryRawText("");
      setMemoryForm({
        route_code: "casamicciola_pozzuoli",
        travel_date: todayIso(),
        departure_time: "",
        issue_date: todayIso(),
        ticket_number: "",
        booking_code: "",
        voucher_label: "",
        tariff_label: "ADULTO - TARIFFA SPECIALE AR",
        price_eur: "10.25",
        quantity: "1",
        notes: "",
      });
    } catch (err) {
      setMemoryError(err instanceof Error ? err.message : "Errore salvataggio ticket.");
    } finally {
      setMemorySubmitting(false);
    }
  };

  const handleSend = async (g: BookingGroup, pdfFile: File | null) => {
    if (!token || sending) return;
    setSendModal(null);
    setSending(g.key);
    try {
      let pdf_base64: string | undefined;
      let pdf_filename: string | undefined;
      if (pdfFile) {
        const buf = await pdfFile.arrayBuffer();
        pdf_base64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
        pdf_filename = pdfFile.name;
      }
      const res = await fetch("/api/services/medmar-send", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ service_ids: g.allServiceIds, pdf_base64, pdf_filename })
      });
      const data = (await res.json()) as { ok: boolean; sent_to?: string | null; error?: string };
      if (data.ok) {
        setSentKeys((prev) => new Set([...prev, g.key]));
        if (tenantId) void refreshMedmarData(tenantId, dateFrom, dateTo);
        const msg = data.sent_to
          ? `Email inviata a ${data.sent_to}${pdfFile ? " con biglietto allegato" : ""}`
          : "Marcato come fatto (nessuna email agenzia configurata)";
        alert(msg);
      } else {
        alert(`Errore: ${data.error ?? "sconosciuto"}`);
      }
    } catch (e) {
      alert("Errore di rete");
    } finally {
      setSending(null);
    }
  };

  const handleDeliverMedmarPdf = async (serviceIds: string[]) => {
    if (!token || medmarDelivery.phase === "sending") return;
    setMedmarDelivery({ phase: "sending" });
    try {
      const res = await fetch("/api/services/medmar-send", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ service_ids: serviceIds }),
      });
      const data = (await res.json()) as {
        ok: boolean;
        status?: string;
        error?: string;
        recipient?: string | null;
        attempt_count?: number;
        last_attempt_at?: string;
      };
      setMedmarDelivery({
        phase: "done",
        status: data.status,
        error: data.ok ? undefined : data.error,
        recipient: data.recipient ?? null,
        attemptCount: data.attempt_count,
        lastAttemptAt: data.last_attempt_at,
      });
      if (data.ok && tenantId) void refreshMedmarData(tenantId, dateFrom, dateTo);
    } catch {
      setMedmarDelivery({ phase: "done", status: "delivery_state_unknown", error: "Errore di rete durante l'invio." });
    }
  };

  /** Pulsante "Riprova ora" sulla card in lista (FASE 4): richiama lo stesso motore sicuro/idempotente di handleDeliverMedmarPdf, poi ricarica lo stato delivery. */
  const handleRetryDeliveryFromCard = async (g: BookingGroup) => {
    if (!token || retryingKey) return;
    setRetryingKey(g.key);
    try {
      await fetch("/api/services/medmar-send", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ service_ids: g.allServiceIds }),
      });
      if (tenantId) await refreshMedmarData(tenantId, dateFrom, dateTo);
    } finally {
      setRetryingKey(null);
    }
  };

  const toggleExpandedDelivered = (key: string) => {
    setExpandedDeliveredKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  /**
   * "Rimanda biglietto" (MVP sicuro, PARTE 1/2): conferma via modal, poi
   * POST /api/services/medmar-resend-ticket con SOLO delivery_attempt_id —
   * nessuna nuova emissione, nessun lock/booking/payment, destinatario
   * sempre quello gia' salvato (mai modificabile da qui).
   */
  const handleConfirmResend = async () => {
    if (!token || !resendModal || resendSending) return;
    setResendSending(true);
    setResendError(null);
    setResendSuccess(null);
    try {
      const res = await fetch("/api/services/medmar-resend-ticket", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ delivery_attempt_id: resendModal.attempt.id }),
      });
      const json = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !json?.ok) {
        setResendError(json?.error ?? "Errore durante il reinvio.");
        return;
      }
      setResendSuccess("Biglietto reinviato con successo.");
      if (tenantId) await refreshMedmarData(tenantId, dateFrom, dateTo);
    } catch {
      setResendError("Errore di rete durante il reinvio.");
    } finally {
      setResendSending(false);
    }
  };

  /**
   * Stato delivery per card (FASE 2/3/4): matching service_ids -> attempt e
   * regola compatta delegati a lib/medmar-delivery-card.ts (pure, testato)
   * — mai calcolato dal solo stato locale post-emissione, sempre dai dati
   * gia' presenti in DB (deliveryAttempts caricati da loadMedmarDeliveryStatus).
   */
  const groupDeliveryByKey = useMemo(() => {
    const map = new Map<string, { attempt?: MedmarDeliveryAttemptRow; isCompact: boolean }>();
    for (const g of bookingGroups) {
      map.set(g.key, resolveMedmarGroupDelivery(g.allServiceIds, deliveryAttempts, g.sentAt));
    }
    return map;
  }, [bookingGroups, deliveryAttempts]);

  return (
    <>
    <section className="space-y-5">
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Biglietti MEDMAR</h1>
          <p className="text-sm text-slate-500">Transfer via porto — arrivo e partenza per cliente, pronti per prenotazione</p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2 text-sm">
          <label className="text-xs font-medium text-slate-600">
            Dal
            <DateInput value={dateFrom} onChange={(iso) => setDateFrom(iso)} className="ml-1 input-saas" />
          </label>
          <label className="text-xs font-medium text-slate-600">
            Al
            <DateInput value={dateTo} onChange={(iso) => setDateTo(iso)} className="ml-1 input-saas" />
          </label>
          <button
            type="button"
            onClick={() => {
              if (tenantId) void refreshMedmarData(tenantId, dateFrom, dateTo);
              if (token) void loadTicketMemory(token, dateFrom, dateTo);
            }}
            className="rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-700">
            Cerca
          </button>
          <button
            type="button"
            onClick={() => setMemoryModalOpen(true)}
            className="rounded-lg border border-indigo-300 bg-indigo-50 px-3 py-1.5 text-xs font-semibold text-indigo-700 hover:bg-indigo-100">
            + Memorizza ticket da foto
          </button>
          <button
            type="button"
            onClick={() => setShowSent((v) => !v)}
            className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${showSent ? "border-emerald-300 bg-emerald-50 text-emerald-700" : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50"}`}>
            {showSent ? "✓ Inviati visibili" : "Mostra inviati"}
          </button>
        </div>
      </div>

      {loading && <p className="text-sm text-slate-500">Caricamento...</p>}
      {error && <p className="text-sm text-rose-600">{error}</p>}

      {/* "Credito e biglietti Medmar" — evoluzione del contatore coda (PARTE 3), sola lettura da GET /api/services/medmar-delivery-summary. */}
      {queueSummary && (
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-bold text-slate-800">Credito e biglietti Medmar</h2>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-slate-400">Aggiornato {formatDateTimeIt(queueSummary.as_of)}</span>
              <Link
                href="/settings/system"
                className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-100"
              >
                Gestisci credito
              </Link>
            </div>
          </div>
          <p className="mt-1 text-[10px] text-slate-400">
            Calcolato da credito iniziale + ricariche - biglietti emessi nel gestionale.
          </p>

          {/* Credito e fabbisogno Medmar */}
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
            <QueueStatChip
              label="Credito disponibile"
              value={queueSummary.credit.available_cents != null ? formatEur(queueSummary.credit.available_cents) : "non disponibile"}
              tone={MEDMAR_CREDIT_STATUS_TONE[queueSummary.credit_evaluation.status]}
            />
            <QueueStatChip label="Tipo credito" value={MEDMAR_CREDIT_TYPE_LABEL[queueSummary.credit.type]} tone="slate" />
            <QueueStatChip
              label="Emessi oggi"
              value={queueSummary.activity.issued_today_count}
              sublabel={formatEur(queueSummary.activity.issued_today_amount_cents)}
              tone="blue"
            />
            <QueueStatChip
              label="In coda invio"
              value={queueSummary.queue.awaiting_pdf + queueSummary.queue.ready + queueSummary.queue.in_progress}
              tone="amber"
            />
            <QueueStatChip label="Errori" value={queueSummary.queue.errors} tone={queueSummary.queue.errors > 0 ? "rose" : "slate"} />
            <QueueStatChip
              label="Prossimi 3 giorni"
              value={`${queueSummary.forecast.upcoming_3d_estimated_tickets} biglietti`}
              sublabel={
                queueSummary.forecast.upcoming_3d_estimated_amount_cents != null
                  ? formatEur(queueSummary.forecast.upcoming_3d_estimated_amount_cents)
                  : "importo non calcolabile"
              }
              tone="indigo"
            />
            <QueueStatChip
              label="Esito"
              value={MEDMAR_CREDIT_STATUS_LABEL[queueSummary.credit_evaluation.status]}
              tone={MEDMAR_CREDIT_STATUS_TONE[queueSummary.credit_evaluation.status]}
            />
          </div>
          {queueSummary.credit_evaluation.status === "insufficient" && queueSummary.credit_evaluation.shortfall_cents != null && (
            <p className="mt-2 text-[11px] font-semibold text-rose-600">
              Mancano circa: {formatEur(queueSummary.credit_evaluation.shortfall_cents)}
            </p>
          )}

          {(queueSummary.credit.type === "manual_estimated" || queueSummary.credit.type === "env_estimated") && (
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-500">
              {queueSummary.credit.initial_credit_cents != null && (
                <span>Credito iniziale: {formatEur(queueSummary.credit.initial_credit_cents)}</span>
              )}
              {queueSummary.credit.total_topups_cents != null && (
                <span>Ricariche totali: {formatEur(queueSummary.credit.total_topups_cents)}</span>
              )}
              {queueSummary.credit.total_issued_cents != null && (
                <span>Biglietti emessi totali: {formatEur(queueSummary.credit.total_issued_cents)}</span>
              )}
            </div>
          )}

          {/* Dettaglio coda invio (invariato dalla PARTE 3 originale) */}
          <div className="mt-3 grid grid-cols-3 gap-2 border-t border-slate-100 pt-3 sm:grid-cols-6">
            <QueueStatChip label="Emessi oggi" value={queueSummary.today.issued} tone="blue" />
            <QueueStatChip label="In attesa PDF" value={queueSummary.queue.awaiting_pdf} tone="amber" />
            <QueueStatChip label="Pronti per invio" value={queueSummary.queue.ready} tone="indigo" />
            <QueueStatChip label="Invio in corso" value={queueSummary.queue.in_progress} tone="slate" />
            <QueueStatChip
              label="Inviati oggi"
              value={queueSummary.today.delivered}
              sublabel={queueSummary.activity.delivered_today_amount_cents != null ? formatEur(queueSummary.activity.delivered_today_amount_cents) : undefined}
              tone="emerald"
            />
            <QueueStatChip label="Errori" value={queueSummary.queue.errors} tone={queueSummary.queue.errors > 0 ? "rose" : "slate"} />
          </div>

          {(queueSummary.oldest_pending || queueSummary.last_delivered || queueSummary.last_error) && (
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-slate-100 pt-2 text-[11px] text-slate-500">
              {queueSummary.oldest_pending && (
                <span>In coda da più tempo: {formatDateTimeIt(queueSummary.oldest_pending.created_at)} ({queueSummary.oldest_pending.status})</span>
              )}
              {queueSummary.last_delivered && (
                <span>
                  Ultimo inviato: {formatDateTimeIt(queueSummary.last_delivered.delivered_at)}
                  {queueSummary.activity.last_delivered_amount_cents != null && ` (${formatEur(queueSummary.activity.last_delivered_amount_cents)})`}
                </span>
              )}
              {queueSummary.activity.last_issued_amount_cents != null && (
                <span>Ultimo emesso: {formatEur(queueSummary.activity.last_issued_amount_cents)}</span>
              )}
              {queueSummary.last_error && (
                <span className="font-semibold text-rose-600">Ultimo errore: {formatDateTimeIt(queueSummary.last_error.updated_at)} ({queueSummary.last_error.status})</span>
              )}
            </div>
          )}
        </div>
      )}

      {/* Coda operativa biglietti: filtra lato client i gruppi gia' caricati, non tocca emissione/delivery/cron. */}
      <div className="rounded-[22px] border border-indigo-100 bg-white p-4 shadow-sm shadow-slate-200/60">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-extrabold uppercase tracking-[0.18em] text-indigo-500">Area emissione</p>
            <h2 className="text-lg font-extrabold text-slate-950">Coda operativa Medmar</h2>
            <p className="text-xs text-slate-500">Vista tabellare pensata per giornate con molti biglietti.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <span className="rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs font-semibold text-indigo-700">
              {medmarFilteredGroups.length} in coda
            </span>
            <span className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-700">
              {medmarAgencyOptions.length} agenzie
            </span>
            <span className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700">
              {visibleGroups.length} in vista
            </span>
          </div>
        </div>
        <div className="grid gap-2 lg:grid-cols-[minmax(260px,1fr)_220px_220px]">
          <input
            type="text"
            value={medmarSearchQuery}
            onChange={(e) => setMedmarSearchQuery(e.target.value)}
            placeholder="Cerca cliente, pratica o agenzia..."
            className="input-saas w-full text-sm"
          />
          <select
            value={medmarAgencyFilter}
            onChange={(e) => setMedmarAgencyFilter(e.target.value)}
            className="input-saas text-sm"
            aria-label="Filtro agenzia"
          >
            <option value="all">Tutte le agenzie</option>
            {medmarAgencyOptions.map((agency) => (
              <option key={agency} value={agency}>{agency}</option>
            ))}
          </select>
          <select
            value={medmarSentDateFilter}
            onChange={(e) => setMedmarSentDateFilter(e.target.value as MedmarSentDateFilter)}
            className="input-saas text-sm"
            aria-label="Filtro data inviati"
          >
            {MEDMAR_SENT_DATE_FILTER_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
      </div>

      <details className="rounded-2xl border border-indigo-200 bg-indigo-50/70 px-4 py-3">
        <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-3 text-sm font-bold text-indigo-900">
          <span>Memoria ticket da foto</span>
          <span className="rounded-lg bg-white/80 px-3 py-1 text-xs font-semibold text-indigo-700">
            {activeTicketSlots.reduce((sum, slot) => sum + slot.available_quantity, 0)} ticket disponibili
          </span>
        </summary>
        <div className="mt-3 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-bold text-indigo-900">Memoria ticket da foto</h2>
            <p className="text-xs text-indigo-700">
              Archivia il biglietto fotografato e verifica subito se nel DB esistono arrivi o partenze compatibili.
            </p>
          </div>
          <div className="rounded-xl bg-white/80 px-3 py-2 text-right">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Disponibilità attiva</p>
            <p className="text-lg font-extrabold text-slate-900">
              {activeTicketSlots.reduce((sum, slot) => sum + slot.available_quantity, 0)} biglietti
            </p>
            <p className="text-[11px] text-slate-500">
              Storico scaduti: {expiredMemoryCount}
            </p>
          </div>
        </div>

        {memoryLoading && <p className="text-sm text-slate-500">Controllo ticket disponibili...</p>}
        {memoryError && <p className="text-sm text-rose-600">{memoryError}</p>}

        {!memoryLoading && activeTicketSlots.length === 0 && (
          <div className="rounded-xl border border-dashed border-indigo-200 bg-white/70 p-4 text-sm text-slate-500">
            Nessun ticket disponibile memorizzato nel periodo selezionato.
          </div>
        )}

        <div className="grid gap-3 lg:grid-cols-2">
          {activeTicketSlots.map((slot) => (
            <div key={slot.key} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-bold text-slate-900">
                    {formatSlotLabel({
                      routeCode: slot.route_code,
                      travelDate: slot.travel_date,
                      departureTime: slot.departure_time,
                    })}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {slot.tickets.length} memori{slot.tickets.length === 1 ? "a" : "e"} · {slot.available_quantity} posti ticket disponibili
                  </p>
                </div>
                <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-bold text-emerald-700">
                  {slot.available_quantity} disp.
                </span>
              </div>

              <div className="flex flex-wrap gap-2">
                {slot.tickets.map((ticket) => (
                  <a
                    key={ticket.id}
                    href={ticket.photo_url ?? "#"}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-100"
                  >
                    {ticket.ticket_number ?? "Ticket"} · {formatEur(ticket.price_cents)}
                  </a>
                ))}
              </div>

              {slot.matched_services.length > 0 ? (
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-amber-700">
                    {slot.available_quantity} bigliett{slot.available_quantity === 1 ? "o" : "i"} disponibili per questa corsa
                  </p>
                  <p className="text-sm font-semibold text-slate-800">
                    Potresti abbinarl{slot.available_quantity === 1 ? "o" : "i"} a:
                  </p>
                  <div className="space-y-2">
                    {slot.matched_services.slice(0, 5).map((service) => (
                      <div key={service.service_id} className="rounded-lg bg-white px-3 py-2 border border-amber-100">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-sm font-semibold text-slate-900">{service.customer_name ?? "Cliente N/D"}</p>
                          <span className="text-[10px] font-bold text-amber-700">score {service.score}</span>
                        </div>
                        <p className="text-xs text-slate-500">
                          {service.pax ?? "?"} pax
                          {service.hotel_name ? ` · ${service.hotel_name}` : ""}
                          {service.time ? ` · ${service.time}` : ""}
                        </p>
                        <p className="text-[11px] text-slate-400">{service.vessel ?? "Vessel N/D"}</p>
                        <p className="text-[10px] text-amber-700">{service.reasons.join(" · ")}</p>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-500">
                  Nessun servizio Medmar compatibile trovato nel DB per questa corsa nel periodo selezionato.
                </div>
              )}
            </div>
          ))}
        </div>
        </div>
      </details>

      {!loading && bookingGroups.length === 0 && (
        <div className="card p-6 text-center text-sm text-slate-500">
          Nessun biglietto MEDMAR nel periodo selezionato.
        </div>
      )}

      {!loading && bookingGroups.length > 0 && visibleGroups.length > 0 && medmarFilteredGroups.length === 0 && (
        <div className="card p-6 text-center text-sm text-slate-500">
          Nessun biglietto inviato trovato con questi filtri.
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_330px]">
        <div className="min-h-[520px] overflow-hidden rounded-[22px] border border-slate-200 bg-white shadow-sm">
          <div className="sticky top-0 z-10 grid grid-cols-[28px_minmax(160px,1.35fr)_126px_42px_minmax(165px,1fr)_66px_96px_96px_108px] border-b border-slate-200 bg-slate-50 px-3 py-2 text-[10px] font-extrabold uppercase tracking-wide text-slate-500 max-xl:hidden">
            <span />
            <span>Cliente</span>
            <span>Agenzia</span>
            <span>Pax</span>
            <span>Tratta</span>
            <span>Orario</span>
            <span>Pratica</span>
            <span>Stato</span>
            <span className="text-right">Azioni</span>
          </div>
          <div className="divide-y divide-slate-100">
            {byDate.map(([date, groups]) => (
              <div key={`queue-${date}`} className="bg-white">
                <div className="flex flex-wrap items-center gap-2 border-y border-indigo-100 bg-indigo-50 px-3 py-2">
                  <span className="font-extrabold text-indigo-950">{formatDate(date)}</span>
                  <span className="rounded-full bg-white px-2.5 py-0.5 text-xs font-semibold text-blue-700">{groups.length} biglietti</span>
                  <span className="rounded-full bg-white px-2.5 py-0.5 text-xs font-semibold text-slate-600">{groups.reduce((s, g) => s + g.pax, 0)} pax</span>
                  <span className="rounded-full bg-white px-2.5 py-0.5 text-xs font-semibold text-slate-600">{new Set(groups.map((g) => g.agencyName?.trim() || "Privato")).size} agenzie</span>
                </div>
                {groups.map((g) => {
                  const agency = g.agencyName?.trim() || "Privato";
                  const deliveryInfo = groupDeliveryByKey.get(g.key);
                  const deliveryAttempt = deliveryInfo?.attempt;
                  const isDeliveredCompact = deliveryInfo?.isCompact ?? false;
                  const isSent = g.sentAt != null || sentKeys.has(g.key);
                  const hasIssuedAttempt = !!deliveryAttempt;
                  const ferrySource = g.partenza ?? g.arrivo ?? null;
                  const routeLabel = ferrySource ? getDepartureFerryLabel(ferrySource) ?? ferrySource.vessel ?? "MEDMAR" : "MEDMAR";
                  const timeLabel = (g.arrivo?.time ?? g.partenza?.orario_barca ?? g.partenza?.time ?? "").slice(0, 5) || "-";
                  const statusLabel = isDeliveredCompact
                    ? "Inviato"
                    : deliveryAttempt
                      ? MEDMAR_DELIVERY_STATUS_LABEL[deliveryAttempt.status] ?? deliveryAttempt.status
                      : isSent
                        ? "Inviato"
                        : "Da emettere";
                  const statusTone = isDeliveredCompact || isSent
                    ? "bg-emerald-100 text-emerald-700"
                    : deliveryAttempt?.status?.includes("error") || deliveryAttempt?.status?.includes("failed")
                      ? "bg-rose-100 text-rose-700"
                      : deliveryAttempt
                        ? "bg-amber-100 text-amber-700"
                        : "bg-blue-100 text-blue-700";
                  return (
                    <div
                      key={`queue-row-${g.key}`}
                      className={`grid gap-2 px-3 py-3 text-sm transition hover:bg-slate-50 max-xl:rounded-xl max-xl:border max-xl:border-slate-200 max-xl:m-2 max-xl:bg-white xl:grid-cols-[28px_minmax(160px,1.35fr)_126px_42px_minmax(165px,1fr)_66px_96px_96px_108px] xl:items-center xl:py-2.5 ${selectedMedmarGroup?.key === g.key ? "bg-indigo-50/80 ring-1 ring-inset ring-indigo-200" : ""}`}
                    >
                      <input type="checkbox" className="mt-1 h-4 w-4 rounded border-slate-300 xl:mt-0" aria-label={`Seleziona ${g.customerName}`} />
                      <button type="button" onClick={() => setSelectedMedmarGroupKey(g.key)} className="min-w-0 text-left">
                        <span className="block truncate font-extrabold uppercase text-slate-900">{g.customerName}</span>
                        <span className="block truncate text-xs text-slate-500">{g.phone ?? "Telefono non indicato"} · {g.hotel}</span>
                      </button>
                      <span className="max-w-full truncate rounded-lg bg-slate-100 px-2 py-1 text-[10px] font-bold uppercase text-slate-700 max-xl:w-fit max-xl:before:content-['Agenzia:_']">{agency}</span>
                      <span className="font-bold text-slate-900 max-xl:before:mr-1 max-xl:before:text-xs max-xl:before:font-semibold max-xl:before:text-slate-400 max-xl:before:content-['Pax']">{g.pax}</span>
                      <span className="truncate text-slate-700 max-xl:before:mr-1 max-xl:before:text-xs max-xl:before:font-semibold max-xl:before:text-slate-400 max-xl:before:content-['Tratta']">{routeLabel}</span>
                      <span className="font-mono text-xs font-bold text-slate-800 max-xl:before:mr-1 max-xl:before:font-sans max-xl:before:font-semibold max-xl:before:text-slate-400 max-xl:before:content-['Orario']">{timeLabel}</span>
                      <span className="truncate font-mono text-xs text-slate-500 max-xl:before:mr-1 max-xl:before:font-sans max-xl:before:font-semibold max-xl:before:text-slate-400 max-xl:before:content-['Pratica']">{g.pratica || g.key.slice(0, 12)}</span>
                      <span className={`w-fit rounded-full px-2.5 py-1 text-[11px] font-bold ${statusTone}`}>{statusLabel}</span>
                      <div className="flex justify-end gap-1 max-xl:justify-start">
                        <button type="button" onClick={() => setSelectedMedmarGroupKey(g.key)} className="rounded-lg border border-slate-200 px-2 py-1.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-50">Dettagli</button>
                        {!hasIssuedAttempt && !isSent ? (
                          <button type="button" disabled={verifying === g.key} onClick={() => void handleVerifyMedmar(g)} className="rounded-lg bg-indigo-600 px-2 py-1.5 text-[11px] font-semibold text-white hover:bg-indigo-700 disabled:opacity-50">
                            {verifying === g.key ? "..." : "Emetti"}
                          </button>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        <aside className="rounded-[22px] border border-indigo-100 bg-white p-4 shadow-sm xl:sticky xl:top-4 xl:max-h-[calc(100vh-120px)] xl:overflow-y-auto">
          <div className="flex items-start justify-between gap-3 border-b border-slate-100 pb-3">
            <div>
              <h2 className="text-base font-extrabold text-slate-950">Dettaglio pratica</h2>
              <p className="text-xs text-slate-500">Anteprima operativa Medmar</p>
            </div>
            <button type="button" onClick={() => setSelectedMedmarGroupKey(null)} className="rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-500 hover:bg-slate-50">Reset</button>
          </div>
          {selectedMedmarGroup ? (() => {
            const deliveryInfo = groupDeliveryByKey.get(selectedMedmarGroup.key);
            const deliveryAttempt = deliveryInfo?.attempt;
            const isDeliveredCompact = deliveryInfo?.isCompact ?? false;
            const agency = selectedMedmarGroup.agencyName?.trim() || "Privato";
            const ferrySource = selectedMedmarGroup.partenza ?? selectedMedmarGroup.arrivo ?? null;
            const routeLabel = ferrySource ? getDepartureFerryLabel(ferrySource) ?? ferrySource.vessel ?? "MEDMAR" : "MEDMAR";
            const timeLabel = (selectedMedmarGroup.arrivo?.time ?? selectedMedmarGroup.partenza?.orario_barca ?? selectedMedmarGroup.partenza?.time ?? "").slice(0, 5) || "-";
            return (
              <div className="space-y-4 pt-4 text-sm">
                <div>
                  <p className="text-xs font-bold uppercase text-slate-400">Cliente</p>
                  <p className="font-extrabold text-slate-950">{selectedMedmarGroup.customerName}</p>
                  <p className="text-xs text-slate-500">{selectedMedmarGroup.phone ?? "Telefono non indicato"}</p>
                </div>
                <div>
                  <p className="text-xs font-bold uppercase text-slate-400">Agenzia</p>
                  <p className="inline-flex rounded bg-slate-100 px-2 py-1 text-xs font-bold uppercase text-slate-700">{agency}</p>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div><p className="text-xs font-bold uppercase text-slate-400">Pax</p><p className="font-bold text-slate-900">{selectedMedmarGroup.pax}</p></div>
                  <div><p className="text-xs font-bold uppercase text-slate-400">Orario</p><p className="font-bold text-slate-900">{timeLabel}</p></div>
                </div>
                <div>
                  <p className="text-xs font-bold uppercase text-slate-400">Viaggio</p>
                  <p className="font-semibold text-slate-900">{routeLabel}</p>
                  <p className="text-xs text-slate-500">{selectedMedmarGroup.refDate ? formatDate(selectedMedmarGroup.refDate) : "Data non indicata"}</p>
                </div>
                <div>
                  <p className="text-xs font-bold uppercase text-slate-400">Hotel</p>
                  <p className="font-semibold text-slate-900">{selectedMedmarGroup.hotel}</p>
                </div>
                <div>
                  <p className="text-xs font-bold uppercase text-slate-400">Pratica</p>
                  <p className="font-mono text-xs text-slate-700">{selectedMedmarGroup.pratica || selectedMedmarGroup.key}</p>
                </div>
                {deliveryAttempt ? (
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                    <p className="text-xs font-bold uppercase text-slate-400">Stato invio</p>
                    <p className="font-semibold text-slate-900">{isDeliveredCompact ? "Emesso e inviato" : MEDMAR_DELIVERY_STATUS_LABEL[deliveryAttempt.status] ?? deliveryAttempt.status}</p>
                    <p className="mt-1 text-xs text-slate-500">Codice: {deliveryAttempt.medmar_numero ?? "-"}</p>
                    <p className="text-xs text-slate-500">Destinatario: {deliveryAttempt.recipient_email ?? "-"}</p>
                  </div>
                ) : null}
                <div className="flex flex-col gap-2 border-t border-slate-100 pt-4">
                  {!deliveryAttempt && !(selectedMedmarGroup.sentAt != null || sentKeys.has(selectedMedmarGroup.key)) ? (
                    <button type="button" disabled={verifying === selectedMedmarGroup.key} onClick={() => void handleVerifyMedmar(selectedMedmarGroup)} className="rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50">
                      {verifying === selectedMedmarGroup.key ? "Verifica in corso..." : "Emetti biglietto Medmar"}
                    </button>
                  ) : null}
                  <button type="button" onClick={() => handleCopy(selectedMedmarGroup.customerName, `drawer-name-${selectedMedmarGroup.key}`)} className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">
                    Copia nome cliente
                  </button>
                </div>
              </div>
            );
          })() : (
            <p className="pt-4 text-sm text-slate-500">Seleziona una riga per vedere il dettaglio.</p>
          )}
        </aside>
      </div>

      <details className="rounded-2xl border border-slate-200 bg-white p-4">
        <summary className="cursor-pointer text-sm font-bold text-slate-700">Strumenti avanzati e copia Medmar</summary>
        <div className="mt-4 space-y-5">

      {byDate.map(([date, groups]) => (
        <div key={date} className="space-y-2">
          {/* Header data */}
          <div className="flex items-center gap-3 pb-1 border-b border-slate-200">
            <h2 className="text-sm font-bold text-slate-700 uppercase tracking-wide">
              {formatDate(date)}
            </h2>
            <span className="rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-semibold text-blue-700">
              {groups.length} {groups.length === 1 ? "prenotazione" : "prenotazioni"} · {groups.reduce((s, g) => s + g.pax, 0)} pax
            </span>
            <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-600">
              {new Set(groups.map((g) => g.agencyName?.trim() || "Privato")).size} agenzie
            </span>
            <button type="button"
              onClick={() => handleCopy(
                groups.map((g) =>
                  [g.customerName, g.agencyName ? `Agenzia: ${g.agencyName}` : "Agenzia: Privato", `${g.pax} pax`, g.phone ?? "", g.hotel,
                   g.pratica ? `Pratica: ${g.pratica}` : "",
                   g.arrivo ? `Arrivo: ${g.arrivo.date} ${g.arrivo.time ?? ""}` : "",
                   (() => {
                     const pd = g.partenza?.date ?? g.arrivo?.departure_date ?? null;
                     const pt = g.partenza?.time ?? g.arrivo?.departure_time ?? g.arrivo?.return_time ?? null;
                     return (pd || pt) ? `Partenza: ${pd ?? ""} ${pt ?? ""}`.trim() : "";
                   })()
                  ].filter(Boolean).join(" | ")
                ).join("\n"),
                `all-${date}`
              )}
              className="ml-auto rounded-lg border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50">
              {copied === `all-${date}` ? "✓ Copiato tutto" : "⎘ Copia tutti"}
            </button>
          </div>

          {/* Cards */}
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {groups.map((g) => {
              const isSent = g.sentAt != null || sentKeys.has(g.key);
              const nameParts = g.customerName.trim().split(/\s+/);
              const nomeFirst = nameParts[0] ?? "";
              const cognomeLast = nameParts.slice(1).join(" ");
              const tel = g.phone ?? "";
              const email = "info@ischiatransferservice.it";
              const medmarClipboard = [cognomeLast || nomeFirst, cognomeLast ? nomeFirst : "", tel, email].join("\t");
              const partenzaDate = g.partenza?.date ?? g.arrivo?.departure_date ?? null;
              const ferrySource = g.partenza ?? g.arrivo ?? null;
              const departureFerryLabel = ferrySource ? getDepartureFerryLabel(ferrySource) : null;
              const partenzaVessel = departureFerryLabel ?? g.partenza?.vessel ?? "MEDMAR";
              const timeFromVessel = partenzaVessel?.match(/(\d{1,2}:\d{2})$/)?.[1] ?? null;
              const partenzaTime = g.partenza?.orario_barca?.slice(0, 5) ?? timeFromVessel ?? null;
              const hasPartenza = !!(partenzaDate || partenzaTime);
              const deliveryInfo = groupDeliveryByKey.get(g.key);
              const deliveryAttempt = deliveryInfo?.attempt;
              const isDeliveredCompact = deliveryInfo?.isCompact ?? false;
              const isDetailsExpanded = expandedDeliveredKeys.has(g.key);
              // Esiste gia' un'emissione Medmar One Click per questo gruppo (qualunque stato di delivery,
              // 'delivered' incluso — quel caso e' pero' gestito prima dal ramo compatto qui sotto): da qui in
              // poi il pulsante "Emetti biglietto Medmar" e il vecchio upload manuale non vanno piu' mostrati
              // come percorso normale, per non far pensare a un altro operatore che il biglietto sia da fare.
              const hasIssuedAttempt = !!deliveryAttempt;
              const finalTotalCents = deliveryAttempt ? issuingFinalTotalById.get(deliveryAttempt.issuing_attempt_id) ?? null : null;

              // FASE 2/3: card compatta solo quando l'esito e' davvero 'emesso e inviato'
              // (delivery attempt 'delivered', o fallback difensivo su medmar_ticket_sent_at
              // quando non esiste alcun attempt — mai quando l'attempt esiste con un altro stato).
              if (isDeliveredCompact) {
                const sentAtIso = deliveryAttempt?.delivered_at ?? deliveryAttempt?.updated_at ?? g.sentAt ?? null;
                const andataLabel = g.arrivo ? `${g.arrivo.date?.slice(5).split("-").reverse().join("/")} ${(g.arrivo.time ?? "").slice(0, 5)}`.trim() : null;
                const ritornoLabel = hasPartenza
                  ? `${partenzaDate ? partenzaDate.slice(5).split("-").reverse().join("/") : "—"} ${partenzaTime ?? ""}`.trim()
                  : null;
                const resendRows = deliveryAttempt ? resendsByDeliveryAttemptId.get(deliveryAttempt.id) ?? [] : [];
                const lastResend = resendRows[0] ?? null;
                const canResend = canResendMedmarTicket(deliveryAttempt);
                return (
                  <div key={g.key} className="rounded-xl border border-emerald-300 bg-emerald-50 shadow-sm overflow-hidden">
                    <div className="px-3 py-2 space-y-0.5">
                      <p className="text-[10px] font-bold text-emerald-700">✅ Emesso e inviato</p>
                      <p className="text-[12px] font-bold uppercase text-slate-800 truncate">{g.customerName}</p>
                      <p className="inline-flex max-w-full rounded bg-slate-100 px-1.5 py-0.5 text-[9px] font-bold uppercase text-slate-600">
                        Agenzia: {g.agencyName?.trim() || "Privato"}
                      </p>
                      <p className="text-[10px] text-slate-500 truncate">{[andataLabel, ritornoLabel].filter(Boolean).join(" / ") || "—"}</p>
                      {deliveryAttempt?.medmar_numero && (
                        <p className="text-[10px] text-slate-500 font-mono truncate">Codice: {deliveryAttempt.medmar_numero}</p>
                      )}
                      <p className="text-[10px] text-slate-500 truncate">Inviato a: {deliveryAttempt?.recipient_email ?? "—"}</p>
                      {sentAtIso && <p className="text-[10px] text-slate-400">{formatDateTimeIt(sentAtIso)}</p>}
                      {resendRows.length > 0 && (
                        <p className="text-[10px] text-indigo-600 font-semibold">
                          Reinviato {resendRows.length} {resendRows.length === 1 ? "volta" : "volte"}
                          {lastResend && (lastResend.sent_at || lastResend.created_at) && (
                            <> · Ultimo reinvio: {formatDateTimeIt(lastResend.sent_at ?? lastResend.created_at)}</>
                          )}
                        </p>
                      )}
                    </div>
                    {canResend && (
                      <button
                        type="button"
                        onClick={() => {
                          if (!deliveryAttempt) return;
                          setResendError(null);
                          setResendSuccess(null);
                          setResendModal({ groupKey: g.key, customerName: g.customerName, attempt: deliveryAttempt });
                        }}
                        className="w-full border-t border-emerald-200 bg-indigo-50 px-3 py-1.5 text-[10px] font-semibold text-indigo-700 hover:bg-indigo-100"
                      >
                        ↻ Rimanda biglietto
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => toggleExpandedDelivered(g.key)}
                      className="w-full border-t border-emerald-200 bg-white/70 px-3 py-1.5 text-[10px] font-semibold text-emerald-700 hover:bg-white"
                    >
                      {isDetailsExpanded ? "Nascondi dettagli" : "Mostra dettagli"}
                    </button>
                    {isDetailsExpanded && (
                      <div className="border-t border-emerald-200 bg-white px-3 py-2 space-y-1 text-[10px] text-slate-600">
                        <p><span className="font-semibold">ID prenotazione:</span> {deliveryAttempt?.medmar_id_prenotazione ?? "—"}</p>
                        <p><span className="font-semibold">Codice Medmar:</span> {deliveryAttempt?.medmar_numero ?? "—"}</p>
                        <p><span className="font-semibold">Prezzo finale:</span> {finalTotalCents != null ? formatEur(finalTotalCents) : "—"}</p>
                        <p><span className="font-semibold">Destinatario:</span> {deliveryAttempt?.recipient_name ?? "—"} {deliveryAttempt?.recipient_email ? `(${deliveryAttempt.recipient_email})` : ""}</p>
                        <p><span className="font-semibold">Resend message id:</span> {deliveryAttempt?.resend_message_id ?? "—"}</p>
                        <p><span className="font-semibold">Delivered at:</span> {deliveryAttempt?.delivered_at ? formatDateTimeIt(deliveryAttempt.delivered_at) : "—"}</p>
                        <p><span className="font-semibold">medmar_ticket_sent_at:</span> {g.sentAt ? formatDateTimeIt(g.sentAt) : "—"}</p>
                        <p><span className="font-semibold">Stato delivery:</span> {deliveryAttempt?.status ?? "delivered (fallback: nessun delivery attempt trovato)"}</p>
                        <p><span className="font-semibold">Service IDs:</span> <span className="font-mono break-all">{g.allServiceIds.join(", ")}</span></p>
                        {lastResend && (
                          <>
                            <p><span className="font-semibold">Ultimo destinatario reinvio:</span> {lastResend.recipient_email}</p>
                            <p><span className="font-semibold">Ultimo stato reinvio:</span> {lastResend.status}</p>
                            {lastResend.status === "failed" && lastResend.error_message && (
                              <p className="text-rose-600"><span className="font-semibold">Errore ultimo reinvio:</span> {lastResend.error_message}</p>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              }

              return (
                <div key={g.key} className={`flex flex-col rounded-xl border bg-white shadow-sm overflow-hidden ${isSent ? "border-emerald-300" : "border-slate-200"}`}>
                  {/* Header */}
                  <div className="flex items-start justify-between gap-1.5 px-3 pt-2.5 pb-1.5">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <p className="text-[13px] font-bold text-slate-800 uppercase leading-tight truncate">{g.customerName}</p>
                        {isSent && <span className="shrink-0 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[9px] font-bold text-emerald-700">✓</span>}
                      </div>
                      <p className="text-[11px] text-slate-400 truncate leading-tight">{g.hotel}</p>
                      <p className="mt-1 inline-flex max-w-full rounded bg-slate-100 px-1.5 py-0.5 text-[9px] font-bold uppercase text-slate-600">
                        Agenzia: {g.agencyName?.trim() || "Privato"}
                      </p>
                      {g.pratica && <p className="text-[10px] text-slate-300 font-mono leading-tight">{g.pratica}</p>}
                    </div>
                    <span className="shrink-0 rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-bold text-blue-700">{g.pax}p</span>
                  </div>

                  {/* Biglietto gia' emesso via One Click ma email non ancora delivered — mai per delivered (compattato sopra).
                      Nessun pulsante di emissione qui: deve essere inequivocabile per un altro operatore che il biglietto e' gia' fatto. */}
                  {deliveryAttempt && deliveryAttempt.status !== "delivered" && (
                    <div className="border-t border-amber-100 bg-amber-50 px-3 py-1.5 space-y-1">
                      <p className="text-[10px] font-bold text-emerald-700">✅ Biglietto Medmar emesso</p>
                      <p className="text-[9px] text-slate-600">
                        Codice: <span className="font-mono">{deliveryAttempt.medmar_numero ?? "—"}</span>
                        {" · "}Prenotazione: <span className="font-mono">{deliveryAttempt.medmar_id_prenotazione ?? "—"}</span>
                        {finalTotalCents != null && <>{" · "}Prezzo: {formatEur(finalTotalCents)}</>}
                      </p>
                      <p className="text-[10px] font-medium text-amber-800">
                        Stato invio: {MEDMAR_DELIVERY_STATUS_LABEL[deliveryAttempt.status] ?? deliveryAttempt.status}
                      </p>
                      {MEDMAR_DELIVERY_AUTO_RETRY_STATUSES.has(deliveryAttempt.status) && (
                        <>
                          <p className="text-[10px] font-semibold text-amber-800">📩 Invio email in attesa PDF</p>
                          <p className="text-[9px] text-amber-700">Il sistema riproverà automaticamente.</p>
                          <p className="text-[9px] text-amber-700">
                            Tentativi: {deliveryAttempt.attempt_count} · Ultimo: {formatDateTimeIt(deliveryAttempt.updated_at)} · Prossimo retry: {formatDateTimeIt(addMinutesIso(deliveryAttempt.updated_at, 2))}
                          </p>
                        </>
                      )}
                      <div className="flex flex-wrap gap-1.5 pt-0.5">
                        {isMedmarDeliveryRetryButtonVisible(deliveryAttempt.status) && (
                          <button
                            type="button"
                            disabled={retryingKey === g.key}
                            onClick={() => void handleRetryDeliveryFromCard(g)}
                            className="rounded-md bg-emerald-600 px-2 py-1 text-[10px] font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                          >
                            {retryingKey === g.key ? "Invio..." : "Riprova ora"}
                          </button>
                        )}
                        {isMedmarManualFallbackVisible(deliveryAttempt.status) && (
                          <button
                            type="button"
                            onClick={() => setSendModal({ group: g, pdfFile: null })}
                            className="rounded-md border border-amber-300 bg-white px-2 py-1 text-[10px] font-semibold text-amber-800 hover:bg-amber-50"
                          >
                            Invio manuale PDF
                          </button>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Arrivo + Partenza compatti */}
                  <div className="border-t border-slate-100 divide-y divide-slate-100">
                    <div className="flex items-center gap-2 px-3 py-1.5">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-[10px] font-bold text-emerald-700">A</span>
                      <div className="min-w-0 flex-1">
                        <p className="text-[11px] font-semibold text-slate-700 truncate leading-tight">
                          {g.arrivo ? `${g.arrivo.date?.slice(5).split("-").reverse().join("/")} · ${(g.arrivo.time ?? "").slice(0,5)}` : "—"}
                        </p>
                        <p className="text-[10px] text-slate-400 truncate leading-tight">
                          {g.arrivo?.vessel ?? "N/D"}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 px-3 py-1.5">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-100 text-[10px] font-bold text-amber-700">P</span>
                      <div className="min-w-0 flex-1">
                        <p className="text-[11px] font-semibold text-slate-700 truncate leading-tight">
                          {hasPartenza ? `${partenzaDate?.slice(5).split("-").reverse().join("/") ?? "—"} · ${partenzaTime ?? "—"}` : "—"}
                        </p>
                        <p className="text-[10px] text-slate-400 truncate leading-tight">{hasPartenza ? partenzaVessel : "nessuna partenza"}</p>
                      </div>
                    </div>
                  </div>

                  {/* Copia MEDMAR */}
                  <div className="border-t border-slate-100 bg-slate-50 px-3 py-2 space-y-1.5">
                    <button type="button"
                      onClick={() => handleCopy(medmarClipboard, `medmar-${g.key}`)}
                      className="w-full rounded-lg border border-indigo-300 bg-indigo-50 px-2 py-1 text-[11px] font-semibold text-indigo-700 hover:bg-indigo-100 text-center">
                      {copied === `medmar-${g.key}` ? "✓ Pronto!" : "⎘ Copia per MEDMAR"}
                    </button>
                    <div className="flex flex-wrap gap-1">
                      {cognomeLast && (
                        <button type="button" onClick={() => handleCopy(cognomeLast, `cgn-${g.key}`)}
                          className="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] text-slate-600 hover:bg-slate-100 whitespace-nowrap">
                          {copied === `cgn-${g.key}` ? "✓" : "⎘"} Cognome
                        </button>
                      )}
                      <button type="button" onClick={() => handleCopy(nomeFirst, `nome-${g.key}`)}
                        className="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] text-slate-600 hover:bg-slate-100">
                        {copied === `nome-${g.key}` ? "✓" : "⎘"} Nome
                      </button>
                      {tel && (
                        <button type="button" onClick={() => handleCopy(tel, `tel-${g.key}`)}
                          className="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] text-slate-600 hover:bg-slate-100">
                          {copied === `tel-${g.key}` ? "✓" : "⎘"} {tel}
                        </button>
                      )}
                      <button type="button" onClick={() => handleCopy(email, `email-${g.key}`)}
                        className="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] text-slate-600 hover:bg-slate-100">
                        {copied === `email-${g.key}` ? "✓" : "⎘"} Email
                      </button>
                    </div>
                  </div>

                  {/* Azioni — pulsante principale: "Emetti biglietto Medmar" avvia direttamente il preflight
                      One Click (mai il vecchio upload manuale). Nascosto se il biglietto e' gia' stato emesso
                      (hasIssuedAttempt): un altro operatore non deve poter riavviare l'emissione. */}
                  <div className="border-t border-slate-100 px-3 py-2 flex gap-1.5">
                    {hasIssuedAttempt ? (
                      <div className="flex-1 rounded-lg bg-emerald-50 border border-emerald-200 px-2 py-1.5 text-center">
                        <span className="text-[11px] text-emerald-700 font-semibold">✅ Biglietto Medmar emesso</span>
                      </div>
                    ) : isSent ? (
                      <div className="flex flex-1 items-center gap-1.5 rounded-lg bg-emerald-50 border border-emerald-200 px-2 py-1">
                        <span className="text-[11px] text-emerald-700 font-semibold flex-1">✓ Inviato</span>
                        <button type="button" onClick={() => setSendModal({ group: g, pdfFile: null })}
                          className="text-[10px] text-emerald-600 underline hover:no-underline">Invio manuale PDF</button>
                      </div>
                    ) : (
                      <button type="button" disabled={verifying === g.key} onClick={() => void handleVerifyMedmar(g)}
                        className="flex-1 rounded-lg bg-blue-600 px-2 py-1.5 text-[11px] font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
                        {verifying === g.key ? "Verifica in corso..." : "Emetti biglietto Medmar"}
                      </button>
                    )}
                    <button type="button" disabled={deleting === g.key} onClick={() => void handleDelete(g)}
                      className="flex-1 rounded-lg border border-rose-200 bg-rose-50 px-2 py-1.5 text-[11px] font-medium text-rose-600 hover:bg-rose-100 disabled:opacity-50">
                      {deleting === g.key ? "..." : "Elimina"}
                    </button>
                  </div>
                  {!hasIssuedAttempt && !isSent && verifyError && !verifying && (
                    <div className="border-t border-slate-100 px-3 py-1.5">
                      <p className="text-[10px] text-rose-600">{verifyError}</p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
        </div>
      </details>
    </section>

    {/* Fallback manuale PDF — vecchio sistema pre-One-Click. NON e' piu' il percorso normale:
        va aperto solo per stati di errore/revisione manuale (isMedmarManualFallbackVisible) o per
        il legacy "Reinvia" su prenotazioni gia' inviate col vecchio sistema (nessun delivery attempt). */}
    {sendModal && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
        <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-base font-semibold text-slate-800">Invio manuale PDF</h2>
              <p className="text-[11px] font-medium text-amber-700">Fallback manuale — usare solo se il retry automatico non può riuscire</p>
            </div>
            <button type="button" onClick={() => setSendModal(null)} className="text-slate-400 hover:text-slate-600 text-xl leading-none">×</button>
          </div>

          <div className="rounded-xl bg-slate-50 border border-slate-200 px-4 py-3 space-y-0.5">
            <p className="text-sm font-semibold text-slate-800">{sendModal.group.customerName}</p>
            <p className="text-xs text-slate-500">{sendModal.group.hotel} · {sendModal.group.pax} pax</p>
            {sendModal.group.pratica && <p className="text-xs text-slate-400 font-mono">Pratica: {sendModal.group.pratica}</p>}
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">
              Allega biglietto MEDMAR (PDF)
            </label>
            <label className={`flex flex-col items-center justify-center w-full h-28 border-2 border-dashed rounded-xl cursor-pointer transition ${sendModal.pdfFile ? "border-emerald-400 bg-emerald-50" : "border-slate-300 bg-slate-50 hover:bg-slate-100"}`}>
              <input
                type="file"
                accept="application/pdf"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  setSendModal((prev) => prev ? { ...prev, pdfFile: f } : null);
                }}
              />
              {sendModal.pdfFile ? (
                <>
                  <span className="text-2xl">📎</span>
                  <span className="text-sm font-medium text-emerald-700 mt-1 max-w-[260px] truncate">{sendModal.pdfFile.name}</span>
                  <span className="text-xs text-emerald-600">Clicca per cambiare file</span>
                </>
              ) : (
                <>
                  <span className="text-2xl text-slate-400">📄</span>
                  <span className="text-sm text-slate-500 mt-1">Clicca per selezionare il PDF</span>
                  <span className="text-xs text-slate-400">oppure trascina qui</span>
                </>
              )}
            </label>
          </div>

          <div className="flex gap-2 pt-1">
            <button type="button"
              onClick={() => setSendModal(null)}
              className="flex-1 rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50">
              Annulla
            </button>
            <button type="button"
              onClick={() => void handleSend(sendModal.group, sendModal.pdfFile)}
              disabled={!sendModal.pdfFile || sending === sendModal.group.key}
              className="flex-1 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed">
              {sending === sendModal.group.key ? "Invio..." : "Invia con allegato"}
            </button>
          </div>

        </div>
      </div>
    )}
    {memoryModalOpen && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
        <div className="w-full max-w-2xl rounded-2xl bg-white p-6 shadow-xl space-y-4 max-h-[90vh] overflow-y-auto">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-slate-800">Memorizza ticket Medmar da foto</h2>
            <button type="button" onClick={() => setMemoryModalOpen(false)} className="text-slate-400 hover:text-slate-600 text-xl leading-none">×</button>
          </div>

          <p className="text-sm text-slate-500">
            La foto viene archiviata, il ticket viene letto con OCR classico e poi indicizzato per corsa. Se la data passa, sparisce dalla disponibilità attiva ma resta nello storico.
          </p>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-medium text-slate-600 sm:col-span-2">
              Foto biglietto *
              <input
                type="file"
                accept="image/*"
                onChange={(event) => {
                  setMemoryPhoto(event.target.files?.[0] ?? null);
                  setMemoryRawText("");
                  setMemoryError(null);
                }}
                className="mt-1 block w-full text-sm"
              />
            </label>
            <div className="sm:col-span-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void handleExtractMemoryFromPhoto()}
                disabled={!memoryPhoto || memoryExtracting}
                className="rounded-xl border border-indigo-300 bg-indigo-50 px-4 py-2 text-sm font-semibold text-indigo-700 hover:bg-indigo-100 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {memoryExtracting ? "Lettura foto..." : "Leggi dati dalla foto"}
              </button>
              <p className="text-xs text-slate-500">
                Nessuna AI generativa: OCR standard + parser dedicato al formato Medmar.
              </p>
            </div>
            <label className="text-xs font-medium text-slate-600">
              Corsa *
              <select
                value={memoryForm.route_code}
                onChange={(event) => setMemoryForm((prev) => ({ ...prev, route_code: event.target.value as MedmarTicketRouteCode }))}
                className="mt-1 input-saas w-full"
              >
                {MEDMAR_TICKET_ROUTE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <label className="text-xs font-medium text-slate-600">
              Data corsa *
              <DateInput value={memoryForm.travel_date} onChange={(value) => setMemoryForm((prev) => ({ ...prev, travel_date: value }))} className="mt-1 input-saas w-full" />
            </label>
            <label className="text-xs font-medium text-slate-600">
              Orario corsa
              <input type="time" value={memoryForm.departure_time} onChange={(event) => setMemoryForm((prev) => ({ ...prev, departure_time: event.target.value }))} className="mt-1 input-saas w-full" />
            </label>
            <label className="text-xs font-medium text-slate-600">
              Data emissione
              <DateInput value={memoryForm.issue_date} onChange={(value) => setMemoryForm((prev) => ({ ...prev, issue_date: value }))} className="mt-1 input-saas w-full" />
            </label>
            <label className="text-xs font-medium text-slate-600">
              N. biglietto
              <input value={memoryForm.ticket_number} onChange={(event) => setMemoryForm((prev) => ({ ...prev, ticket_number: event.target.value }))} className="mt-1 input-saas w-full" />
            </label>
            <label className="text-xs font-medium text-slate-600">
              Booking Medmar
              <input value={memoryForm.booking_code} onChange={(event) => setMemoryForm((prev) => ({ ...prev, booking_code: event.target.value }))} className="mt-1 input-saas w-full" />
            </label>
            <label className="text-xs font-medium text-slate-600">
              Voucher
              <input value={memoryForm.voucher_label} onChange={(event) => setMemoryForm((prev) => ({ ...prev, voucher_label: event.target.value }))} className="mt-1 input-saas w-full" />
            </label>
            <label className="text-xs font-medium text-slate-600">
              Prezzo €
              <input value={memoryForm.price_eur} onChange={(event) => setMemoryForm((prev) => ({ ...prev, price_eur: event.target.value }))} className="mt-1 input-saas w-full" />
            </label>
            <label className="text-xs font-medium text-slate-600">
              Quantità ticket
              <input type="number" min="1" value={memoryForm.quantity} onChange={(event) => setMemoryForm((prev) => ({ ...prev, quantity: event.target.value }))} className="mt-1 input-saas w-full" />
            </label>
            <label className="text-xs font-medium text-slate-600 sm:col-span-2">
              Tariffa
              <input value={memoryForm.tariff_label} onChange={(event) => setMemoryForm((prev) => ({ ...prev, tariff_label: event.target.value }))} className="mt-1 input-saas w-full" />
            </label>
            <label className="text-xs font-medium text-slate-600 sm:col-span-2">
              Note
              <textarea value={memoryForm.notes} onChange={(event) => setMemoryForm((prev) => ({ ...prev, notes: event.target.value }))} rows={3} className="mt-1 input-saas w-full resize-none" />
            </label>
            {memoryRawText && (
              <label className="text-xs font-medium text-slate-600 sm:col-span-2">
                Testo letto dalla foto
                <textarea value={memoryRawText} readOnly rows={6} className="mt-1 input-saas w-full resize-y bg-slate-50 text-[11px]" />
              </label>
            )}
          </div>

          {memoryError && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-600">{memoryError}</p>}

          <div className="flex gap-2 pt-1">
            <button type="button" onClick={() => setMemoryModalOpen(false)} className="flex-1 rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50">
              Annulla
            </button>
            <button type="button" onClick={() => void handleMemorySubmit()} disabled={memorySubmitting} className="flex-1 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50">
              {memorySubmitting ? "Salvataggio..." : "Salva ticket in memoria"}
            </button>
          </div>
        </div>
      </div>
    )}
    {verifyModal && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
        <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl bg-white p-6 shadow-xl space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-slate-800">Verifica emissione Medmar</h2>
            <button
              type="button"
              onClick={() => { setVerifyModal(null); dispatchMedmarPrepare({ type: "RESET" }); setMedmarDelivery({ phase: "idle" }); }}
              className="text-slate-400 hover:text-slate-600 text-xl leading-none"
            >×</button>
          </div>

          <div className="flex items-center gap-2">
            <div className="flex-1 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs font-semibold text-amber-800 text-center">
              NESSUNA EMISSIONE ESEGUITA
            </div>
            {verifyModal.result.is_live && (
              <span className="rounded-full bg-emerald-100 border border-emerald-300 px-2.5 py-1 text-[10px] font-bold text-emerald-700 whitespace-nowrap">
                🟢 DATI MEDMAR LIVE
              </span>
            )}
          </div>

          <div className="rounded-xl bg-slate-50 border border-slate-200 px-4 py-3 space-y-0.5">
            <p className="text-sm font-semibold text-slate-800">{verifyModal.result.customer_name ?? verifyModal.group.customerName}</p>
            <p className="text-xs text-slate-500">{verifyModal.result.pax} pax</p>
            {verifyModal.result.pratica && <p className="text-xs text-slate-400 font-mono">Pratica: {verifyModal.result.pratica}</p>}
          </div>

          {verifyModal.result.error && (
            <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-600">{verifyModal.result.error}</p>
          )}

          {verifyModal.result.status === "medmar_auth_expired" && (
            <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-600">Sessione Medmar scaduta: impossibile verificare in tempo reale. Contattare l&apos;amministratore per rinnovare l&apos;accesso.</p>
          )}
          {verifyModal.result.status === "medmar_unavailable" && (
            <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-600">Medmar non ha risposto: nessuna emissione possibile finché il portale non è di nuovo raggiungibile.</p>
          )}

          {!verifyModal.result.error && (
            <div className="space-y-2">
              {([["outward", "Andata"], ["return", "Ritorno"]] as const).map(([field, label]) => {
                const leg = verifyModal.result[field];
                if (!leg) return null;
                const alreadyDeparted = verifyModal.result.warnings.some((w) => w.code === "course_already_departed" && w.leg === field);
                return (
                  <div key={field} className={`rounded-lg border px-3 py-2 text-xs ${alreadyDeparted ? "bg-rose-50 border-rose-200" : "bg-slate-50 border-slate-200"}`}>
                    <p className="font-semibold text-slate-700">{label} — {leg.route ? `${leg.route.from} → ${leg.route.to}` : "tratta non determinata"}</p>
                    {alreadyDeparted ? (
                      <p className="font-semibold text-rose-700">Corsa già partita</p>
                    ) : (
                      <p className="text-slate-500">{leg.date} · richiesto {leg.requested_time ?? "—"} · corsa {leg.matched_departure_time ?? "non confermata"}{leg.vessel ? ` · ${leg.vessel}` : ""}</p>
                    )}
                    {leg.id_corsa != null && <p className="text-slate-400">id_corsa: {leg.id_corsa} {leg.source === "local_fallback" && "(fallback locale, solo diagnostico)"}</p>}
                  </div>
                );
              })}

              <div className="rounded-lg bg-slate-50 border border-slate-200 px-3 py-2 text-xs">
                <p className="font-semibold text-slate-700">Tariffa</p>
                <p className="text-slate-500">{verifyModal.result.tariff?.label ?? "non determinata"}</p>
                {(verifyModal.result.tariff?.id_biglietto != null || verifyModal.result.tariff?.id_tariffa != null) && (
                  <p className="text-slate-400">id_biglietto: {verifyModal.result.tariff?.id_biglietto ?? "—"} · id_tariffa: {verifyModal.result.tariff?.id_tariffa ?? "—"}</p>
                )}
                <p className="text-slate-500">Prezzo unitario: {formatEur(verifyModal.result.tariff?.unit_price_cents)}</p>
                {verifyModal.result.taxes.map((tax, i) => (
                  <p key={i} className="text-slate-500">{tax.label}: {formatEur(tax.amount_cents)}</p>
                ))}
                <p className="text-slate-700 font-semibold">Totale previsto: {formatEur(verifyModal.result.expected_total_cents)}</p>
              </div>

              {verifyModal.result.status === "passenger_payload_pending_verification" && verifyModal.result.ticket_breakdown && (
                <div className="rounded-xl bg-amber-50 border border-amber-200 px-4 py-3 space-y-2">
                  <p className="text-xs font-semibold text-amber-900">Composizione passeggeri (prezzi Medmar live)</p>
                  {([
                    ["Adulto", verifyModal.result.ticket_breakdown.adult],
                    ["Bambino", verifyModal.result.ticket_breakdown.child],
                    ["Infant", verifyModal.result.ticket_breakdown.infant],
                  ] as const).map(([label, t]) =>
                    t ? (
                      <p key={label} className="text-xs text-amber-800">
                        {label} x {t.count} · {formatEur(t.unit_price_cents)} cad. · totale {formatEur(t.total_cents)}
                      </p>
                    ) : null
                  )}
                  {verifyModal.result.ticket_breakdown.taxes && verifyModal.result.ticket_breakdown.taxes.count > 0 && (
                    <p className="text-xs text-amber-800">
                      {verifyModal.result.ticket_breakdown.taxes.label ?? "Tassa di sbarco"} x {verifyModal.result.ticket_breakdown.taxes.count} · totale {formatEur(verifyModal.result.ticket_breakdown.taxes.total_amount_cents)}
                    </p>
                  )}
                  <p className="text-sm font-semibold text-amber-900 pt-1 border-t border-amber-200">
                    Il prezzo Medmar è stato verificato, ma l&apos;emissione automatica dei minori non è ancora abilitata.
                  </p>
                  <button
                    type="button"
                    disabled
                    className="w-full rounded-xl bg-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-600 cursor-not-allowed"
                  >
                    Emissione minori non ancora disponibile
                  </button>
                </div>
              )}

              <p className="text-xs font-semibold text-slate-600">
                Stato: {verifyModal.result.status} · {verifyModal.result.can_issue ? "dati sufficienti per una futura emissione" : "verifica manuale necessaria"}
              </p>

              {verifyModal.result.warnings.length > 0 && (() => {
                const operatorWarnings = verifyModal.result.warnings.filter((w) => !isMedmarTechnicalDiagnostic(w));
                const technicalDiagnostics = verifyModal.result.warnings.filter(isMedmarTechnicalDiagnostic);
                return (
                <div className="space-y-2">
                  {([
                    ["outward", "Andata"],
                    ["return", "Ritorno"],
                    [undefined, "Generali"],
                  ] as const).map(([legKey, legLabel]) => {
                    const legWarnings = operatorWarnings.filter((w) => w.leg === legKey);
                    if (legWarnings.length === 0) return null;
                    return (
                      <div key={legLabel} className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 space-y-1">
                        <p className="text-[10px] font-bold uppercase tracking-wide text-amber-600">{legLabel}</p>
                        {legWarnings.map((w, i) => (
                          <p key={i} className="text-[11px] leading-snug text-amber-800 break-words">⚠ {w.message}</p>
                        ))}
                      </div>
                    );
                  })}
                  {operatorWarnings.length === 0 && verifyModal.result.can_issue && (
                    <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
                      Dati verificati: non ci sono avvisi operativi da correggere.
                    </div>
                  )}
                  {technicalDiagnostics.length > 0 && (
                    <details className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                      <summary className="cursor-pointer font-semibold text-slate-700">
                        Dettagli tecnici verifica Medmar ({technicalDiagnostics.length})
                      </summary>
                      <div className="mt-2 space-y-1">
                        {technicalDiagnostics.map((w, i) => (
                          <p key={i} className="leading-snug break-words">• {w.message}</p>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
                );
              })()}
            </div>
          )}

          {verifyModal.result.can_issue && verifyModal.result.is_live && (
            <div className="space-y-3 border-t border-slate-100 pt-3">
              {/* UX 2-click (PARTE 1): la preparazione parte automaticamente dopo il click 1
                  (handleVerifyMedmar -> runPrepareMedmar), nessun pulsante manuale nel percorso normale. */}
              {medmarPrepareState.phase === "preparing" && (
                <div className="rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm text-indigo-700">
                  Preparazione emissione in corso...
                </div>
              )}

              {medmarPrepareState.phase === "prepare_failed" && (
                <div className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700 space-y-2">
                  <p className="font-semibold">{medmarPrepareState.error}</p>
                  <button
                    type="button"
                    onClick={() => void handlePrepareMedmar()}
                    className="rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-700"
                  >
                    Riprova preparazione
                  </button>
                </div>
              )}

              {(medmarPrepareState.phase === "prepared" || medmarPrepareState.phase === "issuing") && (
                <div className="rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-3 space-y-2">
                  <p className="text-xs font-semibold text-indigo-900">Controlla attentamente i dati prima di procedere.</p>
                  {([["outward", "Andata"], ["return", "Ritorno"]] as const).map(([field, label]) => {
                    const leg = medmarPrepareState.route[field];
                    if (!leg) return null;
                    return (
                      <p key={field} className="text-xs text-indigo-800">
                        {label}: {leg.route ? `${leg.route.from} → ${leg.route.to}` : "tratta non determinata"} · {leg.date} · {leg.matched_departure_time ?? leg.requested_time ?? "—"}{leg.vessel ? ` · ${leg.vessel}` : ""}
                      </p>
                    );
                  })}
                  <p className="text-xs text-indigo-800">Passeggeri: {medmarPrepareState.pax}</p>
                  <p className="text-sm font-semibold text-indigo-900">Prezzo totale da confermare: {formatEur(medmarPrepareState.expected_total_cents)}</p>
                  <div className="rounded-lg border border-indigo-200 bg-white px-2.5 py-2 text-[11px] text-slate-600 space-y-0.5">
                    <p><span className="font-semibold text-slate-500">Destinatario originale Medmar:</span> {medmarPrepareState.delivery.medmar_recipient.email}</p>
                    <p>
                      <span className="font-semibold text-slate-500">Destinatario finale ITS:</span>{" "}
                      {medmarPrepareState.delivery.final_recipient.type === "agency" ? "Agenzia" : "Cliente"} — {medmarPrepareState.delivery.final_recipient.name} ({medmarPrepareState.delivery.final_recipient.email})
                    </p>
                  </div>
                  {isTokenExpired(medmarPrepareState) ? (
                    <p className="text-xs font-semibold text-rose-700">Conferma scaduta. Ripeti la verifica.</p>
                  ) : (
                    <p className="text-[11px] text-indigo-700">Conferma valida fino alle {new Date(medmarPrepareState.expires_at).toLocaleTimeString("it-IT")}.</p>
                  )}
                  {!medmarPrepareState.issuing_enabled && (
                    <p className="text-[11px] text-amber-700">Emissione reale non ancora abilitata.</p>
                  )}

                  <button
                    type="button"
                    onClick={() => void handleConfirmIssueMedmar()}
                    disabled={!MEDMAR_ISSUING_UI_ENABLED || !canConfirmIssue(medmarPrepareState) || medmarPrepareState.phase === "issuing"}
                    className="w-full rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {medmarPrepareState.phase === "issuing"
                      ? "Emissione in corso..."
                      : !MEDMAR_ISSUING_UI_ENABLED || !medmarPrepareState.issuing_enabled
                        ? "Emissione reale non ancora abilitata"
                        : isTokenExpired(medmarPrepareState)
                          ? "Conferma scaduta"
                          : "Conferma emissione Medmar"}
                  </button>
                </div>
              )}

              {medmarPrepareState.phase === "issue_failed" && (
                <div className={`rounded-lg border px-3 py-2 text-sm ${medmarPrepareState.status === "remote_state_unknown" ? "border-rose-300 bg-rose-50 text-rose-700" : "border-amber-200 bg-amber-50 text-amber-800"}`}>
                  <p className="font-semibold">
                    {medmarPrepareState.status === "remote_state_unknown"
                      ? "Stato Medmar da verificare manualmente. Non riprovare."
                      : medmarPrepareState.status === "already_in_progress"
                        ? "Emissione già in corso."
                        : medmarPrepareState.error}
                  </p>
                  {isRetryableIssueFailure(medmarPrepareState) && (
                    <p className="mt-1 text-[11px]">Puoi ripetere la preparazione per un nuovo tentativo.</p>
                  )}
                </div>
              )}

              {medmarPrepareState.phase === "issued" && (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 space-y-0.5">
                  <p className="font-semibold">✅ Biglietto Medmar emesso{medmarPrepareState.result.existing ? " (emissione gia' esistente)" : ""}</p>
                  <p>Codice Medmar: {medmarPrepareState.result.medmar_numero}</p>
                  <p>Prenotazione: {medmarPrepareState.result.medmar_id_prenotazione}</p>
                  <p>Prezzo finale: {formatEur(medmarPrepareState.result.final_total_cents)}</p>

                  <div className="mt-2 border-t border-emerald-200 pt-2 space-y-1">
                    <p>
                      Stato invio:{" "}
                      {medmarDelivery.phase === "sending"
                        ? "Invio automatico in corso"
                        : medmarDeliveryStatusLabel(medmarDelivery.status, medmarDelivery.recipient)}
                    </p>
                    {medmarDelivery.phase === "done" && medmarDelivery.error && medmarDelivery.status !== "delivered" && (
                      <p className="text-rose-700">{medmarDelivery.error}</p>
                    )}
                    {/* Diagnostica retry automatico: mostrata solo quando disponibile (risposta di /medmar-send),
                        solo per gli stati che il cron di retry ritenta davvero (awaiting_pdf/pdf_not_found). */}
                    {medmarDelivery.phase === "done" &&
                      typeof medmarDelivery.attemptCount === "number" &&
                      medmarDelivery.status &&
                      MEDMAR_DELIVERY_AUTO_RETRY_STATUSES.has(medmarDelivery.status) && (
                        <p className="text-[11px] text-slate-500">
                          Tentativi: {medmarDelivery.attemptCount} · Ultimo tentativo:{" "}
                          {medmarDelivery.lastAttemptAt ? formatDateTimeIt(medmarDelivery.lastAttemptAt) : "—"} · Prossimo retry:{" "}
                          {medmarDelivery.lastAttemptAt ? formatDateTimeIt(addMinutesIso(medmarDelivery.lastAttemptAt, 2)) : "a breve"}
                        </p>
                      )}
                    {/* Pulsante manuale = fallback: mai mostrato se già delivered (terminale) o se lo stato è
                        "incerto" (delivery_in_progress/delivery_state_unknown) — nessun retry automatico su ambiguità. */}
                    {verifyModal &&
                      medmarDelivery.phase !== "sending" &&
                      medmarDelivery.status !== "delivered" &&
                      medmarDelivery.status !== "delivery_in_progress" &&
                      medmarDelivery.status !== "delivery_state_unknown" &&
                      medmarDelivery.status !== "remote_state_unknown_blocked" && (
                        <button
                          type="button"
                          onClick={() => void handleDeliverMedmarPdf(verifyModal.group.allServiceIds)}
                          className="mt-1 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
                        >
                          {medmarDelivery.status && MEDMAR_DELIVERY_RETRYABLE_STATUSES.has(medmarDelivery.status)
                            ? "Riprova ora"
                            : "Invia biglietto pulito"}
                        </button>
                      )}
                  </div>
                </div>
              )}
            </div>
          )}

          <button type="button" onClick={() => { setVerifyModal(null); dispatchMedmarPrepare({ type: "RESET" }); setMedmarDelivery({ phase: "idle" }); }}
            className="w-full rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50">
            Chiudi
          </button>
        </div>
      </div>
    )}

    {/* "Rimanda biglietto" (MVP sicuro) — PARTE 1: modal di conferma, stesso destinatario, nessuna nuova emissione. */}
    {resendModal && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
        <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-slate-800">Rimanda biglietto</h2>
            {!resendSending && (
              <button
                type="button"
                onClick={() => { setResendModal(null); setResendError(null); setResendSuccess(null); }}
                className="text-slate-400 hover:text-slate-600 text-xl leading-none"
              >×</button>
            )}
          </div>

          <div className="rounded-xl bg-slate-50 border border-slate-200 px-4 py-3 space-y-1 text-sm">
            <p><span className="font-semibold text-slate-700">Cliente:</span> {resendModal.customerName}</p>
            <p><span className="font-semibold text-slate-700">Codice Medmar:</span> {resendModal.attempt.medmar_numero}</p>
            <p><span className="font-semibold text-slate-700">ID prenotazione:</span> {resendModal.attempt.medmar_id_prenotazione}</p>
            <p><span className="font-semibold text-slate-700">Destinatario:</span> {resendModal.attempt.recipient_email}</p>
          </div>

          <p className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
            Verrà reinviato il PDF pulito già emesso allo stesso destinatario. Non verrà emesso un nuovo biglietto.
          </p>

          {resendError && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-600">{resendError}</p>}
          {resendSuccess && <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{resendSuccess}</p>}

          <div className="flex gap-2">
            <button
              type="button"
              disabled={resendSending}
              onClick={() => { setResendModal(null); setResendError(null); setResendSuccess(null); }}
              className="flex-1 rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
            >
              Annulla
            </button>
            <button
              type="button"
              disabled={resendSending || !!resendSuccess}
              onClick={() => void handleConfirmResend()}
              className="flex-1 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {resendSending ? "Invio in corso..." : "Rimanda biglietto"}
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}
