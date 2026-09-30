/**
 * Guard "biglietto Medmar già emesso": regola pura (lib/medmar-issuance-guard.ts),
 * loader delle prove (lib/server/medmar-booking/prior-issuance.ts) e blocco
 * server-side sulle route preflight / prepare / issue (chiamate dirette,
 * senza UI).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import {
  MEDMAR_ALREADY_ISSUED_MESSAGE,
  evaluateMedmarIssuanceRequest,
  resolveMedmarQueueIssuanceView,
  type MedmarServiceIssuanceEvidence,
} from "@/lib/medmar-issuance-guard";

type Row = Record<string, unknown>;

const mocks = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  failTable: null as string | null,
  consumeConfirmationToken: vi.fn(),
  orchestratorIssue: vi.fn(),
  runMedmarPreflight: vi.fn(),
  deliver: vi.fn(),
}));

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

class FakeQuery implements PromiseLike<{ data: unknown; error: { message: string } | null }> {
  private filters: Array<(r: Row) => boolean> = [];
  constructor(private table: string) {}
  select() { return this; }
  eq(c: string, v: unknown) { this.filters.push((r) => r[c] === v); return this; }
  in(c: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[c])); return this; }
  overlaps(c: string, vs: unknown[]) { this.filters.push((r) => ((r[c] as unknown[]) ?? []).some((x) => vs.includes(x))); return this; }
  then<T1, T2>(ok?: ((v: { data: unknown; error: { message: string } | null }) => T1 | PromiseLike<T1>) | null, ko?: ((e: unknown) => T2 | PromiseLike<T2>) | null) {
    return Promise.resolve().then(() => {
      if (mocks.failTable === this.table) return { data: null, error: { message: "boom" } };
      return { data: (mocks.db[this.table] ?? []).filter((r) => this.filters.every((f) => f(r))), error: null };
    }).then(ok, ko);
  }
}
const admin = {
  from: (t: string) => new FakeQuery(t),
  // Lock di concorrenza (0288) sempre libero qui: coperto da medmar-issuance-lock.test.ts.
  rpc: async (name: string) => (name === "acquire_medmar_service_issuance_locks"
    ? { data: [{ acquired: true, lock_token: "lock-1", conflicting_service_ids: [], expires_at: null }], error: null }
    : { data: 1, error: null }),
};

vi.mock("@/lib/server/pricing-auth", () => ({
  authorizePricingRequest: vi.fn(async () => ({
    admin,
    user: { id: "99999999-9999-4999-8999-999999999999", email: "op@example.com" },
    membership: { tenant_id: TENANT, role: "operator", suspended: false },
  })),
}));
vi.mock("@/lib/server/ops-audit", () => ({ auditLog: vi.fn() }));
vi.mock("@/lib/server/medmar-booking/issue-confirmation", () => ({
  consumeConfirmationToken: mocks.consumeConfirmationToken,
  createConfirmationToken: vi.fn(),
  MedmarConfirmationInvalidError: class extends Error {},
}));
vi.mock("@/lib/server/medmar-booking/issue-orchestrator", () => ({
  createMedmarIssueOrchestrator: () => mocks.orchestratorIssue,
}));
vi.mock("@/lib/server/medmar-booking/pdf-delivery", () => ({ deliverMedmarTicketWithTimeout: mocks.deliver }));
vi.mock("@/lib/server/medmar-booking/preflight", () => ({ runMedmarPreflight: mocks.runMedmarPreflight }));

import { loadMedmarIssuanceEvidence } from "@/lib/server/medmar-booking/prior-issuance";
import { POST as issuePOST } from "@/app/api/services/medmar-issue/route";
import { POST as preparePOST } from "@/app/api/services/medmar-issue/prepare/route";
import { POST as preflightPOST } from "@/app/api/services/medmar-preflight/route";

function attempt(id: string, serviceIds: string[], status: string, extra: Row = {}): Row {
  return {
    id, tenant_id: TENANT, service_ids: serviceIds, status,
    medmar_numero: "MM1", medmar_id_prenotazione: "P1", final_total_cents: 5000,
    completed_at: "2026-09-01T10:00:00.000Z", updated_at: "2026-09-01T10:00:00.000Z", ...extra,
  };
}

function service(id: string, sentAt: string | null = null): Row {
  return { id, tenant_id: TENANT, medmar_ticket_sent_at: sentAt };
}

function req(url: string, body: unknown) {
  return new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: { authorization: "Bearer t", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mocks.failTable = null;
  mocks.db = { services: [service(A), service(B), service(C)], medmar_issuing_attempts: [], status_events: [] };
  mocks.consumeConfirmationToken.mockReset().mockResolvedValue(undefined);
  mocks.orchestratorIssue.mockReset().mockResolvedValue({ ok: false, status: "manual_review", error: "stub", retry_allowed: false });
  mocks.runMedmarPreflight.mockReset().mockResolvedValue({ ok: false, status: "not_ready", can_issue: false, is_live: false });
  mocks.deliver.mockReset();
});

async function evidenceFor(ids: string[]) {
  return loadMedmarIssuanceEvidence(admin as never, TENANT, ids);
}

describe("regola 'già emesso' (loader + decisione)", () => {
  it("A: medmar_ticket_sent_at valorizzato (senza attempt) -> emissione bloccata", async () => {
    mocks.db.services[0] = service(A, "2026-09-02T10:00:00.000Z");
    const decision = evaluateMedmarIssuanceRequest([A], await evidenceFor([A]));
    expect(decision).toMatchObject({ blocked: true, reason: "already_issued", blocking_service_ids: [A] });
  });

  it("B: attempt completato + sent_at NULL, raggruppamento diverso -> bloccata", async () => {
    mocks.db.medmar_issuing_attempts.push(attempt("att-1", [A, B], "completed"));
    // [A] da solo dopo un'emissione [A,B]: chiave idempotenza diversa -> sarebbe una seconda emissione.
    expect(evaluateMedmarIssuanceRequest([A], await evidenceFor([A])).blocked).toBe(true);
    // A raggruppato con un altro servizio.
    expect(evaluateMedmarIssuanceRequest([A, C], await evidenceFor([A, C])).blocked).toBe(true);
  });

  it("B: stesso gruppo già completato ma cancellato DOPO l'emissione -> bloccata", async () => {
    mocks.db.medmar_issuing_attempts.push(attempt("att-1", [A], "completed"));
    mocks.db.status_events.push({ tenant_id: TENANT, service_id: A, status: "cancelled", at: "2026-09-05T08:00:00.000Z" });
    const decision = evaluateMedmarIssuanceRequest([A], await evidenceFor([A]));
    expect(decision).toMatchObject({ blocked: true, cancelled_after_issuance: true });
  });

  it("stesso gruppo già completato, mai cancellato -> replay idempotente consentito (nessuna nuova emissione)", async () => {
    mocks.db.medmar_issuing_attempts.push(attempt("att-1", [A, B], "completed"));
    // Cancellazione PRIMA dell'emissione: non conta.
    mocks.db.status_events.push({ tenant_id: TENANT, service_id: A, status: "cancelled", at: "2026-08-01T08:00:00.000Z" });
    const decision = evaluateMedmarIssuanceRequest([B, A], await evidenceFor([A, B]));
    expect(decision).toMatchObject({ blocked: false, reason: "idempotent_replay" });
  });

  it("attempt 'completed' senza numero/id Medmar -> l'orchestratore non lo riuserebbe -> bloccata", async () => {
    mocks.db.medmar_issuing_attempts.push(attempt("att-1", [A], "completed", { medmar_numero: null }));
    expect(evaluateMedmarIssuanceRequest([A], await evidenceFor([A])).blocked).toBe(true);
  });

  // Solo gli stati precedenti a qualunque mutazione remota o i fallimenti
  // sicuri non bloccano; gli stati incerti sono coperti da medmar-uncertain-issuance.test.ts.
  it.each([
    "preflight_started", "preflight_ok", "preflight_failed", "lock_failed",
  ])("C: attempt '%s' (sicuro) -> non è prova, emissione consentita dal guard", async (status) => {
    mocks.db.medmar_issuing_attempts.push(attempt("att-x", [A], status));
    const decision = evaluateMedmarIssuanceRequest([A], await evidenceFor([A]));
    expect(decision).toMatchObject({ blocked: false, reason: "none" });
  });

  it("D: nessun precedente Medmar -> consentita", async () => {
    expect(evaluateMedmarIssuanceRequest([A, B], await evidenceFor([A, B]))).toMatchObject({ blocked: false, reason: "none" });
  });

  it("isolamento tenant: attempt di un altro tenant non conta", async () => {
    mocks.db.medmar_issuing_attempts.push({ ...attempt("att-1", [A], "completed"), tenant_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
    expect(evaluateMedmarIssuanceRequest([A], await evidenceFor([A])).blocked).toBe(false);
  });
});

describe("coda /biglietti-medmar", () => {
  it("E: la query della coda esclude ancora cancelled e pending_cancellation", () => {
    const source = readFileSync(path.join(process.cwd(), "app/(app)/biglietti-medmar/page.tsx"), "utf8");
    expect(source).toContain('.neq("status", "cancelled")');
    expect(source).toContain('.neq("status", "pending_cancellation")');
  });

  it("F: ripristinata senza precedente emissione -> torna normalmente in coda", () => {
    const evidence: Record<string, MedmarServiceIssuanceEvidence> = {
      [A]: { service_id: A, ticket_sent_at: null, completed_attempts: [], cancelled_after_issuance: false },
    };
    const view = resolveMedmarQueueIssuanceView(evaluateMedmarIssuanceRequest([A], evidence));
    expect(view).toEqual({ issueAllowed: true, warningTitle: null, warningDetail: null, shortLabel: null, forceVisible: false });
  });

  it("G: ripristinata con precedente emissione -> visibile ma bloccata con avviso esplicito", () => {
    const evidence: Record<string, MedmarServiceIssuanceEvidence> = {
      [A]: { service_id: A, ticket_sent_at: "2026-09-02T10:00:00.000Z", completed_attempts: [], cancelled_after_issuance: true },
    };
    const view = resolveMedmarQueueIssuanceView(evaluateMedmarIssuanceRequest([A], evidence));
    expect(view).toEqual({
      issueAllowed: false,
      warningTitle: "⚠ BIGLIETTO GIÀ EMESSO PRIMA DELLA CANCELLAZIONE",
      warningDetail: "Verificare lo storico Medmar prima di una nuova emissione.",
      shortLabel: "Già emesso",
      forceVisible: true,
    });
  });
});

describe("H: chiamate dirette alle API (bypass UI)", () => {
  beforeEach(() => {
    mocks.db.services[0] = service(A, "2026-09-02T10:00:00.000Z");
  });

  it("issue: 409 business, token NON consumato, orchestratore mai chiamato", async () => {
    const res = await issuePOST(req("/api/services/medmar-issue", { service_ids: [A], confirmation_token: "tok-123456789" }));
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body).toMatchObject({ ok: false, status: "already_issued", code: "medmar_already_issued", error: MEDMAR_ALREADY_ISSUED_MESSAGE, retry_allowed: false });
    expect(mocks.consumeConfirmationToken).not.toHaveBeenCalled();
    expect(mocks.orchestratorIssue).not.toHaveBeenCalled();
  });

  it("prepare e preflight: 409 prima di qualunque lettura Medmar", async () => {
    const prep = await preparePOST(req("/api/services/medmar-issue/prepare", { service_ids: [A] }));
    expect(prep.status).toBe(409);
    const pre = await preflightPOST(req("/api/services/medmar-preflight", { service_ids: [A] }));
    expect(pre.status).toBe(409);
    expect((await pre.json()).error).toBe(MEDMAR_ALREADY_ISSUED_MESSAGE);
    expect(mocks.runMedmarPreflight).not.toHaveBeenCalled();
  });

  it("storico non verificabile -> 503 fail-closed, nessuna emissione", async () => {
    mocks.failTable = "medmar_issuing_attempts";
    const res = await issuePOST(req("/api/services/medmar-issue", { service_ids: [B], confirmation_token: "tok-123456789" }));
    expect(res.status).toBe(503);
    expect(mocks.orchestratorIssue).not.toHaveBeenCalled();
  });

  it("nessun precedente -> il flusso prosegue come prima (token + orchestratore)", async () => {
    const res = await issuePOST(req("/api/services/medmar-issue", { service_ids: [B], confirmation_token: "tok-123456789" }));
    expect(res.status).toBe(422);
    expect(mocks.consumeConfirmationToken).toHaveBeenCalledTimes(1);
    expect(mocks.orchestratorIssue).toHaveBeenCalledTimes(1);
  });

  it("attempt fallito -> il guard non blocca, decide l'orchestratore come oggi", async () => {
    mocks.db.medmar_issuing_attempts.push(attempt("att-f", [B], "preflight_failed"));
    await issuePOST(req("/api/services/medmar-issue", { service_ids: [B], confirmation_token: "tok-123456789" }));
    expect(mocks.orchestratorIssue).toHaveBeenCalledTimes(1);
  });
});
