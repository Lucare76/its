import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

/**
 * Data Integrity Sprint 9 — app/api/ops/bulk-delete-services/route.ts.
 *
 * Prima del fix: due loop separati su tutti i chunk (1° cancella
 * status_events+assignments per ogni chunk, SOLO DOPO un 2° loop cancella
 * services chunk per chunk). Un fallimento di services.delete su un chunk
 * qualsiasi lasciava orfani (status invariato, zero assignment — stessa
 * firma dei 36 record storici) anche i chunk successivi mai raggiunti dal
 * secondo loop. Dopo il fix: un solo loop per chunk, ogni chunk esegue
 * l'intera sequenza (snapshot → status_events.delete → assignments.delete →
 * services.delete con 1 retry → compensazione se persiste) prima di passare
 * al chunk successivo.
 */

type Row = Record<string, unknown>;

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OPERATOR_1 = "op111111-1111-4111-8111-111111111111";

function uuidFor(n: number): string {
  const hex = n.toString(16).padStart(8, "0");
  return `${hex}-0000-4000-8000-000000000000`;
}

const SERVICE_1 = uuidFor(1);
const SERVICE_2 = uuidFor(2);

/** Fake Supabase in-memory, tenant-aware — schema minimo per bulk-delete-services. */
function createTenantAwareSupabase(
  seed: Partial<Record<"services" | "assignments" | "status_events", Row[]>> = {}
) {
  const tables: Record<string, Row[]> = {
    services: [...(seed.services ?? [])],
    assignments: [...(seed.assignments ?? [])],
    status_events: [...(seed.status_events ?? [])],
  };

  const opErrorQueues: Record<string, Array<{ message: string } | null>> = {};
  let idCounter = 0;

  function nextOpError(opKey: string): { message: string } | null {
    const queue = opErrorQueues[opKey];
    if (!queue || queue.length === 0) return null;
    return queue.shift() ?? null;
  }

  function makeSelectBuilder(table: string) {
    let filtered = tables[table];
    const builder = {
      eq(field: string, value: unknown) {
        filtered = filtered.filter((r) => r[field] === value);
        return builder;
      },
      in(field: string, values: unknown[]) {
        filtered = filtered.filter((r) => values.includes(r[field]));
        return builder;
      },
      then(resolve: (v: { data: Row[] | null; error: { message: string } | null }) => unknown, reject?: (e: unknown) => unknown) {
        const err = nextOpError(`${table}.select`);
        if (err) return Promise.resolve({ data: null, error: err }).then(resolve, reject);
        return Promise.resolve({ data: filtered.map((r) => ({ ...r })), error: null }).then(resolve, reject);
      },
    };
    return builder;
  }

  function makeInsertBuilder(table: string, rowsArr: Row[]) {
    function settle() {
      const err = nextOpError(`${table}.insert`);
      if (err) return { data: null, error: err };
      const inserted = rowsArr.map((r) => ({ id: `${table}-restored-${++idCounter}`, ...r }));
      tables[table].push(...inserted);
      return { data: inserted, error: null };
    }
    return {
      then(resolve: (v: { data: Row[] | null; error: { message: string } | null }) => unknown, reject?: (e: unknown) => unknown) {
        return Promise.resolve(settle()).then(resolve, reject);
      },
    };
  }

  function makeDeleteBuilder(table: string, opts?: { count?: string }) {
    let filtered = tables[table];
    const builder = {
      eq(field: string, value: unknown) {
        filtered = filtered.filter((r) => r[field] === value);
        return builder;
      },
      in(field: string, values: unknown[]) {
        filtered = filtered.filter((r) => values.includes(r[field]));
        return builder;
      },
      then(resolve: (v: { data: null; error: { message: string } | null; count: number | null }) => unknown, reject?: (e: unknown) => unknown) {
        const err = nextOpError(`${table}.delete`);
        if (err) return Promise.resolve({ data: null, error: err, count: null }).then(resolve, reject);
        const toRemove = new Set(filtered);
        const matchCount = filtered.length;
        tables[table] = tables[table].filter((r) => !toRemove.has(r));
        return Promise.resolve({ data: null, error: null, count: opts?.count === "exact" ? matchCount : null }).then(resolve, reject);
      },
    };
    return builder;
  }

  const admin = {
    from(table: string) {
      return {
        select(_cols?: string) {
          return makeSelectBuilder(table);
        },
        insert(rowsOrRow: Row | Row[]) {
          return makeInsertBuilder(table, Array.isArray(rowsOrRow) ? rowsOrRow : [rowsOrRow]);
        },
        delete(opts?: { count?: string }) {
          return makeDeleteBuilder(table, opts);
        },
      };
    },
  };

  return {
    admin,
    tables,
    setOpErrorQueue(table: string, op: "select" | "insert" | "delete", queue: Array<{ message: string } | null>) {
      opErrorQueues[`${table}.${op}`] = [...queue];
    },
  };
}

const mocks = vi.hoisted(() => ({
  authorizePricingRequest: vi.fn(),
  auditLog: vi.fn(),
}));

vi.mock("@/lib/server/pricing-auth", () => ({
  authorizePricingRequest: mocks.authorizePricingRequest,
}));
vi.mock("@/lib/server/ops-audit", () => ({
  auditLog: mocks.auditLog,
}));

import { POST } from "@/app/api/ops/bulk-delete-services/route";

function baseSeed(overrides: Parameters<typeof createTenantAwareSupabase>[0] = {}) {
  return createTenantAwareSupabase({
    services: [{ id: SERVICE_1, tenant_id: TENANT_A, status: "assigned" }],
    assignments: [{ id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_1, driver_user_id: "d1", driver_profile_id: "dp1", vehicle_label: "Van 1", group_id: "grp-A" }],
    status_events: [{ id: "se-1", tenant_id: TENANT_A, service_id: SERVICE_1, status: "assigned" }],
    ...overrides,
  });
}

function authorizeAs(fake: ReturnType<typeof createTenantAwareSupabase>, userId: string = OPERATOR_1, role: string = "operator", tenantId: string = TENANT_A) {
  mocks.authorizePricingRequest.mockResolvedValue({
    admin: fake.admin,
    user: { id: userId, email: `${userId}@test.dev` },
    membership: { tenant_id: tenantId, role, suspended: false },
  });
}

function callPost(ids: string[]) {
  return POST(new NextRequest("http://localhost:3010/api/ops/bulk-delete-services", {
    method: "POST",
    headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    body: JSON.stringify({ ids }),
  }));
}

function auditDetails(): Row[] {
  return mocks.auditLog.mock.calls.map((call) => (call[0] as { details?: Row }).details ?? {});
}

describe("Data Integrity Sprint 9 — bulk-delete-services orphan prevention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("1. happy path: status_events + assignments + services tutti cancellati", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost([SERVICE_1]);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.deleted).toBe(1);
    expect(fake.tables.services.find((s) => s.id === SERVICE_1)).toBeUndefined();
    expect(fake.tables.assignments.length).toBe(0);
    expect(fake.tables.status_events.length).toBe(0);
  });

  it("2. assignments.delete fallisce: services NON cancellati, nessun ok:true, errore sanificato", async () => {
    const fake = baseSeed();
    fake.setOpErrorQueue("assignments", "delete", [{ message: "raw postgres constraint violation xyz" }]);
    authorizeAs(fake);

    const res = await callPost([SERVICE_1]);
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.ok).toBeUndefined();
    expect(body.error).toBeTruthy();
    expect(body.error).not.toMatch(/raw postgres constraint violation xyz/);
    expect(fake.tables.services.some((s) => s.id === SERVICE_1)).toBe(true);
    expect(fake.tables.assignments.length).toBe(1);
  });

  it("3. services.delete fallisce (2 tentativi) dopo assignments.delete riuscito: assignment ripristinato, mai ok:true", async () => {
    const fake = baseSeed();
    fake.setOpErrorQueue("services", "delete", [{ message: "fail 1" }, { message: "fail 2" }]);
    authorizeAs(fake);

    const res = await callPost([SERVICE_1]);
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.ok).toBeUndefined();
    expect(body.error).toMatch(/ripristinate/);
    expect(fake.tables.services.some((s) => s.id === SERVICE_1)).toBe(true);
    expect(fake.tables.assignments.length).toBe(1);
  });

  it("4. il restore preserva esattamente i valori precedenti (driver/vehicle/group_id), nessun mismatch", async () => {
    const fake = baseSeed();
    fake.setOpErrorQueue("services", "delete", [{ message: "fail 1" }, { message: "fail 2" }]);
    authorizeAs(fake);

    await callPost([SERVICE_1]);

    const restored = fake.tables.assignments.find((a) => a.service_id === SERVICE_1);
    expect(restored).toBeDefined();
    expect(restored?.driver_user_id).toBe("d1");
    expect(restored?.driver_profile_id).toBe("dp1");
    expect(restored?.vehicle_label).toBe("Van 1");
    expect(restored?.group_id).toBe("grp-A");
    // id omesso dallo snapshot, un nuovo id viene generato dal DB — mai lo
    // stesso id della riga cancellata (stesso pattern di
    // assign-service-core.ts/restoreDeletedOrphanAssignment).
    expect(restored?.id).not.toBe("asg-1");
    // Il service non è mai stato cancellato (services.delete è fallito):
    // resta coerente con l'assignment appena ripristinato.
    expect(fake.tables.services.find((s) => s.id === SERVICE_1)).toBeDefined();
  });

  it("5. la compensazione stessa fallisce: errore 'verifica manuale', mai un successo travestito", async () => {
    const fake = baseSeed();
    fake.setOpErrorQueue("services", "delete", [{ message: "fail 1" }, { message: "fail 2" }]);
    fake.setOpErrorQueue("assignments", "insert", [{ message: "restore also fails" }]);
    authorizeAs(fake);

    const res = await callPost([SERVICE_1]);
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.ok).toBeUndefined();
    expect(body.error).toMatch(/verifica manuale/);
    expect(fake.tables.assignments.length).toBe(0);
  });

  it("6. batch multi-chunk (501 id, chunk size 500): fallimento nel 2° chunk non tocca il 1° già completato, il 2° viene ripristinato", async () => {
    const services: Row[] = [];
    const assignments: Row[] = [];
    const statusEvents: Row[] = [];
    const ids: string[] = [];
    for (let i = 1; i <= 501; i += 1) {
      const id = uuidFor(i);
      ids.push(id);
      services.push({ id, tenant_id: TENANT_A, status: "assigned" });
      assignments.push({ id: `asg-${i}`, tenant_id: TENANT_A, service_id: id, driver_user_id: "d1", vehicle_label: "Van 1" });
      statusEvents.push({ id: `se-${i}`, tenant_id: TENANT_A, service_id: id, status: "assigned" });
    }
    const fake = createTenantAwareSupabase({ services, assignments, status_events: statusEvents });
    // 1° chiamata (chunk 1, 500 id) riesce; 2° chiamata (chunk 2, 1 id,
    // tentativo 1) fallisce; retry (tentativo 2) fallisce ancora.
    fake.setOpErrorQueue("services", "delete", [null, { message: "fail chunk2 try1" }, { message: "fail chunk2 try2" }]);
    authorizeAs(fake);

    const res = await callPost(ids);
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.ok).toBeUndefined();

    const chunk1Ids = ids.slice(0, 500);
    const chunk2Id = ids[500]!;

    for (const id of chunk1Ids) {
      expect(fake.tables.services.some((s) => s.id === id)).toBe(false);
      expect(fake.tables.assignments.some((a) => a.service_id === id)).toBe(false);
    }
    expect(fake.tables.services.some((s) => s.id === chunk2Id)).toBe(true);
    const restoredChunk2 = fake.tables.assignments.find((a) => a.service_id === chunk2Id);
    expect(restoredChunk2).toBeDefined();
    expect(restoredChunk2?.driver_user_id).toBe("d1");
  });

  it("7. tenant isolation: snapshot/restore non tocca mai righe di un altro tenant con lo stesso service_id", async () => {
    const fake = createTenantAwareSupabase({
      services: [{ id: SERVICE_1, tenant_id: TENANT_A, status: "assigned" }],
      assignments: [
        { id: "asg-a", tenant_id: TENANT_A, service_id: SERVICE_1, driver_user_id: "d1", vehicle_label: "Van 1" },
        { id: "asg-b", tenant_id: TENANT_B, service_id: SERVICE_1, driver_user_id: "d2", vehicle_label: "Van 2" },
      ],
      status_events: [],
    });
    fake.setOpErrorQueue("services", "delete", [{ message: "fail 1" }, { message: "fail 2" }]);
    authorizeAs(fake, OPERATOR_1, "operator", TENANT_A);

    await callPost([SERVICE_1]);

    // Il fallimento su TENANT_A ripristina solo la riga di TENANT_A; la riga
    // di TENANT_B non è mai stata toccata (delete/snapshot scoped su
    // tenant_id=TENANT_A) e resta invariata per costruzione.
    const tenantBRow = fake.tables.assignments.find((a) => a.tenant_id === TENANT_B);
    expect(tenantBRow).toBeDefined();
    expect(tenantBRow?.driver_user_id).toBe("d2");
    const tenantARows = fake.tables.assignments.filter((a) => a.tenant_id === TENANT_A);
    expect(tenantARows.length).toBe(1);
  });

  it("8. nessuna PII nei log di audit su fallimento", async () => {
    const fake = baseSeed({
      services: [{ id: SERVICE_1, tenant_id: TENANT_A, status: "assigned", customer_name: "Mario Rossi", phone: "+391234567", notes: "note riservate cliente" }],
    });
    fake.setOpErrorQueue("services", "delete", [{ message: "fail 1" }, { message: "fail 2" }]);
    fake.setOpErrorQueue("assignments", "insert", [{ message: "restore fails" }]);
    authorizeAs(fake);

    await callPost([SERVICE_1]);

    const details = auditDetails();
    expect(details.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(details);
    expect(serialized).not.toMatch(/Mario Rossi/);
    expect(serialized).not.toMatch(/\+391234567/);
    expect(serialized).not.toMatch(/note riservate/);
  });

  it("9. retry: services.delete fallisce una volta ma il retry riesce → nessuna compensazione, successo pieno", async () => {
    const fake = baseSeed();
    fake.setOpErrorQueue("services", "delete", [{ message: "transient" }, null]);
    authorizeAs(fake);

    const res = await callPost([SERVICE_1]);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.deleted).toBe(1);
    // Nessuna compensazione: assignments/services/status_events tutti vuoti,
    // non "ripristinati" — se la compensazione fosse scattata per errore,
    // l'assignment sarebbe di nuovo presente.
    expect(fake.tables.assignments.length).toBe(0);
    expect(fake.tables.services.length).toBe(0);
  });

  it("10. nessuna regressione su auth: una risposta 403 di authorizePricingRequest viene propagata senza toccare le tabelle", async () => {
    const fake = baseSeed();
    mocks.authorizePricingRequest.mockResolvedValue(
      NextResponse.json({ error: "Forbidden" }, { status: 403 })
    );

    const res = await callPost([SERVICE_1]);

    expect(res.status).toBe(403);
    expect(fake.tables.services.length).toBe(1);
    expect(fake.tables.assignments.length).toBe(1);
    expect(fake.tables.status_events.length).toBe(1);
  });
});
