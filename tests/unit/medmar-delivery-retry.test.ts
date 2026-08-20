import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  runMedmarDeliveryRetryBatch,
  MEDMAR_DELIVERY_RETRY_MAX_ATTEMPTS,
  MEDMAR_DELIVERY_RETRY_MIN_INTERVAL_MS,
  MEDMAR_DELIVERY_RETRY_DEFAULT_BATCH_SIZE,
  type MedmarDeliveryRetryCandidate,
  type MedmarDeliveryRetryDeps,
} from "@/lib/server/medmar-booking/delivery-retry";
import type { DeliveryRepository, MedmarDeliveryAttempt } from "@/lib/server/medmar-booking/delivery-types";
import type { MedmarDeliveryOutcome } from "@/lib/server/medmar-booking/pdf-delivery";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ADMIN_USER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ISSUING_ATTEMPT_1 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ISSUING_ATTEMPT_2 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const DELIVERY_ATTEMPT_1 = "11111111-aaaa-4aaa-8aaa-111111111111";
const DELIVERY_ATTEMPT_2 = "22222222-aaaa-4aaa-8aaa-222222222222";

function makeCandidate(overrides: Partial<MedmarDeliveryRetryCandidate> = {}): MedmarDeliveryRetryCandidate {
  return {
    id: DELIVERY_ATTEMPT_1,
    tenant_id: TENANT,
    issuing_attempt_id: ISSUING_ATTEMPT_1,
    status: "awaiting_pdf",
    attempt_count: 0,
    updated_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    ...overrides,
  };
}

function makeAttempt(overrides: Partial<MedmarDeliveryAttempt> = {}): MedmarDeliveryAttempt {
  return {
    id: DELIVERY_ATTEMPT_1,
    tenant_id: TENANT,
    issuing_attempt_id: ISSUING_ATTEMPT_1,
    service_ids: [],
    status: "pdf_not_found",
    medmar_id_prenotazione: "737817",
    medmar_numero: "AG1908926B000441194",
    pdf_mailbox_message_uid: null,
    pdf_filename: null,
    pdf_original_sha256: null,
    pdf_cleaned_sha256: null,
    recipient_type: null,
    recipient_name: null,
    recipient_email: null,
    resend_message_id: null,
    attempt_count: 1,
    last_error_code: null,
    last_error_message: null,
    created_by: ADMIN_USER,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    delivered_at: null,
    ...overrides,
  };
}

function fakeRepo(): DeliveryRepository & { updateAttemptSpy: ReturnType<typeof vi.fn> } {
  const updateAttemptSpy = vi.fn(async (id: string, patch: Partial<MedmarDeliveryAttempt>, _expectedStatus: string) => {
    return makeAttempt({ id, ...patch });
  });
  return {
    async findByIssuingAttempt() {
      return null;
    },
    async acquireAttempt() {
      throw new Error("non atteso in questi test: i candidati esistono gia'");
    },
    updateAttempt: updateAttemptSpy,
    updateAttemptSpy,
  };
}

function baseDeps(overrides: Partial<MedmarDeliveryRetryDeps> = {}): MedmarDeliveryRetryDeps {
  return {
    resolveSystemUserId: (async () => ADMIN_USER) as never,
    ...overrides,
  };
}

describe("runMedmarDeliveryRetryBatch — retry controllato delivery Medmar", () => {
  it("1. candidato awaiting_pdf viene ritentato: deliverMedmarTicket chiamato con lo stesso issuing_attempt_id", async () => {
    const candidate = makeCandidate({ status: "awaiting_pdf" });
    const deliver = vi.fn(async (): Promise<MedmarDeliveryOutcome> => ({
      ok: true,
      status: "delivered",
      attempt: makeAttempt({ status: "delivered", resend_message_id: "msg-1" }),
      already_delivered: false,
    }));
    const summary = await runMedmarDeliveryRetryBatch(
      {} as SupabaseClient,
      10,
      baseDeps({ loadCandidates: (async () => [candidate]) as never, deliver })
    );
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, userId: ADMIN_USER, issuingAttemptId: ISSUING_ATTEMPT_1 }),
      undefined
    );
    expect(summary.delivered).toBe(1);
  });

  it("2. candidato pdf_not_found viene ritentato allo stesso modo", async () => {
    const candidate = makeCandidate({ status: "pdf_not_found", attempt_count: 2 });
    const deliver = vi.fn(async (): Promise<MedmarDeliveryOutcome> => ({
      ok: true,
      status: "delivered",
      attempt: makeAttempt({ status: "delivered" }),
      already_delivered: false,
    }));
    const summary = await runMedmarDeliveryRetryBatch(
      {} as SupabaseClient,
      10,
      baseDeps({ loadCandidates: (async () => [candidate]) as never, deliver })
    );
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(summary.delivered).toBe(1);
  });

  it("3. loadRetryCandidates reale interroga solo gli stati ritentabili (mai 'delivered')", async () => {
    const inSpy = vi.fn().mockReturnThis();
    const chain = {
      select: vi.fn().mockReturnThis(),
      in: inSpy,
      lt: vi.fn().mockReturnThis(),
      lte: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn(() => Promise.resolve({ data: [], error: null })),
    };
    const admin = { from: vi.fn(() => chain) } as unknown as SupabaseClient;

    await runMedmarDeliveryRetryBatch(admin, 10, baseDeps());

    expect(admin.from).toHaveBeenCalledWith("medmar_delivery_attempts");
    expect(inSpy).toHaveBeenCalledWith("status", expect.arrayContaining(["awaiting_pdf", "pdf_not_found"]));
    const statusesQueried = inSpy.mock.calls[0]![1] as string[];
    expect(statusesQueried).not.toContain("delivered");
    expect(statusesQueried).not.toContain("delivery_state_unknown");
    expect(statusesQueried).not.toContain("pdf_ambiguous");
    expect(statusesQueried).not.toContain("pdf_validation_failed");
    expect(statusesQueried).not.toContain("manual_review");
  });

  it("4. resend_message_id gia' presente -> deliverMedmarTicket segnala already_delivered, il batch non fa altro", async () => {
    const candidate = makeCandidate({ status: "awaiting_pdf" });
    const repo = fakeRepo();
    const deliver = vi.fn(async (): Promise<MedmarDeliveryOutcome> => ({
      ok: true,
      status: "delivered",
      attempt: makeAttempt({ status: "delivered", resend_message_id: "resend-existing" }),
      already_delivered: true,
    }));
    const summary = await runMedmarDeliveryRetryBatch(
      {} as SupabaseClient,
      10,
      baseDeps({ loadCandidates: (async () => [candidate]) as never, deliver, repo })
    );
    expect(summary.delivered).toBe(1);
    expect(repo.updateAttemptSpy).not.toHaveBeenCalled();
  });

  it("5. medmar_ticket_sent_at gia' valorizzato -> stesso esito 'delivered', nessuna escalation", async () => {
    const candidate = makeCandidate({ status: "pdf_not_found" });
    const repo = fakeRepo();
    const deliver = vi.fn(async (): Promise<MedmarDeliveryOutcome> => ({
      ok: true,
      status: "delivered",
      attempt: makeAttempt({ status: "delivered" }),
      already_delivered: true,
    }));
    const summary = await runMedmarDeliveryRetryBatch(
      {} as SupabaseClient,
      10,
      baseDeps({ loadCandidates: (async () => [candidate]) as never, deliver, repo })
    );
    expect(summary.delivered).toBe(1);
    expect(summary.escalated_to_manual_review).toBe(0);
    expect(repo.updateAttemptSpy).not.toHaveBeenCalled();
  });

  it("6. delivery_state_unknown non viene mai escalato ne' ritentato oltre la chiamata gia' bloccata internamente", async () => {
    const candidate = makeCandidate({ status: "pdf_not_found", attempt_count: 4 });
    const repo = fakeRepo();
    const deliver = vi.fn(async (): Promise<MedmarDeliveryOutcome> => ({
      ok: false,
      status: "delivery_state_unknown",
      attempt: makeAttempt({ status: "delivery_state_unknown", attempt_count: 4 }),
      error: "Timeout invio email.",
    }));
    const summary = await runMedmarDeliveryRetryBatch(
      {} as SupabaseClient,
      10,
      baseDeps({ loadCandidates: (async () => [candidate]) as never, deliver, repo })
    );
    expect(summary.still_pending).toBe(1);
    expect(summary.escalated_to_manual_review).toBe(0);
    expect(repo.updateAttemptSpy).not.toHaveBeenCalled();
  });

  it("7. pdf_ambiguous non ritentabile: nessuna escalation automatica", async () => {
    const candidate = makeCandidate({ status: "awaiting_pdf" });
    const repo = fakeRepo();
    const deliver = vi.fn(async (): Promise<MedmarDeliveryOutcome> => ({
      ok: false,
      status: "pdf_ambiguous",
      attempt: makeAttempt({ status: "pdf_ambiguous" }),
      error: "2 PDF compatibili trovati",
    }));
    const summary = await runMedmarDeliveryRetryBatch(
      {} as SupabaseClient,
      10,
      baseDeps({ loadCandidates: (async () => [candidate]) as never, deliver, repo })
    );
    expect(summary.still_pending).toBe(1);
    expect(summary.escalated_to_manual_review).toBe(0);
    expect(repo.updateAttemptSpy).not.toHaveBeenCalled();
  });

  it("8. pdf_validation_failed non ritentabile: nessuna escalation automatica", async () => {
    const candidate = makeCandidate({ status: "awaiting_pdf" });
    const repo = fakeRepo();
    const deliver = vi.fn(async (): Promise<MedmarDeliveryOutcome> => ({
      ok: false,
      status: "pdf_validation_failed",
      attempt: makeAttempt({ status: "pdf_validation_failed" }),
      error: "Etichetta vietata ancora presente",
    }));
    const summary = await runMedmarDeliveryRetryBatch(
      {} as SupabaseClient,
      10,
      baseDeps({ loadCandidates: (async () => [candidate]) as never, deliver, repo })
    );
    expect(summary.still_pending).toBe(1);
    expect(summary.escalated_to_manual_review).toBe(0);
    expect(repo.updateAttemptSpy).not.toHaveBeenCalled();
  });

  it("9. max_attempts rispettato: pdf_not_found con attempt_count >= soglia passa a manual_review", async () => {
    const candidate = makeCandidate({ status: "pdf_not_found", attempt_count: MEDMAR_DELIVERY_RETRY_MAX_ATTEMPTS - 1 });
    const repo = fakeRepo();
    const deliver = vi.fn(async (): Promise<MedmarDeliveryOutcome> => ({
      ok: false,
      status: "pdf_not_found",
      attempt: makeAttempt({ status: "pdf_not_found", attempt_count: MEDMAR_DELIVERY_RETRY_MAX_ATTEMPTS }),
      error: "Nessun PDF trovato nella mailbox Medmar per questa prenotazione.",
    }));
    const summary = await runMedmarDeliveryRetryBatch(
      {} as SupabaseClient,
      10,
      baseDeps({ loadCandidates: (async () => [candidate]) as never, deliver, repo })
    );
    expect(summary.escalated_to_manual_review).toBe(1);
    expect(summary.still_pending).toBe(0);
    expect(repo.updateAttemptSpy).toHaveBeenCalledWith(
      DELIVERY_ATTEMPT_1,
      expect.objectContaining({ status: "manual_review" }),
      "pdf_not_found"
    );
  });

  it("9b. pdf_not_found sotto la soglia NON viene escalato: resta ritentabile", async () => {
    const candidate = makeCandidate({ status: "pdf_not_found", attempt_count: 1 });
    const repo = fakeRepo();
    const deliver = vi.fn(async (): Promise<MedmarDeliveryOutcome> => ({
      ok: false,
      status: "pdf_not_found",
      attempt: makeAttempt({ status: "pdf_not_found", attempt_count: 2 }),
      error: "Nessun PDF trovato nella mailbox Medmar per questa prenotazione.",
    }));
    const summary = await runMedmarDeliveryRetryBatch(
      {} as SupabaseClient,
      10,
      baseDeps({ loadCandidates: (async () => [candidate]) as never, deliver, repo })
    );
    expect(summary.escalated_to_manual_review).toBe(0);
    expect(summary.still_pending).toBe(1);
    expect(repo.updateAttemptSpy).not.toHaveBeenCalled();
  });

  it("10. intervallo minimo rispettato: loadRetryCandidates reale filtra per updated_at <= now - intervallo minimo", async () => {
    const lteSpy = vi.fn().mockReturnThis();
    const chain = {
      select: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      lt: vi.fn().mockReturnThis(),
      lte: lteSpy,
      order: vi.fn().mockReturnThis(),
      limit: vi.fn(() => Promise.resolve({ data: [], error: null })),
    };
    const admin = { from: vi.fn(() => chain) } as unknown as SupabaseClient;
    const fixedNow = new Date("2026-08-20T15:00:00.000Z");

    await runMedmarDeliveryRetryBatch(admin, 10, baseDeps({ now: () => fixedNow }));

    const expectedCutoff = new Date(fixedNow.getTime() - MEDMAR_DELIVERY_RETRY_MIN_INTERVAL_MS).toISOString();
    expect(lteSpy).toHaveBeenCalledWith("updated_at", expectedCutoff);
  });

  it("11. cron processa al massimo N record per run: il limite viene passato alla query", async () => {
    const limitSpy = vi.fn(() => Promise.resolve({ data: [], error: null }));
    const chain = {
      select: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      lt: vi.fn().mockReturnThis(),
      lte: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: limitSpy,
    };
    const admin = { from: vi.fn(() => chain) } as unknown as SupabaseClient;

    await runMedmarDeliveryRetryBatch(admin, 5, baseDeps());
    expect(limitSpy).toHaveBeenCalledWith(5);

    await runMedmarDeliveryRetryBatch(admin, undefined, baseDeps());
    expect(limitSpy).toHaveBeenCalledWith(MEDMAR_DELIVERY_RETRY_DEFAULT_BATCH_SIZE);
  });

  it("12. PDF arrivato al secondo tentativo: primo run pdf_not_found, secondo run (stesso attempt) delivered", async () => {
    const candidateFirstRun = makeCandidate({ id: DELIVERY_ATTEMPT_2, issuing_attempt_id: ISSUING_ATTEMPT_2, status: "awaiting_pdf", attempt_count: 0 });
    const deliverFirst = vi.fn(async (): Promise<MedmarDeliveryOutcome> => ({
      ok: false,
      status: "pdf_not_found",
      attempt: makeAttempt({ id: DELIVERY_ATTEMPT_2, issuing_attempt_id: ISSUING_ATTEMPT_2, status: "pdf_not_found", attempt_count: 1 }),
      error: "Nessun PDF trovato nella mailbox Medmar per questa prenotazione.",
    }));
    const firstSummary = await runMedmarDeliveryRetryBatch(
      {} as SupabaseClient,
      10,
      baseDeps({ loadCandidates: (async () => [candidateFirstRun]) as never, deliver: deliverFirst })
    );
    expect(firstSummary.still_pending).toBe(1);
    expect(firstSummary.delivered).toBe(0);

    const candidateSecondRun = makeCandidate({ id: DELIVERY_ATTEMPT_2, issuing_attempt_id: ISSUING_ATTEMPT_2, status: "pdf_not_found", attempt_count: 1 });
    const deliverSecond = vi.fn(async (): Promise<MedmarDeliveryOutcome> => ({
      ok: true,
      status: "delivered",
      attempt: makeAttempt({ id: DELIVERY_ATTEMPT_2, issuing_attempt_id: ISSUING_ATTEMPT_2, status: "delivered", attempt_count: 1, resend_message_id: "resend-msg-second-try" }),
      already_delivered: false,
    }));
    const secondSummary = await runMedmarDeliveryRetryBatch(
      {} as SupabaseClient,
      10,
      baseDeps({ loadCandidates: (async () => [candidateSecondRun]) as never, deliver: deliverSecond })
    );
    expect(secondSummary.delivered).toBe(1);
    expect(deliverSecond).toHaveBeenCalledTimes(1);
  });

  it("13. nessun invio duplicato: un secondo run dopo la delivery non ritrova candidati (fuori dagli stati ritentabili) e non richiama mai deliver", async () => {
    const candidate = makeCandidate({ status: "awaiting_pdf" });
    let callCount = 0;
    const deliver = vi.fn(async (): Promise<MedmarDeliveryOutcome> => {
      callCount += 1;
      return {
        ok: true,
        status: "delivered",
        attempt: makeAttempt({ status: "delivered", resend_message_id: `resend-msg-${callCount}` }),
        already_delivered: callCount > 1,
      };
    });
    await runMedmarDeliveryRetryBatch({} as SupabaseClient, 10, baseDeps({ loadCandidates: (async () => [candidate]) as never, deliver }));
    await runMedmarDeliveryRetryBatch({} as SupabaseClient, 10, baseDeps({ loadCandidates: (async () => []) as never, deliver }));
    expect(deliver).toHaveBeenCalledTimes(1); // il secondo run non trova piu' candidati (gia' delivered, fuori dagli stati ritentabili)
  });

  it("14. errore imprevisto durante un retry viene contenuto (non propagato) e conteggiato separatamente", async () => {
    const candidate = makeCandidate({ status: "awaiting_pdf" });
    const deliver = vi.fn(async () => {
      throw new Error("boom: mailbox non raggiungibile");
    });
    const summary = await runMedmarDeliveryRetryBatch(
      {} as SupabaseClient,
      10,
      baseDeps({ loadCandidates: (async () => [candidate]) as never, deliver: deliver as never })
    );
    expect(summary.errors).toBe(1);
    expect(summary.results[0]!.error).toBe(true);
  });
});
