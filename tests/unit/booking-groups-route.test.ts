import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";

/**
 * FASE 1 — /api/ops/booking-groups.
 * Verifica: creazione gruppo incompleto, add_stop senza service/allocazione,
 * bus reservation DATE-SCOPED che non tocca tenant_bus_units, override ferry
 * che non tocca bus_line_ferry_config, integrità tenant.
 */

const mocks = vi.hoisted(() => ({ authorizePricingRequest: vi.fn(), autoAllocateBusService: vi.fn() }));
vi.mock("@/lib/server/pricing-auth", () => ({ authorizePricingRequest: mocks.authorizePricingRequest }));
vi.mock("@/lib/server/bus-auto-allocation", () => ({ autoAllocateBusService: mocks.autoAllocateBusService }));

import { GET, POST } from "@/app/api/ops/booking-groups/route";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_TENANT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const GROUP_ID = "11111111-1111-4111-8111-111111111111";
const BUS_UNIT_ID = "22222222-2222-4222-8222-222222222222";
const AGENCY_ID = "33333333-3333-4333-8333-333333333333";
const STOP_ID = "44444444-4444-4444-8444-444444444444";

type Row = Record<string, unknown>;

function makeAdmin(seed: Record<string, Row[]> = {}) {
  const writes = {
    inserts: [] as Array<{ table: string; row: Row }>,
    updates: [] as Array<{ table: string; filters: Row; payload: Row }>,
    deletes: [] as Array<{ table: string; filters: Row }>,
    upserts: [] as Array<{ table: string; row: Row; options: unknown }>,
  };
  let seq = 0;

  function builder(table: string) {
    const filters: Row = {};
    let pending: { kind: "insert" | "update" | "upsert" | "delete"; payload?: Row; options?: unknown } | null = null;

    const rowsForFilters = () =>
      (seed[table] ?? []).filter((r) => Object.entries(filters).every(([k, v]) => r[k] === v));

    const finish = () => {
      if (pending?.kind === "insert") {
        const row = { id: `${table}-${++seq}`, ...(pending.payload ?? {}) };
        writes.inserts.push({ table, row });
        return { data: row, error: null };
      }
      if (pending?.kind === "update") {
        writes.updates.push({ table, filters: { ...filters }, payload: pending.payload ?? {} });
        return { data: { id: filters.id, ...(pending.payload ?? {}) }, error: null };
      }
      if (pending?.kind === "upsert") {
        const row = { id: `${table}-${++seq}`, ...(pending.payload ?? {}) };
        writes.upserts.push({ table, row, options: pending.options });
        return { data: row, error: null };
      }
      return { data: null, error: null };
    };

    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.order = () => b;
    b.limit = () => b;
    b.in = () => b;
    b.eq = (col: string, val: unknown) => { filters[col] = val; return b; };
    b.maybeSingle = async () => (pending ? finish() : { data: rowsForFilters()[0] ?? null, error: null });
    b.single = async () => (pending ? finish() : { data: rowsForFilters()[0] ?? null, error: null });
    b.insert = (payload: Row) => { pending = { kind: "insert", payload }; return b; };
    b.update = (payload: Row) => { pending = { kind: "update", payload }; return b; };
    b.upsert = (payload: Row, options: unknown) => { pending = { kind: "upsert", payload, options }; return b; };
    b.delete = () => { pending = { kind: "delete" }; return b; };
    b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      if (pending?.kind === "delete") {
        writes.deletes.push({ table, filters: { ...filters } });
        return Promise.resolve({ data: null, error: null }).then(resolve, reject);
      }
      if (pending) {
        // insert/update/upsert awaitati senza .single()
        return Promise.resolve(finish()).then(resolve, reject);
      }
      return Promise.resolve({ data: rowsForFilters(), error: null }).then(resolve, reject);
    };
    return b;
  }

  return { admin: { from: (t: string) => builder(t) } as never, writes };
}

function authCtx(admin: unknown, role = "operator") {
  return { admin, user: { id: "u1", email: "op@test.it" }, membership: { tenant_id: TENANT, role, suspended: false } };
}

function post(body: unknown) {
  return new NextRequest("http://localhost/api/ops/booking-groups", { method: "POST", body: JSON.stringify(body) });
}
function get(qs = "") {
  return new NextRequest(`http://localhost/api/ops/booking-groups${qs}`, { method: "GET" });
}

beforeEach(() => { vi.clearAllMocks(); mocks.autoAllocateBusService.mockResolvedValue({ allocated: false }); });

describe("POST create_group — gruppo incompleto (scenario Parrocchia Natività)", () => {
  it("A/B/C: crea 50 pax bus_exclusive to_complete senza fermate/nominativi/nave/hotel", async () => {
    const { admin, writes } = makeAdmin();
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    const res = await POST(post({
      action: "create_group",
      name: "Parrocchia Natività",
      expected_pax: 50,
      kind: "bus_exclusive",
      status: "to_complete",
      service_date: "2026-09-12",
    }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.group).toBeTruthy();

    const bgInserts = writes.inserts.filter((w) => w.table === "booking_groups");
    expect(bgInserts).toHaveLength(1);
    expect(bgInserts[0]!.row).toMatchObject({
      tenant_id: TENANT,
      name: "Parrocchia Natività",
      expected_pax: 50,
      kind: "bus_exclusive",
      status: "to_complete",
      service_date: "2026-09-12",
      created_by_user_id: "u1",
    });
    expect(writes.inserts.filter((w) => w.table === "services")).toHaveLength(0);
    expect(writes.inserts.filter((w) => w.table === "tenant_bus_allocations")).toHaveLength(0);
    expect(writes.inserts.filter((w) => w.table === "booking_group_stops")).toHaveLength(0);
    expect(bgInserts[0]!.row.outbound_ferry_company).toBeUndefined();
  });

  it("expected_pax = 0 → 400 (zod)", async () => {
    const { admin } = makeAdmin();
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));
    const res = await POST(post({ action: "create_group", name: "X", expected_pax: 0 }));
    expect(res.status).toBe(400);
  });

  it("agency_id di un altro tenant → 400 (integrità tenant)", async () => {
    const { admin } = makeAdmin({ agencies: [{ id: AGENCY_ID, tenant_id: OTHER_TENANT }] });
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));
    const res = await POST(post({ action: "create_group", name: "X", expected_pax: 10, agency_id: AGENCY_ID }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Agenzia/i);
  });

  it("J: override ferry gruppo NON tocca bus_line_ferry_config", async () => {
    const { admin, writes } = makeAdmin();
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));
    const res = await POST(post({
      action: "create_group",
      name: "Parrocchia Natività",
      expected_pax: 50,
      outbound_ferry_company: "MEDMAR",
      outbound_ferry_time: "10:35",
      outbound_expected_arrival_time: "12:05",
    }));
    expect(res.status).toBe(200);
    const row = writes.inserts.find((w) => w.table === "booking_groups")!.row;
    expect(row).toMatchObject({ outbound_ferry_company: "MEDMAR", outbound_ferry_time: "10:35", outbound_expected_arrival_time: "12:05" });
    expect([...writes.inserts, ...writes.updates, ...writes.upserts].some((w) => (w as { table: string }).table === "bus_line_ferry_config")).toBe(false);
  });
});

describe("POST add_stop — pianificazione fermata, nessun service/allocazione", () => {
  it("città e punto di carico separati, stop_id null, nessuna tenant_bus_allocation", async () => {
    const { admin, writes } = makeAdmin({ booking_groups: [{ id: GROUP_ID, tenant_id: TENANT }] });
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    const res = await POST(post({
      action: "add_stop",
      booking_group_id: GROUP_ID,
      city: "Tivoli",
      pickup_point: "Villa d'Este",
      expected_pax: 20,
      direction: "arrival",
    }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    const stopInserts = writes.inserts.filter((w) => w.table === "booking_group_stops");
    expect(stopInserts).toHaveLength(1);
    expect(stopInserts[0]!.row).toMatchObject({
      tenant_id: TENANT,
      booking_group_id: GROUP_ID,
      city: "Tivoli",
      pickup_point: "Villa d'Este",
      expected_pax: 20,
      direction: "arrival",
      sort_order: 0,
    });
    expect(stopInserts[0]!.row.stop_id).toBeUndefined();
    expect(writes.inserts.filter((w) => w.table === "services")).toHaveLength(0);
    expect(writes.inserts.filter((w) => w.table === "tenant_bus_allocations")).toHaveLength(0);
  });

  it("stop_id di un altro tenant → 400", async () => {
    const { admin } = makeAdmin({
      booking_groups: [{ id: GROUP_ID, tenant_id: TENANT }],
      tenant_bus_line_stops: [{ id: STOP_ID, tenant_id: OTHER_TENANT }],
    });
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));
    const res = await POST(post({
      action: "add_stop", booking_group_id: GROUP_ID, city: "Tivoli", expected_pax: 20, direction: "arrival", stop_id: STOP_ID,
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Fermata catalogo/i);
  });

  it("gruppo inesistente → 404", async () => {
    const { admin } = makeAdmin();
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));
    const res = await POST(post({ action: "add_stop", booking_group_id: GROUP_ID, city: "X", expected_pax: 5, direction: "arrival" }));
    expect(res.status).toBe(404);
  });
});

describe("POST upsert_bus_reservation — esclusiva DATE-SCOPED", () => {
  it("G: riserva unit il 2026-09-12; nessuna riserva implicita altre date; tenant_bus_units NON modificato", async () => {
    const { admin, writes } = makeAdmin({
      booking_groups: [{ id: GROUP_ID, tenant_id: TENANT }],
      tenant_bus_units: [{ id: BUS_UNIT_ID, tenant_id: TENANT, tag: "esclusivo", group_name: null, status: "open" }],
    });
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    const res = await POST(post({
      action: "upsert_bus_reservation",
      booking_group_id: GROUP_ID,
      bus_unit_id: BUS_UNIT_ID,
      service_date: "2026-09-12",
      reserved_pax: 50,
      exclusive: true,
    }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    const up = writes.upserts.filter((w) => w.table === "booking_group_bus_reservations");
    expect(up).toHaveLength(1);
    expect(up[0]!.row).toMatchObject({
      tenant_id: TENANT,
      booking_group_id: GROUP_ID,
      bus_unit_id: BUS_UNIT_ID,
      service_date: "2026-09-12",
      reserved_pax: 50,
      exclusive: true,
    });
    expect(String((up[0]!.options as { onConflict?: string }).onConflict)).toContain("service_date");
    const touchedUnit = [...writes.inserts, ...writes.updates, ...writes.upserts, ...writes.deletes]
      .some((w) => (w as { table: string }).table === "tenant_bus_units");
    expect(touchedUnit).toBe(false);
  });

  it("bus_unit di un altro tenant → 400", async () => {
    const { admin } = makeAdmin({
      booking_groups: [{ id: GROUP_ID, tenant_id: TENANT }],
      tenant_bus_units: [{ id: BUS_UNIT_ID, tenant_id: OTHER_TENANT }],
    });
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));
    const res = await POST(post({
      action: "upsert_bus_reservation", booking_group_id: GROUP_ID, bus_unit_id: BUS_UNIT_ID, service_date: "2026-09-12", reserved_pax: 10,
    }));
    expect(res.status).toBe(400);
  });
});

describe("GET list / detail", () => {
  it("list → gruppi del tenant", async () => {
    const { admin } = makeAdmin({ booking_groups: [{ id: GROUP_ID, tenant_id: TENANT, name: "Parrocchia Natività", expected_pax: 50, status: "to_complete" }] });
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin, "supervisor"));
    const res = await GET(get());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.groups).toHaveLength(1);
  });

  it("detail → include summary pax derivato (planned 40 / unplanned 10)", async () => {
    const { admin } = makeAdmin({
      booking_groups: [{ id: GROUP_ID, tenant_id: TENANT, name: "Parrocchia Natività", expected_pax: 50, status: "stops_defined" }],
      booking_group_stops: [
        { id: "s1", tenant_id: TENANT, booking_group_id: GROUP_ID, expected_pax: 20, direction: "arrival", sort_order: 0 },
        { id: "s2", tenant_id: TENANT, booking_group_id: GROUP_ID, expected_pax: 20, direction: "arrival", sort_order: 1 },
      ],
      booking_group_bus_reservations: [],
      services: [],
    });
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));
    const res = await GET(get(`?id=${GROUP_ID}`));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.summary.pax).toMatchObject({ expectedPax: 50, plannedPax: 40, unplannedPax: 10, overbooked: false });
    expect(json.summary.suggestedStatus).toBe("stops_defined");
  });
});

describe("POST create_group_service / batch — FASE 2 (service collegato al gruppo)", () => {
  const GROUP = { id: GROUP_ID, tenant_id: TENANT, kind: "bus_exclusive", service_date: "2026-09-12" };
  const STOP = { id: STOP_ID, tenant_id: TENANT, booking_group_id: GROUP_ID, city: "Tivoli", pickup_point: "Villa d'Este", direction: "arrival" };

  it("F: batch 4 nominativi Tivoli → 4 services, 20 pax, booking_group_id + booking_group_stop_id + bus_city_origin + meeting_point corretti", async () => {
    const { admin, writes } = makeAdmin({ booking_groups: [GROUP], booking_group_stops: [STOP] });
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    const res = await POST(post({
      action: "create_group_services_batch",
      booking_group_id: GROUP_ID,
      booking_group_stop_id: STOP_ID,
      passengers: [
        { customer_name: "Rossi", pax: 4 },
        { customer_name: "Verdi", pax: 10 },
        { customer_name: "Pinco Pallo", pax: 2 },
        { customer_name: "Gennaro", pax: 4 },
      ],
    }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.created_count).toBe(4);
    expect(json.failed_count).toBe(0);

    const svcInserts = writes.inserts.filter((w) => w.table === "services");
    expect(svcInserts).toHaveLength(4);
    const totalPax = svcInserts.reduce((n, w) => n + Number(w.row.pax), 0);
    expect(totalPax).toBe(20);
    for (const w of svcInserts) {
      expect(w.row).toMatchObject({
        tenant_id: TENANT,
        booking_group_id: GROUP_ID,
        booking_group_stop_id: STOP_ID,
        bus_city_origin: "Tivoli",
        meeting_point: "Villa d'Este",
        direction: "arrival",
        date: "2026-09-12",
        is_draft: true,
        status: "needs_review",
        booking_service_kind: "bus_city_hotel",
        service_type_code: "bus_line",
      });
    }
    // status_events per ogni service creato
    expect(writes.inserts.filter((w) => w.table === "status_events")).toHaveLength(4);
  });

  it("create_group_service singolo → 1 service collegato", async () => {
    const { admin, writes } = makeAdmin({ booking_groups: [GROUP], booking_group_stops: [STOP] });
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));
    const res = await POST(post({
      action: "create_group_service", booking_group_id: GROUP_ID, booking_group_stop_id: STOP_ID, customer_name: "Rossi", pax: 4,
    }));
    expect(res.status).toBe(200);
    const svc = writes.inserts.filter((w) => w.table === "services");
    expect(svc).toHaveLength(1);
    expect(svc[0]!.row).toMatchObject({ customer_name: "Rossi", pax: 4, booking_group_stop_id: STOP_ID });
  });

  it("gruppo senza service_date → 422 (nessun service creato)", async () => {
    const { admin, writes } = makeAdmin({
      booking_groups: [{ ...GROUP, service_date: null }],
      booking_group_stops: [STOP],
    });
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));
    const res = await POST(post({
      action: "create_group_service", booking_group_id: GROUP_ID, booking_group_stop_id: STOP_ID, customer_name: "Rossi", pax: 4,
    }));
    expect(res.status).toBe(422);
    expect(writes.inserts.filter((w) => w.table === "services")).toHaveLength(0);
  });

  it("stop non appartenente al gruppo → 404", async () => {
    const { admin } = makeAdmin({
      booking_groups: [GROUP],
      booking_group_stops: [{ ...STOP, booking_group_id: "99999999-9999-4999-8999-999999999999" }],
    });
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));
    const res = await POST(post({
      action: "create_group_service", booking_group_id: GROUP_ID, booking_group_stop_id: STOP_ID, customer_name: "X", pax: 1,
    }));
    expect(res.status).toBe(404);
  });
});

describe("POST unlink_group_service — soft unlink (M: nessuna cancellazione)", () => {
  it("azzera booking_group_id + booking_group_stop_id, NON cancella il service", async () => {
    const SVC = "77777777-7777-4777-8777-777777777777";
    const { admin, writes } = makeAdmin({ services: [{ id: SVC, tenant_id: TENANT, booking_group_id: GROUP_ID }] });
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));
    const res = await POST(post({ action: "unlink_group_service", service_id: SVC }));
    expect(res.status).toBe(200);
    expect(writes.deletes.filter((w) => w.table === "services")).toHaveLength(0);
    const upd = writes.updates.filter((w) => w.table === "services");
    expect(upd).toHaveLength(1);
    expect(upd[0]!.payload).toMatchObject({ booking_group_id: null, booking_group_stop_id: null });
  });
});

describe("GET detail — stop_summaries per fermata (FASE 2)", () => {
  it("G: Tivoli 20 previsti con 16 pax in services → remaining 4; Guidonia 20 con 0 → remaining 20", async () => {
    const { admin } = makeAdmin({
      booking_groups: [{ id: GROUP_ID, tenant_id: TENANT, name: "Parrocchia Natività", expected_pax: 50, status: "stops_defined" }],
      booking_group_stops: [
        { id: "tiv", tenant_id: TENANT, booking_group_id: GROUP_ID, expected_pax: 20, direction: "arrival", sort_order: 0, city: "Tivoli", pickup_point: "Villa d'Este" },
        { id: "gui", tenant_id: TENANT, booking_group_id: GROUP_ID, expected_pax: 20, direction: "arrival", sort_order: 1, city: "Guidonia", pickup_point: "Fermata Bus" },
      ],
      booking_group_bus_reservations: [],
      services: [
        { id: "s1", tenant_id: TENANT, booking_group_id: GROUP_ID, booking_group_stop_id: "tiv", pax: 10 },
        { id: "s2", tenant_id: TENANT, booking_group_id: GROUP_ID, booking_group_stop_id: "tiv", pax: 6 },
      ],
    });
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));
    const res = await GET(get(`?id=${GROUP_ID}`));
    const json = await res.json();
    expect(res.status).toBe(200);
    const tiv = json.stop_summaries.find((s: { stopId: string }) => s.stopId === "tiv");
    const gui = json.stop_summaries.find((s: { stopId: string }) => s.stopId === "gui");
    expect(tiv).toMatchObject({ expectedPax: 20, servicePax: 16, remainingServicePax: 4, overbooked: false });
    expect(gui).toMatchObject({ expectedPax: 20, servicePax: 0, remainingServicePax: 20 });
  });
});

describe("FASE 2.5 — preview / operationalize", () => {
  const GROUP = { id: GROUP_ID, tenant_id: TENANT, kind: "bus_exclusive", service_date: "2026-09-12", expected_pax: 50, status: "passengers_defined", outbound_ferry_company: null, outbound_ferry_time: null, return_ferry_company: null, return_ferry_time: null };
  const STOP = { id: STOP_ID, tenant_id: TENANT, booking_group_id: GROUP_ID, city: "Tivoli", pickup_point: "Villa d'Este", stop_id: STOP_ID, expected_pax: 20 };
  const svc = (id: string, over: Record<string, unknown> = {}) => ({
    id, tenant_id: TENANT, booking_group_id: GROUP_ID, booking_group_stop_id: STOP_ID,
    is_draft: true, status: "needs_review", pax: 4, customer_name: "Rossi", date: "2026-09-12",
    time: "07:30", direction: "arrival", bus_city_origin: "Tivoli", meeting_point: "Villa d'Este",
    hotel_id: null, booking_service_kind: "bus_city_hotel", ...over,
  });

  it("preview: 1 ready + 1 blocked (time 00:00), nessuna scrittura", async () => {
    const { admin, writes } = makeAdmin({
      booking_groups: [GROUP], booking_group_stops: [STOP],
      services: [svc("svc-ok"), svc("svc-ko", { id: "svc-ko", customer_name: "Verdi", time: "00:00" })],
      booking_group_bus_reservations: [],
    });
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));
    const res = await POST(post({ action: "preview_operationalize_group", booking_group_id: GROUP_ID }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.services_ready).toBe(1);
    expect(json.services_blocked).toBe(1);
    const ko = json.services.find((s: { service_id: string }) => s.service_id === "svc-ko");
    expect(ko.missing_fields).toContain("missing_time");
    // O: nessuna reservation → warning
    expect(json.warnings).toContain("bus_reservation_missing");
    expect(writes.inserts).toHaveLength(0);
    expect(writes.updates).toHaveLength(0);
  });

  it("F: operationalize partial → 207, solo il ready diventa is_draft=false status=new + status_event", async () => {
    const { admin, writes } = makeAdmin({
      booking_groups: [GROUP], booking_group_stops: [STOP],
      services: [svc("svc-ok"), svc("svc-ko", { id: "svc-ko", customer_name: "Verdi", time: "00:00" })],
      booking_group_bus_reservations: [],
    });
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));
    const res = await POST(post({ action: "operationalize_group", booking_group_id: GROUP_ID }));
    const json = await res.json();
    expect(res.status).toBe(207);
    expect(json.operationalized).toHaveLength(1);
    expect(json.operationalized[0].service_id).toBe("svc-ok");
    expect(json.blocked).toHaveLength(1);
    const upd = writes.updates.filter((w) => w.table === "services");
    expect(upd).toHaveLength(1);
    expect(upd[0]!.payload).toEqual({ is_draft: false, status: "new" }); // K + L; H/I non toccati
    expect(upd[0]!.filters).toMatchObject({ id: "svc-ok" });
    // J: status_event
    expect(writes.inserts.filter((w) => w.table === "status_events")).toHaveLength(1);
    // gruppo NON promosso operational (resta 1 blocked)
    expect(writes.updates.filter((w) => w.table === "booking_groups")).toHaveLength(0);
  });

  it("G: nessuno ready → 422, nessuna scrittura", async () => {
    const { admin, writes } = makeAdmin({
      booking_groups: [GROUP], booking_group_stops: [STOP],
      services: [svc("a", { time: "00:00" }), svc("b", { id: "b", time: "00:00" })],
      booking_group_bus_reservations: [],
    });
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));
    const res = await POST(post({ action: "operationalize_group", booking_group_id: GROUP_ID }));
    expect(res.status).toBe(422);
    expect(writes.updates.filter((w) => w.table === "services")).toHaveLength(0);
  });

  it("E: service già is_draft=false → already_operational, nessun update / status_event", async () => {
    const SVC_OP = "aaaaaaaa-0000-4000-8000-00000000000a";
    const { admin, writes } = makeAdmin({
      booking_groups: [GROUP], booking_group_stops: [STOP],
      services: [svc(SVC_OP, { is_draft: false, status: "new" })],
      booking_group_bus_reservations: [],
    });
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));
    const res = await POST(post({ action: "operationalize_group", booking_group_id: GROUP_ID, service_ids: [SVC_OP] }));
    const json = await res.json();
    expect(json.already_operational).toContain(SVC_OP);
    expect(writes.updates.filter((w) => w.table === "services")).toHaveLength(0);
    expect(writes.inserts.filter((w) => w.table === "status_events")).toHaveLength(0);
  });

  it("tutti ready + operationalize → gruppo promosso a operational", async () => {
    const { admin, writes } = makeAdmin({
      booking_groups: [GROUP], booking_group_stops: [STOP],
      services: [svc("x"), svc("y", { id: "y", customer_name: "Verdi" })],
      booking_group_bus_reservations: [],
    });
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));
    const res = await POST(post({ action: "operationalize_group", booking_group_id: GROUP_ID }));
    expect(res.status).toBe(200);
    expect(writes.updates.filter((w) => w.table === "services")).toHaveLength(2);
    const gUpd = writes.updates.filter((w) => w.table === "booking_groups");
    expect(gUpd).toHaveLength(1);
    expect(gUpd[0]!.payload).toMatchObject({ status: "operational" });
  });

  it("P/Q: reserved_pax < expected e reserved_pax > capacity → warnings di gruppo", async () => {
    const { admin } = makeAdmin({
      booking_groups: [GROUP], booking_group_stops: [STOP],
      services: [svc("x")],
      booking_group_bus_reservations: [{ id: "r1", tenant_id: TENANT, booking_group_id: GROUP_ID, bus_unit_id: BUS_UNIT_ID, service_date: "2026-09-12", reserved_pax: 45, exclusive: true }],
      tenant_bus_units: [{ id: BUS_UNIT_ID, tenant_id: TENANT, capacity: 40 }],
    });
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));
    const res = await POST(post({ action: "preview_operationalize_group", booking_group_id: GROUP_ID }));
    const json = await res.json();
    expect(json.warnings).toContain("reserved_pax_below_expected"); // 45 < 50
    expect(json.warnings).toContain("reserved_pax_above_capacity"); // 45 > 40
    expect(json.warnings).not.toContain("bus_reservation_missing");
    expect(json.bus_reservation.bus_capacity).toBe(40);
  });
});

describe("FASE 2.5 — Piano del Giorno (M/N: draft escluso, operativo incluso)", () => {
  it("il dataset Piano del Giorno esclude is_draft=true e non filtra i services per booking_group_id", () => {
    const piano = readFileSync(new URL("../../app/api/ops/piano-giorno/route.ts", import.meta.url), "utf8");
    // draft escluso (service gruppo appena creato)
    expect(piano).toMatch(/\.neq\("is_draft",\s*true\)/);
    // dopo operationalize (is_draft=false) il service rientra: nessuna restrizione
    // `.eq("booking_group_id", ...)` sulla query services (FASE 4 aggrega solo in
    // presentazione, non filtra quali services entrano nel Piano).
    expect(piano).not.toMatch(/\.eq\("booking_group_id"/);
  });
});

describe("FASE 4 — Piano del Giorno group-aware (presentazione, non filtro)", () => {
  it("legge booking_group_id/booking_group_stop_id e delega l'aggregazione all'helper puro condiviso", () => {
    const piano = readFileSync(new URL("../../app/api/ops/piano-giorno/route.ts", import.meta.url), "utf8");
    expect(piano).toMatch(/booking_group_id/);
    expect(piano).toMatch(/booking_group_stop_id/);
    // nessuna logica di aggregazione duplicata inline: usa lo stesso helper testato
    // in tests/unit/piano-booking-group-display.test.ts.
    expect(piano).toMatch(/buildPianoDisplayUnits/);
    expect(piano).toMatch(/from "@\/lib\/piano-booking-group-display"/);
  });

  it("non tocca trip_groups / assignments / tenant_bus_units in scrittura, resta sola lettura", () => {
    const piano = readFileSync(new URL("../../app/api/ops/piano-giorno/route.ts", import.meta.url), "utf8");
    expect(piano).not.toMatch(/\.update\(/);
    expect(piano).not.toMatch(/\.insert\(/);
    expect(piano).not.toMatch(/\.upsert\(/);
    expect(piano).not.toMatch(/\.delete\(/);
  });

  it("batcha i gruppi con IN (...) invece di una query per gruppo (niente N+1)", () => {
    const piano = readFileSync(new URL("../../app/api/ops/piano-giorno/route.ts", import.meta.url), "utf8");
    expect(piano).toMatch(/\.in\("id", bookingGroupIds\)/);
    expect(piano).toMatch(/\.in\("booking_group_id", bookingGroupIds\)/);
  });
});

describe("migration 0264 — services.booking_group_stop_id", () => {
  const sql = readFileSync(new URL("../../supabase/migrations/0264_services_booking_group_stop_id.sql", import.meta.url), "utf8");
  it("colonna nullable, FK -> booking_group_stops ON DELETE SET NULL, indice tenant-aware", () => {
    expect(sql).toMatch(/add column if not exists booking_group_stop_id uuid null/);
    expect(sql).toMatch(/references public\.booking_group_stops\(id\) on delete set null/);
    expect(sql).toMatch(/create index if not exists idx_services_tenant_booking_group_stop/);
    expect(sql).toMatch(/\(tenant_id, booking_group_stop_id\)/);
  });
  it("non tocca trip_groups / tenant_bus_allocations / tenant_bus_units / bus_line_ferry_config", () => {
    expect(sql).not.toMatch(/alter table public\.trip_groups/i);
    expect(sql).not.toMatch(/alter table public\.tenant_bus_allocations/i);
    expect(sql).not.toMatch(/alter table public\.tenant_bus_units/i);
    expect(sql).not.toMatch(/alter table public\.bus_line_ferry_config/i);
  });
});

describe("migration 0263 — vincoli chiave", () => {
  const sql = readFileSync(new URL("../../supabase/migrations/0263_booking_groups.sql", import.meta.url), "utf8");

  it("services.booking_group_id nullable, FK ON DELETE SET NULL (I: cancellazione gruppo lascia i services)", () => {
    expect(sql).toMatch(/alter table public\.services\s+add column if not exists booking_group_id uuid null/);
    expect(sql).toMatch(/references public\.booking_groups\(id\) on delete set null/);
  });

  it("stops e reservations sono figli puri → ON DELETE CASCADE", () => {
    expect(sql).toMatch(/booking_group_id uuid not null references public\.booking_groups\(id\) on delete cascade/);
  });

  it("tenant_bus_allocations NON alterato / nessun insert dalla migration", () => {
    expect(sql).not.toMatch(/alter table public\.tenant_bus_allocations/i);
    expect(sql).not.toMatch(/insert into public\.tenant_bus_allocations/i);
  });

  it("bus reservation date-scoped: unique(tenant_id, booking_group_id, bus_unit_id, service_date)", () => {
    expect(sql).toMatch(/unique \(tenant_id, booking_group_id, bus_unit_id, service_date\)/);
  });

  it("nessuna modifica a trip_groups / tenant_bus_units / bus_line_ferry_config", () => {
    expect(sql).not.toMatch(/alter table public\.trip_groups/);
    expect(sql).not.toMatch(/alter table public\.tenant_bus_units/);
    expect(sql).not.toMatch(/alter table public\.bus_line_ferry_config/);
  });
});
describe("migration 0267 - booking_groups.return_date", () => {
  const sql = readFileSync(new URL("../../supabase/migrations/0267_booking_groups_return_date.sql", import.meta.url), "utf8");

  it("aggiunge return_date nullable senza rinominare service_date", () => {
    expect(sql).toMatch(/alter table public\.booking_groups\s+add column if not exists return_date date null/i);
    expect(sql).toMatch(/comment on column public\.booking_groups\.return_date/i);
    expect(sql).not.toMatch(/rename column service_date/i);
  });
});

describe("create_group date rules", () => {
  it("gruppo generico senza date -> 200", async () => {
    const { admin, writes } = makeAdmin();
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));
    const res = await POST(post({ action: "create_group", name: "Gruppo generico", expected_pax: 12, kind: "other" }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(writes.inserts.find((w) => w.table === "booking_groups")!.row.service_date).toBeNull();
  });

  it("gruppo generico con sola data ritorno -> 200", async () => {
    const { admin, writes } = makeAdmin();
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));
    const res = await POST(post({ action: "create_group", name: "Gruppo generico", expected_pax: 12, kind: "other", return_date: "2026-09-27" }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(writes.inserts.find((w) => w.table === "booking_groups")!.row.return_date).toBe("2026-09-27");
  });

  it("bus_exclusive senza date -> 400", async () => {
    const { admin, writes } = makeAdmin();
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));
    const res = await POST(post({ action: "create_group", name: "Bus senza data", expected_pax: 50, kind: "bus_exclusive" }));
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.error).toMatch(/arrivo e ritorno/i);
    expect(writes.inserts.filter((w) => w.table === "booking_groups")).toHaveLength(0);
  });

  it("bus_exclusive solo data arrivo -> 200", async () => {
    const { admin, writes } = makeAdmin();
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));
    const res = await POST(post({
      action: "create_group",
      name: "Bus solo arrivo",
      expected_pax: 50,
      kind: "bus_exclusive",
      service_date: "2026-09-20",
    }));
    expect(res.status).toBe(200);
    expect(writes.inserts.find((w) => w.table === "booking_groups")!.row.service_date).toBe("2026-09-20");
  });

  it("bus_exclusive solo data ritorno -> 200", async () => {
    const { admin, writes } = makeAdmin();
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));
    const res = await POST(post({
      action: "create_group",
      name: "Bus solo ritorno",
      expected_pax: 50,
      kind: "bus_exclusive",
      return_date: "2026-09-27",
    }));
    expect(res.status).toBe(200);
    expect(writes.inserts.find((w) => w.table === "booking_groups")!.row.return_date).toBe("2026-09-27");
  });

  it("bus_exclusive con arrivo e ritorno -> 200", async () => {
    const { admin, writes } = makeAdmin();
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));
    const res = await POST(post({
      action: "create_group",
      name: "Bus andata ritorno",
      expected_pax: 50,
      kind: "bus_exclusive",
      service_date: "2026-09-20",
      return_date: "2026-09-27",
    }));
    expect(res.status).toBe(200);
    expect(writes.inserts.find((w) => w.table === "booking_groups")!.row).toMatchObject({
      service_date: "2026-09-20",
      return_date: "2026-09-27",
    });
  });

  it("ritorno prima dell'arrivo -> 400", async () => {
    const { admin, writes } = makeAdmin();
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));
    const res = await POST(post({
      action: "create_group",
      name: "Bus date invertite",
      expected_pax: 50,
      kind: "bus_exclusive",
      service_date: "2026-09-27",
      return_date: "2026-09-20",
    }));
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.error).toMatch(/ritorno/i);
    expect(writes.inserts.filter((w) => w.table === "booking_groups")).toHaveLength(0);
  });
});
