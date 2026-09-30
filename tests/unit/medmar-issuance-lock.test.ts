/**
 * Lock di concorrenza emissione Medmar (tenant_id + service_id, migration
 * 0288) sulla route POST /api/services/medmar-issue.
 *
 * Le RPC acquire/release sono rispecchiate in TypeScript (atomiche: il corpo
 * gira in un unico blocco sincrono, come una transazione). La semantica SQL
 * reale — attesa sul commit, nessun deadlock con ordini opposti, una sola
 * vincente su 8 connessioni simultanee — è verificata a parte con sessioni
 * psql separate su Postgres locale.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { MEDMAR_ALREADY_ISSUED_MESSAGE } from "@/lib/medmar-issuance-guard";
import { MEDMAR_ISSUANCE_LOCK_BUSY_MESSAGE } from "@/lib/server/medmar-booking/issuance-lock";

type Row = Record<string, unknown>;

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_TENANT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const D = "44444444-4444-4444-8444-444444444444";

const mocks = vi.hoisted(() => ({
  tenant: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  db: {} as Record<string, Row[]>,
  rpcFail: false,
  afterAcquire: null as null | (() => void),
  orchestrator: vi.fn(),
  consumeConfirmationToken: vi.fn(),
  deliver: vi.fn(),
  locksAtDelivery: -1,
}));

let tokenSeq = 0;
const newToken = () => `tok-${++tokenSeq}`;

function fakeAcquire(args: Row) {
  const now = Date.now();
  const tenant = args.p_tenant_id as string;
  const ids = Array.from(new Set(args.p_service_ids as string[])).sort();
  const token = newToken();
  const inserted: Row[] = [];
  const conflicts: string[] = [];
  for (const id of ids) {
    // stale recovery
    mocks.db.medmar_service_issuance_locks = mocks.db.medmar_service_issuance_locks.filter((l) => !(l.tenant_id === tenant && l.service_id === id && (l.expires_at as number) <= now));
    const table = mocks.db.medmar_service_issuance_locks;
    if (table.some((l) => l.tenant_id === tenant && l.service_id === id)) {
      conflicts.push(id);
      continue;
    }
    const row = { tenant_id: tenant, service_id: id, lock_token: token, holder: args.p_holder, expires_at: now + (args.p_ttl_seconds as number) * 1000 };
    table.push(row);
    inserted.push(row);
  }
  if (conflicts.length) {
    mocks.db.medmar_service_issuance_locks = mocks.db.medmar_service_issuance_locks.filter((l) => l.lock_token !== token);
    return [{ acquired: false, lock_token: null, conflicting_service_ids: conflicts, expires_at: null }];
  }
  mocks.afterAcquire?.();
  return [{ acquired: true, lock_token: token, conflicting_service_ids: [], expires_at: new Date(now + 900_000).toISOString() }];
}

function fakeRelease(args: Row) {
  const before = mocks.db.medmar_service_issuance_locks.length;
  mocks.db.medmar_service_issuance_locks = mocks.db.medmar_service_issuance_locks.filter(
    (l) => !(l.tenant_id === args.p_tenant_id && l.lock_token === args.p_lock_token)
  );
  return before - mocks.db.medmar_service_issuance_locks.length;
}

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

const admin = {
  from: (t: string) => new FakeQuery(t),
  rpc: async (name: string, args: Row) => {
    await Promise.resolve();
    if (mocks.rpcFail) return { data: null, error: { message: "connection reset" } };
    if (name === "acquire_medmar_service_issuance_locks") return { data: fakeAcquire(args), error: null };
    if (name === "release_medmar_service_issuance_locks") return { data: fakeRelease(args), error: null };
    throw new Error(`rpc ${name} non simulata`);
  },
};

vi.mock("@/lib/server/pricing-auth", () => ({
  authorizePricingRequest: vi.fn(async () => ({
    admin,
    user: { id: "99999999-9999-4999-8999-999999999999", email: "op@example.com" },
    membership: { tenant_id: mocks.tenant, role: "operator", suspended: false },
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

const locks = () => mocks.db.medmar_service_issuance_locks;

function issue(serviceIds: string[]) {
  return issuePOST(new NextRequest("http://localhost/api/services/medmar-issue", {
    method: "POST",
    headers: { authorization: "Bearer t", "content-type": "application/json" },
    body: JSON.stringify({ service_ids: serviceIds, confirmation_token: "confirm-token-1" }),
  }));
}

/** Orchestratore "in corso": resta sospeso finché il test non chiama release(). */
function holdOrchestrator() {
  let release!: (value: unknown) => void;
  const pending = new Promise((resolve) => { release = resolve; });
  mocks.orchestrator.mockImplementationOnce(async () => {
    await pending;
    return { ok: false, status: "preflight_failed", error: "stub", retry_allowed: true };
  });
  return () => release(undefined);
}

async function flush() {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function completedAttempt(serviceIds: string[]): Row {
  return {
    id: `att-${serviceIds.join("-")}`, tenant_id: mocks.tenant, service_ids: serviceIds, status: "completed",
    medmar_numero: "MM1", medmar_id_prenotazione: "P1", final_total_cents: 5000,
    completed_at: "2026-09-01T10:00:00.000Z", updated_at: "2026-09-01T10:00:00.000Z",
  };
}

beforeEach(() => {
  tokenSeq = 0;
  mocks.tenant = TENANT;
  mocks.rpcFail = false;
  mocks.afterAcquire = null;
  mocks.locksAtDelivery = -1;
  mocks.db = {
    services: [A, B, C, D].flatMap((id) => [
      { id, tenant_id: TENANT, medmar_ticket_sent_at: null },
      { id, tenant_id: OTHER_TENANT, medmar_ticket_sent_at: null },
    ]),
    medmar_issuing_attempts: [],
    status_events: [],
    medmar_service_issuance_locks: [],
  };
  mocks.orchestrator.mockReset().mockResolvedValue({ ok: false, status: "preflight_failed", error: "stub", retry_allowed: true });
  mocks.consumeConfirmationToken.mockReset().mockResolvedValue(undefined);
  mocks.deliver.mockReset().mockImplementation(async () => {
    mocks.locksAtDelivery = locks().length;
    return { status: "delivered", warning: null, recipient_email: "a@b.it" };
  });
});

describe("lock di concorrenza emissione Medmar", () => {
  it("A: [A,B] in corso + nuova [A] -> 409, nessuna seconda chiamata Medmar", async () => {
    const release = holdOrchestrator();
    const first = issue([A, B]);
    await flush();
    expect(locks().map((l) => l.service_id).sort()).toEqual([A, B]);

    const second = await issue([A]);
    const body = await second.json();
    expect(second.status).toBe(409);
    expect(body).toMatchObject({ ok: false, status: "issuance_in_progress", code: "medmar_issuance_locked", error: MEDMAR_ISSUANCE_LOCK_BUSY_MESSAGE, conflicting_service_ids: [A] });
    expect(mocks.orchestrator).toHaveBeenCalledTimes(1);
    expect(mocks.consumeConfirmationToken).toHaveBeenCalledTimes(1);

    release();
    await first;
    expect(locks()).toHaveLength(0);
  });

  it("B: [A] in corso + nuova [A,C] -> 409 e nessun lock residuo su C (E: niente lock parziali)", async () => {
    const release = holdOrchestrator();
    const first = issue([A]);
    await flush();
    const second = await issue([C, A]);
    expect(second.status).toBe(409);
    expect(locks().map((l) => l.service_id)).toEqual([A]);
    release();
    await first;
    expect(locks()).toHaveLength(0);
  });

  it("C: [A,B] e [C,D] in parallelo -> entrambe procedono", async () => {
    const releaseAB = holdOrchestrator();
    const releaseCD = holdOrchestrator();
    const ab = issue([A, B]);
    const cd = issue([C, D]);
    await flush();
    expect(locks()).toHaveLength(4);
    expect(mocks.orchestrator).toHaveBeenCalledTimes(2);
    releaseAB();
    releaseCD();
    const [r1, r2] = await Promise.all([ab, cd]);
    expect([r1.status, r2.status]).toEqual([422, 422]);
    expect(locks()).toHaveLength(0);
  });

  it("D: due richieste simultanee per [A] (Promise.all) -> una sola arriva all'orchestratore", async () => {
    const release = holdOrchestrator();
    const both = Promise.all([issue([A]), issue([A])]);
    await flush();
    release();
    const responses = await both;
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses).toEqual([409, 422]);
    expect(mocks.orchestrator).toHaveBeenCalledTimes(1);
    expect(mocks.consumeConfirmationToken).toHaveBeenCalledTimes(1);
    expect(locks()).toHaveLength(0);
  });

  it("F: lock scaduto (istanza terminata senza rilascio) -> nuova emissione consentita", async () => {
    locks().push({ tenant_id: TENANT, service_id: A, lock_token: "crashed", holder: "dead", expires_at: Date.now() - 1000 });
    const res = await issue([A]);
    expect(res.status).toBe(422);
    expect(mocks.orchestrator).toHaveBeenCalledTimes(1);
    expect(locks()).toHaveLength(0);
  });

  it("lock NON scaduto di un'istanza viva -> 409", async () => {
    locks().push({ tenant_id: TENANT, service_id: A, lock_token: "alive", holder: "other", expires_at: Date.now() + 60_000 });
    expect((await issue([A])).status).toBe(409);
    expect(mocks.orchestrator).not.toHaveBeenCalled();
    expect(locks()).toHaveLength(1);
  });

  it("G: tenant diversi sullo stesso service_id -> nessuna interferenza", async () => {
    locks().push({ tenant_id: OTHER_TENANT, service_id: A, lock_token: "other-tenant", holder: "x", expires_at: Date.now() + 60_000 });
    const res = await issue([A]);
    expect(res.status).toBe(422);
    expect(mocks.orchestrator).toHaveBeenCalledTimes(1);
    expect(locks()).toEqual([expect.objectContaining({ tenant_id: OTHER_TENANT, lock_token: "other-tenant" })]);
  });

  it("H: dopo errore definitivo / eccezione / token rifiutato -> lock liberato", async () => {
    mocks.orchestrator.mockResolvedValueOnce({ ok: false, status: "manual_review", error: "x", retry_allowed: false });
    expect((await issue([A])).status).toBe(422);
    expect(locks()).toHaveLength(0);

    mocks.orchestrator.mockRejectedValueOnce(new Error("boom"));
    expect((await issue([A])).status).toBe(500);
    expect(locks()).toHaveLength(0);

    mocks.consumeConfirmationToken.mockRejectedValueOnce(new Error("expired"));
    expect((await issue([A])).status).toBe(409);
    expect(locks()).toHaveLength(0);
  });

  it("I: dopo completed -> lock liberato prima dell'invio automatico", async () => {
    mocks.orchestrator.mockResolvedValueOnce({
      ok: true, status: "completed", idempotency_key: "k", attempt_id: "att-1",
      medmar_id_prenotazione: "P1", medmar_numero: "MM1", final_total_cents: 5000,
    });
    const res = await issue([A, B]);
    expect(res.status).toBe(200);
    expect(mocks.locksAtDelivery).toBe(0);
    expect(locks()).toHaveLength(0);
  });

  it("J: emissione completata da un concorrente tra il primo controllo e il lock -> 409 già emesso, nessuna chiamata Medmar", async () => {
    mocks.afterAcquire = () => { mocks.db.medmar_issuing_attempts.push(completedAttempt([A, C])); };
    const res = await issue([A]);
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body).toMatchObject({ status: "already_issued", error: MEDMAR_ALREADY_ISSUED_MESSAGE });
    expect(mocks.consumeConfirmationToken).not.toHaveBeenCalled();
    expect(mocks.orchestrator).not.toHaveBeenCalled();
    expect(locks()).toHaveLength(0);
  });

  it("K: replay identico di un gruppo già completed -> invariato (fast-path orchestratore), lock liberato", async () => {
    mocks.db.medmar_issuing_attempts.push(completedAttempt([A, B]));
    mocks.orchestrator.mockResolvedValueOnce({
      ok: true, status: "completed", idempotency_key: "medmar_passenger_ar:A,B", attempt_id: "att-A-B",
      medmar_id_prenotazione: "P1", medmar_numero: "MM1", final_total_cents: 5000, existing: true,
    });
    const res = await issue([B, A]);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, status: "completed", existing: true });
    expect(mocks.orchestrator).toHaveBeenCalledTimes(1);
    expect(locks()).toHaveLength(0);
  });

  it("gruppo diverso con servizio già emesso -> bloccato dal prior-issuance PRIMA del lock", async () => {
    mocks.db.medmar_issuing_attempts.push(completedAttempt([A, B]));
    const res = await issue([A]);
    expect(res.status).toBe(409);
    expect((await res.json()).status).toBe("already_issued");
    expect(locks()).toHaveLength(0);
    expect(mocks.orchestrator).not.toHaveBeenCalled();
  });

  it("RPC lock non disponibile -> 503 fail-closed, nessuna emissione", async () => {
    mocks.rpcFail = true;
    const res = await issue([A]);
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("medmar_issuance_lock_unavailable");
    expect(mocks.orchestrator).not.toHaveBeenCalled();
  });
});
