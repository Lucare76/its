"use client";

import { useEffect, useMemo, useState, useCallback, useReducer } from "react";
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
  type MedmarPrepareState,
  type MedmarDeliveryDiagnostics,
} from "@/lib/medmar-issue-flow";

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

function extractPratica(notes: string | null | undefined): string {
  const m = (notes ?? "").match(/\[practice:([^\]]+)\]/);
  return m?.[1] ?? "";
}

function normalizeCustomerKey(name: string, pratica: string): string {
  // Se c'è una pratica, usa quella come chiave primaria per evitare merge errati
  if (pratica) return pratica;
  return name.trim().toLowerCase().replace(/\s+/g, " ");
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

/** Stati che il cron di retry automatico (/api/cron/medmar-delivery-retry) ritenta davvero — deve restare identico a RETRYABLE_DELIVERY_STATUSES in delivery-types.ts. */
const MEDMAR_DELIVERY_AUTO_RETRY_STATUSES = new Set(["awaiting_pdf", "pdf_not_found"]);

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

function medmarDeliveryStatusLabel(status: string | undefined, recipient: string | null | undefined): string {
  if (!status) return "—";
  if (status === "delivered" && recipient) return `✅ Biglietto inviato a ${recipient}`;
  return MEDMAR_DELIVERY_STATUS_LABEL[status] ?? status;
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
    if (tenantId) void loadData(tenantId, dateFrom, dateTo);
  };

  const handleVerifyMedmar = async (g: BookingGroup) => {
    if (!token) return;
    setVerifying(g.key);
    setVerifyError(null);
    try {
      const data = await apiFetch<MedmarPreflightResult>("/api/services/medmar-preflight", token, {
        method: "POST",
        body: JSON.stringify({ service_ids: g.allServiceIds }),
      });
      dispatchMedmarPrepare({ type: "RESET" });
      setVerifyModal({ group: g, result: data });
    } catch (err) {
      setVerifyError(err instanceof Error ? err.message : "Errore durante la verifica Medmar.");
    } finally {
      setVerifying(null);
    }
  };

  // STEP 1 -> STEP 2: preflight/local validation server-side, SOLO
  // lettura verso Medmar. Nessuna mutazione Medmar puo' partire da questa
  // chiamata (vedi app/api/services/medmar-issue/prepare/route.ts).
  const handlePrepareMedmar = async () => {
    if (!token || !verifyModal) return;
    if (medmarPrepareState.phase === "preparing" || medmarPrepareState.phase === "prepared") return;
    dispatchMedmarPrepare({ type: "PREPARE_START" });
    try {
      const data = await apiFetchJson<MedmarPrepareApiResponse>("/api/services/medmar-issue/prepare", token, {
        method: "POST",
        body: JSON.stringify({ service_ids: verifyModal.group.allServiceIds }),
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

  const loadData = useCallback(async (tid: string, from?: string, to?: string) => {
    if (!supabase) return;
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
    if (servicesRes.error) { setError(servicesRes.error.message); return; }
    setServices((servicesRes.data ?? []) as Service[]);
    setHotels((hotelsRes.data ?? []) as Hotel[]);
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
      await loadData(session.tenantId, dateFrom, dateTo);
      if (session.accessToken) await loadTicketMemory(session.accessToken, dateFrom, dateTo);
      if (active) setLoading(false);
    };
    void load();
    return () => { active = false; };
  }, [dateFrom, dateTo, loadData, loadTicketMemory]);

  const hotelsById = useMemo(() => new Map(hotels.map((h) => [h.id, h])), [hotels]);

  const medmarServices = useMemo(() => services.filter(isMedmarService), [services]);

  // Raggruppa per pratica (o nome se non c'è pratica)
  const bookingGroups = useMemo((): BookingGroup[] => {
    const map = new Map<string, BookingGroup>();

    for (const s of medmarServices) {
      const pratica = extractPratica(s.notes);
      const key = normalizeCustomerKey(s.customer_name ?? "sconosciuto", pratica);
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

  const byDate = useMemo(() => {
    const map = new Map<string, BookingGroup[]>();
    for (const g of visibleGroups) {
      const k = g.refDate || "senza-data";
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(g);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [visibleGroups]);

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
        if (tenantId) void loadData(tenantId, dateFrom, dateTo);
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
      if (data.ok && tenantId) void loadData(tenantId, dateFrom, dateTo);
    } catch {
      setMedmarDelivery({ phase: "done", status: "delivery_state_unknown", error: "Errore di rete durante l'invio." });
    }
  };

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
              if (tenantId) void loadData(tenantId, dateFrom, dateTo);
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

      <div className="rounded-2xl border border-indigo-200 bg-indigo-50 p-4 space-y-3">
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

      {!loading && bookingGroups.length === 0 && (
        <div className="card p-6 text-center text-sm text-slate-500">
          Nessun biglietto MEDMAR nel periodo selezionato.
        </div>
      )}

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
            <button type="button"
              onClick={() => handleCopy(
                groups.map((g) =>
                  [g.customerName, `${g.pax} pax`, g.phone ?? "", g.hotel,
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
              const isSending = sending === g.key;
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
                      {g.pratica && <p className="text-[10px] text-slate-300 font-mono leading-tight">{g.pratica}</p>}
                    </div>
                    <span className="shrink-0 rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-bold text-blue-700">{g.pax}p</span>
                  </div>

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

                  {/* Azioni */}
                  <div className="border-t border-slate-100 px-3 py-2 flex gap-1.5">
                    {isSent ? (
                      <div className="flex flex-1 items-center gap-1.5 rounded-lg bg-emerald-50 border border-emerald-200 px-2 py-1">
                        <span className="text-[11px] text-emerald-700 font-semibold flex-1">✓ Inviato</span>
                        <button type="button" onClick={() => setSendModal({ group: g, pdfFile: null })}
                          className="text-[10px] text-emerald-600 underline hover:no-underline">Reinvia</button>
                      </div>
                    ) : (
                      <button type="button" disabled={isSending} onClick={() => setSendModal({ group: g, pdfFile: null })}
                        className="flex-1 rounded-lg bg-blue-600 px-2 py-1.5 text-[11px] font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
                        {isSending ? "Invio..." : "✓ Fatto e invia"}
                      </button>
                    )}
                    <button type="button" disabled={deleting === g.key} onClick={() => void handleDelete(g)}
                      className="flex-1 rounded-lg border border-rose-200 bg-rose-50 px-2 py-1.5 text-[11px] font-medium text-rose-600 hover:bg-rose-100 disabled:opacity-50">
                      {deleting === g.key ? "..." : "Elimina"}
                    </button>
                  </div>
                  <div className="border-t border-slate-100 px-3 py-1.5">
                    <button type="button" disabled={verifying === g.key} onClick={() => void handleVerifyMedmar(g)}
                      className="w-full rounded-lg border border-indigo-200 bg-indigo-50 px-2 py-1.5 text-[11px] font-medium text-indigo-700 hover:bg-indigo-100 disabled:opacity-50">
                      {verifying === g.key ? "Verifica in corso..." : "🔍 Verifica emissione Medmar"}
                    </button>
                    {verifyError && !verifying && (
                      <p className="mt-1 text-[10px] text-rose-600">{verifyError}</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </section>

    {/* Modal invio con allegato PDF */}
    {sendModal && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
        <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-slate-800">Invia biglietto all&apos;agenzia</h2>
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
              <button
                type="button"
                onClick={() => void handlePrepareMedmar()}
                disabled={medmarPrepareState.phase === "preparing" || medmarPrepareState.phase === "prepared" || medmarPrepareState.phase === "issuing" || medmarPrepareState.phase === "issued"}
                className="w-full rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {medmarPrepareState.phase === "preparing" ? "Verifica finale in corso..." : "Prepara emissione Medmar"}
              </button>

              {medmarPrepareState.phase === "prepare_failed" && (
                <div className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700">
                  <p className="font-semibold">{medmarPrepareState.error}</p>
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
                          : "Conferma ed emetti biglietto Medmar"}
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
    </>
  );
}
