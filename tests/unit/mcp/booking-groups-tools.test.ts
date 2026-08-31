import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

/**
 * FASE 3 — Tool MCP gruppi prenotazione (§30-36).
 *
 * Copertura:
 *  - lookup per nome/id + ambiguità NON risolta (§18, §36)
 *  - flusso preview → confirmation token → write per: create (§30),
 *    add_stop (§31), add_passengers (§32), reserve_bus (§33), ferry (§34),
 *    operationalize (§35)
 *  - sicurezza token (§25): scaduto, riusato, cross-tenant, op sbagliata
 *  - permessi (§26): supervisor NON può preview/write; READ sì
 *
 * Le funzioni di dominio sono le STESSE della route HTTP
 * (`lib/server/booking-groups-service.ts`): qui si verifica solo lo strato MCP.
 */

const mocks = vi.hoisted(() => ({ autoAllocateBusService: vi.fn() }));
vi.mock("@/lib/server/bus-auto-allocation", () => ({ autoAllocateBusService: mocks.autoAllocateBusService }));

import { getTool } from "@/lib/mcp/registry";
import { canExecuteTool } from "@/lib/mcp/policy";
import { __resetConfirmationRegistryForTests, generateBookingGroupConfirmationToken } from "@/lib/mcp/confirmation";
import type { McpContext } from "@/lib/mcp/context";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_TENANT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER = "11111111-1111-4111-8111-1111111111aa";
const GROUP_ID = "22222222-2222-4222-8222-222222222222";
const STOP_ID = "33333333-3333-4333-8333-333333333333";
const BUS_UNIT_ID = "44444444-4444-4444-8444-444444444444";
const CAT_STOP_ID = "55555555-5555-4555-8555-555555555555";

type Row = Record<string, unknown>;

function makeAdmin(seed: Record<string, Row[]> = {}) {
  const db: Record<string, Row[]> = {};
  for (const k of Object.keys(seed)) db[k] = seed[k].map((r) => ({ ...r }));
  const writes = {
    inserts: [] as Array<{ table: string; row: Row }>,
    updates: [] as Array<{ table: string; payload: Row }>,
    upserts: [] as Array<{ table: string; row: Row }>,
    deletes: [] as Array<{ table: string }>,
  };
  let seq = 0;

  function table(name: string) {
    if (!db[name]) db[name] = [];
    const filters: Array<[string, unknown]> = [];
    let pending: { kind: "insert" | "update" | "upsert" | "delete"; payload?: Row; opts?: { onConflict?: string } } | null = null;
    const rows = () => db[name].filter((r) => filters.every(([c, v]) => r[c] === v));

    function run(): { data: Row | Row[] | null; error: null } {
      if (pending?.kind === "insert") {
        const row = { id: `${name}-${++seq}`, ...(pending.payload ?? {}) };
        db[name].push(row);
        writes.inserts.push({ table: name, row });
        return { data: row, error: null };
      }
      if (pending?.kind === "update") {
        const matched = rows();
        for (const r of matched) Object.assign(r, pending.payload);
        writes.updates.push({ table: name, payload: pending.payload ?? {} });
        return { data: matched[0] ?? { ...Object.fromEntries(filters), ...(pending.payload ?? {}) }, error: null };
      }
      if (pending?.kind === "upsert") {
        const keys = String(pending.opts?.onConflict ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        const existing = keys.length ? db[name].find((r) => keys.every((k) => r[k] === (pending!.payload as Row)[k])) : undefined;
        if (existing) {
          Object.assign(existing, pending.payload);
          writes.upserts.push({ table: name, row: existing });
          return { data: existing, error: null };
        }
        const row = { id: `${name}-${++seq}`, ...(pending.payload ?? {}) };
        db[name].push(row);
        writes.upserts.push({ table: name, row });
        return { data: row, error: null };
      }
      if (pending?.kind === "delete") {
        db[name] = db[name].filter((r) => !filters.every(([c, v]) => r[c] === v));
        writes.deletes.push({ table: name });
        return { data: null, error: null };
      }
      return { data: null, error: null };
    }

    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = (c: string, v: unknown) => { filters.push([c, v]); return b; };
    b.order = () => b;
    b.limit = () => b;
    b.insert = (payload: Row) => { pending = { kind: "insert", payload }; return b; };
    b.update = (payload: Row) => { pending = { kind: "update", payload }; return b; };
    b.upsert = (payload: Row, opts: { onConflict?: string }) => { pending = { kind: "upsert", payload, opts }; return b; };
    b.delete = () => { pending = { kind: "delete" }; return b; };
    b.maybeSingle = async () => (pending ? run() : { data: rows()[0] ?? null, error: null });
    b.single = async () => (pending ? run() : { data: rows()[0] ?? null, error: null });
    b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      if (pending) return Promise.resolve(run()).then(resolve, reject);
      return Promise.resolve({ data: rows(), error: null }).then(resolve, reject);
    };
    return b;
  }

  return { admin: { from: table } as unknown as McpContext["admin"], db, writes };
}

function ctx(admin: McpContext["admin"], role: McpContext["role"] = "operator", tenantId = TENANT): McpContext {
  return { requestId: "req-1", userId: USER, userEmail: "op@test.it", tenantId, role, admin };
}

function tool(name: string) {
  const t = getTool(name);
  if (!t) throw new Error(`${name} non registrato`);
  return t as { handler: (c: McpContext, i: unknown) => Promise<Record<string, unknown>>; category: string; allowedRoles: readonly string[] };
}

function baseGroup(over: Row = {}): Row {
  return {
    id: GROUP_ID, tenant_id: TENANT, name: "Parrocchia Natività", expected_pax: 50,
    kind: "bus_exclusive", status: "to_complete", service_date: "2026-09-12",
    outbound_ferry_company: null, outbound_departure_port: null, outbound_ferry_time: null,
    outbound_arrival_port: null, outbound_expected_arrival_time: null,
    return_ferry_company: null, return_departure_port: null, return_ferry_time: null,
    return_arrival_port: null, return_expected_arrival_time: null,
    created_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-01T00:00:00Z",
    ...over,
  };
}

beforeAll(async () => {
  process.env.AGENCY_ACTION_SECRET = "fase3-test-secret";
  await import("@/lib/mcp/tools/booking-groups/read");
  await import("@/lib/mcp/tools/booking-groups/preview");
  await import("@/lib/mcp/tools/booking-groups/write");
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.autoAllocateBusService.mockResolvedValue({ allocated: false });
  __resetConfirmationRegistryForTests();
});

// ─── §18 / §36 — lookup + ambiguità ──────────────────────────────────────

describe("its.find_booking_group — §18 ambiguità mai risolta", () => {
  it("nome esatto univoco → strategy exact, ambiguous false", async () => {
    const { admin } = makeAdmin({ booking_groups: [baseGroup()] });
    const out = await tool("its.find_booking_group").handler(ctx(admin), { query: "parrocchia natività" });
    expect(out.strategy).toBe("exact");
    expect(out.ambiguous).toBe(false);
    expect((out.matches as Row[])).toHaveLength(1);
    expect((out.matches as Array<{ service_date_label: string }>)[0].service_date_label).toBe("12/09/2026");
  });

  it("due gruppi con lo stesso nome → ambiguous true, entrambi restituiti", async () => {
    const { admin } = makeAdmin({
      booking_groups: [
        baseGroup(),
        baseGroup({ id: "g2", name: "Parrocchia Natività", service_date: "2026-10-01" }),
      ],
    });
    const out = await tool("its.find_booking_group").handler(ctx(admin), { query: "Parrocchia Natività" });
    expect(out.ambiguous).toBe(true);
    expect((out.matches as Row[])).toHaveLength(2);
  });

  it("stessa data disambigua se fornita", async () => {
    const { admin } = makeAdmin({
      booking_groups: [
        baseGroup({ service_date: "2026-09-12" }),
        baseGroup({ id: "g2", service_date: "2026-10-01" }),
      ],
    });
    const out = await tool("its.find_booking_group").handler(ctx(admin), { query: "Parrocchia Natività", serviceDate: "2026-09-12" });
    expect(out.strategy).toBe("exact_same_date");
    expect(out.ambiguous).toBe(false);
    expect((out.matches as Row[])).toHaveLength(1);
  });

  it("per id → 1 match o 0", async () => {
    const { admin } = makeAdmin({ booking_groups: [baseGroup()] });
    const okM = await tool("its.find_booking_group").handler(ctx(admin), { bookingGroupId: GROUP_ID });
    expect((okM.matches as Row[])).toHaveLength(1);
    const none = await tool("its.find_booking_group").handler(ctx(admin), { bookingGroupId: "99999999-9999-4999-8999-999999999999" });
    expect((none.matches as Row[])).toHaveLength(0);
  });

  it("cross-tenant: gruppo di un altro tenant NON è visibile", async () => {
    const { admin } = makeAdmin({ booking_groups: [baseGroup({ tenant_id: OTHER_TENANT })] });
    const out = await tool("its.find_booking_group").handler(ctx(admin), { query: "Parrocchia Natività" });
    expect((out.matches as Row[])).toHaveLength(0);
  });
});

// ─── §30 — create ────────────────────────────────────────────────────────

describe("its.preview_create_booking_group → its.create_booking_group (§30)", () => {
  it("preview emette token; write crea il gruppo con gli stessi dati", async () => {
    const { admin, db } = makeAdmin({});
    const preview = await tool("its.preview_create_booking_group").handler(ctx(admin), {
      name: "Parrocchia Natività", expectedPax: 50, kind: "bus_exclusive", serviceDate: "2026-09-12",
    });
    expect(preview.service_date_label).toBe("12/09/2026");
    expect(typeof preview.confirmationToken).toBe("string");
    expect(preview.return_date).toBeNull();

    const res = await tool("its.create_booking_group").handler(ctx(admin), { confirmationToken: preview.confirmationToken });
    expect(res.name).toBe("Parrocchia Natività");
    expect(db.booking_groups).toHaveLength(1);
    expect(db.booking_groups[0]).toMatchObject({ tenant_id: TENANT, expected_pax: 50, kind: "bus_exclusive", service_date: "2026-09-12", created_by_user_id: USER });
  });

  it("preview + write supportano bus_exclusive con sola data ritorno", async () => {
    const { admin, db } = makeAdmin({});
    const preview = await tool("its.preview_create_booking_group").handler(ctx(admin), {
      name: "Bus solo ritorno", expectedPax: 42, kind: "bus_exclusive", returnDate: "2026-09-27",
    });
    expect(preview.service_date).toBeNull();
    expect(preview.return_date).toBe("2026-09-27");
    expect(preview.return_date_label).toBe("27/09/2026");

    const res = await tool("its.create_booking_group").handler(ctx(admin), { confirmationToken: preview.confirmationToken });
    expect(res.name).toBe("Bus solo ritorno");
    expect(db.booking_groups[0]).toMatchObject({ kind: "bus_exclusive", service_date: null, return_date: "2026-09-27" });
  });

  it("preview blocca bus_exclusive senza arrivo e ritorno", async () => {
    const { admin } = makeAdmin({});
    await expect(
      tool("its.preview_create_booking_group").handler(ctx(admin), { name: "Bus senza date", expectedPax: 42, kind: "bus_exclusive" }),
    ).rejects.toMatchObject({ code: "MCP_INVALID_INPUT" });
  });

  it("preview blocca ritorno precedente all'arrivo", async () => {
    const { admin } = makeAdmin({});
    await expect(
      tool("its.preview_create_booking_group").handler(ctx(admin), {
        name: "Bus date invertite", expectedPax: 42, kind: "bus_exclusive", serviceDate: "2026-09-27", returnDate: "2026-09-20",
      }),
    ).rejects.toMatchObject({ code: "MCP_INVALID_INPUT" });
  });

  it("token riusato → MCP_CONFIRMATION_ALREADY_USED", async () => {
    const { admin } = makeAdmin({});
    const preview = await tool("its.preview_create_booking_group").handler(ctx(admin), { name: "X", expectedPax: 10 });
    await tool("its.create_booking_group").handler(ctx(admin), { confirmationToken: preview.confirmationToken });
    await expect(
      tool("its.create_booking_group").handler(ctx(admin), { confirmationToken: preview.confirmationToken }),
    ).rejects.toMatchObject({ code: "MCP_CONFIRMATION_ALREADY_USED" });
  });

  it("token di un altro tenant → MCP_CONFIRMATION_INVALID", async () => {
    const { admin } = makeAdmin({});
    const foreign = generateBookingGroupConfirmationToken({
      op: "create_booking_group", userId: USER, tenantId: OTHER_TENANT, groupId: null,
      args: { name: "X", expected_pax: 5, kind: "other" },
    });
    await expect(
      tool("its.create_booking_group").handler(ctx(admin), { confirmationToken: foreign.token }),
    ).rejects.toMatchObject({ code: "MCP_CONFIRMATION_INVALID" });
  });

  it("token emesso per un'altra op → MCP_CONFIRMATION_INVALID", async () => {
    const { admin } = makeAdmin({ booking_groups: [baseGroup()] });
    const wrong = generateBookingGroupConfirmationToken({
      op: "add_booking_group_stop", userId: USER, tenantId: TENANT, groupId: GROUP_ID, args: {},
    });
    await expect(
      tool("its.create_booking_group").handler(ctx(admin), { confirmationToken: wrong.token }),
    ).rejects.toMatchObject({ code: "MCP_CONFIRMATION_INVALID" });
  });

  it("token scaduto → MCP_CONFIRMATION_EXPIRED", async () => {
    const { admin } = makeAdmin({});
    vi.useFakeTimers();
    try {
      const preview = await tool("its.preview_create_booking_group").handler(ctx(admin), { name: "X", expectedPax: 10 });
      vi.advanceTimersByTime(200_000); // TTL = 180s
      await expect(
        tool("its.create_booking_group").handler(ctx(admin), { confirmationToken: preview.confirmationToken }),
      ).rejects.toMatchObject({ code: "MCP_CONFIRMATION_EXPIRED" });
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── §31 — add stop ─────────────────────────────────────────────────────

describe("its.preview_add_booking_group_stop → its.add_booking_group_stop (§31)", () => {
  it("preview + write: fermata pianificata, città e punto di carico separati, nessun catalogo creato", async () => {
    const { admin, db, writes } = makeAdmin({ booking_groups: [baseGroup()] });
    const preview = await tool("its.preview_add_booking_group_stop").handler(ctx(admin), {
      bookingGroupId: GROUP_ID, city: "Tivoli", pickupPoint: "Villa d'Este", expectedPax: 20, direction: "arrival",
    });
    expect(preview.planned_pax_after).toBe(20);
    const res = await tool("its.add_booking_group_stop").handler(ctx(admin), { confirmationToken: preview.confirmationToken });
    expect(res.city).toBe("Tivoli");
    expect(db.booking_group_stops[0]).toMatchObject({ tenant_id: TENANT, booking_group_id: GROUP_ID, city: "Tivoli", pickup_point: "Villa d'Este", expected_pax: 20, direction: "arrival" });
    expect(writes.inserts.some((w) => w.table === "tenant_bus_line_stops")).toBe(false);
  });

  it("preview segnala overbooked se i pax fermate superano i pax gruppo", async () => {
    const { admin } = makeAdmin({
      booking_groups: [baseGroup({ expected_pax: 30 })],
      booking_group_stops: [{ id: STOP_ID, tenant_id: TENANT, booking_group_id: GROUP_ID, expected_pax: 20, direction: "arrival", sort_order: 0, city: "Tivoli", pickup_point: null, stop_id: null }],
    });
    const preview = await tool("its.preview_add_booking_group_stop").handler(ctx(admin), {
      bookingGroupId: GROUP_ID, city: "Guidonia", expectedPax: 20, direction: "arrival",
    });
    expect(preview.warnings).toContain("planned_pax_exceeds_group_expected");
  });

  it("gruppo inesistente → MCP_NOT_FOUND", async () => {
    const { admin } = makeAdmin({});
    await expect(
      tool("its.preview_add_booking_group_stop").handler(ctx(admin), { bookingGroupId: GROUP_ID, city: "X", expectedPax: 5, direction: "arrival" }),
    ).rejects.toMatchObject({ code: "MCP_NOT_FOUND" });
  });
});

// ─── §32 — add passengers ───────────────────────────────────────────────

describe("its.preview_add_booking_group_passengers → its.add_booking_group_passengers (§32)", () => {
  const seed = () => ({
    booking_groups: [baseGroup()],
    booking_group_stops: [{ id: STOP_ID, tenant_id: TENANT, booking_group_id: GROUP_ID, expected_pax: 20, direction: "arrival", sort_order: 0, city: "Tivoli", pickup_point: "Villa d'Este", stop_id: CAT_STOP_ID }],
  });

  it("batch 4 nominativi → 4 servizi bozza collegati, 20 pax, status_events", async () => {
    const { admin, db } = makeAdmin(seed());
    const preview = await tool("its.preview_add_booking_group_passengers").handler(ctx(admin), {
      bookingGroupId: GROUP_ID, bookingGroupStopId: STOP_ID,
      passengers: [
        { customerName: "Rossi", pax: 4 }, { customerName: "Verdi", pax: 10 },
        { customerName: "Pinco", pax: 2 }, { customerName: "Gennaro", pax: 4 },
      ],
    });
    expect(preview.total_pax).toBe(20);
    expect(preview.service_date_label).toBe("12/09/2026");

    const res = await tool("its.add_booking_group_passengers").handler(ctx(admin), { confirmationToken: preview.confirmationToken });
    expect(res.outcome).toBe("created");
    expect(res.created_count).toBe(4);
    const svc = db.services.filter((s) => s.booking_group_id === GROUP_ID);
    expect(svc).toHaveLength(4);
    for (const s of svc) {
      expect(s).toMatchObject({ tenant_id: TENANT, booking_group_stop_id: STOP_ID, bus_city_origin: "Tivoli", meeting_point: "Villa d'Este", is_draft: true, status: "needs_review", booking_service_kind: "bus_city_hotel" });
    }
    expect(db.services.reduce((n, s) => n + Number(s.pax), 0)).toBe(20);
    expect(db.status_events).toHaveLength(4);
  });

  it("gruppo senza service_date: preview avvisa e write → MCP_CONFIRMATION_STALE (422)", async () => {
    const s = seed();
    s.booking_groups = [baseGroup({ service_date: null })];
    const { admin } = makeAdmin(s);
    const preview = await tool("its.preview_add_booking_group_passengers").handler(ctx(admin), {
      bookingGroupId: GROUP_ID, bookingGroupStopId: STOP_ID, passengers: [{ customerName: "Rossi", pax: 4 }],
    });
    expect(preview.warnings).toContain("group_service_date_missing");
    await expect(
      tool("its.add_booking_group_passengers").handler(ctx(admin), { confirmationToken: preview.confirmationToken }),
    ).rejects.toMatchObject({ code: "MCP_CONFIRMATION_STALE" });
  });
});

// ─── §33 — reserve bus ──────────────────────────────────────────────────

describe("its.preview_reserve_booking_group_bus → its.reserve_booking_group_bus (§33)", () => {
  it("preview capacità + write upsert date-scoped, tenant_bus_units non toccato", async () => {
    const { admin, db, writes } = makeAdmin({
      booking_groups: [baseGroup()],
      tenant_bus_units: [{ id: BUS_UNIT_ID, tenant_id: TENANT, capacity: 40, tag: "esclusivo", group_name: null }],
    });
    const preview = await tool("its.preview_reserve_booking_group_bus").handler(ctx(admin), {
      bookingGroupId: GROUP_ID, busUnitId: BUS_UNIT_ID, serviceDate: "2026-09-12", reservedPax: 45, exclusive: true,
    });
    expect(preview.bus_capacity).toBe(40);
    expect(preview.warnings).toContain("reserved_pax_above_capacity");

    const res = await tool("its.reserve_booking_group_bus").handler(ctx(admin), { confirmationToken: preview.confirmationToken });
    expect(res.reservedPax).toBe(45);
    expect(db.booking_group_bus_reservations[0]).toMatchObject({ tenant_id: TENANT, booking_group_id: GROUP_ID, bus_unit_id: BUS_UNIT_ID, service_date: "2026-09-12", exclusive: true });
    expect(writes.updates.some((w) => w.table === "tenant_bus_units")).toBe(false);
    expect(writes.inserts.some((w) => w.table === "tenant_bus_units")).toBe(false);
  });

  it("bus unit di un altro tenant → preview MCP_INVALID_INPUT", async () => {
    const { admin } = makeAdmin({
      booking_groups: [baseGroup()],
      tenant_bus_units: [{ id: BUS_UNIT_ID, tenant_id: OTHER_TENANT, capacity: 40 }],
    });
    await expect(
      tool("its.preview_reserve_booking_group_bus").handler(ctx(admin), { bookingGroupId: GROUP_ID, busUnitId: BUS_UNIT_ID, serviceDate: "2026-09-12", reservedPax: 10 }),
    ).rejects.toMatchObject({ code: "MCP_INVALID_INPUT" });
  });
});

// ─── §34 — ferry ────────────────────────────────────────────────────────

describe("its.preview_update_booking_group_ferry → its.update_booking_group_ferry (§34)", () => {
  it("mostra i soli campi che cambiano e li applica; bus_line_ferry_config non toccato", async () => {
    const { admin, db, writes } = makeAdmin({ booking_groups: [baseGroup()] });
    const preview = await tool("its.preview_update_booking_group_ferry").handler(ctx(admin), {
      bookingGroupId: GROUP_ID,
      ferry: { outbound_ferry_company: "MEDMAR", outbound_ferry_time: "10:35" },
    });
    expect(preview.changes).toEqual(
      expect.arrayContaining([
        { field: "outbound_ferry_company", before: null, after: "MEDMAR" },
        { field: "outbound_ferry_time", before: null, after: "10:35" },
      ]),
    );
    const res = await tool("its.update_booking_group_ferry").handler(ctx(admin), { confirmationToken: preview.confirmationToken });
    expect(res.updatedFields).toEqual(expect.arrayContaining(["outbound_ferry_company", "outbound_ferry_time"]));
    expect(db.booking_groups[0]).toMatchObject({ outbound_ferry_company: "MEDMAR", outbound_ferry_time: "10:35" });
    expect(writes.updates.some((w) => w.table === "bus_line_ferry_config")).toBe(false);
  });
});

// ─── §35 — operationalize ───────────────────────────────────────────────

describe("its.preview_booking_group_operationalization → its.operationalize_booking_group (§35)", () => {
  const svc = (id: string, over: Row = {}) => ({
    id, tenant_id: TENANT, booking_group_id: GROUP_ID, booking_group_stop_id: STOP_ID,
    is_draft: true, status: "needs_review", pax: 4, customer_name: "Rossi", date: "2026-09-12",
    time: "07:30", direction: "arrival", bus_city_origin: "Tivoli", meeting_point: "Villa d'Este",
    hotel_id: null, booking_service_kind: "bus_city_hotel", ...over,
  });
  const seed = (services: Row[]) => ({
    booking_groups: [baseGroup({ status: "passengers_defined" })],
    booking_group_stops: [{ id: STOP_ID, tenant_id: TENANT, booking_group_id: GROUP_ID, city: "Tivoli", pickup_point: "Villa d'Este", stop_id: STOP_ID, expected_pax: 20 }],
    services,
    booking_group_bus_reservations: [],
  });

  it("preview: 1 pronto + 1 bloccato (time 00:00) + warning bus_reservation_missing", async () => {
    const { admin } = makeAdmin(seed([svc("ok"), svc("ko", { id: "ko", customer_name: "Verdi", time: "00:00" })]));
    const preview = await tool("its.preview_booking_group_operationalization").handler(ctx(admin), { bookingGroupId: GROUP_ID });
    expect(preview.services_ready).toBe(1);
    expect(preview.services_blocked).toBe(1);
    expect(preview.warnings).toContain("bus_reservation_missing");
    expect(typeof preview.confirmationToken).toBe("string");
  });

  it("write parziale: solo il servizio pronto diventa operativo → outcome 'partial'", async () => {
    const { admin, db } = makeAdmin(seed([svc("ok"), svc("ko", { id: "ko", customer_name: "Verdi", time: "00:00" })]));
    const preview = await tool("its.preview_booking_group_operationalization").handler(ctx(admin), { bookingGroupId: GROUP_ID });
    const res = await tool("its.operationalize_booking_group").handler(ctx(admin), { confirmationToken: preview.confirmationToken });
    expect(res.outcome).toBe("partial");
    expect((res.operationalized as Row[])).toHaveLength(1);
    expect((res.operationalized as Array<{ service_id: string }>)[0].service_id).toBe("ok");
    expect((res.blocked as Row[])).toHaveLength(1);
    expect(db.services.find((s) => s.id === "ok")).toMatchObject({ is_draft: false, status: "new" });
    expect(db.services.find((s) => s.id === "ko")).toMatchObject({ is_draft: true });
  });

  it("tutti pronti → outcome 'operationalized' e gruppo promosso a operational", async () => {
    const { admin, db } = makeAdmin(seed([svc("a"), svc("b", { id: "b", customer_name: "Verdi" })]));
    const preview = await tool("its.preview_booking_group_operationalization").handler(ctx(admin), { bookingGroupId: GROUP_ID });
    const res = await tool("its.operationalize_booking_group").handler(ctx(admin), { confirmationToken: preview.confirmationToken });
    expect(res.outcome).toBe("operationalized");
    expect(res.group_status).toBe("operational");
    expect(db.booking_groups[0].status).toBe("operational");
  });

  it("nessuno pronto → outcome 'blocked', nessuna scrittura sui servizi", async () => {
    const { admin, db } = makeAdmin(seed([svc("a", { time: "00:00" }), svc("b", { id: "b", time: "00:00" })]));
    const token = generateBookingGroupConfirmationToken({ op: "operationalize_booking_group", userId: USER, tenantId: TENANT, groupId: GROUP_ID, args: {} });
    const res = await tool("its.operationalize_booking_group").handler(ctx(admin), { confirmationToken: token.token });
    expect(res.outcome).toBe("blocked");
    expect((res.operationalized as Row[])).toHaveLength(0);
    expect(db.services.every((s) => s.is_draft === true)).toBe(true);
  });
});

// ─── §26 — permessi ─────────────────────────────────────────────────────

describe("permessi (§26)", () => {
  it("supervisor: canExecuteTool nega preview_create e create (nessun token eseguibile)", () => {
    const c = ctx(makeAdmin({}).admin, "supervisor");
    expect(() => canExecuteTool(c, tool("its.preview_create_booking_group") as never)).toThrow(/FORBIDDEN|non autorizzato/i);
    expect(() => canExecuteTool(c, tool("its.create_booking_group") as never)).toThrow(/FORBIDDEN|non autorizzato/i);
  });

  it("supervisor: READ consentite (find / detail / preview_operationalization)", () => {
    const c = ctx(makeAdmin({}).admin, "supervisor");
    expect(canExecuteTool(c, tool("its.find_booking_group") as never)).toBe(true);
    expect(canExecuteTool(c, tool("its.get_booking_group_detail") as never)).toBe(true);
    expect(canExecuteTool(c, tool("its.preview_booking_group_operationalization") as never)).toBe(true);
  });

  it("preview_booking_group_operationalization NON emette token per supervisor", async () => {
    const { admin } = makeAdmin({
      booking_groups: [baseGroup({ status: "passengers_defined" })],
      booking_group_stops: [{ id: STOP_ID, tenant_id: TENANT, booking_group_id: GROUP_ID, city: "Tivoli", pickup_point: "Villa d'Este", stop_id: STOP_ID, expected_pax: 20 }],
      services: [{ id: "ok", tenant_id: TENANT, booking_group_id: GROUP_ID, booking_group_stop_id: STOP_ID, is_draft: true, status: "needs_review", pax: 4, customer_name: "Rossi", date: "2026-09-12", time: "07:30", direction: "arrival", bus_city_origin: "Tivoli", meeting_point: "Villa d'Este", hotel_id: null, booking_service_kind: "bus_city_hotel" }],
      booking_group_bus_reservations: [],
    });
    const out = await tool("its.preview_booking_group_operationalization").handler(ctx(admin, "supervisor"), { bookingGroupId: GROUP_ID });
    expect(out.services_ready).toBe(1);
    expect(out.confirmationToken).toBeNull();
  });

  it("WRITE tool tutti abilitati nell'allowlist di policy", async () => {
    const { ENABLED_WRITE_TOOLS } = await import("@/lib/mcp/policy");
    for (const n of [
      "its.create_booking_group", "its.add_booking_group_stop", "its.add_booking_group_passengers",
      "its.reserve_booking_group_bus", "its.update_booking_group_ferry", "its.operationalize_booking_group",
    ]) {
      expect(ENABLED_WRITE_TOOLS).toContain(n);
    }
  });
});

// ─── §39 — scenario end-to-end PARROCCHIA NATIVITÀ ──────────────────────

describe("§39 — conversazione end-to-end Parrocchia Natività (chain di tool)", () => {
  const BUS = "66666666-6666-4666-8666-666666666666";

  async function pv(admin: McpContext["admin"], name: string, input: unknown) {
    return tool(name).handler(ctx(admin), input);
  }

  it("crea gruppo → 3 fermate → nominativi → riserva bus → traghetto → operativizza", async () => {
    const { admin, db } = makeAdmin({
      tenant_bus_units: [{ id: BUS, tenant_id: TENANT, capacity: 55, tag: "esclusivo", group_name: "Bus Parrocchia" }],
    });

    // 1. "trova il gruppo Parrocchia Natività" → non esiste ancora.
    const found = await pv(admin, "its.find_booking_group", { query: "Parrocchia Natività" });
    expect((found.matches as Row[])).toHaveLength(0);

    // 2-3. crea il gruppo (50 pax, bus esclusivo, 12/09/2026).
    const pCreate = await pv(admin, "its.preview_create_booking_group", {
      name: "Parrocchia Natività", expectedPax: 50, kind: "bus_exclusive", serviceDate: "2026-09-12",
    });
    const created = await pv(admin, "its.create_booking_group", { confirmationToken: pCreate.confirmationToken });
    const groupId = created.bookingGroupId as string;
    expect(db.booking_groups).toHaveLength(1);

    // 4-6. tre fermate: Tivoli 20, Guidonia 20, Castel Madama 10 → planned 50.
    const stopIds: string[] = [];
    for (const [city, pax, pickup] of [["Tivoli", 20, "Villa d'Este"], ["Guidonia", 20, "Piazza Matteotti"], ["Castel Madama", 10, "Bar Centrale"]] as const) {
      const pStop = await pv(admin, "its.preview_add_booking_group_stop", {
        bookingGroupId: groupId, city, pickupPoint: pickup, expectedPax: pax, direction: "arrival",
      });
      const s = await pv(admin, "its.add_booking_group_stop", { confirmationToken: pStop.confirmationToken });
      stopIds.push(s.bookingGroupStopId as string);
    }
    expect(db.booking_group_stops).toHaveLength(3);

    // 7-8. nominativi su Tivoli (Rossi 4 + Verdi 10 + Pinco 2 + Gennaro 4 = 20).
    const pPax = await pv(admin, "its.preview_add_booking_group_passengers", {
      bookingGroupId: groupId, bookingGroupStopId: stopIds[0],
      passengers: [
        { customerName: "Rossi", pax: 4 }, { customerName: "Verdi", pax: 10 },
        { customerName: "Pinco Pallo", pax: 2 }, { customerName: "Gennaro", pax: 4 },
      ],
    });
    expect(pPax.total_pax).toBe(20);
    const addPax = await pv(admin, "its.add_booking_group_passengers", { confirmationToken: pPax.confirmationToken });
    expect(addPax.created_count).toBe(4);

    // 9-10. riserva bus esclusivo per la data.
    const pBus = await pv(admin, "its.preview_reserve_booking_group_bus", {
      bookingGroupId: groupId, busUnitId: BUS, serviceDate: "2026-09-12", reservedPax: 50, exclusive: true,
    });
    expect(pBus.warnings).not.toContain("reserved_pax_above_capacity");
    await pv(admin, "its.reserve_booking_group_bus", { confirmationToken: pBus.confirmationToken });
    expect(db.booking_group_bus_reservations).toHaveLength(1);

    // 11-12. traghetto override (andata + ritorno).
    const pFerry = await pv(admin, "its.preview_update_booking_group_ferry", {
      bookingGroupId: groupId,
      ferry: { outbound_ferry_company: "MEDMAR", outbound_ferry_time: "10:35", return_ferry_company: "MEDMAR", return_ferry_time: "17:00" },
    });
    expect((pFerry.changes as Row[]).length).toBe(4);
    await pv(admin, "its.update_booking_group_ferry", { confirmationToken: pFerry.confirmationToken });
    expect(db.booking_groups[0]).toMatchObject({ outbound_ferry_time: "10:35", return_ferry_time: "17:00" });

    // 13. "il gruppo è pronto per essere operativo?" → NO: i servizi bozza
    // hanno orario placeholder 00:00 (Mario NON inventa l'orario, §23/§38).
    const inspect1 = await pv(admin, "its.preview_booking_group_operationalization", { bookingGroupId: groupId });
    expect(inspect1.services_ready).toBe(0);
    expect(inspect1.services_blocked).toBe(4);
    const blockedSvc = inspect1.services as Array<{ missing_fields: string[] }>;
    expect(blockedSvc.every((s) => s.missing_fields.includes("missing_time"))).toBe(true);
    expect(inspect1.warnings).not.toContain("bus_reservation_missing"); // il bus è stato riservato
    expect(inspect1.warnings).not.toContain("ferry_outbound_missing"); // il traghetto è stato impostato

    // 14. l'operatore completa gli orari nel flusso normale (fuori FASE 3).
    for (const s of db.services) s.time = "07:30";

    // 15. ora l'operativizzazione va a buon fine per tutti.
    const inspect2 = await pv(admin, "its.preview_booking_group_operationalization", { bookingGroupId: groupId });
    expect(inspect2.services_ready).toBe(4);
    expect(typeof inspect2.confirmationToken).toBe("string");
    const op = await pv(admin, "its.operationalize_booking_group", { confirmationToken: inspect2.confirmationToken });
    expect(op.outcome).toBe("operationalized");
    expect(op.group_status).toBe("operational");
    expect(db.services.every((s) => s.is_draft === false && s.status === "new")).toBe(true);
    expect(db.booking_groups[0].status).toBe("operational");
  });

  it("ambiguità blocca la scrittura: due gruppi omonimi → find restituisce entrambi, nessun write parte", async () => {
    const { admin, db } = makeAdmin({
      booking_groups: [
        baseGroup({ id: "gA", service_date: "2026-09-12" }),
        baseGroup({ id: "gB", service_date: "2026-10-05" }),
      ],
    });
    const found = await tool("its.find_booking_group").handler(ctx(admin), { query: "Parrocchia Natività" });
    expect(found.ambiguous).toBe(true);
    expect((found.matches as Row[])).toHaveLength(2);
    // nessun tool di scrittura è stato invocato: lo stato resta invariato.
    expect(db.booking_group_stops ?? []).toHaveLength(0);
    expect(db.services ?? []).toHaveLength(0);
  });
});
