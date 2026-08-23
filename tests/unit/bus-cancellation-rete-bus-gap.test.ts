/**
 * Test di regressione — verifica mirata del flusso di cancellazione bus
 * introdotto dal commit 5ea764205693de7ecb9f1ec713b74cb4459f8c6c (migration
 * 0244) e corretto da supabase/migrations/0245_fix_cancel_service_practice_
 * rete_bus_allocations.sql.
 *
 * Il fake di admin.rpc("cancel_service_practice", ...) qui sotto e' uno
 * specchio riga-per-riga della funzione PL/pgSQL reale come ridefinita dalla
 * 0245: UPDATE services SET status='cancelled', DELETE assignments, DELETE
 * tenant_bus_allocations (Rete Bus continentale, migration 0036) E DELETE
 * bus_ischia_dist_allocations (smistamento Ischia, migration 0107) — prima
 * della 0245 la RPC cancellava solo la seconda tabella, lasciando orfane le
 * allocazioni sulla Rete Bus continentale (vedi report dell'audit). Non e'
 * un controllo testuale del file SQL: esegue codice reale (la route
 * app/api/ops/services/[id]/cancel/route.ts e la funzione reale
 * validateBusBookingQr) contro uno stato in-memory a due tabelle di
 * allocazione distinte.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { validateBusBookingQr } from "@/lib/server/bus-booking-qr";

const mocks = vi.hoisted(() => ({
  authorizePricingRequest: vi.fn(),
  getOperatorName: vi.fn(),
  readServiceSnapshot: vi.fn(),
  logServiceChange: vi.fn(),
}));

vi.mock("@/lib/server/pricing-auth", () => ({
  authorizePricingRequest: mocks.authorizePricingRequest,
}));

vi.mock("@/lib/server/service-audit-log", () => ({
  getOperatorName: mocks.getOperatorName,
  readServiceSnapshot: mocks.readServiceSnapshot,
  logServiceChange: mocks.logServiceChange,
}));

import { POST } from "@/app/api/ops/services/[id]/cancel/route";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OUTWARD_ID = "11111111-1111-4111-8111-111111111111"; // ANDATA, direction 'arrival'
const RETURN_ID = "22222222-2222-4222-8222-222222222222"; // RITORNO, direction 'departure'
const TOKEN_OUTBOUND = "outbound-token";
const TOKEN_RETURN = "return-token";

type ServiceRow = {
  id: string;
  tenant_id: string;
  status: string;
  linked_service_id: string | null;
  direction: "arrival" | "departure";
  date: string;
  time: string | null;
  booking_service_kind: string | null;
  service_type_code: string | null;
  customer_name: string | null;
  phone: string | null;
  customer_first_name: string | null;
  customer_last_name: string | null;
  arrival_date: string | null;
  arrival_time: string | null;
  departure_date: string | null;
  departure_time: string | null;
  bus_city_origin: string | null;
  vessel: string | null;
  hotel_id: string | null;
  notes: string | null;
};

type QrRow = {
  id: string;
  tenant_id: string;
  booking_id: string;
  direction: "outbound" | "return";
  service_date: string;
  qr_token: string;
  qr_payload: string;
  qr_image_url: string;
  qr_file_path: string | null;
  status: "active" | "used" | "cancelled";
  used_at: string | null;
  used_by: string | null;
  created_at: string;
  updated_at: string;
};

type AllocationRow = { id: string; tenant_id: string; service_id: string; bus_line_id?: string };

type Store = {
  services: ServiceRow[];
  bookingQrCodes: QrRow[];
  assignments: AllocationRow[];
  tenantBusAllocations: AllocationRow[]; // Rete Bus continentale (Linea Italia/Centro/Adriatica) — migration 0036
  busIschiaDistAllocations: AllocationRow[]; // smistamento locale post-sbarco — migration 0107
  statusEvents: Array<Record<string, unknown>>;
  opsAuditEvents: Array<Record<string, unknown>>;
};

function makeService(overrides: Partial<ServiceRow>): ServiceRow {
  return {
    id: OUTWARD_ID,
    tenant_id: TENANT,
    status: "confirmed",
    linked_service_id: null,
    direction: "arrival",
    date: "2026-08-25",
    time: "10:00",
    booking_service_kind: "bus_city_hotel",
    service_type_code: null,
    customer_name: "Mario Rossi",
    phone: "3331234567",
    customer_first_name: null,
    customer_last_name: null,
    arrival_date: "2026-08-25",
    arrival_time: "10:00",
    departure_date: "2026-08-28",
    departure_time: "16:00",
    bus_city_origin: "Napoli",
    vessel: "Bus",
    hotel_id: null,
    notes: null,
    ...overrides,
  };
}

function makeQrRow(overrides: Partial<QrRow>): QrRow {
  return {
    id: overrides.id ?? "qr-1",
    tenant_id: TENANT,
    booking_id: OUTWARD_ID,
    direction: "outbound",
    service_date: "2026-08-25",
    qr_token: TOKEN_OUTBOUND,
    qr_payload: "payload",
    qr_image_url: "https://example.test/qr.png",
    qr_file_path: null,
    status: "active",
    used_at: null,
    used_by: null,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Coppia ANDATA/RITORNO A/R con un assignment autista e un'allocazione in
 * ENTRAMBE le tabelle bus per ciascuna gamba — cosi' ogni test puo' provare
 * quale tabella viene davvero ripulita dalla cancellazione. */
function makeArPracticeStore(): Store {
  return {
    services: [
      makeService({ id: OUTWARD_ID, direction: "arrival", linked_service_id: RETURN_ID, status: "confirmed" }),
      makeService({ id: RETURN_ID, direction: "departure", linked_service_id: OUTWARD_ID, status: "confirmed" }),
    ],
    bookingQrCodes: [
      makeQrRow({ id: "qr-out", booking_id: OUTWARD_ID, direction: "outbound", qr_token: TOKEN_OUTBOUND, status: "active" }),
      makeQrRow({ id: "qr-ret", booking_id: OUTWARD_ID, direction: "return", qr_token: TOKEN_RETURN, status: "active" }),
    ],
    assignments: [
      { id: "assign-out", tenant_id: TENANT, service_id: OUTWARD_ID },
      { id: "assign-ret", tenant_id: TENANT, service_id: RETURN_ID },
    ],
    tenantBusAllocations: [
      { id: "reteb-out", tenant_id: TENANT, service_id: OUTWARD_ID, bus_line_id: "linea-italia" },
      { id: "reteb-ret", tenant_id: TENANT, service_id: RETURN_ID, bus_line_id: "linea-italia" },
    ],
    busIschiaDistAllocations: [
      { id: "smist-out", tenant_id: TENANT, service_id: OUTWARD_ID },
      { id: "smist-ret", tenant_id: TENANT, service_id: RETURN_ID },
    ],
    statusEvents: [],
    opsAuditEvents: [],
  };
}

/** Query builder generico: replica il sottoinsieme dell'API Supabase usato da
 * validateBusBookingQr (select/eq/eq.../order/maybeSingle, e risoluzione ad
 * array via `.then`). Legge sempre l'array live dello store, cosi' le
 * mutazioni fatte dall'RPC nello stesso test sono visibili subito dopo. */
function makeTableBuilder(rows: Array<Record<string, unknown>>) {
  const filters: Record<string, unknown> = {};
  const builder: Record<string, unknown> = {};
  builder.select = () => builder;
  builder.eq = (col: string, val: unknown) => {
    filters[col] = val;
    return builder;
  };
  builder.order = () => builder;
  const matching = () => rows.filter((r) => Object.entries(filters).every(([k, v]) => r[k] === v));
  builder.maybeSingle = async () => ({ data: matching()[0] ?? null, error: null });
  builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: matching(), error: null }).then(resolve);
  return builder;
}

type RpcOptions = { injectErrorForId?: string };

/** Specchio fedele di cancel_service_practice come ridefinita dalla
 * migration 0245, riga per riga: scope check, row lookup, risoluzione gamba
 * collegata per scope='practice', loop su ciascun id target con UPDATE
 * status + DELETE assignments + DELETE tenant_bus_allocations (Rete Bus
 * continentale) + DELETE bus_ischia_dist_allocations (smistamento Ischia) +
 * status_events, insert ops_audit_events finale con bus_allocations_cleared
 * = somma di entrambe le tabelle (contratto RPC invariato rispetto alla
 * 0244). Se injectErrorForId e' tra i target, simula un fallimento a meta'
 * transazione SENZA applicare alcuna mutazione allo store: e' l'equivalente
 * osservabile di un rollback reale di Postgres (una transazione fallita non
 * lascia mai effetti visibili), non serve mutare-e-poi-annullare per
 * riprodurne il comportamento esterno. */
function makeRpc(store: Store, opts: RpcOptions = {}) {
  return vi.fn(async (fnName: string, args: Record<string, unknown>) => {
    if (fnName !== "cancel_service_practice") throw new Error(`rpc inattesa: ${fnName}`);
    const p_service_id = args.p_service_id as string;
    const p_tenant_id = args.p_tenant_id as string;
    const p_scope = args.p_scope as string;

    if (p_scope !== "leg" && p_scope !== "practice") {
      return { data: null, error: { message: `Unsupported cancellation scope: ${p_scope}` } };
    }

    const service = store.services.find((s) => s.id === p_service_id && s.tenant_id === p_tenant_id);
    if (!service) {
      return { data: null, error: { message: "Service not found" } };
    }

    let targetIds = [service.id];
    if (p_scope === "practice" && service.linked_service_id) {
      const linked = store.services.find((s) => s.id === service.linked_service_id && s.tenant_id === p_tenant_id);
      if (linked) targetIds = [service.id, linked.id];
    }

    if (opts.injectErrorForId && targetIds.includes(opts.injectErrorForId)) {
      return { data: null, error: { message: "simulated: bus allocation removal failed mid-transaction" } };
    }

    const rows: Array<{ out_service_id: string; assignments_cleared: number; bus_allocations_cleared: number }> = [];
    for (const id of targetIds) {
      const svc = store.services.find((s) => s.id === id)!;
      svc.status = "cancelled";

      const beforeAssign = store.assignments.length;
      store.assignments = store.assignments.filter((a) => !(a.tenant_id === p_tenant_id && a.service_id === id));
      const assignmentsCleared = beforeAssign - store.assignments.length;

      // Migration 0245: DELETE FROM tenant_bus_allocations (Rete Bus
      // continentale) — il fix del gap confermato dall'audit.
      const beforeTenantBus = store.tenantBusAllocations.length;
      store.tenantBusAllocations = store.tenantBusAllocations.filter((a) => !(a.tenant_id === p_tenant_id && a.service_id === id));
      const tenantBusCleared = beforeTenantBus - store.tenantBusAllocations.length;

      // Migration 0245 (invariato rispetto alla 0244): DELETE FROM
      // bus_ischia_dist_allocations (smistamento Ischia).
      const beforeBus = store.busIschiaDistAllocations.length;
      store.busIschiaDistAllocations = store.busIschiaDistAllocations.filter((a) => !(a.tenant_id === p_tenant_id && a.service_id === id));
      const busIschiaCleared = beforeBus - store.busIschiaDistAllocations.length;

      store.statusEvents.push({ tenant_id: p_tenant_id, service_id: id, status: "cancelled" });
      rows.push({ out_service_id: id, assignments_cleared: assignmentsCleared, bus_allocations_cleared: tenantBusCleared + busIschiaCleared });
    }

    store.opsAuditEvents.push({ tenant_id: p_tenant_id, event: "service_cancelled_operationally", scope: p_scope });
    return { data: rows, error: null };
  });
}

function makeAdmin(store: Store, rpcOpts: RpcOptions = {}): { admin: SupabaseClient; rpcSpy: ReturnType<typeof makeRpc> } {
  const rpcSpy = makeRpc(store, rpcOpts);
  const admin = {
    rpc: rpcSpy,
    from(table: string) {
      if (table === "services") return makeTableBuilder(store.services as unknown as Array<Record<string, unknown>>);
      if (table === "booking_qr_codes") return makeTableBuilder(store.bookingQrCodes as unknown as Array<Record<string, unknown>>);
      throw new Error(`tabella inattesa nel fake admin: ${table}`);
    },
  } as unknown as SupabaseClient;
  return { admin, rpcSpy };
}

function makeAuthContext(admin: SupabaseClient) {
  return {
    admin,
    user: { id: "user-1", email: "operatore@test.it" },
    membership: { tenant_id: TENANT, role: "operator", suspended: false },
  };
}

function makeRequest(id: string, body: unknown) {
  return {
    request: new NextRequest(`http://localhost:3010/api/ops/services/${id}/cancel`, { method: "POST", body: JSON.stringify(body) }),
    params: Promise.resolve({ id }),
  };
}

function wireReadServiceSnapshot(store: Store) {
  mocks.readServiceSnapshot.mockImplementation(async (_auth: unknown, _tenantId: string, serviceId: string) => {
    const svc = store.services.find((s) => s.id === serviceId);
    return svc ? { id: svc.id, status: svc.status, linked_service_id: svc.linked_service_id } : null;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getOperatorName.mockResolvedValue("Mario Rossi");
  mocks.logServiceChange.mockResolvedValue(undefined);
});

describe("Cancellazione bus — gap Rete Bus continentale (tenant_bus_allocations) vs smistamento Ischia (bus_ischia_dist_allocations)", () => {
  describe("Caso A — cancellazione scope='leg' della sola ANDATA", () => {
    it("ANDATA cancellata: status, assignment, smistamento Ischia e QR ANDATA coerenti; RITORNO invariato", async () => {
      const store = makeArPracticeStore();
      wireReadServiceSnapshot(store);
      const { admin } = makeAdmin(store);
      mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(admin));

      const { request, params } = makeRequest(OUTWARD_ID, { reason: "Cliente ha annullato", scope: "leg" });
      const res = await POST(request, { params });
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.ok).toBe(true);
      expect(json.service_ids).toEqual([OUTWARD_ID]);
      expect(json.assignments_cleared).toBe(1);

      expect(store.services.find((s) => s.id === OUTWARD_ID)?.status).toBe("cancelled");
      expect(store.services.find((s) => s.id === RETURN_ID)?.status).toBe("confirmed");

      expect(store.assignments.some((a) => a.service_id === OUTWARD_ID)).toBe(false);
      expect(store.assignments.some((a) => a.service_id === RETURN_ID)).toBe(true);

      expect(store.busIschiaDistAllocations.some((a) => a.service_id === OUTWARD_ID)).toBe(false);
      expect(store.busIschiaDistAllocations.some((a) => a.service_id === RETURN_ID)).toBe(true);

      const outboundQr = await validateBusBookingQr(admin, OUTWARD_ID, "outbound", TOKEN_OUTBOUND);
      const returnQr = await validateBusBookingQr(admin, OUTWARD_ID, "return", TOKEN_RETURN);
      expect(outboundQr.state).toBe("cancelled");
      expect(returnQr.state).toBe("valid");
    });

    it("FIX VERIFICATO (migration 0245): viene rimossa SOLO la riga Rete Bus continentale di ANDATA — quella di RITORNO resta intatta", async () => {
      const store = makeArPracticeStore();
      wireReadServiceSnapshot(store);
      const { admin } = makeAdmin(store);
      mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(admin));

      const { request, params } = makeRequest(OUTWARD_ID, { reason: "Cliente ha annullato", scope: "leg" });
      const res = await POST(request, { params });
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.bus_allocations_cleared).toBe(2); // 1 tenant_bus_allocations + 1 bus_ischia_dist_allocations

      expect(store.tenantBusAllocations.filter((a) => a.service_id === OUTWARD_ID)).toHaveLength(0);
      expect(store.tenantBusAllocations.filter((a) => a.service_id === RETURN_ID)).toHaveLength(1);
    });
  });

  describe("Caso B — cancellazione scope='practice' di entrambe le gambe", () => {
    it("entrambe cancellate: status, assignment, smistamento Ischia e QR di ANDATA e RITORNO coerenti", async () => {
      const store = makeArPracticeStore();
      wireReadServiceSnapshot(store);
      const { admin } = makeAdmin(store);
      mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(admin));

      const { request, params } = makeRequest(OUTWARD_ID, { reason: "Cliente ha annullato", scope: "practice" });
      const res = await POST(request, { params });
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.service_ids.sort()).toEqual([OUTWARD_ID, RETURN_ID].sort());
      expect(json.assignments_cleared).toBe(2);

      expect(store.services.every((s) => s.status === "cancelled")).toBe(true);
      expect(store.assignments).toHaveLength(0);
      expect(store.busIschiaDistAllocations).toHaveLength(0);

      const outboundQr = await validateBusBookingQr(admin, OUTWARD_ID, "outbound", TOKEN_OUTBOUND);
      const returnQr = await validateBusBookingQr(admin, OUTWARD_ID, "return", TOKEN_RETURN);
      expect(outboundQr.state).toBe("cancelled");
      expect(returnQr.state).toBe("cancelled");
    });

    it("FIX VERIFICATO (migration 0245): ENTRAMBE le allocazioni Rete Bus continentale spariscono dopo scope='practice'", async () => {
      const store = makeArPracticeStore();
      wireReadServiceSnapshot(store);
      const { admin } = makeAdmin(store);
      mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(admin));

      const { request, params } = makeRequest(OUTWARD_ID, { reason: "Cliente ha annullato", scope: "practice" });
      const res = await POST(request, { params });
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.bus_allocations_cleared).toBe(4); // 2 tenant_bus_allocations + 2 bus_ischia_dist_allocations

      expect(store.tenantBusAllocations).toHaveLength(0);
    });
  });

  describe("Caso C — rollback atomico su errore durante la pulizia allocazioni", () => {
    it("errore su una gamba durante scope='practice' -> nessun ok:true, nessuno stato parziale su nessuna delle due tabelle bus ne' sugli status", async () => {
      const store = makeArPracticeStore();
      wireReadServiceSnapshot(store);
      // L'errore simulato colpisce la pulizia della gamba RITORNO, la seconda
      // processata nel loop: in una vera transazione Postgres questo annulla
      // anche le mutazioni gia' fatte per ANDATA nello stesso giro.
      const { admin, rpcSpy } = makeAdmin(store, { injectErrorForId: RETURN_ID });
      mocks.authorizePricingRequest.mockResolvedValue(makeAuthContext(admin));

      const { request, params } = makeRequest(OUTWARD_ID, { reason: "Cliente ha annullato", scope: "practice" });
      const res = await POST(request, { params });
      const json = await res.json();

      expect(rpcSpy).toHaveBeenCalledTimes(1);
      expect(res.status).not.toBe(200);
      expect(json).not.toHaveProperty("ok", true);
      expect(typeof json.error).toBe("string");

      // Nessuno stato parziale: ne' ANDATA ne' RITORNO risultano toccati.
      expect(store.services.find((s) => s.id === OUTWARD_ID)?.status).toBe("confirmed");
      expect(store.services.find((s) => s.id === RETURN_ID)?.status).toBe("confirmed");
      expect(store.assignments).toHaveLength(2);
      expect(store.tenantBusAllocations).toHaveLength(2);
      expect(store.busIschiaDistAllocations).toHaveLength(2);
      expect(store.statusEvents).toHaveLength(0);
      expect(store.opsAuditEvents).toHaveLength(0);

      // I QR di entrambe le gambe restano validi: nessuna cancellazione e' mai stata commit-ata.
      const outboundQr = await validateBusBookingQr(admin, OUTWARD_ID, "outbound", TOKEN_OUTBOUND);
      const returnQr = await validateBusBookingQr(admin, OUTWARD_ID, "return", TOKEN_RETURN);
      expect(outboundQr.state).toBe("valid");
      expect(returnQr.state).toBe("valid");
    });
  });
});
