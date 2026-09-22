import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Chiude il gap identificato nell'audit pre-rollout della migration 0285:
 * legacy_import_fingerprint resta scritto anche sui servizi cancelled (mai
 * azzerato al cancel — vedi commento in
 * supabase/migrations/0285_services_legacy_import_fingerprint.sql). Se un
 * servizio S1(X) viene cancellato e poi reimportato come S2(X), un
 * successivo tentativo di ripristinare S1 tramite
 * app/api/ops/services/[id]/replace (unico punto che riporta status
 * cancelled -> new) collide sul partial index uq_services_legacy_import_fingerprint
 * quando S2 e' ancora attivo. Questo file verifica che quella route mappi
 * SOLO quel conflitto specifico a un 409 di business chiaro, mai un 500
 * generico, mai il messaggio Postgres grezzo, mai una falsa classificazione
 * per un 23505 di un altro vincolo.
 */

const mocks = vi.hoisted(() => ({
  authorizePricingRequest: vi.fn(),
  auditLog: vi.fn(),
}));

vi.mock("@/lib/server/pricing-auth", () => ({
  authorizePricingRequest: mocks.authorizePricingRequest,
}));

vi.mock("@/lib/server/ops-audit", () => ({
  auditLog: mocks.auditLog,
  auditLogAwaited: vi.fn(),
}));

import { POST } from "@/app/api/ops/services/[id]/replace/route";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HOTEL = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const FINGERPRINT_X = "2026-09-20|10:00|arrival|" + HOTEL + "|mario rossi|2|snav123|agenzia test";

type Row = Record<string, unknown>;

function makeRequest(id: string, body: unknown) {
  return {
    request: new NextRequest(`http://localhost:3010/api/ops/services/${id}/replace`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
    params: Promise.resolve({ id }),
  };
}

function basePayload(overrides: Record<string, unknown> = {}) {
  return {
    customer_last_name: "Rossi",
    customer_phone: "+39 333 9876543",
    pax: 2,
    hotel_id: HOTEL,
    arrival_date: "2026-09-20",
    arrival_time: "10:00",
    departure_date: "2026-09-22",
    departure_time: "10:00",
    notes: "",
    ...overrides,
  };
}

/** Fake admin: tabella services con conflitto reale su uq_services_legacy_import_fingerprint modellato in UPDATE. */
function makeAdmin(seedRows: Row[]) {
  const store = new Map<string, Row>(seedRows.map((r) => [r.id as string, { ...r }]));
  const updateCalls: Array<{ id: string; patch: Row; errored: boolean }> = [];
  let injectedErrorOnce: { code: string; message: string } | null = null;

  function servicesBuilder() {
    let mode: "select" | "update" | null = null;
    let patch: Row | null = null;
    let filterId: string | undefined;
    const b: Record<string, unknown> = {};
    b.select = () => { mode = "select"; return b; };
    b.update = (p: Row) => { mode = "update"; patch = p; return b; };
    b.eq = (col: string, value: string) => { if (col === "id") filterId = value; return b; };
    b.maybeSingle = async () => {
      if (mode === "select" && filterId) {
        const row = store.get(filterId);
        return { data: row ? { ...row } : null, error: null };
      }
      return { data: null, error: null };
    };
    b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      if (mode === "update" && filterId && patch) {
        if (injectedErrorOnce) {
          const err = injectedErrorOnce;
          injectedErrorOnce = null;
          updateCalls.push({ id: filterId, patch, errored: true });
          return Promise.resolve({ data: null, error: err }).then(resolve, reject);
        }
        const existing = store.get(filterId) ?? { id: filterId };
        const candidate = { ...existing, ...patch };
        const isRestoringToActive = typeof patch.status === "string" && patch.status !== "cancelled";
        if (isRestoringToActive && candidate.legacy_import_fingerprint) {
          const conflict = [...store.values()].some(
            (r) =>
              r.id !== filterId &&
              r.tenant_id === candidate.tenant_id &&
              r.legacy_import_fingerprint === candidate.legacy_import_fingerprint &&
              r.status !== "cancelled",
          );
          if (conflict) {
            updateCalls.push({ id: filterId, patch, errored: true });
            return Promise.resolve({
              data: null,
              error: { code: "23505", message: 'duplicate key value violates unique constraint "uq_services_legacy_import_fingerprint"' },
            }).then(resolve, reject);
          }
        }
        store.set(filterId, candidate);
        updateCalls.push({ id: filterId, patch, errored: false });
      }
      return Promise.resolve({ data: null, error: null }).then(resolve, reject);
    };
    return b;
  }

  function genericBuilder() {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "order", "limit", "or", "neq", "in", "ilike"]) b[m] = () => b;
    b.maybeSingle = async () => ({ data: null, error: null });
    b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(resolve, reject);
    return b;
  }

  const admin = {
    from(table: string) {
      if (table === "services") return servicesBuilder();
      return genericBuilder();
    },
    injectErrorOnNextUpdate: (err: { code: string; message: string }) => { injectedErrorOnce = err; },
  };
  return { admin, store, updateCalls };
}

function authCtx(admin: unknown) {
  return {
    admin,
    user: { id: "user-1", email: "operatore@test.it" },
    membership: { tenant_id: TENANT, role: "operator", suspended: false },
  };
}

beforeEach(() => { vi.clearAllMocks(); });

describe("POST /api/ops/services/[id]/replace — conflitto restore su uq_services_legacy_import_fingerprint (migration 0285)", () => {
  it("A. import S1(X) -> cancel S1 -> reimport S2(X): consentito (verificato a livello di dati di setup, non e' questa route)", () => {
    // Il percorso reale (import legacy + RPC cancel) e' gia' coperto da
    // tests/unit/excel-import-legacy-fingerprint-concurrency.test.ts (caso
    // 11: reimport con stesso fingerprint di un cancellato -> allowed).
    // Qui fissiamo solo lo stato di partenza usato dai test B/C sotto:
    // S1 cancelled con fingerprint X, S2 attivo con lo stesso fingerprint X.
    const { store } = makeAdmin([
      { id: "S1", tenant_id: TENANT, status: "cancelled", hotel_id: HOTEL, legacy_import_fingerprint: FINGERPRINT_X, booking_service_kind: null, direction: null },
      { id: "S2", tenant_id: TENANT, status: "new", hotel_id: HOTEL, legacy_import_fingerprint: FINGERPRINT_X, booking_service_kind: null, direction: null },
    ]);
    expect(store.get("S1")?.status).toBe("cancelled");
    expect(store.get("S2")?.status).toBe("new");
  });

  it("B. restore S1 mentre S2(X) e' attivo -> negato, HTTP 409, S1 resta cancelled, S2 invariato", async () => {
    const { admin, store } = makeAdmin([
      { id: "S1", tenant_id: TENANT, status: "cancelled", hotel_id: HOTEL, legacy_import_fingerprint: FINGERPRINT_X, booking_service_kind: null, direction: null },
      { id: "S2", tenant_id: TENANT, status: "new", hotel_id: HOTEL, legacy_import_fingerprint: FINGERPRINT_X, booking_service_kind: null, direction: null },
    ]);
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    const { request, params } = makeRequest("S1", basePayload());
    const res = await POST(request, { params });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/non può essere ripristinato.*servizio attivo equivalente/i);
    expect(body.error).not.toMatch(/duplicate key value|constraint|23505/i);

    expect(store.get("S1")?.status).toBe("cancelled");
    expect(store.get("S2")?.status).toBe("new");
    expect(store.get("S2")).toEqual({ id: "S2", tenant_id: TENANT, status: "new", hotel_id: HOTEL, legacy_import_fingerprint: FINGERPRINT_X, booking_service_kind: null, direction: null });
  });

  it("C. restore S1 quando NON esiste altro servizio attivo con X -> consentito", async () => {
    const { admin, store } = makeAdmin([
      { id: "S1", tenant_id: TENANT, status: "cancelled", hotel_id: HOTEL, legacy_import_fingerprint: FINGERPRINT_X, booking_service_kind: null, direction: null },
    ]);
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    const { request, params } = makeRequest("S1", basePayload());
    const res = await POST(request, { params });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(store.get("S1")?.status).toBe("new");
  });

  it("D. 23505 su un altro constraint nella replace route non viene falsamente classificato come conflitto fingerprint", async () => {
    const { admin, updateCalls } = makeAdmin([
      { id: "S1", tenant_id: TENANT, status: "cancelled", hotel_id: HOTEL, legacy_import_fingerprint: FINGERPRINT_X, booking_service_kind: null, direction: null },
    ]);
    admin.injectErrorOnNextUpdate({
      code: "23505",
      message: 'duplicate key value violates unique constraint "services_share_token_key"',
    });
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    const { request, params } = makeRequest("S1", basePayload());
    const res = await POST(request, { params });
    const body = await res.json();

    // Non e' il conflitto fingerprint: resta il comportamento invariato preesistente (500, messaggio grezzo passato attraverso, MAI riclassificato come 409 business del fingerprint).
    expect(res.status).toBe(500);
    expect(body.error).toMatch(/services_share_token_key/);
    expect(body.error).not.toMatch(/non può essere ripristinato/i);
    expect(updateCalls[updateCalls.length - 1]?.errored).toBe(true);
  });

  it("E. nessun errore Postgres grezzo esposto al client sul conflitto fingerprint", async () => {
    const { admin } = makeAdmin([
      { id: "S1", tenant_id: TENANT, status: "cancelled", hotel_id: HOTEL, legacy_import_fingerprint: FINGERPRINT_X, booking_service_kind: null, direction: null },
      { id: "S2", tenant_id: TENANT, status: "new", hotel_id: HOTEL, legacy_import_fingerprint: FINGERPRINT_X, booking_service_kind: null, direction: null },
    ]);
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    const { request, params } = makeRequest("S1", basePayload());
    const res = await POST(request, { params });
    const body = await res.json();

    expect(body.error).not.toMatch(/duplicate key value violates unique constraint/i);
    expect(body.error).not.toMatch(/uq_services_legacy_import_fingerprint/);
    expect(res.status).toBe(409);
  });
});
