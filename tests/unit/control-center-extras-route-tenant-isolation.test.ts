import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TEST_DATE = "2026-09-05";

type Row = Record<string, unknown>;
type TableName = "services" | "hotels" | "assignments" | "booking_approval_tokens" | "cancellation_requests" | "whatsapp_events";

/**
 * Fake Supabase in-memory, tenant-aware, per le 6 tabelle lette da
 * app/api/ops/control-center-extras/route.ts. Ogni query viene filtrata per
 * davvero (eq/neq/in) contro righe seedate condivise da entrambi i tenant:
 * se una futura modifica rimuovesse un filtro tenant_id, i test cross-tenant
 * sotto falliscono per davvero, non solo tautologicamente.
 */
function createTenantAwareSupabase(seed: Partial<Record<TableName, Row[]>> = {}) {
  const tables: Record<TableName, Row[]> = {
    services: [...(seed.services ?? [])],
    hotels: [...(seed.hotels ?? [])],
    assignments: [...(seed.assignments ?? [])],
    booking_approval_tokens: [...(seed.booking_approval_tokens ?? [])],
    cancellation_requests: [...(seed.cancellation_requests ?? [])],
    whatsapp_events: [...(seed.whatsapp_events ?? [])],
  };
  const calls = { unscopedQueries: [] as string[] };

  function makeBuilder(table: TableName) {
    let filtered = tables[table];
    let sawTenantFilter = false;
    const builder = {
      eq(field: string, value: unknown) {
        if (field === "tenant_id") sawTenantFilter = true;
        filtered = filtered.filter((row) => row[field] === value);
        return builder;
      },
      neq(field: string, value: unknown) {
        filtered = filtered.filter((row) => row[field] !== value);
        return builder;
      },
      in(field: string, values: unknown[]) {
        filtered = filtered.filter((row) => values.includes(row[field]));
        return builder;
      },
      order() {
        return builder;
      },
      limit() {
        return builder;
      },
      then(resolve: (v: { data: Row[]; error: null }) => unknown, reject?: (e: unknown) => unknown) {
        if (!sawTenantFilter) calls.unscopedQueries.push(table);
        return Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
      },
    };
    return builder;
  }

  const admin = {
    from(table: string) {
      return {
        select() {
          return makeBuilder(table as TableName);
        },
      };
    },
  };

  return { admin, tables, calls };
}

const mocks = vi.hoisted(() => ({ authorizePricingRequest: vi.fn() }));
vi.mock("@/lib/server/pricing-auth", () => ({ authorizePricingRequest: mocks.authorizePricingRequest }));

import { GET } from "@/app/api/ops/control-center-extras/route";

function authorizeAs(tenantId: string, fake: ReturnType<typeof createTenantAwareSupabase>, role = "operator") {
  mocks.authorizePricingRequest.mockResolvedValue({
    admin: fake.admin,
    user: { id: "user-1", email: "op@test.dev" },
    membership: { tenant_id: tenantId, role, suspended: false },
  });
}

function callGet(date = TEST_DATE) {
  return GET(
    new NextRequest(`http://localhost:3010/api/ops/control-center-extras?date=${date}`, {
      headers: { authorization: "Bearer test-token" },
    })
  );
}

function serviceRow(tenantId: string, overrides: Row = {}): Row {
  return {
    id: `svc-${tenantId.slice(0, 4)}-${Math.random().toString(36).slice(2)}`,
    tenant_id: tenantId,
    date: TEST_DATE,
    time: "09:00",
    status: "new",
    is_draft: false,
    customer_name: "Cliente",
    pax: 2,
    hotel_id: null,
    approval_status: null,
    created_at: "2026-09-01T08:00:00Z",
    ...overrides,
  };
}

describe("Tenant isolation e RBAC — /api/ops/control-center-extras", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ruolo non autorizzato (es. 'driver') → risposta di authorizePricingRequest rispettata, nessuna query eseguita", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Ruolo non autorizzato." }, { status: 403 }));
    createTenantAwareSupabase({ services: [serviceRow(TENANT_A)] });

    const res = await callGet();
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe("Ruolo non autorizzato.");
  });

  it("ruolo 'supervisor' è autorizzato su questo endpoint (200) — la restrizione su /pdf-imports è gestita dalla pagina, non qui", async () => {
    const fake = createTenantAwareSupabase({});
    authorizeAs(TENANT_A, fake, "supervisor");

    const res = await callGet();
    expect(res.status).toBe(200);
  });

  it("nessuna query su nessuna delle 6 tabelle è mai priva di filtro tenant_id", async () => {
    const fake = createTenantAwareSupabase({
      services: [serviceRow(TENANT_A), serviceRow(TENANT_B)],
      hotels: [{ id: "h1", tenant_id: TENANT_A, name: "Hotel A", zone: "Ischia", lat: null, lng: null }],
    });
    authorizeAs(TENANT_A, fake);

    await callGet();

    expect(fake.calls.unscopedQueries).toEqual([]);
  });

  it("header.services_count conta solo i servizi del tenant autenticato, mai quelli del tenant B", async () => {
    const fake = createTenantAwareSupabase({
      services: [serviceRow(TENANT_A), serviceRow(TENANT_A), serviceRow(TENANT_B)],
    });
    authorizeAs(TENANT_A, fake);

    const res = await callGet();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.header.services_count).toBe(2);
  });

  it("prenotazioni agenzia pendenti del tenant B non compaiono mai nella risposta del tenant A, anche con lo stesso approval_status", async () => {
    const fake = createTenantAwareSupabase({
      services: [
        serviceRow(TENANT_A, { id: "svc-a-pending", approval_status: "pending_operator" }),
        serviceRow(TENANT_B, { id: "svc-b-pending", approval_status: "pending_operator", customer_name: "Solo B" }),
      ],
    });
    authorizeAs(TENANT_A, fake);

    const res = await callGet();
    const body = await res.json();

    expect(body.agency_approvals_pending.count).toBe(1);
    expect(body.agency_approvals_pending.items[0].service_id).toBe("svc-a-pending");
    expect(JSON.stringify(body.agency_approvals_pending.items)).not.toContain("Solo B");
  });

  it("cancellation_requests del tenant B non contaminano il conteggio del tenant A", async () => {
    const fake = createTenantAwareSupabase({
      cancellation_requests: [
        { id: "cr-a", tenant_id: TENANT_A, service_id: "svc-a", status: "pending_review", created_at: "2026-09-01T08:00:00Z" },
        { id: "cr-b", tenant_id: TENANT_B, service_id: "svc-b", status: "pending_review", created_at: "2026-09-01T08:00:00Z" },
      ],
    });
    authorizeAs(TENANT_A, fake);

    const res = await callGet();
    const body = await res.json();

    expect(body.cancellation_requests_pending.count).toBe(1);
    expect(body.cancellation_requests_pending.items[0].id).toBe("cr-a");
  });

  it("whatsapp_events falliti del tenant B non contaminano whatsapp_failed del tenant A, anche per lo stesso service_id casuale", async () => {
    const fake = createTenantAwareSupabase({
      services: [serviceRow(TENANT_A, { id: "shared-id" })],
      whatsapp_events: [
        { tenant_id: TENANT_A, service_id: "shared-id", kind: "info_3d", status: "failed", happened_at: "2026-09-05T09:00:00Z", to_phone: "+390000001", template: "t" },
        { tenant_id: TENANT_B, service_id: "shared-id", kind: "info_3d", status: "failed", happened_at: "2026-09-05T09:00:00Z", to_phone: "+390000002", template: "t" },
      ],
    });
    authorizeAs(TENANT_A, fake);

    const res = await callGet();
    const body = await res.json();

    expect(body.whatsapp_failed.count).toBe(1);
    expect(body.whatsapp_failed.items[0].to_phone).toBe("+390000001");
  });

  it("assignments del tenant B non influenzano assignable_unassigned del tenant A", async () => {
    const fake = createTenantAwareSupabase({
      services: [serviceRow(TENANT_A, { id: "svc-a" })],
      assignments: [{ tenant_id: TENANT_B, service_id: "svc-a", driver_user_id: "driver-b", vehicle_label: "Bus B" }],
    });
    authorizeAs(TENANT_A, fake);

    const res = await callGet();
    const body = await res.json();

    // L'assignment del tenant B (stesso service_id per costruzione del test)
    // non deve marcare il servizio del tenant A come "già assegnato".
    expect(res.status).toBe(200);
    expect(body.header.drivers_in_use_count).toBe(0);
    expect(body.header.buses_in_use_count).toBe(0);
  });

  it("struttura risposta invariata: { ok:true, header, assignable_unassigned, agency_approvals_pending, cancellation_requests_pending, whatsapp_failed }", async () => {
    const fake = createTenantAwareSupabase({});
    authorizeAs(TENANT_A, fake);

    const res = await callGet();
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body).toHaveProperty("header");
    expect(body).toHaveProperty("assignable_unassigned");
    expect(body).toHaveProperty("agency_approvals_pending");
    expect(body).toHaveProperty("cancellation_requests_pending");
    expect(body).toHaveProperty("whatsapp_failed");
    expect(body.whatsapp_failed.kind).toBe("info_3d");
  });

  it("data non valida → 400 controllato", async () => {
    const fake = createTenantAwareSupabase({});
    authorizeAs(TENANT_A, fake);

    const res = await callGet("not-a-date");
    expect(res.status).toBe(400);
  });
});
