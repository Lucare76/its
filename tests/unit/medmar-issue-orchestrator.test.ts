import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueRepository, MedmarIssueAttempt, MedmarIssueSessionContext, MedmarMutationClient } from "@/lib/server/medmar-booking/issue-types";
import { MedmarMutationRemoteUnknownError } from "@/lib/server/medmar-booking/medmar-mutation-client";

vi.mock("@/lib/server/ops-audit", () => ({ auditLog: vi.fn() }));

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SVC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SESSION_CONTEXT: MedmarIssueSessionContext = {
  bearerToken: "test-token",
  userId: 89,
  clienteId: "cliente-from-auth",
  postazioneId: "postazione-from-auth",
  turnoId: 91001,
};

function attempt(overrides: Partial<MedmarIssueAttempt> = {}): MedmarIssueAttempt {
  return {
    id: "attempt-1",
    tenant_id: TENANT,
    idempotency_key: `medmar_passenger_ar:${SVC}`,
    service_ids: [SVC],
    status: "preflight_started",
    preflight_snapshot: null,
    lock_snapshot: null,
    booking_payload_hash: null,
    medmar_id_prenotazione: null,
    medmar_numero: null,
    expected_total_cents: null,
    final_total_cents: null,
    last_error_code: null,
    last_error_message: null,
    remote_state_unknown: false,
    created_by: USER,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    completed_at: null,
    ...overrides,
  };
}

function makeRepo(existing?: MedmarIssueAttempt): IssueRepository & { current: MedmarIssueAttempt; events: unknown[] } {
  const store = { current: existing ?? attempt(), created: Boolean(existing), events: [] as unknown[] };
  return {
    get current() { return store.current; },
    get events() { return store.events; },
    async findAttempt() {
      return store.created ? store.current : null;
    },
    async acquireAttempt() {
      if (store.created) return { kind: "existing", attempt: store.current };
      store.created = true;
      return { kind: "created", attempt: store.current };
    },
    async updateAttempt(_id, patch, _expectedStatus) {
      store.current = { ...store.current, ...patch, updated_at: new Date().toISOString() };
      return store.current;
    },
    async addEvent(event) {
      store.events.push(event);
    },
    async loadServices() {
      return [{ id: SVC, tenant_id: TENANT, customer_name: "Mario Rossi", customer_email: "mario@example.test", customer_phone: "123456", pax: 1 }];
    },
  };
}

function preflight(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    can_issue: true,
    status: "ok" as const,
    group_key: "AAA",
    customer_name: "Mario Rossi",
    pratica: "AAA",
    pax: 1,
    outward: {
      direction: "outward" as const,
      route_code: "napoli_ischia" as const,
      route: { from: "NAPOLI", to: "ISCHIA" },
      date: "2026-08-20",
      requested_time: "08:40",
      matched_departure_time: "08:40:00",
      candidate_count: 1,
      match_source: "booked_ferry_time" as const,
      vessel: "MEDMAR GIULIA",
      service_ids: [SVC],
      id_corsa: 131943,
      source: "live" as const,
    },
    return: null,
    tariff: { id_biglietto: 370, id_tariffa: 6, label: "PASSAGGIO PONTE ADULTO - TARIFFA SPECIALE AR", unit_price_cents: 1150, source: "medmar_live" as const },
    taxes: [],
    expected_total_cents: 1150,
    is_live: true,
    warnings: [],
    error: null,
    ...overrides,
  };
}

function vendibili() {
  return [{
    id_corsa: 131943,
    id_biglietto: 370,
    id_tipologia_passeggero: 1,
    id_tariffa: 6,
    id_iva: 78,
    id_log: 58818,
    nome: "ADULTO - TARIFFA SPECIALE AR",
    descrizione: "PASSAGGIO PONTE ADULTO - TARIFFA SPECIALE AR",
    prezzo: 11.5,
    prezzo_ar: 0,
    prezzo_prevendita: 0,
    flag_ar_obbligatorio: true,
    flag_targa: 0,
    quantita_min_per_esclusivo: null,
    quantita_max_per_esclusivo: null,
  }];
}

function mutationClient(overrides: Partial<MedmarMutationClient> = {}): MedmarMutationClient {
  return {
    openTurn: vi.fn().mockResolvedValue({ id_turno: SESSION_CONTEXT.turnoId }),
    lockAvailability: vi.fn().mockResolvedValue({
      nonDisponibili: [],
      congelati: [{ id_corsa: 131943, quantita: 1, id_log: 58818, descrizione: "PASSAGGIO PONTE ADULTO - TARIFFA SPECIALE AR", id_biglietto: "370", id_biglietto_congelato: 207675 }],
    }),
    createBooking: vi.fn().mockResolvedValue({ id_prenotazione: 732162, prezzo_totale: "11.50", id_cliente: SESSION_CONTEXT.clienteId }),
    payManual: vi.fn().mockResolvedValue({ id_prenotazione: "732162", prezzo: "11.50", id_cliente: SESSION_CONTEXT.clienteId, id_modalita: "5", numero: "AG1908926B000423610" }),
    unlockAvailability: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function passengerComposition(overrides: { adults?: number; children?: number; infants?: number } = {}) {
  return {
    ok: true as const,
    composition: {
      adults: overrides.adults ?? 1,
      children: overrides.children ?? 0,
      infants: overrides.infants ?? 0,
      source: "pax_fallback" as const,
    },
  };
}

async function run(input: {
  repo?: IssueRepository;
  mutationClient?: MedmarMutationClient;
  preflightResult?: ReturnType<typeof preflight>;
  loadPassengerComposition?: ReturnType<typeof vi.fn>;
  resolveSessionContext?: ReturnType<typeof vi.fn>;
}) {
  const { createMedmarIssueOrchestrator } = await import("@/lib/server/medmar-booking/issue-orchestrator");
  return createMedmarIssueOrchestrator({
    repo: input.repo ?? makeRepo(),
    mutationClient: input.mutationClient ?? mutationClient(),
    runPreflight: vi.fn().mockResolvedValue(input.preflightResult ?? preflight()),
    fetchVendibili: vi.fn().mockResolvedValue(vendibili()),
    resolveSessionContext: (input.resolveSessionContext ?? vi.fn().mockResolvedValue({ ok: true, context: SESSION_CONTEXT })) as never,
    config: { enabled: true, causaleId: 1, modalitaId: 5, vettoreAndataId: 1, vettoreRitornoId: 1 },
    loadPassengerComposition: (input.loadPassengerComposition ?? vi.fn().mockResolvedValue(passengerComposition())) as never,
  })({ admin: {} as never, tenantId: TENANT, userId: USER, serviceIds: [SVC] });
}

describe("medmar issue orchestrator", () => {
  const ORIGINAL_MEDMAR_DELIVERY_EMAIL = process.env.MEDMAR_DELIVERY_EMAIL;
  beforeEach(() => {
    vi.clearAllMocks();
    // Fase 2B.6 — email tecnica configurata di default: i test qui sopra
    // esercitano il flusso pre-esistente (nessuna agenzia collegata nelle
    // fixture -> destinatario finale = cliente, già presente via
    // customer_email), non la gate email in sé (coperta a parte).
    process.env.MEDMAR_DELIVERY_EMAIL = "info@ischiatransferservice.it";
  });
  afterEach(() => {
    process.env.MEDMAR_DELIVERY_EMAIL = ORIGINAL_MEDMAR_DELIVERY_EMAIL;
  });

  it("happy path mock -> completed", async () => {
    const client = mutationClient();
    const result = await run({ mutationClient: client });
    expect(result.ok).toBe(true);
    expect(result.status).toBe("completed");
    expect(client.lockAvailability).toHaveBeenCalledTimes(1);
    expect(client.createBooking).toHaveBeenCalledTimes(1);
    expect(client.payManual).toHaveBeenCalledTimes(1);
  });

  it("preflight non ok -> zero mutazioni", async () => {
    const client = mutationClient();
    const result = await run({ mutationClient: client, preflightResult: preflight({ status: "no_match", can_issue: false }) });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("preflight_failed");
    expect(client.lockAvailability).not.toHaveBeenCalled();
  });

  it("27/29/30/31/32. Fase 2B.5 — bambino presente -> child_issue_payload_not_verified, ZERO resolveSessionContext (quindi zero openTurn)/lock/booking/payment, nessun attempt acquisito", async () => {
    const client = mutationClient();
    const repo = makeRepo();
    const acquireSpy = vi.spyOn(repo, "acquireAttempt");
    const resolveSessionContextSpy = vi.fn().mockResolvedValue({ ok: true, context: SESSION_CONTEXT });
    const result = await run({
      mutationClient: client,
      repo,
      resolveSessionContext: resolveSessionContextSpy,
      loadPassengerComposition: vi.fn().mockResolvedValue(passengerComposition({ adults: 1, children: 1 })),
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("child_issue_payload_not_verified");
    expect(result.retry_allowed).toBe(false);
    expect(acquireSpy).not.toHaveBeenCalled();
    // resolveSessionContext è il punto che nella produzione apre il turno
    // (openTurn): non essendo mai invocato, openTurn non può essere partito.
    expect(resolveSessionContextSpy).not.toHaveBeenCalled();
    expect(client.openTurn).not.toHaveBeenCalled();
    expect(client.lockAvailability).not.toHaveBeenCalled();
    expect(client.createBooking).not.toHaveBeenCalled();
    expect(client.payManual).not.toHaveBeenCalled();
  });

  it("28. Fase 2B.5 — infant presente -> child_issue_payload_not_verified, ZERO resolveSessionContext/mutazioni", async () => {
    const client = mutationClient();
    const resolveSessionContextSpy = vi.fn().mockResolvedValue({ ok: true, context: SESSION_CONTEXT });
    const result = await run({
      mutationClient: client,
      resolveSessionContext: resolveSessionContextSpy,
      loadPassengerComposition: vi.fn().mockResolvedValue(passengerComposition({ adults: 1, infants: 1 })),
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("child_issue_payload_not_verified");
    expect(resolveSessionContextSpy).not.toHaveBeenCalled();
    expect(client.lockAvailability).not.toHaveBeenCalled();
  });

  it("Fase 2B.5 — composizione passeggeri non verificabile (errore DB) -> manual_review retryable, ZERO resolveSessionContext/mutazioni (fail-closed, non fail-open)", async () => {
    const client = mutationClient();
    const resolveSessionContextSpy = vi.fn().mockResolvedValue({ ok: true, context: SESSION_CONTEXT });
    const result = await run({
      mutationClient: client,
      resolveSessionContext: resolveSessionContextSpy,
      loadPassengerComposition: vi.fn().mockResolvedValue({ ok: false, error: "passenger_composition_lookup_failed" }),
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("manual_review");
    expect(result.retry_allowed).toBe(true);
    expect(resolveSessionContextSpy).not.toHaveBeenCalled();
  });

  it("Fase 2B.5 — solo adulti (children=0, infants=0) -> il gate è un no-op, flusso invariato fino a completed", async () => {
    const client = mutationClient();
    const result = await run({ mutationClient: client, loadPassengerComposition: vi.fn().mockResolvedValue(passengerComposition({ adults: 2 })) });
    expect(result.ok).toBe(true);
    expect(result.status).toBe("completed");
    expect(client.lockAvailability).toHaveBeenCalledTimes(1);
    expect(client.createBooking).toHaveBeenCalledTimes(1);
    expect(client.payManual).toHaveBeenCalledTimes(1);
  });

  it("feature flag false blocca prima di repo e mutazioni", async () => {
    const { createMedmarIssueOrchestrator } = await import("@/lib/server/medmar-booking/issue-orchestrator");
    const repo = makeRepo();
    const client = mutationClient();
    const result = await createMedmarIssueOrchestrator({
      repo,
      mutationClient: client,
      runPreflight: vi.fn().mockResolvedValue(preflight()),
      fetchVendibili: vi.fn().mockResolvedValue(vendibili()),
      resolveSessionContext: vi.fn().mockResolvedValue({ ok: true, context: SESSION_CONTEXT }),
      config: { enabled: false, causaleId: 1, modalitaId: 5, vettoreAndataId: 1, vettoreRitornoId: 1 },
    })({ admin: {} as never, tenantId: TENANT, userId: USER, serviceIds: [SVC] });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("feature_disabled");
    expect(client.lockAvailability).not.toHaveBeenCalled();
  });

  it("session context non pronto -> nessun attempt e zero mutazioni", async () => {
    const { createMedmarIssueOrchestrator } = await import("@/lib/server/medmar-booking/issue-orchestrator");
    const repo = makeRepo();
    const acquireSpy = vi.spyOn(repo, "acquireAttempt");
    const client = mutationClient();
    const result = await createMedmarIssueOrchestrator({
      repo,
      mutationClient: client,
      runPreflight: vi.fn().mockResolvedValue(preflight()),
      fetchVendibili: vi.fn().mockResolvedValue(vendibili()),
      resolveSessionContext: vi.fn().mockResolvedValue({ ok: false, status: "not_ready", error: "Contesto Medmar incompleto.", retry_allowed: false }),
      config: { enabled: true, causaleId: 1, modalitaId: 5, vettoreAndataId: 1, vettoreRitornoId: 1 },
      loadPassengerComposition: vi.fn().mockResolvedValue(passengerComposition()) as never,
    })({ admin: {} as never, tenantId: TENANT, userId: USER, serviceIds: [SVC] });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("not_ready");
    expect(acquireSpy).not.toHaveBeenCalled();
    expect(client.lockAvailability).not.toHaveBeenCalled();
    expect(client.createBooking).not.toHaveBeenCalled();
  });

  it("lock nonDisponibili -> lock_failed senza booking", async () => {
    const client = mutationClient({ lockAvailability: vi.fn().mockResolvedValue({ nonDisponibili: [{ id_log: 1 }], congelati: [] }) });
    const result = await run({ mutationClient: client });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("lock_failed");
    expect(client.createBooking).not.toHaveBeenCalled();
  });

  it("frozen adulto mancante -> lock_failed senza booking, scongela chiamato (lock riuscito, booking mai inviato)", async () => {
    const client = mutationClient({ lockAvailability: vi.fn().mockResolvedValue({ nonDisponibili: [], congelati: [] }) });
    const result = await run({ mutationClient: client });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("lock_failed");
    expect(client.createBooking).not.toHaveBeenCalled();
    expect(client.unlockAvailability).toHaveBeenCalledTimes(1);
  });

  it("frozen adulto mancante e scongela stesso fallisce -> remote_state_unknown (non possiamo provare il rilascio)", async () => {
    const client = mutationClient({
      lockAvailability: vi.fn().mockResolvedValue({ nonDisponibili: [], congelati: [] }),
      unlockAvailability: vi.fn().mockRejectedValue(new Error("scongela down")),
    });
    const result = await run({ mutationClient: client });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("remote_state_unknown");
    expect(client.createBooking).not.toHaveBeenCalled();
  });

  it("completed richiamato restituisce esistente senza mutare", async () => {
    const repo = makeRepo(attempt({ status: "completed", medmar_id_prenotazione: "732162", medmar_numero: "AG1", final_total_cents: 1150 }));
    const client = mutationClient();
    const result = await run({ repo, mutationClient: client });
    expect(result.ok).toBe(true);
    expect(result.existing).toBe(true);
    expect(client.createBooking).not.toHaveBeenCalled();
  });

  it("in_progress blocca seconda richiesta", async () => {
    const repo = makeRepo(attempt({ status: "booking_started" }));
    const client = mutationClient();
    const result = await run({ repo, mutationClient: client });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("already_in_progress");
    expect(client.createBooking).not.toHaveBeenCalled();
  });

  it("booking network drop -> remote_state_unknown e nessun retry", async () => {
    const client = mutationClient({ createBooking: vi.fn().mockRejectedValue(new MedmarMutationRemoteUnknownError()) });
    const result = await run({ mutationClient: client });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("remote_state_unknown");
    expect(client.createBooking).toHaveBeenCalledTimes(1);
    expect(client.payManual).not.toHaveBeenCalled();
  });

  it("payment mismatch -> remote_state_unknown e non ripete manuale", async () => {
    const client = mutationClient({ payManual: vi.fn().mockResolvedValue({ id_prenotazione: "999", prezzo: "11.50", id_cliente: SESSION_CONTEXT.clienteId, id_modalita: "5", numero: "AG1" }) });
    const result = await run({ mutationClient: client });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("remote_state_unknown");
    expect(client.payManual).toHaveBeenCalledTimes(1);
    expect(client.createBooking).toHaveBeenCalledTimes(1);
  });

  it("remote_state_unknown esistente resta terminale: zero mutazioni alla seconda execute", async () => {
    const repo = makeRepo(attempt({ status: "remote_state_unknown", remote_state_unknown: true }));
    const client = mutationClient();
    const result = await run({ repo, mutationClient: client });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("remote_state_unknown");
    expect(client.lockAvailability).not.toHaveBeenCalled();
    expect(client.createBooking).not.toHaveBeenCalled();
    expect(client.payManual).not.toHaveBeenCalled();
  });

  it("booking_failed_definitive esistente -> manual_review, nessun retry silenzioso (Fase 2B.3)", async () => {
    const repo = makeRepo(attempt({ status: "booking_failed_definitive" }));
    const client = mutationClient();
    const result = await run({ repo, mutationClient: client });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("manual_review");
    expect(result.retry_allowed).toBe(false);
    expect(client.lockAvailability).not.toHaveBeenCalled();
    expect(client.createBooking).not.toHaveBeenCalled();
  });

  it("payment_failed_definitive esistente -> manual_review, nessun retry silenzioso (Fase 2B.3)", async () => {
    const repo = makeRepo(attempt({ status: "payment_failed_definitive" }));
    const client = mutationClient();
    const result = await run({ repo, mutationClient: client });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("manual_review");
    expect(result.retry_allowed).toBe(false);
    expect(client.lockAvailability).not.toHaveBeenCalled();
    expect(client.payManual).not.toHaveBeenCalled();
  });

  it("DB persist fallisce subito dopo booking Medmar riuscito -> remote_state_unknown, zero payment, seconda execute zero mutazioni", async () => {
    const repo = makeRepo();
    const client = mutationClient();
    const originalUpdate = repo.updateAttempt.bind(repo);
    vi.spyOn(repo, "updateAttempt").mockImplementation(async (id, patch, expectedStatus) => {
      if (patch && "medmar_id_prenotazione" in patch && patch.medmar_id_prenotazione) {
        throw new Error("db_down_after_booking_success");
      }
      return originalUpdate(id, patch, expectedStatus);
    });

    const result = await run({ repo, mutationClient: client });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("remote_state_unknown");
    expect(client.createBooking).toHaveBeenCalledTimes(1);
    expect(client.payManual).not.toHaveBeenCalled();

    const client2 = mutationClient();
    const result2 = await run({ repo, mutationClient: client2 });
    expect(result2.ok).toBe(false);
    expect(result2.status).toBe("remote_state_unknown");
    expect(client2.lockAvailability).not.toHaveBeenCalled();
    expect(client2.createBooking).not.toHaveBeenCalled();
    expect(client2.payManual).not.toHaveBeenCalled();
  });

  it("DB persist fallisce subito dopo pagamento Medmar riuscito -> remote_state_unknown, seconda execute zero mutazioni", async () => {
    const repo = makeRepo();
    const client = mutationClient();
    const originalUpdate = repo.updateAttempt.bind(repo);
    vi.spyOn(repo, "updateAttempt").mockImplementation(async (id, patch, expectedStatus) => {
      if (patch && "medmar_numero" in patch && patch.medmar_numero) {
        throw new Error("db_down_after_payment_success");
      }
      return originalUpdate(id, patch, expectedStatus);
    });

    const result = await run({ repo, mutationClient: client });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("remote_state_unknown");
    expect(client.createBooking).toHaveBeenCalledTimes(1);
    expect(client.payManual).toHaveBeenCalledTimes(1);

    const client2 = mutationClient();
    const result2 = await run({ repo, mutationClient: client2 });
    expect(result2.ok).toBe(false);
    expect(result2.status).toBe("remote_state_unknown");
    expect(client2.lockAvailability).not.toHaveBeenCalled();
    expect(client2.createBooking).not.toHaveBeenCalled();
    expect(client2.payManual).not.toHaveBeenCalled();
  });

  it("cliente_sito incompleto -> manual_review prima del lock, zero chiamate Medmar mutative", async () => {
    const repo = makeRepo();
    vi.spyOn(repo, "loadServices").mockResolvedValue([
      { id: SVC, tenant_id: TENANT, customer_name: "Mario Rossi", customer_email: "mario@example.test", customer_phone: null, pax: 1 },
    ]);
    const client = mutationClient();
    const result = await run({ repo, mutationClient: client });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("manual_review");
    expect(client.lockAvailability).not.toHaveBeenCalled();
  });

  it("Fase 2B.6 — 17/18/19/20. email tecnica Medmar non configurata -> fail-closed, ZERO resolveSessionContext/openTurn/lock/booking/payment, nessun attempt acquisito", async () => {
    delete process.env.MEDMAR_DELIVERY_EMAIL;
    const client = mutationClient();
    const repo = makeRepo();
    const acquireSpy = vi.spyOn(repo, "acquireAttempt");
    const resolveSessionContextSpy = vi.fn().mockResolvedValue({ ok: true, context: SESSION_CONTEXT });
    const result = await run({ mutationClient: client, repo, resolveSessionContext: resolveSessionContextSpy });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("medmar_delivery_email_not_configured");
    expect(acquireSpy).not.toHaveBeenCalled();
    expect(resolveSessionContextSpy).not.toHaveBeenCalled();
    expect(client.openTurn).not.toHaveBeenCalled();
    expect(client.lockAvailability).not.toHaveBeenCalled();
    expect(client.createBooking).not.toHaveBeenCalled();
    expect(client.payManual).not.toHaveBeenCalled();
  });

  it("Fase 2B.6 — 17/18/19/20. destinatario finale ITS irrisolvibile (cliente senza email, nessuna agenzia) -> fail-closed, ZERO openTurn/lock/booking/payment", async () => {
    const client = mutationClient();
    const repo = makeRepo();
    vi.spyOn(repo, "loadServices").mockResolvedValue([
      { id: SVC, tenant_id: TENANT, customer_name: "Mario Rossi", customer_email: null, customer_phone: "123456", pax: 1, agency_id: null },
    ]);
    const acquireSpy = vi.spyOn(repo, "acquireAttempt");
    const resolveSessionContextSpy = vi.fn().mockResolvedValue({ ok: true, context: SESSION_CONTEXT });
    const result = await run({ mutationClient: client, repo, resolveSessionContext: resolveSessionContextSpy });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("customer_recipient_email_missing");
    expect(acquireSpy).not.toHaveBeenCalled();
    expect(resolveSessionContextSpy).not.toHaveBeenCalled();
    expect(client.openTurn).not.toHaveBeenCalled();
    expect(client.lockAvailability).not.toHaveBeenCalled();
  });

  it("11/12/13. D'ADDIO: agenzia ALESTE VIAGGI con email -> final recipient agenzia, payload usa email tecnica, happy path invariato", async () => {
    const client = mutationClient();
    const repo = makeRepo();
    vi.spyOn(repo, "loadServices").mockResolvedValue([
      { id: SVC, tenant_id: TENANT, customer_name: "Gerardo D'Addio", customer_email: "gerardo.daddio@example.test", customer_phone: "3271152378", pax: 2, agency_id: "agency-aleste" },
    ]);
    const loadAgencyRecipientSpy = vi.fn().mockResolvedValue({ name: "ALESTE VIAGGI", email: "booking@alesteviaggi.test" });
    const { createMedmarIssueOrchestrator } = await import("@/lib/server/medmar-booking/issue-orchestrator");
    const result = await createMedmarIssueOrchestrator({
      repo,
      mutationClient: client,
      runPreflight: vi.fn().mockResolvedValue(preflight()),
      fetchVendibili: vi.fn().mockResolvedValue(vendibili()),
      resolveSessionContext: vi.fn().mockResolvedValue({ ok: true, context: SESSION_CONTEXT }),
      config: { enabled: true, causaleId: 1, modalitaId: 5, vettoreAndataId: 1, vettoreRitornoId: 1 },
      loadPassengerComposition: vi.fn().mockResolvedValue(passengerComposition({ adults: 2 })) as never,
      loadAgencyRecipient: loadAgencyRecipientSpy,
    })({ admin: {} as never, tenantId: TENANT, userId: USER, serviceIds: [SVC] });
    expect(result.ok).toBe(true);
    expect(loadAgencyRecipientSpy).toHaveBeenCalledWith({}, TENANT, "agency-aleste");
    const bookingPayload = (client.createBooking as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(bookingPayload.cliente_sito.email).toBe("info@ischiatransferservice.it");
    expect(bookingPayload.cliente_sito.email).not.toBe("gerardo.daddio@example.test");
    expect(bookingPayload.cliente_sito.email).not.toBe("booking@alesteviaggi.test");
  });

  it("tassa di sbarco con id_tipologia_passeggero diverso da 32 -> manual_review, zero lock (fail-closed)", async () => {
    const repo = makeRepo();
    const client = mutationClient();
    const vendibiliConTassaErrata = () => [
      ...vendibili(),
      {
        id_corsa: 131943,
        id_biglietto: 371,
        id_tipologia_passeggero: 99,
        id_tariffa: 7,
        id_iva: 78,
        id_log: 58819,
        nome: "TASSA DI SBARCO",
        descrizione: "TASSA DI SBARCO",
        prezzo: 1.5,
        prezzo_ar: 0,
        prezzo_prevendita: 0,
        flag_ar_obbligatorio: true,
        flag_targa: 0,
        quantita_min_per_esclusivo: null,
        quantita_max_per_esclusivo: null,
      },
    ];
    const { createMedmarIssueOrchestrator } = await import("@/lib/server/medmar-booking/issue-orchestrator");
    const result = await createMedmarIssueOrchestrator({
      repo,
      mutationClient: client,
      runPreflight: vi.fn().mockResolvedValue(preflight()),
      fetchVendibili: vi.fn().mockResolvedValue(vendibiliConTassaErrata()),
      resolveSessionContext: vi.fn().mockResolvedValue({ ok: true, context: SESSION_CONTEXT }),
      config: { enabled: true, causaleId: 1, modalitaId: 5, vettoreAndataId: 1, vettoreRitornoId: 1 },
      loadPassengerComposition: vi.fn().mockResolvedValue(passengerComposition()) as never,
    })({ admin: {} as never, tenantId: TENANT, userId: USER, serviceIds: [SVC] });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("manual_review");
    expect(client.lockAvailability).not.toHaveBeenCalled();
  });
});
