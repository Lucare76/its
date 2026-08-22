import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  resendMedmarTicket,
  validateMedmarResendPreconditions,
  buildMedmarResendEmailContent,
  type MedmarDeliveryAttemptForResend,
  type MedmarResendDeps,
} from "@/lib/server/medmar-booking/ticket-resend";
import type { MedmarResendRepository, MedmarTicketResendRow } from "@/lib/server/medmar-booking/resend-repository";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DELIVERY_ATTEMPT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ISSUING_ATTEMPT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ID_PRENOTAZIONE = "736987";
const MEDMAR_NUMERO = "AG1908926B000438457";
const RECIPIENT_EMAIL = "biglietteria@alesteviaggi.it";
const PDF_UID = "uid-original-1";

function makeAttempt(overrides: Partial<MedmarDeliveryAttemptForResend> = {}): MedmarDeliveryAttemptForResend {
  return {
    id: DELIVERY_ATTEMPT_ID,
    tenant_id: TENANT,
    issuing_attempt_id: ISSUING_ATTEMPT_ID,
    status: "delivered",
    medmar_id_prenotazione: ID_PRENOTAZIONE,
    medmar_numero: MEDMAR_NUMERO,
    pdf_mailbox_message_uid: PDF_UID,
    pdf_cleaned_sha256: null,
    recipient_email: RECIPIENT_EMAIL,
    delivered_at: new Date().toISOString(),
    resend_message_id: "original-msg-1",
    ...overrides,
  };
}

function makeLedgerRow(overrides: Partial<MedmarTicketResendRow> = {}): MedmarTicketResendRow {
  return {
    id: "ledger-1",
    tenant_id: TENANT,
    delivery_attempt_id: DELIVERY_ATTEMPT_ID,
    issuing_attempt_id: ISSUING_ATTEMPT_ID,
    medmar_id_prenotazione: ID_PRENOTAZIONE,
    medmar_numero: MEDMAR_NUMERO,
    recipient_email: RECIPIENT_EMAIL,
    resend_message_id: null,
    status: "started",
    error_code: null,
    error_message: null,
    pdf_cleaned_sha256: null,
    original_pdf_sha256: null,
    hash_warning: false,
    created_at: new Date().toISOString(),
    created_by: USER,
    sent_at: null,
    ...overrides,
  };
}

/** Repo fake in-memoria: traccia le transizioni started -> sent/failed, stesso pattern dei fake repo gia' usati per pdf-delivery.test.ts. */
function makeResendRepo(): { repo: MedmarResendRepository; rows: MedmarTicketResendRow[] } {
  const rows: MedmarTicketResendRow[] = [];
  const repo: MedmarResendRepository = {
    async insertStarted(input) {
      const row = makeLedgerRow({
        id: `ledger-${rows.length + 1}`,
        delivery_attempt_id: input.deliveryAttemptId,
        issuing_attempt_id: input.issuingAttemptId,
        medmar_id_prenotazione: input.medmarIdPrenotazione,
        medmar_numero: input.medmarNumero,
        recipient_email: input.recipientEmail,
        created_by: input.createdBy,
        status: "started",
      });
      rows.push(row);
      return row;
    },
    async markSent(id, patch) {
      const idx = rows.findIndex((r) => r.id === id);
      if (idx === -1) throw new Error("ledger not found");
      rows[idx] = {
        ...rows[idx]!,
        status: "sent",
        resend_message_id: patch.resendMessageId,
        pdf_cleaned_sha256: patch.pdfCleanedSha256,
        original_pdf_sha256: patch.originalPdfSha256,
        hash_warning: patch.hashWarning,
        sent_at: new Date().toISOString(),
      };
      return rows[idx]!;
    },
    async markFailed(id, patch) {
      const idx = rows.findIndex((r) => r.id === id);
      if (idx === -1) throw new Error("ledger not found");
      rows[idx] = { ...rows[idx]!, status: "failed", error_code: patch.errorCode, error_message: patch.errorMessage };
      return rows[idx]!;
    },
    async listByDeliveryAttempts(_tenantId, ids) {
      return rows.filter((r) => ids.includes(r.delivery_attempt_id));
    },
  };
  return { repo, rows };
}

function baseDeps(attempt: MedmarDeliveryAttemptForResend | null, overrides: Partial<MedmarResendDeps> = {}): { deps: MedmarResendDeps; rows: MedmarTicketResendRow[] } {
  const { repo, rows } = makeResendRepo();
  const deps: MedmarResendDeps = {
    loadAttempt: (async () => attempt) as never,
    repo,
    findPdfByUid: (async () => ({
      kind: "found",
      pdfBytes: Buffer.from("%PDF-ORIGINAL-DUMMY"),
      filename: `Prenotazione${ID_PRENOTAZIONE}.pdf`,
      messageUid: PDF_UID,
      sha256: "orig-sha-placeholder",
    })) as never,
    cleanPdf: (async (bytes: Uint8Array) => new Uint8Array(Buffer.concat([Buffer.from("CLEANED:"), Buffer.from(bytes)]))) as never,
    validatePdf: (async () => ({ ok: true, extractedText: "testo pulito" })) as never,
    sendEmail: (async () => ({ kind: "sent", messageId: "resend-msg-new-1" })) as never,
    ...overrides,
  };
  return { deps, rows };
}

const fakeAdmin = {} as SupabaseClient;

describe("validateMedmarResendPreconditions — precondizioni PARTE 2", () => {
  it("1. attempt nullo -> delivery_attempt_not_found", () => {
    expect(validateMedmarResendPreconditions(null)).toEqual({
      ok: false,
      status: "delivery_attempt_not_found",
      error: expect.any(String),
    });
  });

  it("2. status diverso da delivered -> not_delivered (rifiuta delivery non delivered)", () => {
    const result = validateMedmarResendPreconditions(makeAttempt({ status: "awaiting_pdf" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe("not_delivered");
  });

  it("3. recipient_email mancante -> recipient_email_missing", () => {
    const result = validateMedmarResendPreconditions(makeAttempt({ recipient_email: null }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe("recipient_email_missing");
  });

  it("4. medmar_id_prenotazione mancante -> medmar_id_prenotazione_missing", () => {
    const result = validateMedmarResendPreconditions(makeAttempt({ medmar_id_prenotazione: null }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe("medmar_id_prenotazione_missing");
  });

  it("5. medmar_numero mancante -> medmar_numero_missing", () => {
    const result = validateMedmarResendPreconditions(makeAttempt({ medmar_numero: null }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe("medmar_numero_missing");
  });

  it("6. pdf_mailbox_message_uid mancante -> pdf_mailbox_message_uid_missing", () => {
    const result = validateMedmarResendPreconditions(makeAttempt({ pdf_mailbox_message_uid: null }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe("pdf_mailbox_message_uid_missing");
  });

  it("7. delivered_at e resend_message_id entrambi assenti -> delivered_confirmation_missing", () => {
    const result = validateMedmarResendPreconditions(makeAttempt({ delivered_at: null, resend_message_id: null }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe("delivered_confirmation_missing");
  });

  it("8. delivered_at assente ma resend_message_id presente -> ok (una delle due basta)", () => {
    const result = validateMedmarResendPreconditions(makeAttempt({ delivered_at: null, resend_message_id: "msg-1" }));
    expect(result.ok).toBe(true);
  });

  it("9. tutte le precondizioni soddisfatte -> ok", () => {
    expect(validateMedmarResendPreconditions(makeAttempt())).toEqual({ ok: true });
  });
});

describe("buildMedmarResendEmailContent", () => {
  it("1. oggetto include 'Reinvio' e il codice Medmar", () => {
    const content = buildMedmarResendEmailContent({ medmarNumero: MEDMAR_NUMERO, idPrenotazione: ID_PRENOTAZIONE });
    expect(content.subject).toContain("Reinvio");
    expect(content.subject).toContain(MEDMAR_NUMERO);
  });

  it("2. corpo indica esplicitamente che e' un reinvio, mai un nuovo biglietto", () => {
    const content = buildMedmarResendEmailContent({ medmarNumero: MEDMAR_NUMERO, idPrenotazione: ID_PRENOTAZIONE });
    expect(content.text.toLowerCase()).toContain("reinvio");
    expect(content.text).not.toMatch(/prezzo|totale|€/i);
  });
});

describe("resendMedmarTicket — orchestratore reinvio (MVP sicuro)", () => {
  it("1. precondizioni fallite -> nessun ledger creato, nessun fetch PDF, nessun invio email", async () => {
    const findPdfSpy = vi.fn();
    const sendSpy = vi.fn();
    const { deps, rows } = baseDeps(makeAttempt({ status: "pdf_ambiguous" }), { findPdfByUid: findPdfSpy as never, sendEmail: sendSpy as never });
    const outcome = await resendMedmarTicket({ admin: fakeAdmin, tenantId: TENANT, userId: USER, deliveryAttemptId: DELIVERY_ATTEMPT_ID }, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe("not_delivered");
    expect(rows.length).toBe(0);
    expect(findPdfSpy).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("2. crea SEMPRE un record ledger 'started' prima di qualunque tentativo di invio (protezione doppio click/concorrenza)", async () => {
    const { deps, rows } = baseDeps(makeAttempt());
    await resendMedmarTicket({ admin: fakeAdmin, tenantId: TENANT, userId: USER, deliveryAttemptId: DELIVERY_ATTEMPT_ID }, deps);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.recipient_email).toBe(RECIPIENT_EMAIL);
  });

  it("3. recupera il PDF dalla mailbox via UID gia' salvato, con id_prenotazione/medmar_numero corretti", async () => {
    const findPdfSpy = vi.fn(async () => ({
      kind: "found" as const,
      pdfBytes: Buffer.from("%PDF-ORIGINAL"),
      filename: `Prenotazione${ID_PRENOTAZIONE}.pdf`,
      messageUid: PDF_UID,
      sha256: "sha",
    }));
    const { deps } = baseDeps(makeAttempt(), { findPdfByUid: findPdfSpy as never });
    await resendMedmarTicket({ admin: fakeAdmin, tenantId: TENANT, userId: USER, deliveryAttemptId: DELIVERY_ATTEMPT_ID }, deps);
    expect(findPdfSpy).toHaveBeenCalledWith(expect.objectContaining({ uid: PDF_UID, idPrenotazione: ID_PRENOTAZIONE, medmarNumero: MEDMAR_NUMERO }));
  });

  it("4. pulisce il PDF recuperato con cleanPdf prima di validare/inviare", async () => {
    const cleanSpy = vi.fn(async (bytes: Uint8Array) => new Uint8Array(Buffer.concat([Buffer.from("CLEANED:"), Buffer.from(bytes)])));
    const { deps } = baseDeps(makeAttempt(), { cleanPdf: cleanSpy as never });
    await resendMedmarTicket({ admin: fakeAdmin, tenantId: TENANT, userId: USER, deliveryAttemptId: DELIVERY_ATTEMPT_ID }, deps);
    expect(cleanSpy).toHaveBeenCalledTimes(1);
  });

  it("5. valida il PDF pulito prima di inviare, con medmarNumero/idPrenotazione corretti", async () => {
    const validateSpy = vi.fn(async () => ({ ok: true as const, extractedText: "ok" }));
    const { deps } = baseDeps(makeAttempt(), { validatePdf: validateSpy as never });
    await resendMedmarTicket({ admin: fakeAdmin, tenantId: TENANT, userId: USER, deliveryAttemptId: DELIVERY_ATTEMPT_ID }, deps);
    expect(validateSpy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ medmarNumero: MEDMAR_NUMERO, idPrenotazione: ID_PRENOTAZIONE }));
  });

  it("6. invia SOLO il PDF pulito (mai l'originale) — l'allegato inviato inizia con il marker del cleaner", async () => {
    const sendSpy = vi.fn(async (args: { attachmentBase64: string }) => {
      const decoded = Buffer.from(args.attachmentBase64, "base64").toString();
      expect(decoded.startsWith("CLEANED:")).toBe(true);
      return { kind: "sent" as const, messageId: "resend-msg-new-1" };
    });
    const { deps } = baseDeps(makeAttempt(), { sendEmail: sendSpy as never });
    await resendMedmarTicket({ admin: fakeAdmin, tenantId: TENANT, userId: USER, deliveryAttemptId: DELIVERY_ATTEMPT_ID }, deps);
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it("7. invia allo stesso destinatario gia' salvato (mai un altro)", async () => {
    const sendSpy = vi.fn(async (args: { to: string }) => {
      expect(args.to).toBe(RECIPIENT_EMAIL);
      return { kind: "sent" as const, messageId: "resend-msg-new-1" };
    });
    const { deps } = baseDeps(makeAttempt(), { sendEmail: sendSpy as never });
    await resendMedmarTicket({ admin: fakeAdmin, tenantId: TENANT, userId: USER, deliveryAttemptId: DELIVERY_ATTEMPT_ID }, deps);
    expect(sendSpy).toHaveBeenCalled();
  });

  it("8. successo -> aggiorna il ledger a 'sent' con resend_message_id", async () => {
    const { deps, rows } = baseDeps(makeAttempt());
    const outcome = await resendMedmarTicket({ admin: fakeAdmin, tenantId: TENANT, userId: USER, deliveryAttemptId: DELIVERY_ATTEMPT_ID }, deps);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.resendMessageId).toBe("resend-msg-new-1");
    expect(rows[0]!.status).toBe("sent");
    expect(rows[0]!.resend_message_id).toBe("resend-msg-new-1");
  });

  it("9. PDF non recuperabile dalla mailbox (not_found) -> non invia, ledger 'failed', errore chiaro", async () => {
    const sendSpy = vi.fn();
    const { deps, rows } = baseDeps(makeAttempt(), { findPdfByUid: (async () => ({ kind: "not_found" })) as never, sendEmail: sendSpy as never });
    const outcome = await resendMedmarTicket({ admin: fakeAdmin, tenantId: TENANT, userId: USER, deliveryAttemptId: DELIVERY_ATTEMPT_ID }, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.status).toBe("pdf_not_found");
      expect(outcome.error).toBe("PDF non recuperabile dalla mailbox, reinvio non eseguito.");
    }
    expect(sendSpy).not.toHaveBeenCalled();
    expect(rows[0]!.status).toBe("failed");
  });

  it("10. PDF ambiguo -> non invia, ledger 'failed'", async () => {
    const { deps, rows } = baseDeps(makeAttempt(), {
      findPdfByUid: (async () => ({ kind: "ambiguous", candidates: [{ filename: "a.pdf", messageUid: "u1", sha256: "s1" }, { filename: "b.pdf", messageUid: "u2", sha256: "s2" }] })) as never,
    });
    const outcome = await resendMedmarTicket({ admin: fakeAdmin, tenantId: TENANT, userId: USER, deliveryAttemptId: DELIVERY_ATTEMPT_ID }, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe("pdf_ambiguous");
    expect(rows[0]!.status).toBe("failed");
  });

  it("11. validazione fallita -> non invia, ledger 'failed'", async () => {
    const sendSpy = vi.fn();
    const { deps, rows } = baseDeps(makeAttempt(), {
      validatePdf: (async () => ({ ok: false, reason: "prezzo ancora presente", extractedText: "..." })) as never,
      sendEmail: sendSpy as never,
    });
    const outcome = await resendMedmarTicket({ admin: fakeAdmin, tenantId: TENANT, userId: USER, deliveryAttemptId: DELIVERY_ATTEMPT_ID }, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe("pdf_validation_failed");
    expect(sendSpy).not.toHaveBeenCalled();
    expect(rows[0]!.status).toBe("failed");
  });

  it("12. invio fallito -> ledger 'failed' con errore", async () => {
    const { deps, rows } = baseDeps(makeAttempt(), { sendEmail: (async () => ({ kind: "failed", error: "Resend HTTP 500" })) as never });
    const outcome = await resendMedmarTicket({ admin: fakeAdmin, tenantId: TENANT, userId: USER, deliveryAttemptId: DELIVERY_ATTEMPT_ID }, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe("send_failed");
    expect(rows[0]!.status).toBe("failed");
  });

  it("13. hash_warning=true se pdf_cleaned_sha256 gia' salvato differisce dal nuovo, ma la validazione OK non blocca l'invio", async () => {
    const { deps, rows } = baseDeps(makeAttempt({ pdf_cleaned_sha256: "hash-diverso-dal-nuovo" }));
    const outcome = await resendMedmarTicket({ admin: fakeAdmin, tenantId: TENANT, userId: USER, deliveryAttemptId: DELIVERY_ATTEMPT_ID }, deps);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.hashWarning).toBe(true);
    expect(rows[0]!.hash_warning).toBe(true);
    expect(rows[0]!.status).toBe("sent");
  });

  it("14. hash_warning=false se pdf_cleaned_sha256 non era salvato (nessun confronto possibile)", async () => {
    const { deps, rows } = baseDeps(makeAttempt({ pdf_cleaned_sha256: null }));
    const outcome = await resendMedmarTicket({ admin: fakeAdmin, tenantId: TENANT, userId: USER, deliveryAttemptId: DELIVERY_ATTEMPT_ID }, deps);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.hashWarning).toBe(false);
    expect(rows[0]!.status).toBe("sent");
  });

  it("15. l'admin client fake non espone from(): nessuna scrittura diretta su medmar_issuing_attempts/medmar_delivery_attempts avviene fuori dalle deps iniettate", async () => {
    const { deps } = baseDeps(makeAttempt());
    const outcome = await resendMedmarTicket({ admin: fakeAdmin, tenantId: TENANT, userId: USER, deliveryAttemptId: DELIVERY_ATTEMPT_ID }, deps);
    expect(outcome.ok).toBe(true);
  });
});
