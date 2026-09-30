/**
 * Emissione Medmar dallo stato incerto: remote_state_unknown, manual_review,
 * terminali *_failed_definitive e stati intermedi abbandonati dopo la prima
 * mutazione remota (lock_started e successivi) bloccano una nuova emissione
 * con 409 medmar_issuance_requires_review, anche con il lock di concorrenza
 * scaduto e per gruppi diversi che condividono il servizio.
 * Route reale POST /api/services/medmar-issue; lock (0288) e storico
 * attempt simulati in memoria.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  MEDMAR_ATTEMPT_LIVE_WINDOW_MS,
  MEDMAR_REQUIRES_REVIEW_MESSAGE,
  classifyMedmarAttempt,
  evaluateMedmarIssuanceRequest,
  resolveMedmarQueueIssuanceView,
} from "@/lib/medmar-issuance-guard";
import { MEDMAR_ISSUANCE_LOCK_TTL_SECONDS } from "@/lib/server/medmar-booking/issuance-lock";

type Row = Record<string, unknown>;

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

const mocks = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  orchestrator: vi.fn(),
  consumeConfirmationToken: vi.fn(),
  deliver: vi.fn(),
}));

class FakeQuery implements PromiseLike<{ data: unknown; error: null }> {
  private filters: Array<(r: Row) => boolean> = [];
  constructor(private table: string) {}
  select() { return this; }
  eq(c: string, v: unknown) { this.filters.push((r) => r[c] === v); return this; }
  in(c: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[c])); return this; }
  overlaps(c: string, vs: unknown[]) { this.filters.push((r) => ((r[c] as unknown[]) ?? []).some((x) => vs.includes(x))); return this; }
  then<T1, T2>(ok?: ((v: { data: unknown; error: null }) => T1 | PromiseLike<T1>) | null, ko?: ((e: unknown) => T2 | PromiseLike<T2>) | null) {
    return Promise.resolve()
      .then(() => ({ data: (mocks.db[this.table] ?? []).filter((r) => this.filters.every((f) => f(r))), error: null }))
      .then(ok, ko);
  }
}

let tokenSeq = 0;
const admin = {
  from: (t: string) => new FakeQuery(t),
  rpc: async (name: string, args: Row) => {
    await Promise.resolve();
    const locks = mocks.db.medmar_service_issuance_locks;
    if (name === "acquire_medmar_service_issuance_locks") {
      const now = Date.now();
      const ids = Array.from(new Set(args.p_service_ids as string[])).sort();
      mocks.db.medmar_service_issuance_locks = locks.filter((l) => !(ids.includes(l.service_id as string) && (l.expires_at as number) <= now));
      const conflicts = ids.filter((id) => mocks.db.medmar_service_issuance_locks.some((l) => l.tenant_id === args.p_tenant_id && l.service_id === id));
      if (conflicts.length) return { data: [{ acquired: false, lock_token: null, conflicting_service_ids: conflicts, expires_at: null }], error: null };
      const token = `tok-${++tokenSeq}`;
      for (const id of ids) mocks.db.medmar_service_issuance_locks.push({ tenant_id: args.p_tenant_id, service_id: id, lock_token: token, expires_at: now + 900_000 });
      return { data: [{ acquired: true, lock_token: token, conflicting_service_ids: [], expires_at: null }], error: null };
    }
    if (name === "release_medmar_service_issuance_locks") {
      mocks.db.medmar_service_issuance_locks = locks.filter((l) => l.lock_token !== args.p_lock_token);
      return { data: 1, error: null };
    }
    throw new Error(`rpc ${name} non simulata`);
  },
};

vi.mock("@/lib/server/pricing-auth", () => ({
  authorizePricingRequest: vi.fn(async () => ({
    admin,
    user: { id: "99999999-9999-4999-8999-999999999999", email: "op@example.com" },
    membership: { tenant_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", role: "operator", suspended: false },
  })),
}));
vi.mock("@/lib/server/ops-audit", () => ({ auditLog: vi.fn() }));
vi.mock("@/lib/server/medmar-booking/issue-confirmation", () => ({
  consumeConfirmationToken: mocks.consumeConfirmationToken,
  MedmarConfirmationInvalidError: class extends Error {},
}));
vi.mock("@/lib/server/medmar-booking/issue-orchestrator", () => ({
  createMedmarIssueOrchestrator: () => mocks.orchestrator,
}));
vi.mock("@/lib/server/medmar-booking/pdf-delivery", () => ({ deliverMedmarTicketWithTimeout: mocks.deliver }));

import { POST as issuePOST } from "@/app/api/services/medmar-issue/route";

const OLD = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2 ore fa: abbandonato
const FRESH = () => new Date(Date.now() - 30 * 1000).toISOString(); // 30s fa: potenzialmente vivo

function attempt(id: string, serviceIds: string[], status: string, extra: Row = {}): Row {
  return {
    id, tenant_id: TENANT, service_ids: serviceIds, status, remote_state_unknown: status === "remote_state_unknown",
    medmar_numero: status === "completed" ? "MM1" : null, medmar_id_prenotazione: status === "completed" ? "P1" : null,
    final_total_cents: status === "completed" ? 5000 : null,
    completed_at: status === "completed" ? OLD : null, updated_at: OLD, ...extra,
  };
}

function issue(serviceIds: string[]) {
  return issuePOST(new NextRequest("http://localhost/api/services/medmar-issue", {
    method: "POST",
    headers: { authorization: "Bearer t", "content-type": "application/json" },
    body: JSON.stringify({ service_ids: serviceIds, confirmation_token: "confirm-token-1" }),
  }));
}

async function expectRequiresReview(serviceIds: string[]) {
  const locksBefore = [...mocks.db.medmar_service_issuance_locks];
  const res = await issue(serviceIds);
  const body = await res.json();
  expect(res.status).toBe(409);
  expect(body).toMatchObject({ ok: false, status: "requires_review", code: "medmar_issuance_requires_review", error: MEDMAR_REQUIRES_REVIEW_MESSAGE, retry_allowed: false });
  expect(mocks.consumeConfirmationToken).not.toHaveBeenCalled();
  expect(mocks.orchestrator).not.toHaveBeenCalled();
  // Nessun lock nuovo né residuo (un eventuale lock morto preesistente resta
  // com'era: verrà recuperato alla prossima acquisizione).
  expect(mocks.db.medmar_service_issuance_locks).toEqual(locksBefore);
  return body;
}

beforeEach(() => {
  tokenSeq = 0;
  mocks.db = {
    services: [A, B, C].map((id) => ({ id, tenant_id: TENANT, medmar_ticket_sent_at: null })),
    medmar_issuing_attempts: [],
    status_events: [],
    medmar_service_issuance_locks: [],
  };
  mocks.orchestrator.mockReset().mockResolvedValue({ ok: false, status: "preflight_failed", error: "stub", retry_allowed: true });
  mocks.consumeConfirmationToken.mockReset().mockResolvedValue(undefined);
  mocks.deliver.mockReset().mockResolvedValue({ status: "delivered", warning: null, recipient_email: "a@b.it" });
});

describe("stati incerti -> requires_review (route /medmar-issue, chiamata diretta)", () => {
  it("A: remote_state_unknown -> 409, nessuna chiamata Medmar", async () => {
    mocks.db.medmar_issuing_attempts.push(attempt("att-1", [A], "remote_state_unknown"));
    const body = await expectRequiresReview([A]);
    expect(body.prior_issuance[0].uncertain_attempts[0]).toMatchObject({ id: "att-1", status: "remote_state_unknown" });
  });

  it("A: flag remote_state_unknown=true su uno stato altrimenti sicuro -> 409", async () => {
    mocks.db.medmar_issuing_attempts.push(attempt("att-1", [A], "lock_failed", { remote_state_unknown: true }));
    await expectRequiresReview([A]);
  });

  it("B: manual_review -> 409", async () => {
    mocks.db.medmar_issuing_attempts.push(attempt("att-1", [A], "manual_review"));
    await expectRequiresReview([A]);
  });

  it.each(["booking_failed_definitive", "payment_failed_definitive"])("B: %s (dopo il lock, posti forse congelati) -> 409", async (status) => {
    mocks.db.medmar_issuing_attempts.push(attempt("att-1", [A], status));
    await expectRequiresReview([A]);
  });

  it.each(["preflight_started", "preflight_ok", "preflight_failed", "lock_failed"])(
    "C: '%s' (prima di qualunque mutazione su posti/prenotazioni, o fallimento sicuro) -> consentito",
    async (status) => {
      mocks.db.medmar_issuing_attempts.push(attempt("att-1", [A, B], status));
      const res = await issue([A]);
      expect(res.status).toBe(422); // esito dell'orchestratore finto: è stato chiamato
      expect(mocks.orchestrator).toHaveBeenCalledTimes(1);
    }
  );

  it.each(["lock_started", "locked", "booking_started", "booked", "payment_started", "paid", "unlock_started"])(
    "D: '%s' abbandonato (dopo l'inizio della mutazione remota, mai completato) -> 409 da verificare",
    async (status) => {
      mocks.db.medmar_issuing_attempts.push(attempt("att-1", [A], status));
      await expectRequiresReview([A]);
    }
  );

  it("D: stato intermedio recente (emissione forse ancora viva) -> 409 'in corso', nessuna chiamata Medmar", async () => {
    mocks.db.medmar_issuing_attempts.push(attempt("att-1", [A, B], "booking_started", { updated_at: FRESH() }));
    const res = await issue([A]);
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body).toMatchObject({ status: "issuance_in_progress", code: "medmar_issuance_in_progress", retry_allowed: true });
    expect(mocks.orchestrator).not.toHaveBeenCalled();
  });

  it("E: lock scaduto + remote_state_unknown -> comunque bloccato", async () => {
    mocks.db.medmar_service_issuance_locks.push({ tenant_id: TENANT, service_id: A, lock_token: "dead", expires_at: Date.now() - 1000 });
    mocks.db.medmar_issuing_attempts.push(attempt("att-1", [A], "remote_state_unknown"));
    await expectRequiresReview([A]);
  });

  it("E: lock scaduto + stato intermedio abbandonato (crash a metà) -> bloccato", async () => {
    mocks.db.medmar_service_issuance_locks.push({ tenant_id: TENANT, service_id: A, lock_token: "dead", expires_at: Date.now() - 1000 });
    mocks.db.medmar_issuing_attempts.push(attempt("att-1", [A, B], "booked"));
    await expectRequiresReview([A, C]);
  });

  it("F: lock scaduto + fallimento definitivo sicuro (lock_failed) -> consentito, lock liberato", async () => {
    mocks.db.medmar_service_issuance_locks.push({ tenant_id: TENANT, service_id: A, lock_token: "dead", expires_at: Date.now() - 1000 });
    mocks.db.medmar_issuing_attempts.push(attempt("att-1", [A], "lock_failed"));
    const res = await issue([A]);
    expect(res.status).toBe(422);
    expect(mocks.orchestrator).toHaveBeenCalledTimes(1);
    expect(mocks.db.medmar_service_issuance_locks).toHaveLength(0);
  });

  it("G: gruppo diverso con service_id in stato incerto -> bloccato", async () => {
    mocks.db.medmar_issuing_attempts.push(attempt("att-1", [A, B], "remote_state_unknown"));
    const body = await expectRequiresReview([A, C]);
    expect(body.blocking_service_ids).toEqual([A]);
  });

  it("H: replay dello stesso gruppo completed -> invariato (fast-path orchestratore)", async () => {
    mocks.db.medmar_issuing_attempts.push(attempt("att-AB", [A, B], "completed"));
    // Un tentativo fallito in modo sicuro sullo stesso gruppo non cambia nulla.
    mocks.db.medmar_issuing_attempts.push(attempt("att-old", [A, B], "preflight_failed"));
    mocks.orchestrator.mockResolvedValueOnce({
      ok: true, status: "completed", idempotency_key: "k", attempt_id: "att-AB",
      medmar_id_prenotazione: "P1", medmar_numero: "MM1", final_total_cents: 5000, existing: true,
    });
    const res = await issue([B, A]);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: "completed", existing: true });
    expect(mocks.orchestrator).toHaveBeenCalledTimes(1);
  });

  it("stato incerto prevale sul replay idempotente dello stesso gruppo", async () => {
    mocks.db.medmar_issuing_attempts.push(attempt("att-AB", [A, B], "completed"));
    mocks.db.medmar_issuing_attempts.push(attempt("att-A", [A], "remote_state_unknown"));
    await expectRequiresReview([A, B]);
  });
});

describe("classificazione e UI", () => {
  it("finestra 'in corso' = TTL del lock (unica sorgente)", () => {
    expect(MEDMAR_ISSUANCE_LOCK_TTL_SECONDS * 1000).toBe(MEDMAR_ATTEMPT_LIVE_WINDOW_MS);
    const now = Date.parse("2026-09-30T12:00:00Z");
    expect(classifyMedmarAttempt({ status: "locked", updated_at: "2026-09-30T11:50:00Z" }, now)).toBe("in_progress");
    expect(classifyMedmarAttempt({ status: "locked", updated_at: "2026-09-30T11:44:00Z" }, now)).toBe("requires_review");
    expect(classifyMedmarAttempt({ status: "locked", updated_at: null }, now)).toBe("requires_review");
    expect(classifyMedmarAttempt({ status: "stato_nuovo_sconosciuto" }, now)).toBe("requires_review");
    expect(classifyMedmarAttempt({ status: "preflight_ok" }, now)).toBe("safe");
    expect(classifyMedmarAttempt({ status: "completed" }, now)).toBe("issued");
  });

  it("UI: stato incerto -> '⚠ EMISSIONE MEDMAR DA VERIFICARE', nessuna emissione, sempre visibile", () => {
    const decision = evaluateMedmarIssuanceRequest([A], {
      [A]: {
        service_id: A, ticket_sent_at: null, completed_attempts: [], cancelled_after_issuance: false,
        uncertain_attempts: [{ id: "x", status: "manual_review", service_ids: [A], updated_at: OLD, remote_state_unknown: false }],
      },
    });
    expect(resolveMedmarQueueIssuanceView(decision)).toEqual({
      issueAllowed: false,
      warningTitle: "⚠ EMISSIONE MEDMAR DA VERIFICARE",
      warningDetail: "Una precedente emissione potrebbe essere arrivata a Medmar. Verificare prima di procedere.",
      shortLabel: "Da verificare",
      forceVisible: true,
    });
  });
});
