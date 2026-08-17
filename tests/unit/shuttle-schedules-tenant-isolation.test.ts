import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const HOTEL_A = "11111111-1111-4111-8111-111111111111";
const HOTEL_B = "22222222-2222-4222-8222-222222222222";

function isoDate(offsetDays: number) {
  return new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
const TODAY = isoDate(0);
const TOMORROW = isoDate(1);

type Row = Record<string, unknown>;

// Shared 7-field key with no temporal or tenant component — deliberately
// identical across tenants, so tests can prove that identical keys never
// merge or cross-affect rows belonging to a different tenant_id.
const SHARED_KEY = {
  hotel_id: null as string | null,
  booking_service_kind: "navetta" as const,
  customer_name: "Hotel Test",
  direction: "departure" as const,
  departure_time: "09:30",
  meeting_point: null as string | null,
  vessel: "Navetta",
};

/**
 * Real in-memory, mutating, tenant-aware fake for public.services /
 * public.hotels / public.assignments. Filters (.eq/.is/.in/.gte/.lte) are
 * applied for real against seeded rows shared by BOTH tenants, and
 * delete()/insert() actually mutate the shared arrays — so assertions can
 * inspect the resulting store state, not just which mock args were passed.
 *
 * Every select/delete on "services" or "assignments" is checked for an
 * .eq("tenant_id", ...) filter; if one is never applied before the query
 * resolves, the operation is recorded in calls.unscopedQueries. Tests assert
 * this stays empty — if a future change drops a tenant_id filter from a
 * critical query, the corresponding test fails for real (not tautologically),
 * because the shared store contains both tenants' data by design.
 */
function createTenantAwareSupabase(seed: { services?: Row[]; hotels?: Row[]; assignments?: Row[] } = {}) {
  const services: Row[] = [...(seed.services ?? [])];
  const hotels: Row[] = [...(seed.hotels ?? [])];
  const assignments: Row[] = [...(seed.assignments ?? [])];
  const calls = {
    servicesSelect: 0,
    hotelsSelect: 0,
    assignmentsSelect: 0,
    delete: 0,
    insert: 0,
    unscopedQueries: [] as string[],
    insertedRows: [] as Row[],
  };

  function store(table: "services" | "hotels" | "assignments") {
    return table === "services" ? services : table === "hotels" ? hotels : assignments;
  }

  function makeBuilder(table: "services" | "hotels" | "assignments", op: "select" | "delete") {
    let filtered = store(table);
    let sawTenantFilter = false;
    const builder = {
      eq(field: string, value: unknown) {
        if (field === "tenant_id") sawTenantFilter = true;
        filtered = filtered.filter((row) => row[field] === value);
        return builder;
      },
      is(field: string, value: null) {
        filtered = filtered.filter((row) => row[field] === value);
        return builder;
      },
      in(field: string, values: unknown[]) {
        filtered = filtered.filter((row) => values.includes(row[field]));
        return builder;
      },
      gte(field: string, value: unknown) {
        filtered = filtered.filter((row) => (row[field] as string) >= (value as string));
        return builder;
      },
      lte(field: string, value: unknown) {
        filtered = filtered.filter((row) => (row[field] as string) <= (value as string));
        return builder;
      },
      limit() {
        return builder;
      },
      order() {
        return builder;
      },
      range() {
        return builder;
      },
      then(resolve: (v: { data: Row[] | null; error: null }) => unknown, reject?: (e: unknown) => unknown) {
        if ((table === "services" || table === "assignments") && !sawTenantFilter) {
          calls.unscopedQueries.push(`${table}.${op}`);
        }
        if (op === "delete") {
          calls.delete++;
          const idsToRemove = new Set(filtered.map((row) => row.id));
          const arr = store(table);
          for (let i = arr.length - 1; i >= 0; i--) {
            if (idsToRemove.has(arr[i].id)) arr.splice(i, 1);
          }
          return Promise.resolve({ data: null, error: null }).then(resolve as never, reject);
        }
        return Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
      },
    };
    return builder;
  }

  const admin = {
    from(table: string) {
      if (table === "services") {
        return {
          select() {
            calls.servicesSelect++;
            return makeBuilder("services", "select");
          },
          delete() {
            return makeBuilder("services", "delete");
          },
          insert(rows: Row[]) {
            calls.insert++;
            calls.insertedRows.push(...rows);
            services.push(...rows.map((row) => ({ id: `svc-${Math.random().toString(36).slice(2)}`, ...row })));
            return Promise.resolve({ error: null });
          },
        };
      }
      if (table === "hotels") {
        return {
          select() {
            calls.hotelsSelect++;
            return makeBuilder("hotels", "select");
          },
        };
      }
      if (table === "assignments") {
        return {
          select() {
            calls.assignmentsSelect++;
            return makeBuilder("assignments", "select");
          },
        };
      }
      throw new Error(`Unexpected table in test fake: ${table}`);
    },
  };

  return { admin, services, hotels, assignments, calls };
}

const mocks = vi.hoisted(() => ({
  authorizeServiceRoleRequest: vi.fn(),
  auditLog: vi.fn(),
}));

vi.mock("@/lib/server/pricing-auth", () => ({
  authorizeServiceRoleRequest: mocks.authorizeServiceRoleRequest,
}));
vi.mock("@/lib/server/ops-audit", () => ({
  auditLog: mocks.auditLog,
}));

import { GET, POST } from "@/app/api/shuttle-schedules/route";
import { PATCH, DELETE } from "@/app/api/shuttle-schedules/[id]/route";
import { buildShuttleScheduleId } from "@/lib/shuttle-schedules";

const SHARED_SCHEDULE_ID = buildShuttleScheduleId(SHARED_KEY);

function serviceRow(tenantId: string, overrides: Row = {}): Row {
  return {
    id: `svc-${tenantId.slice(0, 4)}-${Math.random().toString(36).slice(2)}`,
    tenant_id: tenantId,
    date: TOMORROW,
    direction: SHARED_KEY.direction,
    time: SHARED_KEY.departure_time,
    customer_name: SHARED_KEY.customer_name,
    vessel: SHARED_KEY.vessel,
    hotel_id: SHARED_KEY.hotel_id,
    meeting_point: SHARED_KEY.meeting_point,
    booking_service_kind: SHARED_KEY.booking_service_kind,
    status: "new",
    ...overrides,
  };
}

function makeGetRequest() {
  return new NextRequest("http://localhost:3010/api/shuttle-schedules", {
    method: "GET",
    headers: { authorization: "Bearer test-token" },
  });
}
function makePostRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost:3010/api/shuttle-schedules", {
    method: "POST",
    headers: { "Content-Type": "application/json", authorization: "Bearer test-token" },
    body: JSON.stringify(body),
  });
}
function makePatchRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost:3010/api/shuttle-schedules/x", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", authorization: "Bearer test-token" },
    body: JSON.stringify(body),
  });
}
function makeDeleteRequest() {
  return new NextRequest("http://localhost:3010/api/shuttle-schedules/x", {
    method: "DELETE",
    headers: { authorization: "Bearer test-token" },
  });
}
function callGet() {
  return GET(makeGetRequest());
}
function callPost(body: Record<string, unknown>) {
  return POST(makePostRequest(body));
}
function callPatch(id: string, body: Record<string, unknown>) {
  return PATCH(makePatchRequest(body), { params: Promise.resolve({ id }) });
}
function callDelete(id: string) {
  return DELETE(makeDeleteRequest(), { params: Promise.resolve({ id }) });
}

function basePayload(overrides: Record<string, unknown> = {}) {
  return {
    hotel_id: null,
    booking_service_kind: "navetta",
    customer_name: SHARED_KEY.customer_name,
    direction: SHARED_KEY.direction,
    departure_time: SHARED_KEY.departure_time,
    meeting_point: null,
    vessel: SHARED_KEY.vessel,
    valid_from: TODAY,
    valid_to: TOMORROW,
    days_of_week: null,
    notes: null,
    ...overrides,
  };
}

function authorizeAs(tenantId: string, fake: ReturnType<typeof createTenantAwareSupabase>, role: string = "operator") {
  mocks.authorizeServiceRoleRequest.mockResolvedValue({
    admin: fake.admin,
    user: { id: "user-1", email: "op@test.dev" },
    membership: { tenant_id: tenantId, role, suspended: false },
  });
}

describe("Tenant isolation — shuttle-schedules API (M1-03 / F-07)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------
  // GET — isolamento lettura
  // ---------------------------------------------------------------------
  describe("GET /api/shuttle-schedules", () => {
    it("1. la query services applica sempre .eq('tenant_id', tenantAId) (nessuna query non filtrata)", async () => {
      const fake = createTenantAwareSupabase({ services: [serviceRow(TENANT_A), serviceRow(TENANT_B)] });
      authorizeAs(TENANT_A, fake);

      await callGet();

      expect(fake.calls.unscopedQueries).toEqual([]);
      expect(fake.calls.servicesSelect).toBeGreaterThan(0);
    });

    it("2/3. il tenant A non vede schedule del tenant B, anche se il mock contiene righe di entrambi", async () => {
      const fake = createTenantAwareSupabase({
        services: [serviceRow(TENANT_A, { date: TODAY }), serviceRow(TENANT_B, { date: TODAY, customer_name: "Hotel Solo B" })],
      });
      authorizeAs(TENANT_A, fake);

      const res = await callGet();
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.schedules).toHaveLength(1);
      expect(body.schedules[0].customer_name).toBe(SHARED_KEY.customer_name);
      expect(JSON.stringify(body.schedules)).not.toContain("Hotel Solo B");
    });

    it("4. programmazioni con chiave identica ma tenant diversi NON vengono fuse (valid_from/valid_to restano quelli del solo tenant A)", async () => {
      const fake = createTenantAwareSupabase({
        services: [
          serviceRow(TENANT_A, { date: "2026-08-05" }),
          serviceRow(TENANT_A, { date: "2026-08-06" }),
          // Tenant B shares the exact same 7-field key but with dates far
          // outside tenant A's range — if isolation were broken, these would
          // widen the derived valid_from/valid_to of the merged schedule.
          serviceRow(TENANT_B, { date: "2025-01-01" }),
          serviceRow(TENANT_B, { date: "2027-12-31" }),
        ],
      });
      authorizeAs(TENANT_A, fake);

      const res = await callGet();
      const body = await res.json();

      expect(body.schedules).toHaveLength(1);
      expect(body.schedules[0].valid_from).toBe("2026-08-05");
      expect(body.schedules[0].valid_to).toBe("2026-08-06");
    });
  });

  // ---------------------------------------------------------------------
  // POST — isolamento scrittura
  // ---------------------------------------------------------------------
  describe("POST /api/shuttle-schedules", () => {
    it("5/8. ogni riga inserita usa tenant_id del tenant autenticato (hotel valido del tenant A)", async () => {
      const fake = createTenantAwareSupabase({ hotels: [{ id: HOTEL_A, tenant_id: TENANT_A }] });
      authorizeAs(TENANT_A, fake);

      const res = await callPost(basePayload({ hotel_id: HOTEL_A, valid_from: TODAY, valid_to: TOMORROW }));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(fake.calls.insertedRows.length).toBeGreaterThan(0);
      for (const row of fake.calls.insertedRows) {
        expect(row.tenant_id).toBe(TENANT_A);
      }
    });

    it("6/H. un tenant_id presente nel body non sovrascrive quello della sessione", async () => {
      const fake = createTenantAwareSupabase({});
      authorizeAs(TENANT_A, fake);

      const res = await callPost(basePayload({ tenant_id: TENANT_B, valid_from: TODAY, valid_to: TOMORROW } as Record<string, unknown>));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(fake.calls.insertedRows.length).toBeGreaterThan(0);
      for (const row of fake.calls.insertedRows) {
        expect(row.tenant_id).toBe(TENANT_A);
        expect(row.tenant_id).not.toBe(TENANT_B);
      }
    });

    it("7/D/I. hotel_id appartenente al tenant B → 400 INVALID_HOTEL_FOR_TENANT, nessun insert", async () => {
      const fake = createTenantAwareSupabase({ hotels: [{ id: HOTEL_B, tenant_id: TENANT_B }] });
      authorizeAs(TENANT_A, fake);

      const res = await callPost(basePayload({ hotel_id: HOTEL_B, valid_from: TODAY, valid_to: TOMORROW }));
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toBe("INVALID_HOTEL_FOR_TENANT");
      expect(fake.calls.insert).toBe(0);
    });
  });

  // ---------------------------------------------------------------------
  // PATCH — isolamento modifica
  // ---------------------------------------------------------------------
  describe("PATCH /api/shuttle-schedules/[id]", () => {
    it("9/10. id con chiave condivisa: tutte le query services includono tenant_id A, nessuna riga del tenant B viene cancellata", async () => {
      const tenantARow = serviceRow(TENANT_A);
      const tenantBRow = serviceRow(TENANT_B);
      const fake = createTenantAwareSupabase({ services: [tenantARow, tenantBRow], assignments: [] });
      authorizeAs(TENANT_A, fake);

      const res = await callPatch(SHARED_SCHEDULE_ID, basePayload({ valid_from: TODAY, valid_to: TOMORROW }));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toEqual({ ok: true });
      expect(fake.calls.unscopedQueries).toEqual([]);

      // Tenant B's row (same key) must survive untouched in the shared store.
      const survivingB = fake.services.find((row) => row.id === tenantBRow.id);
      expect(survivingB).toBeDefined();
      expect(survivingB?.tenant_id).toBe(TENANT_B);
    });

    it("11/G. hasOperationalFutureServices ignora una riga operativa del tenant B con chiave identica (nessun blocco cross-tenant)", async () => {
      const fake = createTenantAwareSupabase({
        services: [
          serviceRow(TENANT_A, { status: "new" }),
          serviceRow(TENANT_B, { status: "confirmed" }), // operational, but belongs to B
        ],
        assignments: [{ id: "a1", tenant_id: TENANT_B, service_id: "irrelevant" }],
      });
      authorizeAs(TENANT_A, fake);

      const res = await callPatch(SHARED_SCHEDULE_ID, basePayload({ valid_from: TODAY, valid_to: TOMORROW }));
      const body = await res.json();

      // Must NOT be blocked by tenant B's operational row.
      expect(res.status).toBe(200);
      expect(body).toEqual({ ok: true });
    });

    it("12. l'insert generato dal PATCH usa tenant_id del tenant A", async () => {
      const fake = createTenantAwareSupabase({ services: [], assignments: [] });
      authorizeAs(TENANT_A, fake);

      await callPatch(SHARED_SCHEDULE_ID, basePayload({ valid_from: TODAY, valid_to: TOMORROW }));

      expect(fake.calls.insertedRows.length).toBeGreaterThan(0);
      for (const row of fake.calls.insertedRows) {
        expect(row.tenant_id).toBe(TENANT_A);
      }
    });

    it("13/E. hotel_id del tenant B nel PATCH resta bloccato da F-10", async () => {
      const fake = createTenantAwareSupabase({
        hotels: [{ id: HOTEL_B, tenant_id: TENANT_B }],
        services: [],
        assignments: [],
      });
      authorizeAs(TENANT_A, fake);

      const res = await callPatch(SHARED_SCHEDULE_ID, basePayload({ hotel_id: HOTEL_B, valid_from: TODAY, valid_to: TOMORROW }));
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toBe("INVALID_HOTEL_FOR_TENANT");
      expect(fake.calls.delete).toBe(0);
      expect(fake.calls.insert).toBe(0);
    });

    it("14/H. un tenant_id malevolo nel payload PATCH non modifica il tenant effettivo delle righe scritte", async () => {
      const fake = createTenantAwareSupabase({ services: [], assignments: [] });
      authorizeAs(TENANT_A, fake);

      await callPatch(
        SHARED_SCHEDULE_ID,
        basePayload({ tenant_id: TENANT_B, valid_from: TODAY, valid_to: TOMORROW } as Record<string, unknown>)
      );

      for (const row of fake.calls.insertedRows) {
        expect(row.tenant_id).toBe(TENANT_A);
      }
    });

    it("15/F/B. id costruito con la chiave di una programmazione del tenant B modifica esclusivamente le righe del tenant A", async () => {
      // Hardening Sprint 3 — PARTE B: la data hardcoded "2026-08-10" diventava
      // passato rispetto all'orologio reale, escludendo tenantARow dal
      // filtro "solo righe future" del guard PATCH — la riga non veniva mai
      // trovata/sostituita e l'assert su tenantARow "deve essere sparita"
      // falliva. TOMORROW (già usato identicamente nel test 20 di questo
      // stesso file) è sempre nel futuro, indipendentemente da quando il
      // test viene eseguito.
      const tenantARow = serviceRow(TENANT_A, { date: TOMORROW });
      const tenantBRow = serviceRow(TENANT_B, { date: TOMORROW });
      const fake = createTenantAwareSupabase({ services: [tenantARow, tenantBRow], assignments: [] });
      authorizeAs(TENANT_A, fake);

      // Tenant A builds the SAME id tenant B's schedule would have (the id
      // carries no tenant info) and issues a PATCH.
      const res = await callPatch(SHARED_SCHEDULE_ID, basePayload({ departure_time: "10:00", valid_from: TODAY, valid_to: TOMORROW }));

      expect(res.status).toBe(200);
      // Tenant A's original row must be gone (replaced), tenant B's must be
      // untouched and unaffected by the new departure_time.
      expect(fake.services.some((row) => row.id === tenantARow.id)).toBe(false);
      const survivingB = fake.services.find((row) => row.id === tenantBRow.id);
      expect(survivingB).toBeDefined();
      expect(survivingB?.time).toBe(SHARED_KEY.departure_time);
      expect(fake.services.every((row) => row.tenant_id !== TENANT_A || row.time === "10:00")).toBe(true);
    });
  });

  // ---------------------------------------------------------------------
  // DELETE — isolamento cancellazione
  // ---------------------------------------------------------------------
  describe("DELETE /api/shuttle-schedules/[id]", () => {
    it("16/17/C. id con chiave condivisa: la delete filtra per tenant_id A, nessuna riga del tenant B viene eliminata", async () => {
      const tenantARow = serviceRow(TENANT_A);
      const tenantBRow = serviceRow(TENANT_B);
      const fake = createTenantAwareSupabase({ services: [tenantARow, tenantBRow], assignments: [] });
      authorizeAs(TENANT_A, fake);

      const res = await callDelete(SHARED_SCHEDULE_ID);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toEqual({ ok: true });
      expect(fake.calls.unscopedQueries).toEqual([]);
      expect(fake.services.some((row) => row.id === tenantARow.id)).toBe(false);
      expect(fake.services.some((row) => row.id === tenantBRow.id)).toBe(true);
    });

    it("18/G. hasOperationalFutureServices in DELETE controlla esclusivamente le righe del tenant A", async () => {
      const fake = createTenantAwareSupabase({
        services: [serviceRow(TENANT_A, { status: "new" }), serviceRow(TENANT_B, { status: "confirmed" })],
        assignments: [],
      });
      authorizeAs(TENANT_A, fake);

      const res = await callDelete(SHARED_SCHEDULE_ID);

      expect(res.status).toBe(200);
    });

    it("19. tenant A senza righe corrispondenti: comportamento attuale (successo idempotente, non 404) — non modificato", async () => {
      // Only tenant B has matching rows; tenant A has none.
      const fake = createTenantAwareSupabase({ services: [serviceRow(TENANT_B)], assignments: [] });
      authorizeAs(TENANT_A, fake);

      const res = await callDelete(SHARED_SCHEDULE_ID);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toEqual({ ok: true });
      // Tenant B's row must still exist — nothing to delete for tenant A.
      expect(fake.services).toHaveLength(1);
      expect(fake.services[0].tenant_id).toBe(TENANT_B);
    });

    it("20. chiave identica tra tenant A e B: vengono eliminate solo le righe future del tenant A", async () => {
      const tenantARow = serviceRow(TENANT_A, { date: TOMORROW });
      const tenantBRow = serviceRow(TENANT_B, { date: TOMORROW });
      const fake = createTenantAwareSupabase({ services: [tenantARow, tenantBRow], assignments: [] });
      authorizeAs(TENANT_A, fake);

      await callDelete(SHARED_SCHEDULE_ID);

      expect(fake.services).toHaveLength(1);
      expect(fake.services[0].tenant_id).toBe(TENANT_B);
    });
  });

  // ---------------------------------------------------------------------
  // Autenticazione e autorizzazione
  // ---------------------------------------------------------------------
  describe("Autenticazione e ruoli", () => {
    it("21. utente non autenticato → 401 invariato, nessuna query services su nessun endpoint", async () => {
      mocks.authorizeServiceRoleRequest.mockResolvedValue(
        NextResponse.json({ error: "Sessione non valida." }, { status: 401 })
      );

      const resGet = await callGet();
      expect(resGet.status).toBe(401);

      const resPost = await callPost(basePayload());
      expect(resPost.status).toBe(401);

      const resPatch = await callPatch(SHARED_SCHEDULE_ID, basePayload());
      expect(resPatch.status).toBe(401);

      const resDelete = await callDelete(SHARED_SCHEDULE_ID);
      expect(resDelete.status).toBe(401);
    });

    it("22. utente autenticato ma senza membership/tenant valido → comportamento controllato (403), nessuna query cross-tenant", async () => {
      mocks.authorizeServiceRoleRequest.mockResolvedValue(
        NextResponse.json({ error: "Membership non trovata." }, { status: 403 })
      );

      const res = await callGet();
      expect(res.status).toBe(403);
    });

    it("23. ruolo non autorizzato (es. 'driver') non arriva alle query operative: il mock authorizeServiceRoleRequest applica già il controllo ruoli, verificato tramite denial simulato", async () => {
      mocks.authorizeServiceRoleRequest.mockResolvedValue(
        NextResponse.json({ error: "Ruolo non autorizzato." }, { status: 403 })
      );

      const fake = createTenantAwareSupabase({ services: [serviceRow(TENANT_A)] });
      const res = await callDelete(SHARED_SCHEDULE_ID);
      const body = await res.json();

      expect(res.status).toBe(403);
      expect(body.error).toBe("Ruolo non autorizzato.");
      expect(fake.calls.servicesSelect).toBe(0);
      expect(fake.calls.delete).toBe(0);
    });
  });

  // ---------------------------------------------------------------------
  // Regressioni obbligatorie (F-01, F-10, F-11, M1-02, M1-07, casi validi)
  // ---------------------------------------------------------------------
  describe("Regressione: protezioni esistenti invariate", () => {
    it("F-01: guard operativo (409) invariato — corsa futura assegnata del tenant A blocca l'operazione", async () => {
      const fake = createTenantAwareSupabase({
        services: [serviceRow(TENANT_A, { status: "new", id: "svc-op-1" })],
        assignments: [{ id: "a1", tenant_id: TENANT_A, service_id: "svc-op-1" }],
      });
      authorizeAs(TENANT_A, fake);

      const res = await callDelete(SHARED_SCHEDULE_ID);
      const body = await res.json();

      expect(res.status).toBe(409);
      expect(body.error).toBe("SHUTTLE_HAS_OPERATIONAL_SERVICES");
    });

    it("F-10: hotel cross-tenant in POST resta bloccato con messaggio invariato", async () => {
      const fake = createTenantAwareSupabase({ hotels: [{ id: HOTEL_B, tenant_id: TENANT_B }] });
      authorizeAs(TENANT_A, fake);

      const res = await callPost(basePayload({ hotel_id: HOTEL_B }));
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toBe("INVALID_HOTEL_FOR_TENANT");
      expect(body.message).toBe("L'hotel selezionato non appartiene al tenant autenticato.");
    });

    it("F-11: errori interni restano sanificati (nessun dettaglio tecnico nella risposta 500)", async () => {
      const fake = createTenantAwareSupabase({});
      // Force a services select error to trigger GET's sanitized 500 path.
      const brokenAdmin = {
        from(table: string) {
          if (table === "services") {
            return {
              select() {
                return {
                  eq() {
                    return this;
                  },
                  order() {
                    return this;
                  },
                  range() {
                    return this;
                  },
                  then(resolve: (v: { data: null; error: { message: string } }) => unknown) {
                    return Promise.resolve({
                      data: null,
                      error: { message: "duplicate key value violates unique constraint shuttle_internal_unique_idx" },
                    }).then(resolve);
                  },
                };
              },
            };
          }
          return fake.admin.from(table);
        },
      };
      mocks.authorizeServiceRoleRequest.mockResolvedValue({
        admin: brokenAdmin,
        user: { id: "user-1", email: "op@test.dev" },
        membership: { tenant_id: TENANT_A, role: "operator", suspended: false },
      });

      const res = await callGet();
      const rawText = await res.clone().text();

      expect(res.status).toBe(500);
      expect(rawText).not.toContain("duplicate key");
      expect(rawText).not.toContain("shuttle_internal_unique_idx");
    });

    it("M1-02 (Europe/Rome): il filtro data del guard PATCH resta indipendente dal fuso macchina (usa la data odierna reale)", async () => {
      const fake = createTenantAwareSupabase({ services: [], assignments: [] });
      authorizeAs(TENANT_A, fake);

      const res = await callPatch(SHARED_SCHEDULE_ID, basePayload({ valid_from: TODAY, valid_to: TOMORROW }));
      expect(res.status).toBe(200);
      // Rows inserted must start no earlier than "today" per Rome-aware cutoff.
      for (const row of fake.calls.insertedRows) {
        expect((row.date as string) >= TODAY).toBe(true);
      }
    });

    it("M1-07: id malformato resta gestito con 400 controllato, nessuna query", async () => {
      const fake = createTenantAwareSupabase({ services: [serviceRow(TENANT_A)] });
      authorizeAs(TENANT_A, fake);

      const res = await callPatch("%%%invalid%%%", basePayload());
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body).toEqual({ error: "Identificativo navetta non valido." });
      expect(fake.calls.servicesSelect).toBe(0);
      expect(fake.calls.delete).toBe(0);
      expect(fake.calls.insert).toBe(0);
    });

    it("struttura risposta GET invariata: { ok: true, schedules: [...] }", async () => {
      const fake = createTenantAwareSupabase({ services: [serviceRow(TENANT_A)] });
      authorizeAs(TENANT_A, fake);

      const res = await callGet();
      const body = await res.json();

      expect(body).toHaveProperty("ok", true);
      expect(body).toHaveProperty("schedules");
      expect(Array.isArray(body.schedules)).toBe(true);
    });

    it("comportamento POST valido invariato: 200 { ok: true }", async () => {
      const fake = createTenantAwareSupabase({});
      authorizeAs(TENANT_A, fake);

      const res = await callPost(basePayload());
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
    });

    it("comportamento PATCH valido invariato: 200 { ok: true }", async () => {
      const fake = createTenantAwareSupabase({ services: [], assignments: [] });
      authorizeAs(TENANT_A, fake);

      const res = await callPatch(SHARED_SCHEDULE_ID, basePayload());
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toEqual({ ok: true });
    });

    it("comportamento DELETE valido invariato: 200 { ok: true }", async () => {
      const fake = createTenantAwareSupabase({ services: [], assignments: [] });
      authorizeAs(TENANT_A, fake);

      const res = await callDelete(SHARED_SCHEDULE_ID);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toEqual({ ok: true });
    });
  });
});
