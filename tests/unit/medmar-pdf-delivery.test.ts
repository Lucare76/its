import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { deliverMedmarTicket, deliverMedmarTicketWithTimeout, getMedmarDeliveryErrorStep, type MedmarDeliveryDeps } from "@/lib/server/medmar-booking/pdf-delivery";
import type { DeliveryRepository, MedmarDeliveryAttempt } from "@/lib/server/medmar-booking/delivery-types";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ISSUING_ATTEMPT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SVC1 = "11111111-1111-4111-8111-111111111111";
const SVC2 = "22222222-2222-4222-8222-222222222222";
const AGENCY_ID = "30000000-0000-0000-0000-000000000001";
const ID_PRENOTAZIONE = "736987";
const MEDMAR_NUMERO = "AG1908926B000438457";

function makeIssuingAttemptRow(overrides: Partial<{
  status: string;
  remote_state_unknown: boolean;
  medmar_id_prenotazione: string | null;
  medmar_numero: string | null;
}> = {}) {
  return {
    id: ISSUING_ATTEMPT_ID,
    tenant_id: TENANT,
    status: "completed",
    service_ids: [SVC1, SVC2],
    remote_state_unknown: false,
    medmar_id_prenotazione: ID_PRENOTAZIONE,
    medmar_numero: MEDMAR_NUMERO,
    preflight_snapshot: {
      outward: { route: { from: "Pozzuoli", to: "Casamicciola" }, date: "2026-08-23", matched_departure_time: "08:15:00" },
      return: { route: { from: "Ischia", to: "Pozzuoli" }, date: "2026-08-26", matched_departure_time: "15:00:00" },
    },
    ...overrides,
  };
}

function makeDeliveryAttempt(overrides: Partial<MedmarDeliveryAttempt> = {}): MedmarDeliveryAttempt {
  return {
    id: "delivery-1",
    tenant_id: TENANT,
    issuing_attempt_id: ISSUING_ATTEMPT_ID,
    service_ids: [SVC1, SVC2],
    status: "awaiting_pdf",
    medmar_id_prenotazione: ID_PRENOTAZIONE,
    medmar_numero: MEDMAR_NUMERO,
    pdf_mailbox_message_uid: null,
    pdf_filename: null,
    pdf_original_sha256: null,
    pdf_cleaned_sha256: null,
    recipient_type: null,
    recipient_name: null,
    recipient_email: null,
    resend_message_id: null,
    attempt_count: 0,
    last_error_code: null,
    last_error_message: null,
    created_by: USER,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    delivered_at: null,
    ...overrides,
  };
}

/** Repo in-memoria — stesso pattern del fake usato in medmar-issue-orchestrator.test.ts. */
function makeDeliveryRepo(existing?: MedmarDeliveryAttempt): DeliveryRepository {
  let current: MedmarDeliveryAttempt | null = existing ?? null;
  return {
    async findByIssuingAttempt() {
      return current;
    },
    async acquireAttempt(input) {
      if (current) return { kind: "existing", attempt: current };
      current = makeDeliveryAttempt({
        issuing_attempt_id: input.issuingAttemptId,
        service_ids: input.serviceIds,
        medmar_id_prenotazione: input.medmarIdPrenotazione,
        medmar_numero: input.medmarNumero,
        created_by: input.createdBy,
        status: "awaiting_pdf",
      });
      return { kind: "created", attempt: current };
    },
    async updateAttempt(id, patch, expectedStatus) {
      if (!current || current.id !== id) throw new Error("medmar_delivery_attempt_not_found");
      if (current.status !== expectedStatus) throw new Error("medmar_delivery_attempt_conflict");
      current = { ...current, ...patch, updated_at: new Date().toISOString() };
      return current;
    },
  };
}

function fakeAdminWithServicesUpdateSpy(spy: (payload: Record<string, unknown>) => void): SupabaseClient {
  return {
    from(table: string) {
      if (table !== "services") throw new Error(`tabella inattesa nel fake admin: ${table}`);
      return {
        update(payload: Record<string, unknown>) {
          spy(payload);
          return {
            in() {
              return this;
            },
            eq() {
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;
}

function baseDeps(overrides: Partial<MedmarDeliveryDeps> = {}): MedmarDeliveryDeps {
  return {
    loadIssuingAttempt: (async () => makeIssuingAttemptRow()) as never,
    loadDeliveryServices: (async () => [
      { id: SVC1, agency_id: AGENCY_ID, customer_name: "LUCIANO SENESE", customer_email: null, medmar_ticket_sent_at: null },
      { id: SVC2, agency_id: AGENCY_ID, customer_name: "LUCIANO SENESE", customer_email: null, medmar_ticket_sent_at: null },
    ]) as never,
    findPdf: (async () => ({
      kind: "found",
      pdfBytes: Buffer.from("%PDF-ORIGINAL-DUMMY"),
      filename: "Prenotazione736987.pdf",
      messageUid: "uid-1",
      sha256: "orig-sha-placeholder",
    })) as never,
    cleanPdf: (async (bytes: Uint8Array) => new Uint8Array(Buffer.concat([Buffer.from("CLEANED:"), Buffer.from(bytes)]))) as never,
    validatePdf: (async () => ({ ok: true, extractedText: "testo pulito" })) as never,
    loadAgencyRecipient: (async () => ({ name: "ALESTE VIAGGI", email: "biglietteria@alesteviaggi.it" })) as never,
    sendEmail: (async () => ({ kind: "sent", messageId: "resend-msg-1" })) as never,
    ...overrides,
  };
}

describe("deliverMedmarTicket — state machine delivery PDF Medmar", () => {
  it("1. attempt creato per la prima volta parte da 'awaiting_pdf' (prima di qualunque elaborazione)", async () => {
    const repo = makeDeliveryRepo();
    const acquireSpy = vi.spyOn(repo, "acquireAttempt");
    const servicesUpdateSpy = vi.fn();
    await deliverMedmarTicket(
      { admin: fakeAdminWithServicesUpdateSpy(servicesUpdateSpy), tenantId: TENANT, userId: USER, issuingAttemptId: ISSUING_ATTEMPT_ID },
      baseDeps({ repo })
    );
    const createdResult = await acquireSpy.mock.results[0]!.value;
    expect(createdResult.kind).toBe("created");
    expect(createdResult.attempt.status).toBe("awaiting_pdf");
  });

  it("2. PDF trovato: findPdf viene chiamato con id_prenotazione + codice Medmar corretti", async () => {
    const findPdf = vi.fn(async () => ({
      kind: "found" as const,
      pdfBytes: Buffer.from("%PDF-ORIGINAL"),
      filename: "Prenotazione736987.pdf",
      messageUid: "uid-1",
      sha256: "orig-sha",
    }));
    const servicesUpdateSpy = vi.fn();
    await deliverMedmarTicket(
      { admin: fakeAdminWithServicesUpdateSpy(servicesUpdateSpy), tenantId: TENANT, userId: USER, issuingAttemptId: ISSUING_ATTEMPT_ID },
      baseDeps({ repo: makeDeliveryRepo(), findPdf: findPdf as never })
    );
    expect(findPdf).toHaveBeenCalledWith({ idPrenotazione: ID_PRENOTAZIONE, medmarNumero: MEDMAR_NUMERO });
  });

  it("3. PDF non trovato -> status pdf_not_found, nessun invio", async () => {
    const sendEmail = vi.fn();
    const outcome = await deliverMedmarTicket(
      { admin: fakeAdminWithServicesUpdateSpy(vi.fn()), tenantId: TENANT, userId: USER, issuingAttemptId: ISSUING_ATTEMPT_ID },
      baseDeps({ repo: makeDeliveryRepo(), findPdf: (async () => ({ kind: "not_found" })) as never, sendEmail: sendEmail as never })
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe("pdf_not_found");
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("4. PDF ambiguo -> status pdf_ambiguous, nessun invio", async () => {
    const sendEmail = vi.fn();
    const outcome = await deliverMedmarTicket(
      { admin: fakeAdminWithServicesUpdateSpy(vi.fn()), tenantId: TENANT, userId: USER, issuingAttemptId: ISSUING_ATTEMPT_ID },
      baseDeps({
        repo: makeDeliveryRepo(),
        findPdf: (async () => ({
          kind: "ambiguous",
          candidates: [
            { filename: "Prenotazione736987.pdf", messageUid: "uid-1", sha256: "a" },
            { filename: "Prenotazione736987.pdf", messageUid: "uid-2", sha256: "b" },
          ],
        })) as never,
        sendEmail: sendEmail as never,
      })
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe("pdf_ambiguous");
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("5. PDF pulito e validato: l'attempt finale riporta hash originale e pulito distinti", async () => {
    const outcome = await deliverMedmarTicket(
      { admin: fakeAdminWithServicesUpdateSpy(vi.fn()), tenantId: TENANT, userId: USER, issuingAttemptId: ISSUING_ATTEMPT_ID },
      baseDeps({ repo: makeDeliveryRepo() })
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.attempt.pdf_original_sha256).toBeTruthy();
      expect(outcome.attempt.pdf_cleaned_sha256).toBeTruthy();
      expect(outcome.attempt.pdf_original_sha256).not.toBe(outcome.attempt.pdf_cleaned_sha256);
    }
  });

  it("6. validazione PDF fallita blocca l'invio -> pdf_validation_failed, sendEmail mai chiamato", async () => {
    const sendEmail = vi.fn();
    const outcome = await deliverMedmarTicket(
      { admin: fakeAdminWithServicesUpdateSpy(vi.fn()), tenantId: TENANT, userId: USER, issuingAttemptId: ISSUING_ATTEMPT_ID },
      baseDeps({
        repo: makeDeliveryRepo(),
        validatePdf: (async () => ({ ok: false, reason: "Etichetta vietata ancora presente", extractedText: "" })) as never,
        sendEmail: sendEmail as never,
      })
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe("pdf_validation_failed");
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("7. l'agenzia vince sempre sul cliente: destinatario finale è l'email agenzia, non quella cliente", async () => {
    const outcome = await deliverMedmarTicket(
      { admin: fakeAdminWithServicesUpdateSpy(vi.fn()), tenantId: TENANT, userId: USER, issuingAttemptId: ISSUING_ATTEMPT_ID },
      baseDeps({
        repo: makeDeliveryRepo(),
        loadDeliveryServices: (async () => [
          { id: SVC1, agency_id: AGENCY_ID, customer_name: "LUCIANO SENESE", customer_email: "senese@example.test" },
        ]) as never,
        loadAgencyRecipient: (async () => ({ name: "ALESTE VIAGGI", email: "biglietteria@alesteviaggi.it" })) as never,
      })
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.attempt.recipient_type).toBe("agency");
      expect(outcome.attempt.recipient_email).toBe("biglietteria@alesteviaggi.it");
    }
  });

  it("8. destinatario mancante (agenzia senza email, nessun fallback cliente) -> recipient_missing", async () => {
    const sendEmail = vi.fn();
    const outcome = await deliverMedmarTicket(
      { admin: fakeAdminWithServicesUpdateSpy(vi.fn()), tenantId: TENANT, userId: USER, issuingAttemptId: ISSUING_ATTEMPT_ID },
      baseDeps({
        repo: makeDeliveryRepo(),
        loadDeliveryServices: (async () => [
          { id: SVC1, agency_id: AGENCY_ID, customer_name: "LUCIANO SENESE", customer_email: "senese@example.test" },
        ]) as never,
        loadAgencyRecipient: (async () => ({ name: "ALESTE VIAGGI", email: null })) as never,
        sendEmail: sendEmail as never,
      })
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe("recipient_missing");
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("9. Resend restituisce message_id -> delivered, medmar_ticket_sent_at aggiornato su entrambe le righe service", async () => {
    const servicesUpdateSpy = vi.fn();
    const outcome = await deliverMedmarTicket(
      { admin: fakeAdminWithServicesUpdateSpy(servicesUpdateSpy), tenantId: TENANT, userId: USER, issuingAttemptId: ISSUING_ATTEMPT_ID },
      baseDeps({ repo: makeDeliveryRepo(), sendEmail: (async () => ({ kind: "sent", messageId: "resend-msg-9" })) as never })
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.status).toBe("delivered");
      expect(outcome.attempt.resend_message_id).toBe("resend-msg-9");
    }
    expect(servicesUpdateSpy).toHaveBeenCalledTimes(1);
    const payload = servicesUpdateSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.medmar_ticket_sent_at).toBeTruthy();
    expect(payload.medmar_ticket_sent_by).toBe(USER);
  });

  it("10. Resend errore chiaro -> delivery_failed, medmar_ticket_sent_at NON aggiornato", async () => {
    const servicesUpdateSpy = vi.fn();
    const outcome = await deliverMedmarTicket(
      { admin: fakeAdminWithServicesUpdateSpy(servicesUpdateSpy), tenantId: TENANT, userId: USER, issuingAttemptId: ISSUING_ATTEMPT_ID },
      baseDeps({ repo: makeDeliveryRepo(), sendEmail: (async () => ({ kind: "failed", error: "Resend HTTP 422: dominio non verificato" })) as never })
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe("delivery_failed");
    expect(servicesUpdateSpy).not.toHaveBeenCalled();
  });

  it("11. Resend timeout/risposta ambigua -> delivery_state_unknown, medmar_ticket_sent_at NON aggiornato, nessun retry automatico", async () => {
    const servicesUpdateSpy = vi.fn();
    const repo = makeDeliveryRepo();
    const outcome = await deliverMedmarTicket(
      { admin: fakeAdminWithServicesUpdateSpy(servicesUpdateSpy), tenantId: TENANT, userId: USER, issuingAttemptId: ISSUING_ATTEMPT_ID },
      baseDeps({ repo, sendEmail: (async () => ({ kind: "ambiguous", error: "Timeout invio email (20000ms)." })) as never })
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe("delivery_state_unknown");
    expect(servicesUpdateSpy).not.toHaveBeenCalled();

    // Un secondo run sullo stesso attempt (stato delivery_state_unknown) non deve ritentare l'invio.
    const sendEmailRetry = vi.fn();
    const secondOutcome = await deliverMedmarTicket(
      { admin: fakeAdminWithServicesUpdateSpy(servicesUpdateSpy), tenantId: TENANT, userId: USER, issuingAttemptId: ISSUING_ATTEMPT_ID },
      baseDeps({ repo, sendEmail: sendEmailRetry as never })
    );
    expect(secondOutcome.ok).toBe(false);
    if (!secondOutcome.ok) expect(secondOutcome.status).toBe("delivery_state_unknown");
    expect(sendEmailRetry).not.toHaveBeenCalled();
  });

  it("12. delivered è idempotente: un secondo run sullo stesso issuing attempt non reinvia", async () => {
    const repo = makeDeliveryRepo();
    const sendEmail = vi.fn(async () => ({ kind: "sent" as const, messageId: "resend-msg-12" }));
    const servicesUpdateSpy = vi.fn();
    const deps = baseDeps({ repo, sendEmail: sendEmail as never });

    const first = await deliverMedmarTicket(
      { admin: fakeAdminWithServicesUpdateSpy(servicesUpdateSpy), tenantId: TENANT, userId: USER, issuingAttemptId: ISSUING_ATTEMPT_ID },
      deps
    );
    expect(first.ok).toBe(true);
    expect(sendEmail).toHaveBeenCalledTimes(1);

    const second = await deliverMedmarTicket(
      { admin: fakeAdminWithServicesUpdateSpy(servicesUpdateSpy), tenantId: TENANT, userId: USER, issuingAttemptId: ISSUING_ATTEMPT_ID },
      deps
    );
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.already_delivered).toBe(true);
    expect(sendEmail).toHaveBeenCalledTimes(1); // invariato: nessun secondo invio
    expect(servicesUpdateSpy).toHaveBeenCalledTimes(1); // invariato
  });

  it("13. remote_state_unknown sull'issuing attempt blocca tutto: nessun lookup PDF, nessun invio", async () => {
    const findPdf = vi.fn();
    const sendEmail = vi.fn();
    const outcome = await deliverMedmarTicket(
      { admin: fakeAdminWithServicesUpdateSpy(vi.fn()), tenantId: TENANT, userId: USER, issuingAttemptId: ISSUING_ATTEMPT_ID },
      baseDeps({
        loadIssuingAttempt: (async () => makeIssuingAttemptRow({ remote_state_unknown: true })) as never,
        findPdf: findPdf as never,
        sendEmail: sendEmail as never,
      })
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe("remote_state_unknown_blocked");
    expect(findPdf).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("14. il PDF ORIGINALE non viene mai allegato: l'allegato inviato corrisponde all'output del cleaner, non ai byte grezzi della mailbox", async () => {
    let capturedAttachmentBase64: string | undefined;
    const sendEmail = vi.fn(async (args: { attachmentBase64: string }) => {
      capturedAttachmentBase64 = args.attachmentBase64;
      return { kind: "sent" as const, messageId: "resend-msg-14" };
    });
    await deliverMedmarTicket(
      { admin: fakeAdminWithServicesUpdateSpy(vi.fn()), tenantId: TENANT, userId: USER, issuingAttemptId: ISSUING_ATTEMPT_ID },
      baseDeps({ repo: makeDeliveryRepo(), sendEmail: sendEmail as never })
    );
    expect(capturedAttachmentBase64).toBeDefined();
    const attachmentText = Buffer.from(capturedAttachmentBase64!, "base64").toString("latin1");
    expect(attachmentText.startsWith("CLEANED:")).toBe(true); // marcatore del fake cleanPdf, mai il PDF originale grezzo
    expect(attachmentText).not.toBe("%PDF-ORIGINAL-DUMMY");
  });

  it("15. Fase A (stopAfterPdfFound): PDF trovato -> status pdf_found, uid/filename/hash salvati, cleaner e invio MAI chiamati", async () => {
    const cleanPdf = vi.fn();
    const sendEmail = vi.fn();
    const outcome = await deliverMedmarTicket(
      { admin: fakeAdminWithServicesUpdateSpy(vi.fn()), tenantId: TENANT, userId: USER, issuingAttemptId: ISSUING_ATTEMPT_ID, stopAfterPdfFound: true },
      baseDeps({ repo: makeDeliveryRepo(), cleanPdf: cleanPdf as never, sendEmail: sendEmail as never })
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok && "attempt" in outcome) {
      expect(outcome.status).toBe("pdf_found");
      expect(outcome.attempt.pdf_mailbox_message_uid).toBe("uid-1");
      expect(outcome.attempt.pdf_filename).toBe("Prenotazione736987.pdf");
      expect(outcome.attempt.pdf_original_sha256).toBeTruthy();
      expect(outcome.attempt.pdf_cleaned_sha256).toBeNull(); // non ancora pulito: quello e' compito della Fase B
    }
    expect(cleanPdf).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("16. Fase A (stopAfterPdfFound): PDF non trovato -> pdf_not_found identico al comportamento a giro singolo", async () => {
    const sendEmail = vi.fn();
    const outcome = await deliverMedmarTicket(
      { admin: fakeAdminWithServicesUpdateSpy(vi.fn()), tenantId: TENANT, userId: USER, issuingAttemptId: ISSUING_ATTEMPT_ID, stopAfterPdfFound: true },
      baseDeps({ repo: makeDeliveryRepo(), findPdf: (async () => ({ kind: "not_found" })) as never, sendEmail: sendEmail as never })
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok && "attempt" in outcome) {
      expect(outcome.status).toBe("pdf_not_found");
      expect(outcome.attempt.attempt_count).toBe(1);
    }
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("17. Fase B: se l'attempt ha gia' pdf_mailbox_message_uid salvato, usa findPdfByUid con quell'UID — findPdf (scan completo) MAI chiamato", async () => {
    const findPdf = vi.fn();
    const findPdfByUid = vi.fn(async () => ({
      kind: "found" as const,
      pdfBytes: Buffer.from("%PDF-BY-UID"),
      filename: "Prenotazione736987.pdf",
      messageUid: "uid-known-1",
      sha256: "sha-by-uid",
    }));
    const existing = makeDeliveryAttempt({ status: "pdf_found", pdf_mailbox_message_uid: "uid-known-1", pdf_filename: "Prenotazione736987.pdf" });
    const outcome = await deliverMedmarTicket(
      { admin: fakeAdminWithServicesUpdateSpy(vi.fn()), tenantId: TENANT, userId: USER, issuingAttemptId: ISSUING_ATTEMPT_ID },
      baseDeps({ repo: makeDeliveryRepo(existing), findPdf: findPdf as never, findPdfByUid: findPdfByUid as never })
    );
    expect(findPdfByUid).toHaveBeenCalledWith(expect.objectContaining({ uid: "uid-known-1" }));
    expect(findPdf).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.status).toBe("delivered");
  });

  it("18. Fase B: se findPdfByUid non trova piu' il messaggio (UID scaduto/spostato), ricade sullo scan completo (findPdf)", async () => {
    const findPdf = vi.fn(async () => ({
      kind: "found" as const,
      pdfBytes: Buffer.from("%PDF-FALLBACK-SCAN"),
      filename: "Prenotazione736987.pdf",
      messageUid: "uid-nuovo-2",
      sha256: "sha-fallback",
    }));
    const findPdfByUid = vi.fn(async () => ({ kind: "not_found" as const }));
    const existing = makeDeliveryAttempt({ status: "pdf_found", pdf_mailbox_message_uid: "uid-vecchio-scaduto", pdf_filename: "Prenotazione736987.pdf" });
    const outcome = await deliverMedmarTicket(
      { admin: fakeAdminWithServicesUpdateSpy(vi.fn()), tenantId: TENANT, userId: USER, issuingAttemptId: ISSUING_ATTEMPT_ID },
      baseDeps({ repo: makeDeliveryRepo(existing), findPdf: findPdf as never, findPdfByUid: findPdfByUid as never })
    );
    expect(findPdfByUid).toHaveBeenCalledWith(expect.objectContaining({ uid: "uid-vecchio-scaduto" }));
    expect(findPdf).toHaveBeenCalledTimes(1);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.status).toBe("delivered");
  });

  it("19. Fase B end-to-end: UID gia' noto, nessun flag stopAfterPdfFound -> pulisce, valida, invia e consegna in un solo giro", async () => {
    const existing = makeDeliveryAttempt({ status: "pdf_found", pdf_mailbox_message_uid: "uid-known-3", pdf_filename: "Prenotazione736987.pdf" });
    const sendEmail = vi.fn(async () => ({ kind: "sent" as const, messageId: "resend-msg-19" }));
    const outcome = await deliverMedmarTicket(
      { admin: fakeAdminWithServicesUpdateSpy(vi.fn()), tenantId: TENANT, userId: USER, issuingAttemptId: ISSUING_ATTEMPT_ID },
      baseDeps({
        repo: makeDeliveryRepo(existing),
        findPdfByUid: (async () => ({ kind: "found" as const, pdfBytes: Buffer.from("%PDF-KNOWN"), filename: "Prenotazione736987.pdf", messageUid: "uid-known-3", sha256: "sha-known" })) as never,
        sendEmail: sendEmail as never,
      })
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.status).toBe("delivered");
      expect(outcome.attempt.resend_message_id).toBe("resend-msg-19");
    }
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("20. eccezione in validatePdf (non solo cleaner) si propaga taggata con lo step 'pdf_validation' — osservabile via getMedmarDeliveryErrorStep", async () => {
    const validatePdf = vi.fn(async () => {
      throw new Error("pdfjs: errore interno inatteso");
    });
    await expect(
      deliverMedmarTicket(
        { admin: fakeAdminWithServicesUpdateSpy(vi.fn()), tenantId: TENANT, userId: USER, issuingAttemptId: ISSUING_ATTEMPT_ID },
        baseDeps({ repo: makeDeliveryRepo(), validatePdf: validatePdf as never })
      )
    ).rejects.toSatisfy((err: unknown) => getMedmarDeliveryErrorStep(err) === "pdf_validation");
  });

  it("21. eccezione durante il fetch-by-UID (Fase B) e' taggata con lo step 'fetch_pdf_by_uid'", async () => {
    const existing = makeDeliveryAttempt({ status: "pdf_found", pdf_mailbox_message_uid: "uid-known-21", pdf_filename: "Prenotazione736987.pdf" });
    const findPdfByUid = vi.fn(async () => {
      throw new Error("ECONNRESET: connessione POP3 interrotta");
    });
    await expect(
      deliverMedmarTicket(
        { admin: fakeAdminWithServicesUpdateSpy(vi.fn()), tenantId: TENANT, userId: USER, issuingAttemptId: ISSUING_ATTEMPT_ID },
        baseDeps({ repo: makeDeliveryRepo(existing), findPdfByUid: findPdfByUid as never })
      )
    ).rejects.toSatisfy((err: unknown) => getMedmarDeliveryErrorStep(err) === "fetch_pdf_by_uid");
  });

  it("22. eccezione durante la scrittura DB (updateAttempt su pdf_cleaned) e' taggata con lo step 'db_update_pdf_cleaned'", async () => {
    const repo = makeDeliveryRepo();
    const originalUpdate = repo.updateAttempt.bind(repo);
    const failingRepo: typeof repo = {
      ...repo,
      updateAttempt: (async (id, patch, expectedStatus) => {
        if (patch.status === "pdf_cleaned") throw new Error("Supabase: connessione al DB persa");
        return originalUpdate(id, patch, expectedStatus);
      }) as typeof repo.updateAttempt,
    };
    await expect(
      deliverMedmarTicket(
        { admin: fakeAdminWithServicesUpdateSpy(vi.fn()), tenantId: TENANT, userId: USER, issuingAttemptId: ISSUING_ATTEMPT_ID },
        baseDeps({ repo: failingRepo })
      )
    ).rejects.toSatisfy((err: unknown) => getMedmarDeliveryErrorStep(err) === "db_update_pdf_cleaned");
  });

  it("se un service collegato ha già medmar_ticket_sent_at valorizzato, non reinvia (idempotenza a livello services)", async () => {
    const sendEmail = vi.fn();
    const outcome = await deliverMedmarTicket(
      { admin: fakeAdminWithServicesUpdateSpy(vi.fn()), tenantId: TENANT, userId: USER, issuingAttemptId: ISSUING_ATTEMPT_ID },
      baseDeps({
        repo: makeDeliveryRepo(),
        loadDeliveryServices: (async () => [
          { id: SVC1, agency_id: AGENCY_ID, customer_name: "LUCIANO SENESE", customer_email: null, medmar_ticket_sent_at: new Date().toISOString() },
          { id: SVC2, agency_id: AGENCY_ID, customer_name: "LUCIANO SENESE", customer_email: null, medmar_ticket_sent_at: null },
        ]) as never,
        sendEmail: sendEmail as never,
      })
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.already_delivered).toBe(true);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe("deliverMedmarTicketWithTimeout — wrapper per l'auto-delivery collegata a medmar-issue/route.ts", () => {
  it("timeout controllato: se deliverMedmarTicket non conclude entro timeoutMs -> 'delivery_in_progress', mai un'eccezione propagata", async () => {
    const neverResolves = new Promise<never>(() => {}); // simula una mailbox lentissima
    const summary = await deliverMedmarTicketWithTimeout(
      { admin: {} as never, tenantId: TENANT, userId: USER, issuingAttemptId: ISSUING_ATTEMPT_ID },
      50, // timeout brevissimo per il test
      baseDeps({ repo: makeDeliveryRepo(), findPdf: (() => neverResolves) as never })
    );
    expect(summary.status).toBe("delivery_in_progress");
    expect(summary.warning).toBeTruthy();
  });

  it("contenimento errori: se una dipendenza lancia un'eccezione -> 'delivery_error', mai propagata al chiamante (l'emissione non deve mai fallire per colpa della delivery)", async () => {
    const summary = await deliverMedmarTicketWithTimeout(
      { admin: {} as never, tenantId: TENANT, userId: USER, issuingAttemptId: ISSUING_ATTEMPT_ID },
      5000,
      baseDeps({
        loadIssuingAttempt: (() => {
          throw new Error("boom: errore interno inatteso");
        }) as never,
      })
    );
    expect(summary.status).toBe("delivery_error");
    expect(summary.warning).toContain("boom");
  });

  it("esito 'delivered' viene propagato correttamente senza alterazioni", async () => {
    const summary = await deliverMedmarTicketWithTimeout(
      { admin: fakeAdminWithServicesUpdateSpy(vi.fn()), tenantId: TENANT, userId: USER, issuingAttemptId: ISSUING_ATTEMPT_ID },
      5000,
      baseDeps({ repo: makeDeliveryRepo(), sendEmail: (async () => ({ kind: "sent", messageId: "resend-msg-wrapper" })) as never })
    );
    expect(summary.status).toBe("delivered");
    expect(summary.recipient_email).toBe("biglietteria@alesteviaggi.it");
  });
});
