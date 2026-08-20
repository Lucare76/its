/**
 * Fase delivery — orchestratore dell'invio email del PDF Medmar pulito,
 * SUCCESSIVO all'emissione completata (medmar_issuing_attempts.status ===
 * "completed"). Compone: lookup mailbox (pdf-mailbox-lookup.ts) -> cleaner
 * gia' validato (pdf-cleaner.ts/pdf-validation.ts) -> resolver destinatario
 * gia' esistente (recipient-repository.ts/recipient-resolver.ts) -> invio
 * Resend con gestione esplicita successo/errore-chiaro/ambiguo.
 *
 * Regola invariante: `services.medmar_ticket_sent_at` viene impostato SOLO
 * dopo un `message_id` confermato da Resend. Mai prima, mai su risposta
 * ambigua/timeout (quello diventa "delivery_state_unknown", mai un retry
 * automatico).
 */
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { emailHtml } from "../email-layout";
import { getVerifiedFromEmail } from "../send-email";
import { createDeliveryRepository } from "./delivery-repository";
import {
  MANUAL_REVIEW_DELIVERY_STATUSES,
  TERMINAL_DELIVERY_STATUSES,
  type MedmarDeliveryAttempt,
  type MedmarDeliveryStatus,
} from "./delivery-types";
import { MedmarPdfMailboxError, findMedmarTicketPdf } from "./pdf-mailbox-lookup";
import { cleanMedmarPdf, MedmarPdfCleanerError } from "./pdf-cleaner";
import { validateCleanedMedmarPdf } from "./pdf-validation";
import { loadAgencyRecipient } from "./recipient-repository";
import { resolveFinalTicketRecipient, type MedmarFinalRecipient } from "./recipient-resolver";
import type { MedmarPreflightResult } from "./types";

export type MedmarDeliveryPreconditionFailure =
  | "issuing_attempt_not_found"
  | "issuing_not_completed"
  | "remote_state_unknown_blocked"
  | "already_sent";

export type MedmarDeliveryOutcome =
  | { ok: true; status: "delivered"; attempt: MedmarDeliveryAttempt; already_delivered: boolean }
  | { ok: false; status: MedmarDeliveryStatus; attempt: MedmarDeliveryAttempt; error: string }
  | { ok: false; status: MedmarDeliveryPreconditionFailure; error: string };

export type MedmarDeliveryInput = {
  admin: SupabaseClient;
  tenantId: string;
  userId: string;
  issuingAttemptId: string;
};

type IssuingAttemptRow = {
  id: string;
  tenant_id: string;
  status: string;
  service_ids: string[];
  remote_state_unknown: boolean;
  medmar_id_prenotazione: string | null;
  medmar_numero: string | null;
  preflight_snapshot: unknown;
};

async function loadIssuingAttempt(admin: SupabaseClient, tenantId: string, issuingAttemptId: string): Promise<IssuingAttemptRow | null> {
  const result = await admin
    .from("medmar_issuing_attempts")
    .select("id, tenant_id, status, service_ids, remote_state_unknown, medmar_id_prenotazione, medmar_numero, preflight_snapshot")
    .eq("id", issuingAttemptId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (result.error || !result.data) return null;
  const row = result.data as Record<string, unknown>;
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    status: String(row.status),
    service_ids: Array.isArray(row.service_ids) ? row.service_ids.map(String) : [],
    remote_state_unknown: row.remote_state_unknown === true,
    medmar_id_prenotazione: (row.medmar_id_prenotazione as string | null) ?? null,
    medmar_numero: (row.medmar_numero as string | null) ?? null,
    preflight_snapshot: row.preflight_snapshot ?? null,
  };
}

type DeliveryServiceRow = {
  id: string;
  agency_id: string | null;
  customer_name: string | null;
  customer_email: string | null;
  medmar_ticket_sent_at?: string | null;
};

async function loadDeliveryServices(admin: SupabaseClient, tenantId: string, serviceIds: string[]): Promise<DeliveryServiceRow[]> {
  const result = await admin
    .from("services")
    .select("id, agency_id, customer_name, customer_email, medmar_ticket_sent_at")
    .in("id", serviceIds)
    .eq("tenant_id", tenantId);
  if (result.error) throw new Error("medmar_delivery_services_lookup_failed");
  return (result.data ?? []) as unknown as DeliveryServiceRow[];
}

function formatItalianDateTime(dateIso: string | null, time: string | null): string {
  if (!dateIso) return "N/D";
  const [y, m, d] = dateIso.split("-");
  if (!y || !m || !d) return "N/D";
  const datePart = `${d}/${m}/${y}`;
  const timePart = (time ?? "").slice(0, 5);
  return timePart ? `${datePart} ${timePart}` : datePart;
}

export type MedmarDeliveryEmailContent = { subject: string; html: string; text: string };

/** Costruisce oggetto/corpo email esattamente nel formato richiesto — nessun contenuto extra, nessuna omissione. */
export function buildMedmarDeliveryEmailContent(input: {
  customerName: string;
  medmarNumero: string;
  preflightSnapshot: unknown;
}): MedmarDeliveryEmailContent {
  const snapshot = (input.preflightSnapshot ?? null) as MedmarPreflightResult | null;
  const outward = snapshot?.outward ?? null;
  const returnLeg = snapshot?.return ?? null;

  const outwardRoute = outward?.route ? `${outward.route.from} → ${outward.route.to}` : "N/D";
  const returnRoute = returnLeg?.route ? `${returnLeg.route.from} → ${returnLeg.route.to}` : "N/D";
  const trattaLine = `${outwardRoute} / ${returnRoute}`;
  const andataLine = formatItalianDateTime(outward?.date ?? null, outward?.matched_departure_time ?? null);
  const ritornoLine = formatItalianDateTime(returnLeg?.date ?? null, returnLeg?.matched_departure_time ?? null);

  const subject = `Biglietti Medmar - ${input.customerName} - ${input.medmarNumero}`;
  const text = [
    "Gentile Agenzia,",
    "",
    `in allegato i biglietti Medmar relativi alla prenotazione ${input.customerName}.`,
    "",
    `Prenotazione Medmar: ${input.medmarNumero}`,
    `Tratta: ${trattaLine}`,
    `Andata: ${andataLine}`,
    `Ritorno: ${ritornoLine}`,
    "",
    "Cordiali saluti",
    "Ischia Transfer Service",
  ].join("\n");

  const bodyHtml = `
    <p>Gentile Agenzia,</p>
    <p>in allegato i biglietti Medmar relativi alla prenotazione <strong>${input.customerName}</strong>.</p>
    <p>
      Prenotazione Medmar: <strong>${input.medmarNumero}</strong><br />
      Tratta: ${trattaLine}<br />
      Andata: ${andataLine}<br />
      Ritorno: ${ritornoLine}
    </p>
    <p>Cordiali saluti<br />Ischia Transfer Service</p>
  `;
  const html = emailHtml(bodyHtml, { title: subject, preheader: `Biglietti Medmar pronti — prenotazione ${input.customerName}` });

  return { subject, html, text };
}

export type MedmarDeliverySendResult =
  | { kind: "sent"; messageId: string }
  | { kind: "failed"; error: string }
  | { kind: "ambiguous"; error: string };

/** resendFetch di send-email.ts non accetta un AbortSignal: wrapper locale minimo per il timeout esplicito richiesto qui. */
async function resendFetchWithSignal(apiKey: string, payload: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
  const testRedirectRaw = process.env.EMAIL_TEST_REDIRECT?.trim();
  const testRedirectList = testRedirectRaw ? testRedirectRaw.split(/[,;\s]+/).map((e) => e.trim()).filter(Boolean) : [];
  const finalPayload = testRedirectList.length > 0 ? { ...payload, to: testRedirectList, cc: undefined, bcc: undefined } : payload;
  return fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(finalPayload),
    signal,
  });
}

/**
 * Invio diretto via Resend (non passa da sendEmail: serve l'allegato, che
 * SendEmailOptions non supporta). Timeout esplicito: un timeout/errore di
 * rete e' SEMPRE "ambiguous" (non sappiamo se l'email e' partita), mai
 * "failed" — la distinzione e' quella che decide se si puo' impostare
 * medmar_ticket_sent_at.
 */
export async function sendMedmarCleanedTicketEmail(input: {
  to: string;
  content: MedmarDeliveryEmailContent;
  attachmentFilename: string;
  attachmentBase64: string;
  timeoutMs?: number;
}): Promise<MedmarDeliverySendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { kind: "ambiguous", error: "RESEND_API_KEY non configurata: impossibile confermare l'invio." };

  const fromEmail = getVerifiedFromEmail();
  const payload: Record<string, unknown> = {
    from: `Ischia Transfer Service <${fromEmail}>`,
    to: [input.to],
    subject: input.content.subject,
    html: input.content.html,
    text: input.content.text,
    attachments: [{ filename: input.attachmentFilename, content: input.attachmentBase64 }],
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 20_000);
  try {
    const res = await resendFetchWithSignal(apiKey, payload, controller.signal);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { kind: "failed", error: `Resend HTTP ${res.status}: ${body.slice(0, 300)}` };
    }
    const parsed = (await res.json().catch(() => null)) as { id?: string } | null;
    if (!parsed?.id) {
      return { kind: "ambiguous", error: "Resend ha risposto 2xx senza message id: esito non confermabile." };
    }
    return { kind: "sent", messageId: parsed.id };
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    return {
      kind: "ambiguous",
      error: isAbort ? `Timeout invio email (${input.timeoutMs ?? 20_000}ms).` : err instanceof Error ? err.message : "Errore di rete.",
    };
  } finally {
    clearTimeout(timeout);
  }
}

type PdfResolution =
  | { kind: "ok"; original: Buffer; cleaned: Uint8Array; filename: string; messageUid: string; originalSha256: string; cleanedSha256: string }
  | { kind: "not_found" }
  | { kind: "ambiguous"; detail: string }
  | { kind: "validation_failed"; detail: string };

/** Dipendenze iniettabili — stesso pattern di issue-orchestrator.ts (deps? opzionali, default = implementazione reale) per permettere test unitari senza mailbox/Resend reali. */
export type MedmarDeliveryDeps = {
  repo?: import("./delivery-types").DeliveryRepository;
  loadIssuingAttempt?: typeof loadIssuingAttempt;
  loadDeliveryServices?: typeof loadDeliveryServices;
  findPdf?: typeof findMedmarTicketPdf;
  cleanPdf?: typeof cleanMedmarPdf;
  validatePdf?: typeof validateCleanedMedmarPdf;
  loadAgencyRecipient?: typeof loadAgencyRecipient;
  sendEmail?: typeof sendMedmarCleanedTicketEmail;
};

async function resolvePdfForDelivery(idPrenotazione: string, medmarNumero: string, deps?: MedmarDeliveryDeps): Promise<PdfResolution> {
  const findPdf = deps?.findPdf ?? findMedmarTicketPdf;
  const cleanPdf = deps?.cleanPdf ?? cleanMedmarPdf;
  const validatePdf = deps?.validatePdf ?? validateCleanedMedmarPdf;

  const lookup = await findPdf({ idPrenotazione, medmarNumero });
  if (lookup.kind === "not_found") return { kind: "not_found" };
  if (lookup.kind === "ambiguous") {
    return { kind: "ambiguous", detail: `${lookup.candidates.length} PDF compatibili trovati: ${lookup.candidates.map((c) => c.filename).join(", ")}` };
  }

  let cleaned: Uint8Array;
  try {
    cleaned = await cleanPdf(lookup.pdfBytes);
  } catch (err) {
    const detail = err instanceof MedmarPdfCleanerError ? err.message : err instanceof Error ? err.message : "Errore sconosciuto nel cleaner.";
    return { kind: "validation_failed", detail };
  }

  const validation = await validatePdf(cleaned, {
    medmarNumero,
    idPrenotazione,
    ticketNumbers: [],
    requiredPortKeywords: [],
  });
  if (!validation.ok) return { kind: "validation_failed", detail: validation.reason };

  return {
    kind: "ok",
    original: Buffer.from(lookup.pdfBytes),
    cleaned,
    filename: lookup.filename,
    messageUid: lookup.messageUid,
    originalSha256: lookup.sha256,
    cleanedSha256: createHash("sha256").update(Buffer.from(cleaned)).digest("hex"),
  };
}

type RecipientResolution = { ok: true; recipient: MedmarFinalRecipient } | { ok: false; error: string };

async function resolveDeliveryRecipient(admin: SupabaseClient, tenantId: string, primary: DeliveryServiceRow, deps?: MedmarDeliveryDeps): Promise<RecipientResolution> {
  const loadAgency = deps?.loadAgencyRecipient ?? loadAgencyRecipient;
  const agency = primary.agency_id ? await loadAgency(admin, tenantId, primary.agency_id) : null;
  const result = resolveFinalTicketRecipient({ agency, customerName: primary.customer_name, customerEmail: primary.customer_email });
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, recipient: result.recipient };
}

/**
 * Esegue la delivery completa: precondizioni -> lookup mailbox -> clean ->
 * valida -> risolvi destinatario -> invia -> aggiorna stato. Idempotente:
 * se gia' `delivered` non reinvia mai; se `medmar_ticket_sent_at` e' gia'
 * valorizzato su un service collegato, considera l'attempt come inviato
 * senza toccare nulla.
 */
export async function deliverMedmarTicket(input: MedmarDeliveryInput, deps?: MedmarDeliveryDeps): Promise<MedmarDeliveryOutcome> {
  const doLoadIssuingAttempt = deps?.loadIssuingAttempt ?? loadIssuingAttempt;
  const doLoadDeliveryServices = deps?.loadDeliveryServices ?? loadDeliveryServices;
  const doSendEmail = deps?.sendEmail ?? sendMedmarCleanedTicketEmail;

  const issuingAttempt = await doLoadIssuingAttempt(input.admin, input.tenantId, input.issuingAttemptId);
  if (!issuingAttempt) {
    return { ok: false, status: "issuing_attempt_not_found", error: "Nessun tentativo di emissione Medmar trovato per questo id." };
  }
  if (issuingAttempt.status !== "completed") {
    return { ok: false, status: "issuing_not_completed", error: `Emissione non completata (stato attuale: ${issuingAttempt.status}): invio bloccato.` };
  }
  if (issuingAttempt.remote_state_unknown) {
    return { ok: false, status: "remote_state_unknown_blocked", error: "Stato remoto Medmar incerto (remote_state_unknown): invio bloccato per sicurezza." };
  }
  if (!issuingAttempt.medmar_id_prenotazione || !issuingAttempt.medmar_numero) {
    return { ok: false, status: "issuing_not_completed", error: "id_prenotazione o codice Medmar mancanti sull'attempt completato." };
  }

  const services = await doLoadDeliveryServices(input.admin, input.tenantId, issuingAttempt.service_ids);
  const alreadySentRow = services.find((s) => !!s.medmar_ticket_sent_at);

  const repo = deps?.repo ?? createDeliveryRepository(input.admin);
  const acquired = await repo.acquireAttempt({
    tenantId: input.tenantId,
    issuingAttemptId: issuingAttempt.id,
    serviceIds: issuingAttempt.service_ids,
    medmarIdPrenotazione: issuingAttempt.medmar_id_prenotazione,
    medmarNumero: issuingAttempt.medmar_numero,
    createdBy: input.userId,
  });
  let attempt = acquired.attempt;

  if (alreadySentRow || attempt.status === "delivered") {
    if (attempt.status !== "delivered") {
      // services.medmar_ticket_sent_at e' l'unica fonte di verita' per "gia' inviato":
      // se e' valorizzato ma il delivery attempt non lo riflette ancora (es. riga
      // creata da un flusso legacy), allinea lo stato senza rinviare nulla.
      try {
        attempt = await repo.updateAttempt(attempt.id, { status: "delivered", delivered_at: new Date().toISOString() }, attempt.status);
      } catch {
        /* conflitto di stato concorrente: non bloccante, l'idempotenza e' comunque garantita da medmar_ticket_sent_at */
      }
    }
    return { ok: true, status: "delivered", attempt, already_delivered: true };
  }

  if (TERMINAL_DELIVERY_STATUSES.has(attempt.status)) {
    return { ok: true, status: "delivered", attempt, already_delivered: true };
  }
  if (MANUAL_REVIEW_DELIVERY_STATUSES.has(attempt.status)) {
    return { ok: false, status: attempt.status, attempt, error: attempt.last_error_message ?? "Revisione manuale richiesta." };
  }
  if (attempt.status === "delivery_started") {
    // Un run precedente e' stato interrotto dopo aver segnato "delivery_started"
    // senza mai ricevere conferma dal provider: mai un retry automatico che
    // rischi un doppio invio, si passa a delivery_state_unknown e si STOP.
    const unknown = await repo.updateAttempt(
      attempt.id,
      { status: "delivery_state_unknown", last_error_code: "delivery_started_no_confirmation", last_error_message: "delivery_started da un run precedente senza conferma provider." },
      "delivery_started"
    );
    return { ok: false, status: "delivery_state_unknown", attempt: unknown, error: unknown.last_error_message ?? "Stato di invio incerto." };
  }
  if (attempt.status === "delivery_failed" || attempt.status === "delivery_state_unknown") {
    // Non ritentabili automaticamente per istruzione esplicita ("NON fare retry se l'invio è ambiguo").
    return { ok: false, status: attempt.status, attempt, error: attempt.last_error_message ?? "Invio precedente non riuscito o incerto." };
  }

  // --- PDF: awaiting_pdf / pdf_found / pdf_cleaned / pdf_not_found (ritentabile) ---
  const pdfResolution = await resolvePdfForDelivery(issuingAttempt.medmar_id_prenotazione, issuingAttempt.medmar_numero, deps);
  const beforePdfStatus = attempt.status;

  if (pdfResolution.kind === "not_found") {
    attempt = await repo.updateAttempt(attempt.id, { status: "pdf_not_found", attempt_count: attempt.attempt_count + 1 }, beforePdfStatus);
    return { ok: false, status: "pdf_not_found", attempt, error: "Nessun PDF trovato nella mailbox Medmar per questa prenotazione." };
  }
  if (pdfResolution.kind === "ambiguous") {
    attempt = await repo.updateAttempt(
      attempt.id,
      { status: "pdf_ambiguous", last_error_code: "pdf_ambiguous", last_error_message: pdfResolution.detail },
      beforePdfStatus
    );
    return { ok: false, status: "pdf_ambiguous", attempt, error: pdfResolution.detail };
  }
  if (pdfResolution.kind === "validation_failed") {
    attempt = await repo.updateAttempt(
      attempt.id,
      { status: "pdf_validation_failed", last_error_code: "pdf_validation_failed", last_error_message: pdfResolution.detail },
      beforePdfStatus
    );
    return { ok: false, status: "pdf_validation_failed", attempt, error: pdfResolution.detail };
  }

  attempt = await repo.updateAttempt(
    attempt.id,
    {
      status: "pdf_cleaned",
      pdf_mailbox_message_uid: pdfResolution.messageUid,
      pdf_filename: pdfResolution.filename,
      pdf_original_sha256: pdfResolution.originalSha256,
      pdf_cleaned_sha256: pdfResolution.cleanedSha256,
    },
    beforePdfStatus
  );

  // --- Destinatario ---
  const primary = services[0];
  if (!primary) {
    attempt = await repo.updateAttempt(attempt.id, { status: "recipient_missing", last_error_message: "Nessun service trovato per risolvere il destinatario." }, "pdf_cleaned");
    return { ok: false, status: "recipient_missing", attempt, error: "Nessun service trovato per risolvere il destinatario." };
  }
  const recipientResolution = await resolveDeliveryRecipient(input.admin, input.tenantId, primary, deps);
  if (!recipientResolution.ok) {
    attempt = await repo.updateAttempt(attempt.id, { status: "recipient_missing", last_error_message: recipientResolution.error }, "pdf_cleaned");
    return { ok: false, status: "recipient_missing", attempt, error: recipientResolution.error };
  }
  const recipient = recipientResolution.recipient;

  attempt = await repo.updateAttempt(
    attempt.id,
    { status: "delivery_started", recipient_type: recipient.type, recipient_name: recipient.name, recipient_email: recipient.email },
    "pdf_cleaned"
  );

  const content = buildMedmarDeliveryEmailContent({
    customerName: primary.customer_name ?? recipient.name,
    medmarNumero: issuingAttempt.medmar_numero,
    preflightSnapshot: issuingAttempt.preflight_snapshot,
  });

  const sendResult = await doSendEmail({
    to: recipient.email,
    content,
    attachmentFilename: `Prenotazione${issuingAttempt.medmar_id_prenotazione}.pdf`,
    attachmentBase64: Buffer.from(pdfResolution.cleaned).toString("base64"),
  });

  if (sendResult.kind === "sent") {
    const now = new Date().toISOString();
    attempt = await repo.updateAttempt(
      attempt.id,
      { status: "delivered", resend_message_id: sendResult.messageId, delivered_at: now },
      "delivery_started"
    );
    await input.admin
      .from("services")
      .update({ medmar_ticket_sent_at: now, medmar_ticket_sent_by: input.userId })
      .in("id", issuingAttempt.service_ids)
      .eq("tenant_id", input.tenantId);
    // L'email e' gia' partita con successo (message_id confermato): un eventuale
    // errore qui sull'update di services NON deve essere trattato come fallimento
    // dell'invio (sarebbe fuorviante — l'email E' stata inviata). L'idempotenza
    // a monte resta comunque garantita da attempt.status === "delivered".
    return { ok: true, status: "delivered", attempt, already_delivered: false };
  }

  if (sendResult.kind === "failed") {
    attempt = await repo.updateAttempt(
      attempt.id,
      { status: "delivery_failed", last_error_code: "resend_failed", last_error_message: sendResult.error },
      "delivery_started"
    );
    return { ok: false, status: "delivery_failed", attempt, error: sendResult.error };
  }

  attempt = await repo.updateAttempt(
    attempt.id,
    { status: "delivery_state_unknown", last_error_code: "resend_ambiguous", last_error_message: sendResult.error },
    "delivery_started"
  );
  return { ok: false, status: "delivery_state_unknown", attempt, error: sendResult.error };
}

export type MedmarDeliveryPreview =
  | {
      ok: true;
      pdf_found: true;
      pdf_validated: true;
      recipient: MedmarFinalRecipient;
      subject: string;
      attachment_filename: string;
      next_state: "delivery_started";
      original_sha256: string;
      cleaned_sha256: string;
    }
  | { ok: false; status: MedmarDeliveryPreconditionFailure | MedmarDeliveryStatus; error: string };

/**
 * Preview READ-ONLY: esegue lookup+clean+validate+resolve-recipient ma non
 * scrive MAI nulla (nessun delivery attempt toccato, nessuna email inviata).
 * Usata per il passaggio di conferma umana prima dell'invio reale (Fase 9).
 */
export async function previewMedmarDelivery(input: MedmarDeliveryInput, deps?: MedmarDeliveryDeps): Promise<MedmarDeliveryPreview> {
  const doLoadIssuingAttempt = deps?.loadIssuingAttempt ?? loadIssuingAttempt;
  const doLoadDeliveryServices = deps?.loadDeliveryServices ?? loadDeliveryServices;
  const issuingAttempt = await doLoadIssuingAttempt(input.admin, input.tenantId, input.issuingAttemptId);
  if (!issuingAttempt) return { ok: false, status: "issuing_attempt_not_found", error: "Nessun tentativo di emissione Medmar trovato per questo id." };
  if (issuingAttempt.status !== "completed") {
    return { ok: false, status: "issuing_not_completed", error: `Emissione non completata (stato attuale: ${issuingAttempt.status}).` };
  }
  if (issuingAttempt.remote_state_unknown) {
    return { ok: false, status: "remote_state_unknown_blocked", error: "Stato remoto Medmar incerto: preview bloccata." };
  }
  if (!issuingAttempt.medmar_id_prenotazione || !issuingAttempt.medmar_numero) {
    return { ok: false, status: "issuing_not_completed", error: "id_prenotazione o codice Medmar mancanti." };
  }

  const pdfResolution = await resolvePdfForDelivery(issuingAttempt.medmar_id_prenotazione, issuingAttempt.medmar_numero, deps);
  if (pdfResolution.kind === "not_found") return { ok: false, status: "pdf_not_found", error: "PDF non trovato in mailbox." };
  if (pdfResolution.kind === "ambiguous") return { ok: false, status: "pdf_ambiguous", error: pdfResolution.detail };
  if (pdfResolution.kind === "validation_failed") return { ok: false, status: "pdf_validation_failed", error: pdfResolution.detail };

  const services = await doLoadDeliveryServices(input.admin, input.tenantId, issuingAttempt.service_ids);
  const primary = services[0];
  if (!primary) return { ok: false, status: "recipient_missing", error: "Nessun service trovato." };
  const recipientResolution = await resolveDeliveryRecipient(input.admin, input.tenantId, primary, deps);
  if (!recipientResolution.ok) return { ok: false, status: "recipient_missing", error: recipientResolution.error };

  const content = buildMedmarDeliveryEmailContent({
    customerName: primary.customer_name ?? recipientResolution.recipient.name,
    medmarNumero: issuingAttempt.medmar_numero,
    preflightSnapshot: issuingAttempt.preflight_snapshot,
  });

  return {
    ok: true,
    pdf_found: true,
    pdf_validated: true,
    recipient: recipientResolution.recipient,
    subject: content.subject,
    attachment_filename: `Prenotazione${issuingAttempt.medmar_id_prenotazione}.pdf`,
    next_state: "delivery_started",
    original_sha256: pdfResolution.originalSha256,
    cleaned_sha256: pdfResolution.cleanedSha256,
  };
}

export { MedmarPdfMailboxError };
