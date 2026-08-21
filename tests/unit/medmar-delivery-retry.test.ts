import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  runMedmarDeliveryRetryBatch,
  MEDMAR_DELIVERY_RETRY_MAX_ATTEMPTS,
  MEDMAR_DELIVERY_RETRY_MIN_INTERVAL_MS,
  MEDMAR_DELIVERY_RETRY_DEFAULT_BATCH_SIZE,
  MEDMAR_DELIVERY_RETRY_MAX_BATCH_SIZE,
  MEDMAR_DELIVERY_RETRY_TOTAL_BUDGET_MS,
  MEDMAR_DELIVERY_RETRY_PER_CANDIDATE_BUDGET_MS,
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
const MEDMAR_ID_PRENOTAZIONE = "738278";
const MEDMAR_NUMERO = "AG1908926B000442656";

function makeCandidate(overrides: Partial<MedmarDeliveryRetryCandidate> = {}): MedmarDeliveryRetryCandidate {
  return {
    id: DELIVERY_ATTEMPT_1,
    tenant_id: TENANT,
    issuing_attempt_id: ISSUING_ATTEMPT_1,
    status: "awaiting_pdf",
    attempt_count: 0,
    updated_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    medmar_id_prenotazione: MEDMAR_ID_PRENOTAZIONE,
    medmar_numero: MEDMAR_NUMERO,
    pdf_mailbox_message_uid: null,
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
    medmar_id_prenotazione: MEDMAR_ID_PRENOTAZIONE,
    medmar_numero: MEDMAR_NUMERO,
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

function deliveredOutcome(overrides: Partial<MedmarDeliveryAttempt> = {}): MedmarDeliveryOutcome {
  return {
    ok: true,
    status: "delivered",
    attempt: makeAttempt({ status: "delivered", resend_message_id: "resend-msg-1", ...overrides }),
    already_delivered: false,
  };
}

describe("runMedmarDeliveryRetryBatch — retry controllato delivery Medmar", () => {
  it("costanti di budget esportate: default limit 1, max limit 3, totale 29s, per-candidato 28s", () => {
    expect(MEDMAR_DELIVERY_RETRY_DEFAULT_BATCH_SIZE).toBe(1);
    expect(MEDMAR_DELIVERY_RETRY_MAX_BATCH_SIZE).toBe(3);
    expect(MEDMAR_DELIVERY_RETRY_TOTAL_BUDGET_MS).toBe(29_000);
    expect(MEDMAR_DELIVERY_RETRY_PER_CANDIDATE_BUDGET_MS).toBe(28_000);
  });

  it("1. zero candidati -> risposta rapida, nessun timeout, deliver mai chiamato, items vuoto", async () => {
    const deliver = vi.fn();
    const summary = await runMedmarDeliveryRetryBatch(
      {} as SupabaseClient,
      MEDMAR_DELIVERY_RETRY_DEFAULT_BATCH_SIZE,
      baseDeps({ loadCandidates: (async () => []) as never, deliver: deliver as never })
    );
    expect(summary.candidates_found).toBe(0);
    expect(summary.processed).toBe(0);
    expect(summary.delivered).toBe(0);
    expect(summary.timed_out).toBe(false);
    expect(summary.items).toEqual([]);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("2. default limit passato alla query e' 1", async () => {
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
    await runMedmarDeliveryRetryBatch(admin, undefined, baseDeps());
    expect(limitSpy).toHaveBeenCalledWith(MEDMAR_DELIVERY_RETRY_DEFAULT_BATCH_SIZE);
  });

  it("3. max limit e' 3: la route lo applica a monte, qui verifichiamo solo che il limite passato venga rispettato dalla query", async () => {
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
    await runMedmarDeliveryRetryBatch(admin, MEDMAR_DELIVERY_RETRY_MAX_BATCH_SIZE, baseDeps());
    expect(limitSpy).toHaveBeenCalledWith(3);
  });

  it("4. candidato awaiting_pdf con PDF presente -> delivered, item.result='delivered' con resend_message_id", async () => {
    const candidate = makeCandidate({ status: "awaiting_pdf" });
    const deliver = vi.fn(async () => deliveredOutcome());
    const summary = await runMedmarDeliveryRetryBatch(
      {} as SupabaseClient,
      10,
      baseDeps({ loadCandidates: (async () => [candidate]) as never, deliver })
    );
    expect(summary.delivered).toBe(1);
    expect(summary.timed_out).toBe(false);
    expect(summary.items[0]).toMatchObject({
      result: "delivered",
      resend_message_id: "resend-msg-1",
      medmar_id_prenotazione: MEDMAR_ID_PRENOTAZIONE,
      medmar_numero: MEDMAR_NUMERO,
      status_before: "awaiting_pdf",
      budget_ms: MEDMAR_DELIVERY_RETRY_PER_CANDIDATE_BUDGET_MS,
    });
    expect(typeof summary.items[0]!.elapsed_ms).toBe("number");
  });

  it("4b. caso reale scalato: un candidato che completa poco prima del budget (equivalente ai ~26,3s osservati su 738420, ora ben dentro i 28s) viene consegnato, non tagliato", async () => {
    const candidate = makeCandidate({ status: "awaiting_pdf" });
    // Budget di test scalato 1000x rispetto ai 28s reali: 28ms di budget, delivery risolve a 20ms
    // (equivalente proporzionale a ~20s su 28s reali, sotto la soglia dove prima si tagliava a 26s).
    const deliver = vi.fn(
      () =>
        new Promise<MedmarDeliveryOutcome>((resolve) => {
          setTimeout(() => resolve(deliveredOutcome()), 20);
        })
    );
    const summary = await runMedmarDeliveryRetryBatch(
      {} as SupabaseClient,
      10,
      baseDeps({ loadCandidates: (async () => [candidate]) as never, deliver: deliver as never, perCandidateBudgetMs: 28 })
    );
    expect(summary.timed_out).toBe(false);
    expect(summary.delivered).toBe(1);
    expect(summary.items[0]).toMatchObject({ result: "delivered", budget_ms: 28 });
  });

  it("5. lookup lento ma entro budget per-candidato -> delivered, nessun timeout", async () => {
    const candidate = makeCandidate({ status: "awaiting_pdf" });
    const deliver = vi.fn(
      () =>
        new Promise<MedmarDeliveryOutcome>((resolve) => {
          setTimeout(() => resolve(deliveredOutcome()), 15); // lento ma sotto il budget di test (perCandidateBudgetMs: 50)
        })
    );
    const summary = await runMedmarDeliveryRetryBatch(
      {} as SupabaseClient,
      10,
      baseDeps({ loadCandidates: (async () => [candidate]) as never, deliver: deliver as never, perCandidateBudgetMs: 50 })
    );
    expect(summary.timed_out).toBe(false);
    expect(summary.delivered).toBe(1);
    expect(summary.items[0]!.result).toBe("delivered");
  });

  it("6. lookup oltre il budget per-candidato -> HTTP-level ok, timedOut true, item.result='timed_out', nessun repo.updateAttempt", async () => {
    const candidate = makeCandidate({ status: "awaiting_pdf" });
    const repo = fakeRepo();
    const deliver = vi.fn(() => new Promise<MedmarDeliveryOutcome>(() => {})); // non risolve mai
    const summary = await runMedmarDeliveryRetryBatch(
      {} as SupabaseClient,
      10,
      baseDeps({ loadCandidates: (async () => [candidate]) as never, deliver: deliver as never, repo, perCandidateBudgetMs: 20 })
    );
    expect(summary.timed_out).toBe(true);
    expect(summary.deferred).toBe(1);
    expect(summary.delivered).toBe(0);
    expect(summary.items[0]).toMatchObject({ result: "timed_out", status_before: "awaiting_pdf", budget_ms: 20 });
    expect(repo.updateAttemptSpy).not.toHaveBeenCalled();
  });

  it("6b. deliver riceve il budget per-candidato come mailboxTimeoutMs (per chiudere davvero il socket POP3 allo scadere)", async () => {
    const candidate = makeCandidate({ status: "awaiting_pdf" });
    const deliver = vi.fn(async () => deliveredOutcome());
    await runMedmarDeliveryRetryBatch(
      {} as SupabaseClient,
      10,
      baseDeps({ loadCandidates: (async () => [candidate]) as never, deliver, perCandidateBudgetMs: 12_345 })
    );
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ mailboxTimeoutMs: 12_345 }), undefined);
  });

  it("6c. retry a due fasi: candidato senza pdf_mailbox_message_uid -> deliver chiamato con stopAfterPdfFound:true (Fase A)", async () => {
    const candidate = makeCandidate({ status: "awaiting_pdf", pdf_mailbox_message_uid: null });
    const deliver = vi.fn(async () => deliveredOutcome());
    await runMedmarDeliveryRetryBatch({} as SupabaseClient, 10, baseDeps({ loadCandidates: (async () => [candidate]) as never, deliver }));
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ stopAfterPdfFound: true }), undefined);
  });

  it("6d. retry a due fasi: candidato con pdf_mailbox_message_uid gia' salvato -> deliver chiamato con stopAfterPdfFound:false (Fase B, no scan completo)", async () => {
    const candidate = makeCandidate({ status: "pdf_found", pdf_mailbox_message_uid: "uid-gia-noto" });
    const deliver = vi.fn(async () => deliveredOutcome());
    await runMedmarDeliveryRetryBatch({} as SupabaseClient, 10, baseDeps({ loadCandidates: (async () => [candidate]) as never, deliver }));
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ stopAfterPdfFound: false }), undefined);
  });

  it("6e. Fase A riuscita (PDF trovato, budget quasi finito): outcome.status='pdf_found' -> item.result='pdf_found_deferred', uid/filename salvati, still_pending+1, nessuna escalation, nessun 'delivered'", async () => {
    const candidate = makeCandidate({ status: "awaiting_pdf", pdf_mailbox_message_uid: null });
    const repo = fakeRepo();
    const deliver = vi.fn(async (): Promise<MedmarDeliveryOutcome> => ({
      ok: false,
      status: "pdf_found",
      attempt: makeAttempt({ status: "pdf_found", pdf_mailbox_message_uid: "uid-nuovo", pdf_filename: "Prenotazione738278.pdf" }),
      error: "PDF individuato in mailbox: invio rimandato al prossimo ciclo.",
    }));
    const summary = await runMedmarDeliveryRetryBatch(
      {} as SupabaseClient,
      10,
      baseDeps({ loadCandidates: (async () => [candidate]) as never, deliver, repo })
    );
    expect(summary.delivered).toBe(0);
    expect(summary.still_pending).toBe(1);
    expect(summary.escalated_to_manual_review).toBe(0);
    expect(summary.timed_out).toBe(false);
    expect(summary.items[0]).toMatchObject({
      result: "pdf_found_deferred",
      pdf_mailbox_message_uid: "uid-nuovo",
      pdf_filename: "Prenotazione738278.pdf",
    });
    expect(repo.updateAttemptSpy).not.toHaveBeenCalled(); // l'update e' gia' avvenuto dentro deliverMedmarTicket (mockato qui)
  });

  it("6f. item 'delivered' include pdf_mailbox_message_uid/pdf_filename dell'attempt finale (Fase B completata)", async () => {
    const candidate = makeCandidate({ status: "pdf_found", pdf_mailbox_message_uid: "uid-noto" });
    const deliver = vi.fn(async () => deliveredOutcome({ pdf_mailbox_message_uid: "uid-noto", pdf_filename: "Prenotazione738278.pdf" }));
    const summary = await runMedmarDeliveryRetryBatch(
      {} as SupabaseClient,
      10,
      baseDeps({ loadCandidates: (async () => [candidate]) as never, deliver })
    );
    expect(summary.items[0]).toMatchObject({
      result: "delivered",
      pdf_mailbox_message_uid: "uid-noto",
      pdf_filename: "Prenotazione738278.pdf",
    });
  });

  it("7. timeout interno non produce doppio invio: il candidato resta intatto, un secondo run (deliver ora veloce) consegna una volta sola", async () => {
    const candidate = makeCandidate({ status: "awaiting_pdf" });
    let calls = 0;
    const slowThenFastDeliver = vi.fn(() => {
      calls += 1;
      if (calls === 1) return new Promise<MedmarDeliveryOutcome>(() => {}); // primo giro: mai risolve (timeout)
      return Promise.resolve(deliveredOutcome());
    });
    const first = await runMedmarDeliveryRetryBatch(
      {} as SupabaseClient,
      10,
      baseDeps({ loadCandidates: (async () => [candidate]) as never, deliver: slowThenFastDeliver as never, perCandidateBudgetMs: 20 })
    );
    expect(first.timed_out).toBe(true);
    expect(first.delivered).toBe(0);

    const second = await runMedmarDeliveryRetryBatch(
      {} as SupabaseClient,
      10,
      baseDeps({ loadCandidates: (async () => [candidate]) as never, deliver: slowThenFastDeliver as never, perCandidateBudgetMs: 20 })
    );
    expect(second.delivered).toBe(1);
    expect(slowThenFastDeliver).toHaveBeenCalledTimes(2); // una chiamata per run, mai due nello stesso run
  });

  it("8. delivered non e' candidato: loadRetryCandidates reale interroga solo gli stati ritentabili", async () => {
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
    const statusesQueried = inSpy.mock.calls[0]![1] as string[];
    expect(statusesQueried).toEqual(expect.arrayContaining(["awaiting_pdf", "pdf_not_found"]));
    expect(statusesQueried).not.toContain("delivered");
  });

  it("9. resend_message_id gia' presente -> deliverMedmarTicket segnala already_delivered, item.result='delivered', nessun update", async () => {
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
    expect(summary.items[0]!.result).toBe("delivered");
    expect(summary.items[0]!.resend_message_id).toBe("resend-existing");
    expect(repo.updateAttemptSpy).not.toHaveBeenCalled();
  });

  it("10. medmar_ticket_sent_at gia' valorizzato -> stesso esito 'delivered', nessuna escalation, nessun update", async () => {
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

  it("11. delivery_state_unknown non e' ritentabile: se restituito da deliver, item.result='pending', nessuna escalation/update", async () => {
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
    expect(summary.items[0]!.result).toBe("pending");
    expect(repo.updateAttemptSpy).not.toHaveBeenCalled();

    // Anche a livello di selezione query, questi stati non entrano mai nel batch:
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
    const statusesQueried = inSpy.mock.calls[0]![1] as string[];
    expect(statusesQueried).not.toContain("delivery_state_unknown");
  });

  it("12. pdf_ambiguous/pdf_validation_failed/recipient_missing/manual_review non vengono mai selezionati dalla query (pdf_found SI', e' Fase B del retry a due fasi)", async () => {
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
    const statusesQueried = inSpy.mock.calls[0]![1] as string[];
    for (const forbidden of ["pdf_ambiguous", "pdf_validation_failed", "recipient_missing", "manual_review", "remote_state_unknown_blocked", "delivery_state_unknown", "delivery_failed", "delivered"]) {
      expect(statusesQueried).not.toContain(forbidden);
    }
    expect(statusesQueried).toHaveLength(3);
    expect(statusesQueried).toEqual(expect.arrayContaining(["awaiting_pdf", "pdf_not_found", "pdf_found"]));
  });

  it("13. max_attempts rispettato: pdf_not_found con attempt_count >= soglia passa a manual_review, item.result='escalated_to_manual_review'", async () => {
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
    expect(summary.items[0]!.result).toBe("escalated_to_manual_review");
    expect(repo.updateAttemptSpy).toHaveBeenCalledWith(
      DELIVERY_ATTEMPT_1,
      expect.objectContaining({ status: "manual_review" }),
      "pdf_not_found"
    );
  });

  it("13b. pdf_not_found sotto la soglia NON viene escalato: resta ritentabile (result='pdf_not_found')", async () => {
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
    expect(summary.items[0]!.result).toBe("pdf_not_found");
    expect(repo.updateAttemptSpy).not.toHaveBeenCalled();
  });

  it("14. intervallo minimo rispettato: loadRetryCandidates reale filtra per updated_at <= now - intervallo minimo", async () => {
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

  it("15. budget totale esaurito prima di un secondo candidato: si ferma, il secondo risulta 'skipped_budget', mai toccato", async () => {
    const candidate1 = makeCandidate({ id: DELIVERY_ATTEMPT_1, status: "awaiting_pdf" });
    const candidate2 = makeCandidate({ id: DELIVERY_ATTEMPT_2, issuing_attempt_id: ISSUING_ATTEMPT_2, status: "awaiting_pdf" });
    const repo = fakeRepo();
    const deliver = vi.fn(async () => deliveredOutcome());
    let nowMsCallCount = 0;
    const nowMs = vi.fn(() => (nowMsCallCount++ < 4 ? 0 : 100_000));
    const summary = await runMedmarDeliveryRetryBatch(
      {} as SupabaseClient,
      10,
      baseDeps({ loadCandidates: (async () => [candidate1, candidate2]) as never, deliver, repo, nowMs, totalBudgetMs: 25_000 })
    );
    expect(summary.timed_out).toBe(true);
    expect(summary.skipped).toBe(1);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(summary.delivered).toBe(1);
    expect(summary.items).toHaveLength(2);
    expect(summary.items[1]).toMatchObject({ result: "skipped_budget", delivery_attempt_id: DELIVERY_ATTEMPT_2, elapsed_ms: 0 });
    expect(repo.updateAttemptSpy).not.toHaveBeenCalled();
  });

  it("16. errore imprevisto durante un retry viene contenuto (non propagato), item.result='error' con error_name/error_message/error_code osservabili", async () => {
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
    expect(summary.items[0]!.result).toBe("error");
    expect(summary.items[0]!.error_name).toBe("Error");
    expect(summary.items[0]!.error_message).toBe("boom: mailbox non raggiungibile");
    expect(summary.items[0]!.error_code).toBe("medmar_retry_unexpected_error"); // nessuno step taggato su questo errore sintetico
    expect(summary.items[0]!.step).toBeUndefined();
  });

  it("16b. errore lunghissimo/con spazi ripetuti viene troncato e normalizzato prima di finire in audit/response", async () => {
    const candidate = makeCandidate({ status: "awaiting_pdf" });
    const longMessage = "riga1\n\n  riga2   con   spazi   multipli  " + "x".repeat(500);
    const deliver = vi.fn(async () => {
      throw new Error(longMessage);
    });
    const summary = await runMedmarDeliveryRetryBatch(
      {} as SupabaseClient,
      10,
      baseDeps({ loadCandidates: (async () => [candidate]) as never, deliver: deliver as never })
    );
    expect(summary.items[0]!.error_message!.length).toBeLessThanOrEqual(200);
    expect(summary.items[0]!.error_message).not.toContain("\n");
  });

  it("16c. errore in Fase B: tenta un update best-effort di last_error_code/last_error_message SENZA cambiare status (expectedStatus = candidate.status, il record resta 'pdf_found' -> ritentabile)", async () => {
    const candidate = makeCandidate({ status: "pdf_found", pdf_mailbox_message_uid: "uid-noto" });
    const repo = fakeRepo();
    const deliver = vi.fn(async () => {
      throw new Error("errore Fase B simulato");
    });
    await runMedmarDeliveryRetryBatch(
      {} as SupabaseClient,
      10,
      baseDeps({ loadCandidates: (async () => [candidate]) as never, deliver: deliver as never, repo })
    );
    expect(repo.updateAttemptSpy).toHaveBeenCalledWith(
      DELIVERY_ATTEMPT_1,
      expect.objectContaining({ last_error_code: expect.any(String), last_error_message: "errore Fase B simulato" }),
      "pdf_found" // expectedStatus = lo stato del candidato, MAI un cambio di status
    );
    // Il patch non include mai "status": il record resta pdf_found, quindi ritentabile al prossimo giro.
    const patch = repo.updateAttemptSpy.mock.calls[0]![1] as Record<string, unknown>;
    expect(patch.status).toBeUndefined();
  });

  it("16d. se anche l'update best-effort di last_error_* fallisce (conflitto), il batch non si rompe: result resta 'error', nessuna eccezione propagata", async () => {
    const candidate = makeCandidate({ status: "awaiting_pdf" });
    const repo: DeliveryRepository = {
      async findByIssuingAttempt() {
        return null;
      },
      async acquireAttempt() {
        throw new Error("non atteso");
      },
      async updateAttempt() {
        throw new Error("medmar_delivery_attempt_conflict");
      },
    };
    const deliver = vi.fn(async () => {
      throw new Error("errore primario");
    });
    const summary = await runMedmarDeliveryRetryBatch(
      {} as SupabaseClient,
      10,
      baseDeps({ loadCandidates: (async () => [candidate]) as never, deliver: deliver as never, repo })
    );
    expect(summary.errors).toBe(1);
    expect(summary.items[0]!.result).toBe("error");
    expect(summary.items[0]!.error_message).toBe("errore primario"); // l'errore riportato resta quello ORIGINALE, non quello del tentativo di update fallito
  });

  it("17. nessun invio duplicato su run successivi: un secondo run dopo la delivery non trova piu' candidati e non richiama mai deliver", async () => {
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
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});
