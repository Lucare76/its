/**
 * Flusso prenotazioni cancellate: ripristino + penale di cancellazione +
 * email agenzia (migration 0286, route /restore, /penalty, /resend-email,
 * DELETE solo admin).
 *
 * Le RPC restore_cancelled_service / apply_cancellation_penalty sono
 * rispecchiate riga-per-riga in TypeScript sopra uno stato in-memory (stesso
 * approccio di bus-cancellation-rete-bus-gap.test.ts). Il comportamento SQL
 * reale è stato verificato a parte su un Postgres locale.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

type Row = Record<string, unknown>;

const mocks = vi.hoisted(() => ({
  role: "operator" as string,
  sendEmail: vi.fn(),
  auditLog: vi.fn(),
  logServiceChange: vi.fn(),
  resolveAgencyRecipient: vi.fn(),
  db: null as unknown as Record<string, Row[]>,
}));

vi.mock("@/lib/server/pricing-auth", () => ({
  authorizePricingRequest: vi.fn(async (_req: unknown, roles: string[]) => {
    // Stessa espansione della funzione reale: ["admin"] include supervisor.
    const allowed = roles.includes("admin") && !roles.includes("supervisor") ? [...roles, "supervisor"] : roles;
    if (!allowed.includes(mocks.role)) {
      const { NextResponse: NR } = await import("next/server");
      return NR.json({ error: "Ruolo non autorizzato." }, { status: 403 });
    }
    return {
      admin: makeAdmin(),
      user: { id: USER, email: "op@example.com" },
      membership: { tenant_id: TENANT, role: mocks.role, suspended: false },
    };
  }),
}));

vi.mock("@/lib/server/service-audit-log", () => ({
  getOperatorName: vi.fn(async () => "Operatore Test"),
  readServiceSnapshot: vi.fn(async (_auth: unknown, tenantId: string, id: string) =>
    (mocks.db.services.find((s) => s.id === id && s.tenant_id === tenantId) as Row | undefined) ?? null),
  logServiceChange: mocks.logServiceChange,
}));

vi.mock("@/lib/server/ops-audit", () => ({ auditLog: mocks.auditLog }));
vi.mock("@/lib/server/send-email", () => ({ sendEmail: mocks.sendEmail }));
vi.mock("@/lib/server/report-job-email", () => ({ resolveAgencyRecipient: mocks.resolveAgencyRecipient }));

import { POST as restorePOST } from "@/app/api/ops/services/[id]/restore/route";
import { POST as penaltyPOST } from "@/app/api/ops/services/[id]/penalty/route";
import { POST as resendPOST } from "@/app/api/ops/cancellation-penalties/[id]/resend-email/route";
import { DELETE as serviceDELETE } from "@/app/api/ops/services/[id]/route";
import { GET as stateGET } from "@/app/api/ops/cancelled-bookings/state/route";
import { buildPenaltyEmail, isClaimable, mapPenaltyRpcError } from "@/lib/server/cancellation-penalty";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "99999999-9999-4999-8999-999999999999";
const OUT = "11111111-1111-4111-8111-111111111111"; // andata
const RET = "22222222-2222-4222-8222-222222222222"; // ritorno
const SINGLE = "33333333-3333-4333-8333-333333333333";
const ACTIVE = "44444444-4444-4444-8444-444444444444";
const AGENCY = "55555555-5555-4555-8555-555555555555";

let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

// ─── Fake Supabase in-memory ──────────────────────────────────────────────────

function splitTopLevel(expr: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of expr) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function orClause(clause: string): (r: Row) => boolean {
  const m = clause.match(/^(\w+)\.(in|eq)\.\(?(.*?)\)?$/);
  if (!m) throw new Error(`or() non supportato: ${clause}`);
  const [, col, op, raw] = m;
  const values = op === "in" ? raw.split(",") : [raw];
  return (r) => values.includes(String(r[col]));
}

class FakeQuery implements PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }> {
  private filters: Array<(r: Row) => boolean> = [];
  private op: "select" | "update" | "insert" | "delete" = "select";
  private values: Row | Row[] | null = null;
  private returning = false;
  private singleMode: "maybe" | "single" | null = null;
  private orderCol: { col: string; asc: boolean } | null = null;
  private limitN: number | null = null;

  constructor(private table: string) {}

  select() { if (this.op !== "select") this.returning = true; return this; }
  eq(col: string, v: unknown) { this.filters.push((r) => r[col] === v); return this; }
  neq(col: string, v: unknown) { this.filters.push((r) => r[col] !== v); return this; }
  in(col: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[col])); return this; }
  is(col: string, v: unknown) { this.filters.push((r) => (r[col] ?? null) === v); return this; }
  not(col: string, op: string, v: unknown) { if (op === "is") this.filters.push((r) => (r[col] ?? null) !== v); return this; }
  gt(col: string, v: number) { this.filters.push((r) => Number(r[col]) > v); return this; }
  overlaps(col: string, vs: unknown[]) { this.filters.push((r) => ((r[col] as unknown[]) ?? []).some((x) => vs.includes(x))); return this; }
  or(expr: string) { const cls = splitTopLevel(expr).map(orClause); this.filters.push((r) => cls.some((f) => f(r))); return this; }
  order(col: string, opts?: { ascending?: boolean }) { this.orderCol = { col, asc: opts?.ascending !== false }; return this; }
  limit(n: number) { this.limitN = n; return this; }
  update(values: Row) { this.op = "update"; this.values = values; return this; }
  insert(values: Row | Row[]) { this.op = "insert"; this.values = values; return this; }
  delete() { this.op = "delete"; return this; }
  maybeSingle() { this.singleMode = "maybe"; return this; }
  single() { this.singleMode = "single"; return this; }

  private rows() { return (mocks.db[this.table] ??= []); }

  private decorate(row: Row): Row {
    if (this.table !== "services") return { ...row };
    const agency = mocks.db.agencies.find((a) => a.id === row.agency_id) ?? null;
    return { ...row, agencies: agency, hotels: { name: "Hotel Test" } };
  }

  private run() {
    const table = this.rows();
    if (this.op === "insert") {
      const list = (Array.isArray(this.values) ? this.values : [this.values]) as Row[];
      const inserted = list.map((v) => ({ id: uuid(), created_at: new Date().toISOString(), ...v }));
      table.push(...inserted);
      return { data: this.returning ? inserted : null, error: null };
    }
    let matched = table.filter((r) => this.filters.every((f) => f(r)));
    if (this.op === "update") {
      for (const r of matched) Object.assign(r, this.values);
      return { data: this.returning ? matched.map((r) => ({ ...r })) : null, error: null };
    }
    if (this.op === "delete") {
      mocks.db[this.table] = table.filter((r) => !matched.includes(r));
      return { data: null, error: null };
    }
    if (this.orderCol) {
      const { col, asc } = this.orderCol;
      matched = [...matched].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (asc ? 1 : -1));
    }
    if (this.limitN != null) matched = matched.slice(0, this.limitN);
    const data = matched.map((r) => this.decorate(r));
    if (this.singleMode) return { data: data[0] ?? null, error: null };
    return { data, error: null };
  }

  then<T1, T2>(onfulfilled?: ((v: { data: unknown; error: { message: string; code?: string } | null }) => T1 | PromiseLike<T1>) | null, onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null) {
    // Micro-yield: simula l'I/O e consente l'interleaving delle richieste concorrenti.
    return Promise.resolve().then(() => this.run()).then(onfulfilled, onrejected);
  }
}

class RpcError extends Error {}

function makeAdmin() {
  return {
    from: (table: string) => new FakeQuery(table),
    rpc: async (name: string, args: Row) => {
      await Promise.resolve();
      try {
        if (name === "apply_cancellation_penalty") return { data: fakeApplyPenalty(args), error: null };
        if (name === "restore_cancelled_service") return { data: fakeRestore(args), error: null };
        throw new Error(`rpc ${name} non simulata`);
      } catch (err) {
        if (err instanceof RpcError) return { data: null, error: { message: err.message } };
        throw err;
      }
    },
  };
}

// ─── Mirror TS delle RPC (migration 0286) ─────────────────────────────────────

function svc(id: string) {
  return mocks.db.services.find((s) => s.id === id && s.tenant_id === TENANT) ?? null;
}

function activeTouching(ids: string[]) {
  return mocks.db.service_cancellation_penalties.filter((p) =>
    p.tenant_id === TENANT && p.status === "active" && (ids.includes(p.service_id as string) || ids.includes(p.linked_service_id as string)));
}

function fakeApplyPenalty(a: Row) {
  const service = svc(a.p_service_id as string);
  if (!service) throw new RpcError("PENALTY_SERVICE_NOT_FOUND");
  const existing = mocks.db.service_cancellation_penalties.find((p) => p.idempotency_key === a.p_idempotency_key);
  if (existing) {
    return [{ penalty_id: existing.id, replayed: true, out_email_kind: existing.email_kind, out_email_status: existing.email_status, superseded_ids: existing.supersedes_ids, previous_communicated: existing.email_kind === "rectification" }];
  }
  if (service.status !== "cancelled") throw new RpcError("PENALTY_SERVICE_NOT_CANCELLED");
  let targets = [service.id as string];
  let linkedId: string | null = null;
  if (a.p_scope === "practice") {
    const linked = service.linked_service_id ? svc(service.linked_service_id as string) : null;
    if (!linked) throw new RpcError("PENALTY_NO_LINKED_SERVICE");
    if (linked.status !== "cancelled") throw new RpcError("PENALTY_SERVICE_NOT_CANCELLED");
    linkedId = linked.id as string;
    targets = [service.id as string, linkedId];
  }
  const active = activeTouching(targets);
  const activeIds = active.map((p) => p.id as string).sort();
  const expected = [...((a.p_expected_active_ids as string[]) ?? [])].sort();
  if (JSON.stringify(activeIds) !== JSON.stringify(expected)) throw new RpcError("PENALTY_STALE_STATE");
  const communicated = active.some((p) => p.email_status === "sent" || p.email_status === "sending");
  if (communicated && !a.p_confirm_rectification) throw new RpcError("PENALTY_RECTIFICATION_CONFIRMATION_REQUIRED");
  const emailKind = communicated ? "rectification" : "initial";
  const emailStatus = a.p_penalty_type === "none" && !communicated ? "not_required" : "pending";
  const now = new Date().toISOString();
  for (const p of active) Object.assign(p, { status: "superseded", superseded_at: now });
  const id = uuid();
  mocks.db.service_cancellation_penalties.push({
    id, tenant_id: TENANT, service_id: service.id, linked_service_id: linkedId, scope: a.p_scope,
    penalty_type: a.p_penalty_type, penalty_percentage: null,
    penalty_amount_cents: a.p_penalty_type === "none" ? 0 : a.p_amount_cents,
    penalty_notes: a.p_notes ?? null, status: "active", supersedes_ids: activeIds,
    applied_at: now, applied_by_name: a.p_user_name, voided_at: null, voided_by_name: null, void_reason: null,
    email_kind: emailKind, email_status: emailStatus, email_recipient: null, email_sent_at: null,
    email_attempts: 0, email_last_attempt_at: null, email_last_error: null,
    void_email_status: null, void_email_recipient: null, void_email_sent_at: null, void_email_attempts: 0,
    void_email_last_attempt_at: null, void_email_last_error: null,
    idempotency_key: a.p_idempotency_key, created_at: now,
  });
  for (const p of active) p.superseded_by_id = id;
  return [{ penalty_id: id, replayed: false, out_email_kind: emailKind, out_email_status: emailStatus, superseded_ids: activeIds, previous_communicated: communicated }];
}

function fakeRestore(a: Row) {
  const service = svc(a.p_service_id as string);
  if (!service) throw new RpcError("RESTORE_SERVICE_NOT_FOUND");
  const targets: string[] = service.status === "cancelled" ? [service.id as string] : [];
  if (a.p_scope === "practice" && service.linked_service_id) {
    const linked = svc(service.linked_service_id as string);
    if (linked?.status === "cancelled") targets.push(linked.id as string);
  }
  if (targets.length === 0) return [];
  const active = activeTouching(targets);
  let voided: string[] = [];
  let kept: string[] = [];
  if (active.length) {
    const action = (a.p_penalty_action as string) ?? "none";
    if (action === "none") throw new RpcError("RESTORE_ACTIVE_PENALTY");
    if (action === "void") {
      for (const p of active) {
        Object.assign(p, {
          status: "voided", voided_at: new Date().toISOString(), voided_by_name: a.p_user_name, void_reason: a.p_void_reason,
          void_email_status: (p.email_status === "sent" || p.email_status === "sending") && p.penalty_type !== "none" ? "pending" : "not_required",
        });
      }
      voided = active.map((p) => p.id as string);
    } else {
      kept = active.map((p) => p.id as string);
    }
  }
  return targets.map((id) => {
    const target = svc(id)!;
    target.status = "new";
    const before = (t: string) => mocks.db[t].length;
    const a0 = before("assignments"); mocks.db.assignments = mocks.db.assignments.filter((r) => r.service_id !== id);
    const b0 = before("tenant_bus_allocations"); mocks.db.tenant_bus_allocations = mocks.db.tenant_bus_allocations.filter((r) => r.service_id !== id);
    const c0 = before("bus_ischia_dist_allocations"); mocks.db.bus_ischia_dist_allocations = mocks.db.bus_ischia_dist_allocations.filter((r) => r.service_id !== id);
    mocks.db.status_events.push({ tenant_id: TENANT, service_id: id, status: "new", by_user_id: a.p_user_id, notes: "Prenotazione ripristinata da cancellazione (restore_booking)" });
    return {
      out_service_id: id, previous_status: "cancelled", new_status: "new",
      stale_assignments_cleared: a0 - mocks.db.assignments.length,
      stale_bus_allocations_cleared: (b0 - mocks.db.tenant_bus_allocations.length) + (c0 - mocks.db.bus_ischia_dist_allocations.length),
      voided_penalty_ids: voided, kept_penalty_ids: kept,
    };
  });
}

// ─── Helpers richieste ────────────────────────────────────────────────────────

function req(url: string, method: string, body?: unknown) {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { authorization: "Bearer t", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const p = (id: string) => ({ params: Promise.resolve({ id }) });

async function json(res: Response | NextResponse) {
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

let keyN = 0;
async function applyPenalty(serviceId: string, body: Partial<Record<string, unknown>> = {}) {
  return json(await penaltyPOST(req(`/api/ops/services/${serviceId}/penalty`, "POST", {
    scope: "leg", penalty_type: "fixed", amount_cents: 12000, idempotency_key: `test-key-${++keyN}`, ...body,
  }), p(serviceId)));
}

async function restore(serviceId: string, body: Record<string, unknown> = {}) {
  return json(await restorePOST(req(`/api/ops/services/${serviceId}/restore`, "POST", body), p(serviceId)));
}

const penalties = () => mocks.db.service_cancellation_penalties;

beforeEach(() => {
  seq = 0;
  mocks.role = "operator";
  mocks.sendEmail.mockReset().mockResolvedValue({ ok: true });
  mocks.auditLog.mockReset();
  mocks.logServiceChange.mockReset();
  mocks.resolveAgencyRecipient.mockReset().mockResolvedValue({ recipient: null, matchedAgency: null });
  const base = { tenant_id: TENANT, customer_name: "Cennamo Marinella", practice_number: "ITS-2026-42", notes: "", booking_service_kind: "transfer_port_hotel", pax: 2, agency_id: AGENCY, billing_party_name: "Aleste Viaggi", agency_quoted_price_cents: 40000, medmar_ticket_sent_at: null };
  mocks.db = {
    services: [
      { ...base, id: OUT, status: "cancelled", direction: "arrival", date: "2026-10-10", arrival_date: "2026-10-10", departure_date: null, linked_service_id: RET },
      { ...base, id: RET, status: "cancelled", direction: "departure", date: "2026-10-17", arrival_date: null, departure_date: "2026-10-17", linked_service_id: OUT },
      { ...base, id: SINGLE, status: "cancelled", direction: "arrival", date: "2026-10-12", arrival_date: "2026-10-12", departure_date: null, linked_service_id: null, customer_name: "Rossi Mario", practice_number: null },
      { ...base, id: ACTIVE, status: "assigned", direction: "arrival", date: "2026-10-12", arrival_date: "2026-10-12", departure_date: null, linked_service_id: null },
    ],
    agencies: [{ id: AGENCY, name: "Aleste Viaggi", booking_email: "booking@aleste.example", contact_email: null, booking_emails: [], contact_emails: [] }],
    service_cancellation_penalties: [],
    assignments: [],
    tenant_bus_allocations: [],
    bus_ischia_dist_allocations: [],
    status_events: [],
    service_audit_events: [],
    service_change_logs: [{ service_id: OUT, action: "CANCELLED", tenant_id: TENANT, operator_name: "Anna", created_at: "2026-09-30T13:20:00.000Z", after_data: { cancellation_reason: "Cliente ha annullato" } }],
    medmar_issuing_attempts: [],
    cancellation_requests: [],
    memberships: [],
    service_deletion_log: [],
  };
});

// ─── Test ─────────────────────────────────────────────────────────────────────

describe("A/M/N/O — ripristino prenotazione cancellata", () => {
  it("A: riporta a 'new', registra audit restore_booking e non ricrea nulla", async () => {
    const { status, body } = await restore(SINGLE);
    expect(status).toBe(200);
    expect(body.restored_service_ids).toEqual([SINGLE]);
    expect(body.needs_reassignment).toBe(true);
    expect(svc(SINGLE)!.status).toBe("new");
    // O: audit
    expect(mocks.logServiceChange).toHaveBeenCalledWith(expect.objectContaining({ serviceId: SINGLE, action: "RESTORED", fields: ["status"] }));
    const ev = mocks.db.service_audit_events.find((e) => e.event_type === "service_restored");
    expect(ev).toMatchObject({ service_id: SINGLE, reason: "restore_booking", actor_user_id: USER, old_data: { status: "cancelled" }, new_data: { status: "new" } });
    expect(mocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({ event: "service_restored_from_cancellation" }));
    expect(mocks.db.assignments).toHaveLength(0);
    expect(mocks.db.tenant_bus_allocations).toHaveLength(0);
  });

  it("M: rimuove allocazioni bus/assignments rimasti appesi e non ne crea di nuovi", async () => {
    mocks.db.tenant_bus_allocations.push({ id: uuid(), tenant_id: TENANT, service_id: SINGLE, direction: "arrival" });
    mocks.db.bus_ischia_dist_allocations.push({ id: uuid(), tenant_id: TENANT, service_id: SINGLE });
    mocks.db.assignments.push({ id: uuid(), tenant_id: TENANT, service_id: SINGLE, driver_user_id: USER });
    const { body } = await restore(SINGLE);
    expect(body.stale_bus_allocations_cleared).toBe(2);
    expect(body.stale_assignments_cleared).toBe(1);
    expect(mocks.db.tenant_bus_allocations).toHaveLength(0);
    expect(mocks.db.assignments).toHaveLength(0);
  });

  it("N: un secondo ripristino è idempotente (nessun doppio evento/allocazione)", async () => {
    await restore(SINGLE);
    const eventsAfterFirst = mocks.db.status_events.length;
    const { status, body } = await restore(SINGLE);
    expect(status).toBe(200);
    expect(body.already_active).toBe(true);
    expect(mocks.db.status_events).toHaveLength(eventsAfterFirst);
    expect(mocks.db.service_audit_events.filter((e) => e.event_type === "service_restored")).toHaveLength(1);
  });

  it("stato derivato: 'Ripristinata – da riassegnare' finché il servizio non viene riassegnato", async () => {
    await restore(SINGLE);
    let { body } = await json(await stateGET(req(`/api/ops/cancelled-bookings/state?ids=${SINGLE}`, "GET")));
    expect(body.states[SINGLE].restored).toMatchObject({ needs_reassignment: true, restored_by: "Operatore Test" });
    mocks.db.assignments.push({ id: uuid(), tenant_id: TENANT, service_id: SINGLE, driver_user_id: USER });
    ({ body } = await json(await stateGET(req(`/api/ops/cancelled-bookings/state?ids=${SINGLE}`, "GET"))));
    expect(body.states[SINGLE].restored.needs_reassignment).toBe(false);
  });
});

describe("B/C/D/E/F — penale", () => {
  it("B: 'Nessuna penale' registrata senza email", async () => {
    const { status, body } = await applyPenalty(SINGLE, { penalty_type: "none", amount_cents: 0 });
    expect(status).toBe(200);
    expect(body.email.status).toBe("not_required");
    expect(penalties()[0]).toMatchObject({ penalty_type: "none", penalty_amount_cents: 0, status: "active" });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("C: la percentuale è rifiutata nel primo rilascio", async () => {
    const { status, body } = await applyPenalty(SINGLE, { penalty_type: "percentage" });
    expect(status).toBe(400);
    expect(body.error).toContain("percentuale");
    expect(penalties()).toHaveLength(0);
  });

  it("D: importo fisso salvato, agency_quoted_price_cents intatto; importo 0 rifiutato", async () => {
    expect((await applyPenalty(SINGLE, { amount_cents: 0 })).status).toBe(400);
    const { status } = await applyPenalty(SINGLE, { amount_cents: 12000, notes: "Entro 48h" });
    expect(status).toBe(200);
    expect(penalties()[0]).toMatchObject({ penalty_type: "fixed", penalty_amount_cents: 12000, penalty_notes: "Entro 48h", applied_by_name: "Operatore Test" });
    expect(svc(SINGLE)!.agency_quoted_price_cents).toBe(40000);
  });

  it("E: email inviata all'agenzia (booking_email) con oggetto pratica/cliente", async () => {
    const { body } = await applyPenalty(OUT, { amount_cents: 12000 });
    expect(body.email.status).toBe("sent");
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    const sent = mocks.sendEmail.mock.calls[0][0];
    expect(sent.to).toBe("booking@aleste.example");
    expect(sent.subject).toBe("Penale cancellazione pratica ITS-2026-42 – CENNAMO MARINELLA");
    expect(sent.html).toContain("Gentile Aleste Viaggi");
    expect(sent.html).toContain("120,00");
    expect(penalties()[0]).toMatchObject({ email_status: "sent", email_recipient: "booking@aleste.example", email_attempts: 1 });
  });

  it("F: email fallita → penale mantenuta, stato failed, errore registrato nel log", async () => {
    mocks.sendEmail.mockResolvedValue({ ok: false, error: "Resend HTTP 500" });
    const { status, body } = await applyPenalty(SINGLE);
    expect(status).toBe(200);
    expect(body.email.status).toBe("failed");
    expect(penalties()[0]).toMatchObject({ status: "active", email_status: "failed", email_last_error: "Resend HTTP 500", email_attempts: 1 });
    expect(mocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({ event: "cancellation_penalty_email_not_sent", outcome: "failed" }));
  });

  it("agenzia senza email → no_recipient, penale salvata comunque", async () => {
    mocks.db.agencies[0].booking_email = null;
    const { status, body } = await applyPenalty(SINGLE);
    expect(status).toBe(200);
    expect(body.email.status).toBe("no_recipient");
    expect(penalties()[0].status).toBe("active");
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("fallback billing_party_name quando l'agenzia collegata non ha email", async () => {
    mocks.db.agencies[0].booking_email = null;
    mocks.resolveAgencyRecipient.mockResolvedValue({ recipient: "amministrazione@aleste.example", matchedAgency: "Aleste Viaggi" });
    const { body } = await applyPenalty(SINGLE);
    expect(body.email.status).toBe("sent");
    expect(mocks.resolveAgencyRecipient).toHaveBeenCalledWith(expect.anything(), TENANT, "Aleste Viaggi");
    expect(mocks.sendEmail.mock.calls[0][0].to).toBe("amministrazione@aleste.example");
  });

  it("penale solo su prenotazioni cancellate", async () => {
    const { status, body } = await applyPenalty(ACTIVE);
    expect(status).toBe(409);
    expect(body.code).toBe("not_cancelled");
  });
});

describe("G/H — reinvio e doppio click", () => {
  it("G: reinvio dopo fallimento → inviata; un secondo reinvio è rifiutato", async () => {
    mocks.sendEmail.mockResolvedValueOnce({ ok: false, error: "timeout" });
    const { body } = await applyPenalty(SINGLE);
    const id = body.penalty_id as string;
    const first = await json(await resendPOST(req(`/api/ops/cancellation-penalties/${id}/resend-email`, "POST", { channel: "penalty" }), p(id)));
    expect(first.status).toBe(200);
    expect(first.body.email.status).toBe("sent");
    expect(penalties()[0]).toMatchObject({ email_status: "sent", email_attempts: 2, email_last_error: null });
    const second = await json(await resendPOST(req(`/api/ops/cancellation-penalties/${id}/resend-email`, "POST", {}), p(id)));
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("already_sent");
    expect(mocks.sendEmail).toHaveBeenCalledTimes(2);
  });

  it("H: doppio click con la stessa idempotency_key → una sola penale e una sola email", async () => {
    const body = { scope: "leg", penalty_type: "fixed", amount_cents: 5000, idempotency_key: "double-click-key-1" };
    const [r1, r2] = await Promise.all([
      penaltyPOST(req(`/api/ops/services/${SINGLE}/penalty`, "POST", body), p(SINGLE)),
      penaltyPOST(req(`/api/ops/services/${SINGLE}/penalty`, "POST", body), p(SINGLE)),
    ]);
    const [b1, b2] = [await json(r1), await json(r2)];
    expect(b1.status).toBe(200);
    expect(b2.status).toBe(200);
    expect(b1.body.penalty_id).toBe(b2.body.penalty_id);
    expect(penalties()).toHaveLength(1);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    // Anche due reinvii concorrenti non duplicano: il claim CAS ne fa vincere uno.
    penalties()[0].email_status = "failed";
    mocks.sendEmail.mockClear();
    const id = b1.body.penalty_id as string;
    const results = await Promise.all([
      resendPOST(req(`/api/ops/cancellation-penalties/${id}/resend-email`, "POST", {}), p(id)),
      resendPOST(req(`/api/ops/cancellation-penalties/${id}/resend-email`, "POST", {}), p(id)),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
  });
});

describe("I — modifica di una penale già comunicata", () => {
  it("richiede conferma, crea una nuova versione (superseded) e invia la rettifica", async () => {
    const first = await applyPenalty(SINGLE, { amount_cents: 12000 });
    const firstId = first.body.penalty_id as string;
    const noConfirm = await applyPenalty(SINGLE, { amount_cents: 9000, expected_active_ids: [firstId] });
    expect(noConfirm.status).toBe(409);
    expect(noConfirm.body.code).toBe("rectification_confirmation_required");

    const stale = await applyPenalty(SINGLE, { amount_cents: 9000, confirm_rectification: true });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("stale_state");

    const ok = await applyPenalty(SINGLE, { amount_cents: 9000, expected_active_ids: [firstId], confirm_rectification: true });
    expect(ok.status).toBe(200);
    expect(ok.body.email_kind).toBe("rectification");
    const [oldRow, newRow] = penalties();
    expect(oldRow).toMatchObject({ id: firstId, status: "superseded", penalty_amount_cents: 12000, superseded_by_id: newRow.id });
    expect(newRow).toMatchObject({ status: "active", penalty_amount_cents: 9000, supersedes_ids: [firstId], email_kind: "rectification", email_status: "sent" });
    const rect = mocks.sendEmail.mock.calls[1][0];
    expect(rect.subject).toMatch(/^Rettifica penale cancellazione pratica/);
    expect(rect.html).toContain("120,00");
    expect(rect.html).toContain("90,00");
    expect(mocks.db.service_audit_events.map((e) => e.event_type)).toEqual(["cancellation_penalty_applied", "cancellation_penalty_modified"]);
  });
});

describe("J — ripristino con penale attiva", () => {
  it("blocca il ripristino diretto, 'mantieni' richiede doppia conferma", async () => {
    await applyPenalty(SINGLE);
    const blocked = await restore(SINGLE);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe("active_penalty");
    expect(blocked.body.active_penalties).toHaveLength(1);
    expect(svc(SINGLE)!.status).toBe("cancelled");

    const keepNoConfirm = await restore(SINGLE, { penalty_action: "keep" });
    expect(keepNoConfirm.status).toBe(409);
    expect(keepNoConfirm.body.code).toBe("keep_confirmation_required");

    const kept = await restore(SINGLE, { penalty_action: "keep", confirm_keep_penalty: true });
    expect(kept.status).toBe(200);
    expect(svc(SINGLE)!.status).toBe("new");
    expect(penalties()[0].status).toBe("active");
  });

  it("'annulla penale e ripristina': penale voided (non cancellata) + email di annullamento", async () => {
    const applied = await applyPenalty(SINGLE);
    const noReason = await restore(SINGLE, { penalty_action: "void" });
    expect(noReason.status).toBe(400);

    const { status, body } = await restore(SINGLE, { penalty_action: "void", void_reason: "Cliente ha riconfermato" });
    expect(status).toBe(200);
    expect(body.voided_penalty_ids).toEqual([applied.body.penalty_id]);
    expect(penalties()).toHaveLength(1);
    expect(penalties()[0]).toMatchObject({ status: "voided", void_reason: "Cliente ha riconfermato", voided_by_name: "Operatore Test", void_email_status: "sent" });
    const voidMail = mocks.sendEmail.mock.calls[1][0];
    expect(voidMail.subject).toMatch(/^Annullamento penale cancellazione pratica/);
    expect(body.void_emails[0].status).toBe("sent");
    expect(mocks.db.service_audit_events.some((e) => e.event_type === "cancellation_penalty_voided")).toBe(true);
  });
});

describe("K — pratica A/R", () => {
  it("penale di pratica: una sola riga, importo non duplicato sulle due tratte", async () => {
    const { status } = await applyPenalty(OUT, { scope: "practice", amount_cents: 20000 });
    expect(status).toBe(200);
    expect(penalties()).toHaveLength(1);
    expect(penalties()[0]).toMatchObject({ service_id: OUT, linked_service_id: RET, scope: "practice", penalty_amount_cents: 20000 });
    // La stessa penale vale per entrambe le tratte nello stato derivato.
    const { body } = await json(await stateGET(req(`/api/ops/cancelled-bookings/state?ids=${OUT},${RET}`, "GET")));
    expect(body.states[OUT].active_penalty.id).toBe(body.states[RET].active_penalty.id);
  });

  it("ripristino solo tratta vs entrambe, nessuna cascata implicita", async () => {
    await restore(OUT, { scope: "leg" });
    expect(svc(OUT)!.status).toBe("new");
    expect(svc(RET)!.status).toBe("cancelled");
    const { body } = await restore(OUT, { scope: "practice" });
    expect(body.restored_service_ids).toEqual([RET]);
    expect(svc(RET)!.status).toBe("new");
  });

  it("penale di pratica rifiutata se l'altra tratta non è cancellata", async () => {
    svc(RET)!.status = "new";
    const { status, body } = await applyPenalty(OUT, { scope: "practice" });
    expect(status).toBe(409);
    expect(body.code).toBe("not_cancelled");
  });
});

describe("L — Medmar", () => {
  it("avvisa se il biglietto era già inviato/emesso e non tocca medmar_ticket_sent_at", async () => {
    svc(SINGLE)!.medmar_ticket_sent_at = "2026-09-20T10:00:00.000Z";
    mocks.db.medmar_issuing_attempts.push({ tenant_id: TENANT, service_ids: [SINGLE], status: "completed", medmar_numero: "MM123", updated_at: "2026-09-20T09:00:00.000Z" });
    const { body } = await restore(SINGLE);
    expect(body.medmar_warnings).toEqual([{ service_id: SINGLE, ticket_sent_at: "2026-09-20T10:00:00.000Z", issuing_attempt_status: "completed", medmar_numero: "MM123" }]);
    expect(svc(SINGLE)!.medmar_ticket_sent_at).toBe("2026-09-20T10:00:00.000Z");
    expect(mocks.db.medmar_issuing_attempts).toHaveLength(1);
  });

  it("nessun avviso se non c'è traccia di biglietti", async () => {
    mocks.db.medmar_issuing_attempts.push({ tenant_id: TENANT, service_ids: [SINGLE], status: "preflight_failed", medmar_numero: null, updated_at: "x" });
    const { body } = await restore(SINGLE);
    expect(body.medmar_warnings).toEqual([]);
  });
});

describe("P — permessi server-side", () => {
  it.each(["driver", "agency"])("%s non può ripristinare, gestire penali o reinviare email", async (role) => {
    mocks.role = role;
    expect((await restore(SINGLE)).status).toBe(403);
    expect((await applyPenalty(SINGLE)).status).toBe(403);
    const id = uuid();
    expect((await resendPOST(req(`/api/ops/cancellation-penalties/${id}/resend-email`, "POST", {}), p(id))).status).toBe(403);
    expect(svc(SINGLE)!.status).toBe("cancelled");
  });

  it("supervisor può ripristinare e gestire penali", async () => {
    mocks.role = "supervisor";
    expect((await applyPenalty(SINGLE)).status).toBe(200);
    expect((await restore(SINGLE, { penalty_action: "keep", confirm_keep_penalty: true })).status).toBe(200);
  });

  it("eliminazione definitiva: supervisor rifiutato (403) nonostante l'espansione automatica dei ruoli", async () => {
    mocks.role = "supervisor";
    const res = await serviceDELETE(req(`/api/ops/services/${SINGLE}`, "DELETE", { reason: "Prenotazione di test", note: "", confirmation: "ELIMINA_DEFINITIVAMENTE" }), p(SINGLE));
    expect(res.status).toBe(403);
    expect(svc(SINGLE)).not.toBeNull();
  });

  it("eliminazione definitiva: admin bloccato se esiste una penale attiva, consentita dopo l'annullamento", async () => {
    await applyPenalty(SINGLE);
    mocks.role = "admin";
    const body = { reason: "Prenotazione di test", note: "", confirmation: "ELIMINA_DEFINITIVAMENTE" };
    const blocked = await serviceDELETE(req(`/api/ops/services/${SINGLE}`, "DELETE", body), p(SINGLE));
    expect(blocked.status).toBe(409);
    penalties()[0].status = "voided";
    const ok = await serviceDELETE(req(`/api/ops/services/${SINGLE}`, "DELETE", body), p(SINGLE));
    expect(ok.status).toBe(200);
    expect(svc(SINGLE)).toBeNull();
    // Lo storico penali sopravvive all'eliminazione (nessuna FK).
    expect(penalties()).toHaveLength(1);
  });
});

describe("helper puri", () => {
  it("escape HTML delle note nel template email", () => {
    const { html } = buildPenaltyEmail({
      kind: "initial", agencyName: "<b>Ag</b>", scope: "leg", cancelledAt: null,
      services: [{ id: SINGLE, status: "cancelled", customer_name: "x", practice_number: null, notes: "", date: "2026-10-12", direction: "arrival", arrival_date: "2026-10-12", departure_date: null, booking_service_kind: null, pax: 1, agency_id: null, billing_party_name: null, linked_service_id: null, medmar_ticket_sent_at: null }],
      penalty: { penalty_type: "fixed", penalty_amount_cents: 100, penalty_percentage: null, penalty_notes: "<script>x</script>" },
    });
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<b>Ag</b>");
  });

  it("claim: 'sent' mai reinviabile, 'sending' solo se bloccato da oltre 10 minuti", () => {
    const now = Date.parse("2026-09-30T12:00:00Z");
    expect(isClaimable({ status: "sent", lastAttemptAt: null }, "resend", now)).toBe(false);
    expect(isClaimable({ status: "pending", lastAttemptAt: null }, "auto", now)).toBe(true);
    expect(isClaimable({ status: "failed", lastAttemptAt: null }, "auto", now)).toBe(false);
    expect(isClaimable({ status: "failed", lastAttemptAt: null }, "resend", now)).toBe(true);
    expect(isClaimable({ status: "sending", lastAttemptAt: "2026-09-30T11:55:00Z" }, "resend", now)).toBe(false);
    expect(isClaimable({ status: "sending", lastAttemptAt: "2026-09-30T11:40:00Z" }, "resend", now)).toBe(true);
  });

  it("mappatura errori RPC", () => {
    expect(mapPenaltyRpcError("PENALTY_STALE_STATE")?.status).toBe(409);
    expect(mapPenaltyRpcError("boom")).toBeNull();
  });
});
