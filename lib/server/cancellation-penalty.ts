import type { SupabaseClient } from "@supabase/supabase-js";
import { emailDataTable, emailHighlightBox, emailHtml } from "@/lib/server/email-layout";
import { sendEmail } from "@/lib/server/send-email";
import { resolveAgencyRecipient } from "@/lib/server/report-job-email";
import { auditLog } from "@/lib/server/ops-audit";

/**
 * Penali di cancellazione (tabella service_cancellation_penalties, migration
 * 0286). Salvataggio della penale (RPC apply_cancellation_penalty) e invio
 * email all'agenzia sono DUE passi separati: questo modulo gestisce solo il
 * secondo, con un claim compare-and-swap sullo stato email per non inviare
 * mai due volte la stessa comunicazione (doppio click, reinvio concorrente).
 *
 * Non tocca MAI services.agency_quoted_price_cents (a differenza del vecchio
 * flusso finalize_cancellation_request).
 */

export const PENALTY_ROLES = ["admin", "operator", "supervisor"] as const;

export type PenaltyEmailStatus = "pending" | "sending" | "sent" | "failed" | "skipped" | "no_recipient" | "not_required";
export type PenaltyEmailChannel = "penalty" | "void";

export type PenaltyRow = {
  id: string;
  tenant_id: string;
  service_id: string;
  linked_service_id: string | null;
  scope: "leg" | "practice";
  penalty_type: "none" | "percentage" | "fixed";
  penalty_percentage: number | null;
  penalty_amount_cents: number;
  penalty_notes: string | null;
  status: "active" | "superseded" | "voided";
  supersedes_ids: string[] | null;
  applied_at: string;
  applied_by_name: string | null;
  voided_at: string | null;
  voided_by_name: string | null;
  void_reason: string | null;
  email_kind: "initial" | "rectification";
  email_status: PenaltyEmailStatus;
  email_recipient: string | null;
  email_sent_at: string | null;
  email_attempts: number;
  email_last_attempt_at: string | null;
  email_last_error: string | null;
  void_email_status: PenaltyEmailStatus | null;
  void_email_recipient: string | null;
  void_email_sent_at: string | null;
  void_email_attempts: number;
  void_email_last_attempt_at: string | null;
  void_email_last_error: string | null;
  created_at: string;
};

export const PENALTY_SELECT = [
  "id", "tenant_id", "service_id", "linked_service_id", "scope", "penalty_type", "penalty_percentage",
  "penalty_amount_cents", "penalty_notes", "status", "supersedes_ids", "applied_at", "applied_by_name",
  "voided_at", "voided_by_name", "void_reason", "email_kind", "email_status", "email_recipient",
  "email_sent_at", "email_attempts", "email_last_attempt_at", "email_last_error", "void_email_status",
  "void_email_recipient", "void_email_sent_at", "void_email_attempts", "void_email_last_attempt_at",
  "void_email_last_error", "created_at",
].join(", ");

export type PenaltyServiceRow = {
  id: string;
  status: string;
  customer_name: string | null;
  practice_number: string | null;
  notes: string | null;
  date: string | null;
  direction: string | null;
  arrival_date: string | null;
  departure_date: string | null;
  booking_service_kind: string | null;
  pax: number | null;
  agency_id: string | null;
  billing_party_name: string | null;
  linked_service_id: string | null;
  medmar_ticket_sent_at: string | null;
  hotels?: { name: string | null } | Array<{ name: string | null }> | null;
  agencies?: AgencyEmailRow | AgencyEmailRow[] | null;
};

type AgencyEmailRow = {
  id: string;
  name: string | null;
  booking_email: string | null;
  contact_email: string | null;
  booking_emails: unknown;
  contact_emails: unknown;
};

export const PENALTY_SERVICE_SELECT =
  "id, status, customer_name, practice_number, notes, date, direction, arrival_date, departure_date, booking_service_kind, pax, agency_id, billing_party_name, linked_service_id, medmar_ticket_sent_at, hotels(name), agencies(id, name, booking_email, contact_email, booking_emails, contact_emails)";

// Un tentativo rimasto in 'sending' oltre questa soglia (processo morto a
// metà invio) può essere ripreso manualmente con "Reinvia email".
export const STALE_SENDING_MS = 10 * 60 * 1000;

const BOOKING_KIND_LABELS: Record<string, string> = {
  transfer_station_hotel: "Transfer Stazione / Hotel",
  transfer_airport_hotel: "Transfer Aeroporto / Hotel",
  transfer_port_hotel: "Transfer Porto / Hotel",
  transfer_hotel_port: "Transfer Hotel / Porto",
  bus_city_hotel: "Bus Città / Hotel",
  excursion: "Escursione",
};

// ─── Helper puri ──────────────────────────────────────────────────────────────

function first<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? value[0] ?? null : value;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function formatEurCents(cents: number): string {
  return (cents / 100).toLocaleString("it-IT", { style: "currency", currency: "EUR" });
}

function formatDateIt(iso: string | null | undefined): string {
  const m = (iso ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "—";
}

export function formatDateTimeRome(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("it-IT", { timeZone: "Europe/Rome", dateStyle: "short", timeStyle: "short" }).format(d);
}

/** Stessa priorità di app/api/invoices/route.ts: tag [practice:X] nelle note, poi practice_number. */
export function practiceLabel(service: Pick<PenaltyServiceRow, "id" | "practice_number" | "notes">): string {
  const tag = (service.notes ?? "").match(/\[practice:([^\]]+)\]/)?.[1]?.trim();
  return tag || service.practice_number?.trim() || `#${service.id.slice(0, 8).toUpperCase()}`;
}

function legLabel(service: PenaltyServiceRow): string {
  const isDeparture = service.direction === "departure";
  const date = isDeparture ? service.departure_date ?? service.date : service.arrival_date ?? service.date;
  return `${isDeparture ? "Ritorno" : "Andata"} ${formatDateIt(date)}`;
}

export function penaltyLabel(row: Pick<PenaltyRow, "penalty_type" | "penalty_amount_cents" | "penalty_percentage">): string {
  if (row.penalty_type === "none") return "Nessuna penale";
  if (row.penalty_type === "percentage" && row.penalty_percentage != null) {
    return `${row.penalty_percentage}% (${formatEurCents(row.penalty_amount_cents)})`;
  }
  return formatEurCents(row.penalty_amount_cents);
}

export type PenaltyEmailKind = "initial" | "rectification" | "void";

export type PenaltyEmailInput = {
  kind: PenaltyEmailKind;
  agencyName: string | null;
  services: PenaltyServiceRow[];
  scope: "leg" | "practice";
  cancelledAt: string | null;
  penalty: Pick<PenaltyRow, "penalty_type" | "penalty_amount_cents" | "penalty_percentage" | "penalty_notes">;
  previous?: Array<Pick<PenaltyRow, "penalty_type" | "penalty_amount_cents" | "penalty_percentage">>;
  voidReason?: string | null;
};

export function buildPenaltyEmail(input: PenaltyEmailInput): { subject: string; html: string } {
  const main = input.services[0];
  const customer = (main?.customer_name ?? "Cliente").trim().toUpperCase();
  const practice = main ? practiceLabel(main) : "—";
  const kindLabel = BOOKING_KIND_LABELS[main?.booking_service_kind ?? ""] ?? "Transfer";
  const legs = input.services.map(legLabel).join(" · ");
  const hotel = first(main?.hotels)?.name ?? null;
  const greeting = `Gentile ${escapeHtml(input.agencyName?.trim() || "Agenzia")},`;

  const rows: Array<[string, string]> = [
    ["Pratica", escapeHtml(practice)],
    ["Cliente", escapeHtml(customer)],
    ["Servizio", escapeHtml(`${kindLabel} — ${legs}`)],
    ["Riferita a", input.scope === "practice" ? "Intera pratica (andata e ritorno)" : "Singola tratta"],
  ];
  if (hotel) rows.push(["Hotel", escapeHtml(hotel)]);
  rows.push(["Data cancellazione", escapeHtml(formatDateTimeRome(input.cancelledAt))]);

  const notesBlock = input.penalty.penalty_notes?.trim()
    ? `<p style="margin:16px 0 0;color:#475569;"><strong>Note:</strong> ${escapeHtml(input.penalty.penalty_notes.trim())}</p>`
    : "";
  const newLabel = escapeHtml(penaltyLabel(input.penalty));
  const previousLabel = (input.previous ?? []).map((p) => penaltyLabel(p)).join(" + ");

  let subject: string;
  let intro: string;
  let highlight: string;

  if (input.kind === "void") {
    subject = `Annullamento penale cancellazione pratica ${practice} – ${customer}`;
    intro = `in riferimento alla cancellazione della pratica <strong>${escapeHtml(practice)}</strong>, vi comunichiamo che la penale precedentemente comunicata <strong>è stata annullata</strong> e la prenotazione è stata ripristinata.`;
    highlight = `<p style="margin:0;font-size:15px;color:#334155;">Penale annullata: <strong>${newLabel}</strong></p>`
      + (input.voidReason?.trim() ? `<p style="margin:8px 0 0;font-size:13px;color:#64748b;">Motivo: ${escapeHtml(input.voidReason.trim())}</p>` : "");
  } else if (input.kind === "rectification") {
    subject = `Rettifica penale cancellazione pratica ${practice} – ${customer}`;
    intro = `in riferimento alla cancellazione della pratica <strong>${escapeHtml(practice)}</strong>, vi comunichiamo una <strong>rettifica</strong> della penale precedentemente comunicata.`;
    highlight = (previousLabel ? `<p style="margin:0 0 6px;font-size:14px;color:#64748b;">Penale precedente: <span style="text-decoration:line-through;">${escapeHtml(previousLabel)}</span></p>` : "")
      + `<p style="margin:0;font-size:18px;font-weight:700;color:#991b1b;">Nuova penale: ${newLabel}</p>`;
  } else {
    subject = `Penale cancellazione pratica ${practice} – ${customer}`;
    intro = `in riferimento alla cancellazione della pratica <strong>${escapeHtml(practice)}</strong> relativa al servizio sotto indicato, è stata applicata la seguente penale di cancellazione.`;
    highlight = input.penalty.penalty_type === "percentage" && input.penalty.penalty_percentage != null
      ? `<p style="margin:0;font-size:15px;color:#334155;">Penale: <strong>${input.penalty.penalty_percentage}%</strong></p><p style="margin:6px 0 0;font-size:18px;font-weight:700;color:#991b1b;">Importo: ${escapeHtml(formatEurCents(input.penalty.penalty_amount_cents))}</p>`
      : `<p style="margin:0;font-size:18px;font-weight:700;color:#991b1b;">Importo penale: ${newLabel}</p>`;
  }

  const html = emailHtml(`
    <p style="margin:0 0 12px;color:#0f172a;">${greeting}</p>
    <p style="margin:0 0 8px;color:#475569;">${intro}</p>
    ${emailDataTable(rows)}
    ${emailHighlightBox(highlight, "#fef2f2", "#fecaca")}
    ${input.kind !== "void" ? notesBlock : ""}
    <p style="margin:24px 0 0;color:#475569;">Cordiali saluti<br><strong>Ischia Transfer Service</strong></p>
  `, { title: subject, preheader: `${customer} — pratica ${practice}` });

  return { subject, html };
}

export type PenaltyRpcErrorMapping = { status: number; code: string; error: string };

const RPC_ERRORS: Record<string, PenaltyRpcErrorMapping> = {
  PENALTY_INVALID_INPUT: { status: 400, code: "invalid_input", error: "Dati penale non validi." },
  PENALTY_SERVICE_NOT_FOUND: { status: 404, code: "not_found", error: "Prenotazione non trovata." },
  PENALTY_SERVICE_NOT_CANCELLED: { status: 409, code: "not_cancelled", error: "La penale si può applicare solo a tratte cancellate." },
  PENALTY_NO_LINKED_SERVICE: { status: 409, code: "no_linked_service", error: "Nessuna tratta collegata: la penale può riferirsi solo a questa tratta." },
  PENALTY_STALE_STATE: { status: 409, code: "stale_state", error: "La penale è stata modificata da un altro operatore. Ricarica e riprova." },
  PENALTY_RECTIFICATION_CONFIRMATION_REQUIRED: {
    status: 409,
    code: "rectification_confirmation_required",
    error: "Questa penale è già stata comunicata all'agenzia. La modifica genererà una rettifica.",
  },
  RESTORE_INVALID_INPUT: { status: 400, code: "invalid_input", error: "Dati ripristino non validi." },
  RESTORE_SERVICE_NOT_FOUND: { status: 404, code: "not_found", error: "Prenotazione non trovata." },
  RESTORE_ACTIVE_PENALTY: { status: 409, code: "active_penalty", error: "Questa prenotazione ha una penale attiva: scegli se annullarla o mantenerla." },
};

export function mapPenaltyRpcError(message: string | null | undefined): PenaltyRpcErrorMapping | null {
  if (!message) return null;
  const key = Object.keys(RPC_ERRORS).find((code) => message.includes(code));
  return key ? RPC_ERRORS[key] : null;
}

// ─── Destinatario ─────────────────────────────────────────────────────────────

function normalizeEmail(value: unknown): string | null {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  return email.includes("@") ? email : null;
}

/**
 * Ordine: agenzia collegata (booking_email, contact_email, booking_emails[],
 * contact_emails[]), poi fallback su billing_party_name con la stessa logica
 * di matching già usata dagli invii report (report-job-email.ts).
 */
export async function resolvePenaltyRecipient(
  admin: SupabaseClient,
  tenantId: string,
  service: Pick<PenaltyServiceRow, "agency_id" | "billing_party_name" | "agencies">
): Promise<{ email: string | null; agencyName: string | null; source: "agency_id" | "billing_party_name" | null }> {
  const agency = first(service.agencies);
  if (service.agency_id && agency) {
    const candidates = [
      agency.booking_email,
      agency.contact_email,
      ...(Array.isArray(agency.booking_emails) ? agency.booking_emails : []),
      ...(Array.isArray(agency.contact_emails) ? agency.contact_emails : []),
    ];
    const email = candidates.map(normalizeEmail).find((value): value is string => Boolean(value)) ?? null;
    if (email) return { email, agencyName: agency.name ?? null, source: "agency_id" };
  }
  const fallback = await resolveAgencyRecipient(admin, tenantId, service.billing_party_name ?? agency?.name ?? null);
  if (fallback.recipient) {
    return { email: fallback.recipient, agencyName: fallback.matchedAgency ?? agency?.name ?? null, source: "billing_party_name" };
  }
  return { email: null, agencyName: agency?.name ?? service.billing_party_name ?? null, source: null };
}

// ─── Lettura contesto ─────────────────────────────────────────────────────────

export async function loadPenaltyServices(admin: SupabaseClient, tenantId: string, ids: string[]): Promise<PenaltyServiceRow[]> {
  const unique = Array.from(new Set(ids.filter(Boolean)));
  if (unique.length === 0) return [];
  const { data, error } = await admin.from("services").select(PENALTY_SERVICE_SELECT).eq("tenant_id", tenantId).in("id", unique);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as unknown as PenaltyServiceRow[];
  // Ordine stabile: l'ordine degli id richiesti (tratta principale per prima).
  return unique.map((id) => rows.find((row) => row.id === id)).filter((row): row is PenaltyServiceRow => Boolean(row));
}

/** Ultima cancellazione registrata: service_change_logs (CANCELLED), fallback status_events. */
export async function loadLatestCancellation(
  admin: SupabaseClient,
  tenantId: string,
  serviceIds: string[]
): Promise<Map<string, { cancelled_at: string; operator_name: string | null; reason: string | null; note: string | null }>> {
  const out = new Map<string, { cancelled_at: string; operator_name: string | null; reason: string | null; note: string | null }>();
  if (serviceIds.length === 0) return out;
  const { data: logs } = await admin
    .from("service_change_logs")
    .select("service_id, operator_name, created_at, after_data")
    .eq("tenant_id", tenantId)
    .eq("action", "CANCELLED")
    .in("service_id", serviceIds)
    .order("created_at", { ascending: false });
  for (const log of (logs ?? []) as Array<{ service_id: string; operator_name: string | null; created_at: string; after_data: Record<string, unknown> | null }>) {
    if (out.has(log.service_id)) continue;
    out.set(log.service_id, {
      cancelled_at: log.created_at,
      operator_name: log.operator_name ?? null,
      reason: typeof log.after_data?.cancellation_reason === "string" ? log.after_data.cancellation_reason : null,
      note: typeof log.after_data?.cancellation_note === "string" ? log.after_data.cancellation_note : null,
    });
  }
  const missing = serviceIds.filter((id) => !out.has(id));
  if (missing.length) {
    const { data: events } = await admin
      .from("status_events")
      .select("service_id, at, notes")
      .eq("tenant_id", tenantId)
      .eq("status", "cancelled")
      .in("service_id", missing)
      .order("at", { ascending: false });
    for (const ev of (events ?? []) as Array<{ service_id: string; at: string; notes: string | null }>) {
      if (out.has(ev.service_id)) continue;
      out.set(ev.service_id, { cancelled_at: ev.at, operator_name: null, reason: ev.notes ?? null, note: null });
    }
  }
  return out;
}

// ─── Invio email con claim ────────────────────────────────────────────────────

export type PenaltyEmailOutcome = {
  status: PenaltyEmailStatus;
  recipient: string | null;
  sent_at: string | null;
  error: string | null;
  claimed: boolean;
};

const AUTO_CLAIMABLE: PenaltyEmailStatus[] = ["pending"];
const RESEND_CLAIMABLE: PenaltyEmailStatus[] = ["pending", "failed", "skipped", "no_recipient"];

function channelColumns(channel: PenaltyEmailChannel) {
  const p = channel === "void" ? "void_email_" : "email_";
  return {
    status: `${p}status`,
    recipient: `${p}recipient`,
    sentAt: `${p}sent_at`,
    attempts: `${p}attempts`,
    lastAttemptAt: `${p}last_attempt_at`,
    lastError: `${p}last_error`,
  } as const;
}

function readChannel(row: PenaltyRow, channel: PenaltyEmailChannel) {
  return channel === "void"
    ? { status: row.void_email_status, attempts: row.void_email_attempts ?? 0, lastAttemptAt: row.void_email_last_attempt_at, recipient: row.void_email_recipient, sentAt: row.void_email_sent_at, lastError: row.void_email_last_error }
    : { status: row.email_status, attempts: row.email_attempts ?? 0, lastAttemptAt: row.email_last_attempt_at, recipient: row.email_recipient, sentAt: row.email_sent_at, lastError: row.email_last_error };
}

export function isClaimable(
  current: { status: PenaltyEmailStatus | null; lastAttemptAt: string | null },
  mode: "auto" | "resend",
  now = Date.now()
): boolean {
  if (!current.status) return false;
  const allowed = mode === "auto" ? AUTO_CLAIMABLE : RESEND_CLAIMABLE;
  if (allowed.includes(current.status)) return true;
  if (mode === "resend" && current.status === "sending") {
    const last = current.lastAttemptAt ? new Date(current.lastAttemptAt).getTime() : 0;
    return now - last > STALE_SENDING_MS;
  }
  return false;
}

/**
 * Invia (o reinvia) la comunicazione di una penale. Mai un throw verso il
 * chiamante per errori di invio: la penale è già salvata, l'esito email
 * viene persistito sulla riga e restituito.
 */
export async function deliverPenaltyEmail(
  admin: SupabaseClient,
  input: {
    tenantId: string;
    penaltyId: string;
    channel: PenaltyEmailChannel;
    mode: "auto" | "resend";
    actorUserId?: string | null;
    actorRole?: string | null;
  }
): Promise<PenaltyEmailOutcome> {
  const cols = channelColumns(input.channel);
  const { data: rowData, error: rowError } = await admin
    .from("service_cancellation_penalties")
    .select(PENALTY_SELECT)
    .eq("tenant_id", input.tenantId)
    .eq("id", input.penaltyId)
    .maybeSingle();
  if (rowError || !rowData) {
    return { status: "failed", recipient: null, sent_at: null, error: rowError?.message ?? "Penale non trovata.", claimed: false };
  }
  const row = rowData as unknown as PenaltyRow;
  const current = readChannel(row, input.channel);

  if (input.channel === "void" && row.status !== "voided") {
    return { status: current.status ?? "not_required", recipient: current.recipient, sent_at: current.sentAt, error: "Penale non annullata.", claimed: false };
  }
  if (input.channel === "penalty" && row.status !== "active") {
    // Una versione superata/annullata non va più comunicata.
    return { status: current.status ?? "not_required", recipient: current.recipient, sent_at: current.sentAt, error: "Penale non più attiva.", claimed: false };
  }
  if (!isClaimable(current, input.mode)) {
    return { status: current.status ?? "not_required", recipient: current.recipient, sent_at: current.sentAt, error: current.lastError, claimed: false };
  }

  // Claim compare-and-swap: vince un solo processo per (stato, tentativi).
  const nowIso = new Date().toISOString();
  let claimQuery = admin
    .from("service_cancellation_penalties")
    .update({ [cols.status]: "sending", [cols.attempts]: current.attempts + 1, [cols.lastAttemptAt]: nowIso })
    .eq("tenant_id", input.tenantId)
    .eq("id", input.penaltyId)
    .eq(cols.status, current.status as string)
    .eq(cols.attempts, current.attempts);
  claimQuery = current.lastAttemptAt ? claimQuery.eq(cols.lastAttemptAt, current.lastAttemptAt) : claimQuery.is(cols.lastAttemptAt, null);
  const { data: claimed, error: claimError } = await claimQuery.select("id");
  if (claimError || !claimed || (claimed as unknown[]).length === 0) {
    return { status: "sending", recipient: current.recipient, sent_at: current.sentAt, error: claimError?.message ?? null, claimed: false };
  }

  let outcome: PenaltyEmailOutcome;
  try {
    const serviceIds = [row.service_id, row.linked_service_id].filter((id): id is string => Boolean(id));
    const services = await loadPenaltyServices(admin, input.tenantId, serviceIds);
    const main = services[0];
    if (!main) throw new Error("Prenotazione non trovata.");
    const recipient = await resolvePenaltyRecipient(admin, input.tenantId, main);
    if (!recipient.email) {
      outcome = { status: "no_recipient", recipient: null, sent_at: null, error: "Nessuna email agenzia trovata.", claimed: true };
    } else {
      const cancellation = await loadLatestCancellation(admin, input.tenantId, [main.id]);
      let previous: PenaltyRow[] = [];
      if (input.channel === "penalty" && row.email_kind === "rectification" && (row.supersedes_ids ?? []).length) {
        const { data: prev } = await admin
          .from("service_cancellation_penalties")
          .select(PENALTY_SELECT)
          .eq("tenant_id", input.tenantId)
          .in("id", row.supersedes_ids ?? []);
        previous = (prev ?? []) as unknown as PenaltyRow[];
      }
      const { subject, html } = buildPenaltyEmail({
        kind: input.channel === "void" ? "void" : row.email_kind,
        agencyName: recipient.agencyName,
        services,
        scope: row.scope,
        cancelledAt: cancellation.get(main.id)?.cancelled_at ?? null,
        penalty: row,
        previous,
        voidReason: row.void_reason,
      });
      const result = await sendEmail({ to: recipient.email, subject, html });
      if (result.ok && result.skipped) {
        outcome = { status: "skipped", recipient: recipient.email, sent_at: null, error: "Servizio email non configurato (RESEND_API_KEY assente).", claimed: true };
      } else if (result.ok) {
        outcome = { status: "sent", recipient: recipient.email, sent_at: new Date().toISOString(), error: null, claimed: true };
      } else {
        outcome = { status: "failed", recipient: recipient.email, sent_at: null, error: result.error ?? "Invio email non riuscito.", claimed: true };
      }
    }
  } catch (err) {
    outcome = { status: "failed", recipient: null, sent_at: null, error: err instanceof Error ? err.message : "Invio email non riuscito.", claimed: true };
  }

  const { error: persistError } = await admin
    .from("service_cancellation_penalties")
    .update({
      [cols.status]: outcome.status,
      [cols.recipient]: outcome.recipient,
      [cols.sentAt]: outcome.sent_at,
      [cols.lastError]: outcome.error ? outcome.error.slice(0, 1000) : null,
    })
    .eq("tenant_id", input.tenantId)
    .eq("id", input.penaltyId);

  auditLog({
    event: outcome.status === "sent" ? "cancellation_penalty_email_sent" : "cancellation_penalty_email_not_sent",
    level: outcome.status === "sent" ? "info" : "warn",
    tenantId: input.tenantId,
    userId: input.actorUserId ?? null,
    role: input.actorRole ?? null,
    serviceId: row.service_id,
    outcome: outcome.status,
    details: {
      penalty_id: row.id,
      channel: input.channel,
      mode: input.mode,
      email_kind: input.channel === "void" ? "void" : row.email_kind,
      attempt: current.attempts + 1,
      error: outcome.error,
      persist_error: persistError?.message,
    },
  });

  return outcome;
}
