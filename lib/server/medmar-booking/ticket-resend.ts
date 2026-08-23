/**
 * "Rimanda biglietto" (MVP sicuro) — reinvia lo stesso PDF gia' pulito e
 * validato, allo STESSO destinatario gia' salvato in
 * medmar_delivery_attempts.recipient_email al primo invio. Nessuna nuova
 * emissione: non tocca medmar_issuing_attempts, non chiama lock/booking/
 * payment, non modifica medmar_delivery_attempts.delivered_at originale.
 *
 * Percorso PDF identico (per sicurezza) a pdf-delivery.ts: fetch dalla
 * mailbox via UID gia' salvato (`findMedmarPdfByUid`, nessuno scan completo:
 * se il messaggio non e' piu' li' il reinvio fallisce esplicitamente, non
 * ricade su una ricerca piu' ampia) -> cleanMedmarPdf -> validateCleanedMedmarPdf
 * -> invio SOLO del PDF pulito (mai l'originale).
 */
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { emailHtml } from "../email-layout";
import { findMedmarPdfByUid } from "./pdf-mailbox-lookup";
import { cleanMedmarPdf, MedmarPdfCleanerError } from "./pdf-cleaner";
import { validateCleanedMedmarPdf } from "./pdf-validation";
import { sendMedmarCleanedTicketEmail } from "./pdf-delivery";
import { createResendRepository, type MedmarResendRepository } from "./resend-repository";

export type MedmarDeliveryAttemptForResend = {
  id: string;
  tenant_id: string;
  issuing_attempt_id: string;
  status: string;
  medmar_id_prenotazione: string | null;
  medmar_numero: string | null;
  pdf_mailbox_message_uid: string | null;
  pdf_cleaned_sha256: string | null;
  recipient_email: string | null;
  delivered_at: string | null;
  resend_message_id: string | null;
};

async function loadDeliveryAttemptForResend(
  admin: SupabaseClient,
  tenantId: string,
  deliveryAttemptId: string
): Promise<MedmarDeliveryAttemptForResend | null> {
  const result = await admin
    .from("medmar_delivery_attempts")
    .select(
      "id, tenant_id, issuing_attempt_id, status, medmar_id_prenotazione, medmar_numero, pdf_mailbox_message_uid, pdf_cleaned_sha256, recipient_email, delivered_at, resend_message_id"
    )
    .eq("id", deliveryAttemptId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (result.error || !result.data) return null;
  return result.data as MedmarDeliveryAttemptForResend;
}

export type MedmarResendPreconditionFailure =
  | "delivery_attempt_not_found"
  | "not_delivered"
  | "recipient_email_missing"
  | "medmar_id_prenotazione_missing"
  | "medmar_numero_missing"
  | "pdf_mailbox_message_uid_missing"
  | "delivered_confirmation_missing";

/**
 * Tutte le precondizioni della PARTE 2 (payload/UX), in un unico posto
 * testabile senza DB: usata sia dall'orchestratore reale sia (se serve) per
 * decidere lato UI quando mostrare "Rimanda biglietto".
 */
export function validateMedmarResendPreconditions(
  attempt: MedmarDeliveryAttemptForResend | null
): { ok: true } | { ok: false; status: MedmarResendPreconditionFailure; error: string } {
  if (!attempt) return { ok: false, status: "delivery_attempt_not_found", error: "Nessun invio Medmar trovato per questo id." };
  if (attempt.status !== "delivered") {
    return { ok: false, status: "not_delivered", error: `Il biglietto non risulta consegnato (stato attuale: ${attempt.status}): reinvio non consentito.` };
  }
  if (!attempt.recipient_email) {
    return { ok: false, status: "recipient_email_missing", error: "Nessun destinatario email salvato per questo invio: reinvio non consentito." };
  }
  if (!attempt.medmar_id_prenotazione) {
    return { ok: false, status: "medmar_id_prenotazione_missing", error: "id prenotazione Medmar mancante: reinvio non consentito." };
  }
  if (!attempt.medmar_numero) {
    return { ok: false, status: "medmar_numero_missing", error: "codice Medmar mancante: reinvio non consentito." };
  }
  if (!attempt.pdf_mailbox_message_uid) {
    return { ok: false, status: "pdf_mailbox_message_uid_missing", error: "Nessun riferimento al PDF nella mailbox: reinvio non consentito." };
  }
  if (!attempt.delivered_at && !attempt.resend_message_id) {
    return { ok: false, status: "delivered_confirmation_missing", error: "Nessuna conferma dell'invio originale trovata: reinvio non consentito." };
  }
  return { ok: true };
}

export type MedmarResendEmailContent = { subject: string; html: string; text: string };

/** Oggetto/corpo dedicati al reinvio — mai il formato dell'email originale (deve essere inequivocabile che e' un reinvio, mai un nuovo biglietto). */
export function buildMedmarResendEmailContent(input: { medmarNumero: string; idPrenotazione: string }): MedmarResendEmailContent {
  const subject = `Reinvio biglietto Medmar ${input.medmarNumero}`;
  const text = [
    "Gentile Cliente/Agenzia,",
    "",
    `in allegato il reinvio del biglietto Medmar gia' emesso, prenotazione ${input.idPrenotazione}.`,
    "",
    `Codice Medmar: ${input.medmarNumero}`,
    "",
    "Questo e' un reinvio: non e' stato emesso nessun nuovo biglietto.",
    "",
    "Cordiali saluti",
    "Ischia Transfer Service",
  ].join("\n");
  const bodyHtml = `
    <p>Gentile Cliente/Agenzia,</p>
    <p>in allegato il <strong>reinvio</strong> del biglietto Medmar gia' emesso, prenotazione <strong>${input.idPrenotazione}</strong>.</p>
    <p>Codice Medmar: <strong>${input.medmarNumero}</strong></p>
    <p>Questo e' un reinvio: non e' stato emesso nessun nuovo biglietto.</p>
    <p>Cordiali saluti<br />Ischia Transfer Service</p>
  `;
  const html = emailHtml(bodyHtml, { title: subject, preheader: `Reinvio biglietto Medmar ${input.medmarNumero}` });
  return { subject, html, text };
}

export type MedmarResendDeps = {
  loadAttempt?: typeof loadDeliveryAttemptForResend;
  repo?: MedmarResendRepository;
  findPdfByUid?: typeof findMedmarPdfByUid;
  cleanPdf?: typeof cleanMedmarPdf;
  validatePdf?: typeof validateCleanedMedmarPdf;
  sendEmail?: typeof sendMedmarCleanedTicketEmail;
};

/**
 * Finestra anti-doppio-resend (micro-fix "guard anti-doppio resend"): breve
 * di proposito — copre il doppio click/refresh reale, non un blocco
 * prolungato. Qualunque esito del tentativo precedente (sent/failed, o
 * perfino uno 'started' rimasto orfano per un crash) smette di bloccare
 * dopo questa finestra: mai un blocco permanente del ticket.
 */
export const MEDMAR_RESEND_COOLDOWN_SECONDS = 15;

export type MedmarResendOutcome =
  | { ok: true; status: "sent"; resendMessageId: string; hashWarning: boolean; ledgerId: string }
  | { ok: false; status: "pdf_not_found" | "pdf_ambiguous" | "pdf_validation_failed" | "send_failed" | "send_ambiguous"; error: string; ledgerId: string }
  | { ok: false; status: MedmarResendPreconditionFailure; error: string; ledgerId: null }
  | { ok: false; status: "resend_in_progress"; error: string; ledgerId: string };

/**
 * Orchestratore reinvio: precondizioni -> guard anti-doppio-resend -> ledger
 * 'started' -> fetch PDF via UID -> clean -> valida -> invia SOLO il pulito
 * -> ledger 'sent'/'failed'. Nessuna scrittura su medmar_issuing_attempts o
 * su medmar_delivery_attempts.delivered_at — quel record resta quello
 * dell'invio originale, il reinvio vive solo in medmar_ticket_resends.
 */
export async function resendMedmarTicket(
  input: { admin: SupabaseClient; tenantId: string; userId: string; deliveryAttemptId: string },
  deps?: MedmarResendDeps
): Promise<MedmarResendOutcome> {
  const doLoadAttempt = deps?.loadAttempt ?? loadDeliveryAttemptForResend;
  const repo = deps?.repo ?? createResendRepository(input.admin);
  const findPdfByUid = deps?.findPdfByUid ?? findMedmarPdfByUid;
  const cleanPdf = deps?.cleanPdf ?? cleanMedmarPdf;
  const validatePdf = deps?.validatePdf ?? validateCleanedMedmarPdf;
  const sendEmail = deps?.sendEmail ?? sendMedmarCleanedTicketEmail;

  const attempt = await doLoadAttempt(input.admin, input.tenantId, input.deliveryAttemptId);
  const precondition = validateMedmarResendPreconditions(attempt);
  if (!precondition.ok) return { ok: false, status: precondition.status, error: precondition.error, ledgerId: null };
  const validAttempt = attempt as MedmarDeliveryAttemptForResend;

  // Guard anti-doppio-resend: una sola chiamata di repository verifica
  // l'assenza di un reinvio recente/in corso e inserisce 'started' SOLO se
  // eligibile. La richiesta bloccata non crea alcuna riga nuova.
  const guard = await repo.insertStartedIfEligible(
    {
      tenantId: input.tenantId,
      deliveryAttemptId: validAttempt.id,
      issuingAttemptId: validAttempt.issuing_attempt_id,
      medmarIdPrenotazione: validAttempt.medmar_id_prenotazione!,
      medmarNumero: validAttempt.medmar_numero!,
      recipientEmail: validAttempt.recipient_email!,
      createdBy: input.userId,
    },
    MEDMAR_RESEND_COOLDOWN_SECONDS
  );
  if (guard.kind === "blocked") {
    return {
      ok: false,
      status: "resend_in_progress",
      error: "Un reinvio è già in corso o è stato appena effettuato. Attendi qualche secondo e riprova.",
      ledgerId: guard.recent.id,
    };
  }
  const ledger = guard.row;

  const located = await findPdfByUid({
    uid: validAttempt.pdf_mailbox_message_uid!,
    idPrenotazione: validAttempt.medmar_id_prenotazione!,
    medmarNumero: validAttempt.medmar_numero!,
  });

  if (located.kind === "not_found") {
    const message = "PDF non recuperabile dalla mailbox, reinvio non eseguito.";
    await repo.markFailed(ledger.id, { errorCode: "pdf_not_found", errorMessage: message });
    return { ok: false, status: "pdf_not_found", error: message, ledgerId: ledger.id };
  }
  if (located.kind === "ambiguous") {
    const detail = `${located.candidates.length} PDF compatibili trovati: ${located.candidates.map((c) => c.filename).join(", ")}`;
    await repo.markFailed(ledger.id, { errorCode: "pdf_ambiguous", errorMessage: detail });
    return { ok: false, status: "pdf_ambiguous", error: detail, ledgerId: ledger.id };
  }

  let cleaned: Uint8Array;
  try {
    cleaned = await cleanPdf(located.pdfBytes);
  } catch (err) {
    const detail = err instanceof MedmarPdfCleanerError ? err.message : err instanceof Error ? err.message : "Errore sconosciuto nel cleaner.";
    await repo.markFailed(ledger.id, { errorCode: "pdf_validation_failed", errorMessage: detail });
    return { ok: false, status: "pdf_validation_failed", error: detail, ledgerId: ledger.id };
  }

  const validation = await validatePdf(cleaned, {
    medmarNumero: validAttempt.medmar_numero!,
    idPrenotazione: validAttempt.medmar_id_prenotazione!,
    ticketNumbers: [],
    requiredPortKeywords: [],
  });
  if (!validation.ok) {
    await repo.markFailed(ledger.id, { errorCode: "pdf_validation_failed", errorMessage: validation.reason });
    return { ok: false, status: "pdf_validation_failed", error: validation.reason, ledgerId: ledger.id };
  }

  const originalSha256 = createHash("sha256").update(located.pdfBytes).digest("hex");
  const cleanedSha256 = createHash("sha256").update(Buffer.from(cleaned)).digest("hex");
  // Warning, mai un blocco: la validazione sui contenuti (sopra) resta l'unico gate reale.
  const hashWarning = !!validAttempt.pdf_cleaned_sha256 && validAttempt.pdf_cleaned_sha256 !== cleanedSha256;

  const content = buildMedmarResendEmailContent({
    medmarNumero: validAttempt.medmar_numero!,
    idPrenotazione: validAttempt.medmar_id_prenotazione!,
  });

  const sendResult = await sendEmail({
    to: validAttempt.recipient_email!,
    content,
    attachmentFilename: `Prenotazione${validAttempt.medmar_id_prenotazione}.pdf`,
    attachmentBase64: Buffer.from(cleaned).toString("base64"),
  });

  if (sendResult.kind !== "sent") {
    const status = sendResult.kind === "failed" ? "send_failed" : "send_ambiguous";
    await repo.markFailed(ledger.id, { errorCode: status, errorMessage: sendResult.error });
    return { ok: false, status, error: sendResult.error, ledgerId: ledger.id };
  }

  await repo.markSent(ledger.id, {
    resendMessageId: sendResult.messageId,
    pdfCleanedSha256: cleanedSha256,
    originalPdfSha256: originalSha256,
    hashWarning,
  });

  return { ok: true, status: "sent", resendMessageId: sendResult.messageId, hashWarning, ledgerId: ledger.id };
}
