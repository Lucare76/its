import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * FASE A.5 — dominio booking-groups-service.ts:
 *  - serviceDate override in addBookingGroupPassengers (andata/ritorno sullo
 *    stesso gruppo, senza migration);
 *  - risoluzione fermata canonica (stop_id + pickup_time reale, mai "00:00"
 *    inventato);
 *  - gate bus_exclusive: mai auto-allocazione su bus condiviso.
 */

const mocks = vi.hoisted(() => ({ autoAllocateBusService: vi.fn() }));
vi.mock("@/lib/server/bus-auto-allocation", () => ({ autoAllocateBusService: mocks.autoAllocateBusService }));

import {
  addBookingGroupStop,
  addBookingGroupPassengers,
  operationalizeBookingGroup,
  resolveCanonicalBookingGroupStop,
} from "@/lib/server/booking-groups-service";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GROUP_ID = "11111111-1111-4111-8111-111111111111";
const STOP_ID = "44444444-4444-4444-8444-444444444444";
const CANONICAL_STOP_ID = "55555555-5555-4555-8555-555555555555";

type Row = Record<string, unknown>;

function makeAdmin(seed: Record<string, Row[]> = {}) {
  const writes = {
    inserts: [] as Array<{ table: string; row: Row }>,
    updates: [] as Array<{ table: string; filters: Row; payload: Row }>,
  };
  let seq = 0;

  function builder(table: string) {
    const filters: Row = {};
    let pending: { kind: "insert" | "update"; payload?: Row } | null = null;

    const rowsForFilters = () => (seed[table] ?? []).filter((r) => Object.entries(filters).every(([k, v]) => r[k] === v));

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
      return { data: null, error: null };
    };

    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.order = () => b;
    b.limit = () => b;
    b.eq = (col: string, val: unknown) => { filters[col] = val; return b; };
    b.maybeSingle = async () => (pending ? finish() : { data: rowsForFilters()[0] ?? null, error: null });
    b.single = async () => (pending ? finish() : { data: rowsForFilters()[0] ?? null, error: null });
    b.insert = (payload: Row) => { pending = { kind: "insert", payload }; return b; };
    b.update = (payload: Row) => { pending = { kind: "update", payload }; return b; };
    b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      if (pending) return Promise.resolve(finish()).then(resolve, reject);
      return Promise.resolve({ data: rowsForFilters(), error: null }).then(resolve, reject);
    };
    return b;
  }

  return { admin: { from: (t: string) => builder(t) } as never, writes };
}

const actor = { tenantId: TENANT, userId: "u1", role: "operator" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.autoAllocateBusService.mockResolvedValue({ ok: true, allocated: true, serviceId: "svc", busUnitId: "bus", busLabel: "Bus 1", stopId: "stop", stopName: "Rimini", pax: 50 });
});

describe("resolveCanonicalBookingGroupStop — match esatto, mai fuzzy", () => {
  it("match univoco su city → stopId + pickupTime", async () => {
    const { admin } = makeAdmin({
      tenant_bus_line_stops: [{ id: CANONICAL_STOP_ID, tenant_id: TENANT, city: "Rimini", stop_name: "RIMINI", direction: "arrival", active: true, pickup_time: "05:10" }],
    });
    const res = await resolveCanonicalBookingGroupStop(admin as never, TENANT, "Rimini", "arrival");
    expect(res).toEqual({ stopId: CANONICAL_STOP_ID, pickupTime: "05:10" });
  });

  it("nessun match → null (mai un'assegnazione indovinata)", async () => {
    const { admin } = makeAdmin({ tenant_bus_line_stops: [] });
    const res = await resolveCanonicalBookingGroupStop(admin as never, TENANT, "Città Sconosciuta", "arrival");
    expect(res).toBeNull();
  });

  it("match ambiguo (due righe) → null, non sceglie a caso", async () => {
    const { admin } = makeAdmin({
      tenant_bus_line_stops: [
        { id: "a", tenant_id: TENANT, city: "Roma", stop_name: "ROMA TIBURTINA", direction: "arrival", active: true, pickup_time: "07:45" },
        { id: "b", tenant_id: TENANT, city: "Roma", stop_name: "ROMA ANAGNINA", direction: "arrival", active: true, pickup_time: "08:15" },
      ],
    });
    const res = await resolveCanonicalBookingGroupStop(admin as never, TENANT, "Roma", "arrival");
    expect(res).toBeNull();
  });

  // Obiettivo A (prompt "FIX MIRATO — GIACOMONI: MAROTTA DUPLICATA"): regressione
  // sul dato reale. Il catalogo departure aveva UN SOLO stop sotto la linea
  // esclusiva (MAROTTA, pickup_note "PARCHEGGIO CASELLO A14"). Cercare la
  // fermata canonica per FANO con lo stesso pickup_point testuale (copiato
  // pari pari dall'andata da generateReturnStopsFromArrival) risolveva
  // ERRONEAMENTE a MAROTTA — nessun controllo che la città combaciasse
  // quando il match arrivava da pickup_point/stop_name. Risultato reale:
  // l'allocazione del service FANO ritorno veniva salvata con
  // stop_name="MAROTTA", duplicando visivamente MAROTTA nel bus.
  it("città diversa con lo STESSO pickup_point testuale → null, mai un match cross-città (regressione MAROTTA/FANO)", async () => {
    const { admin } = makeAdmin({
      tenant_bus_line_stops: [
        { id: "marotta-dep", tenant_id: TENANT, city: "MAROTTA", stop_name: "MAROTTA", pickup_note: "PARCHEGGIO CASELLO A14", direction: "departure", active: true, pickup_time: "09:00" },
      ],
    });
    const res = await resolveCanonicalBookingGroupStop(admin as never, TENANT, "FANO", "departure", "PARCHEGGIO CASELLO A14");
    expect(res).toBeNull();
  });

  it("stessa città + stesso pickup_point testuale → risolve correttamente (comportamento legittimo invariato)", async () => {
    const { admin } = makeAdmin({
      tenant_bus_line_stops: [
        { id: "marotta-dep", tenant_id: TENANT, city: "MAROTTA", stop_name: "MAROTTA", pickup_note: "PARCHEGGIO CASELLO A14", direction: "departure", active: true, pickup_time: "09:00" },
      ],
    });
    const res = await resolveCanonicalBookingGroupStop(admin as never, TENANT, "MAROTTA", "departure", "PARCHEGGIO CASELLO A14");
    expect(res).toEqual({ stopId: "marotta-dep", pickupTime: "09:00" });
  });

  // Obiettivo D (prompt "FIX MIRATO — CATALOGO FERMATE RITORNO BUS ESCLUSIVI"):
  // catalogo ritorno completo (GIACOMONI, GRUPPI_ESCLUSIVI) — PESARO e
  // CATTOLICA devono risolvere alla propria fermata, MAI a MAROTTA, e FANO
  // resta risolto correttamente anche con più righe simili in catalogo.
  describe("catalogo ritorno GRUPPI_ESCLUSIVI completo (MAROTTA + FANO + PESARO + CATTOLICA)", () => {
    const returnCatalog = [
      { id: "dep-marotta", tenant_id: TENANT, city: "MAROTTA", stop_name: "MAROTTA", pickup_note: "PARCHEGGIO CASELLO A14", direction: "departure", active: true, pickup_time: "09:00" },
      { id: "dep-fano", tenant_id: TENANT, city: "FANO", stop_name: "FANO", pickup_note: "PARCHEGGIO CASELLO A14", direction: "departure", active: true, pickup_time: null },
      { id: "dep-pesaro", tenant_id: TENANT, city: "PESARO", stop_name: "PESARO", pickup_note: "CASELLO A14", direction: "departure", active: true, pickup_time: null },
      { id: "dep-cattolica", tenant_id: TENANT, city: "CATTOLICA", stop_name: "CATTOLICA", pickup_note: "CASELLO A14", direction: "departure", active: true, pickup_time: null },
    ];

    it("PESARO ritorno risolve alla propria fermata", async () => {
      const { admin } = makeAdmin({ tenant_bus_line_stops: returnCatalog });
      const res = await resolveCanonicalBookingGroupStop(admin as never, TENANT, "PESARO", "departure", "CASELLO A14");
      expect(res).toEqual({ stopId: "dep-pesaro", pickupTime: null });
    });

    it("CATTOLICA ritorno risolve alla propria fermata", async () => {
      const { admin } = makeAdmin({ tenant_bus_line_stops: returnCatalog });
      const res = await resolveCanonicalBookingGroupStop(admin as never, TENANT, "CATTOLICA", "departure", "CASELLO A14");
      expect(res).toEqual({ stopId: "dep-cattolica", pickupTime: null });
    });

    it("FANO ritorno resta risolto correttamente (mai confuso con MAROTTA/PESARO/CATTOLICA)", async () => {
      const { admin } = makeAdmin({ tenant_bus_line_stops: returnCatalog });
      const res = await resolveCanonicalBookingGroupStop(admin as never, TENANT, "FANO", "departure", "PARCHEGGIO CASELLO A14");
      expect(res).toEqual({ stopId: "dep-fano", pickupTime: null });
    });

    it("MAROTTA non viene mai usata come fallback per PESARO/CATTOLICA/FANO", async () => {
      const { admin } = makeAdmin({ tenant_bus_line_stops: returnCatalog });
      const pesaro = await resolveCanonicalBookingGroupStop(admin as never, TENANT, "PESARO", "departure", "CASELLO A14");
      const cattolica = await resolveCanonicalBookingGroupStop(admin as never, TENANT, "CATTOLICA", "departure", "CASELLO A14");
      const fano = await resolveCanonicalBookingGroupStop(admin as never, TENANT, "FANO", "departure", "PARCHEGGIO CASELLO A14");
      expect(pesaro?.stopId).not.toBe("dep-marotta");
      expect(cattolica?.stopId).not.toBe("dep-marotta");
      expect(fano?.stopId).not.toBe("dep-marotta");
    });
  });
});

describe("addBookingGroupStop — auto-risolve stop_id canonico (§E)", () => {
  it("città con match univoco → stop_id valorizzato automaticamente", async () => {
    const { admin, writes } = makeAdmin({
      booking_groups: [{ id: GROUP_ID, tenant_id: TENANT }],
      tenant_bus_line_stops: [{ id: CANONICAL_STOP_ID, tenant_id: TENANT, city: "Rimini", stop_name: "RIMINI", direction: "arrival", active: true, pickup_time: "05:10" }],
    });
    const res = await addBookingGroupStop(admin as never, actor, { bookingGroupId: GROUP_ID, city: "Rimini", expected_pax: 50, direction: "arrival" });
    expect(res.ok).toBe(true);
    const row = writes.inserts.find((w) => w.table === "booking_group_stops")!.row;
    expect(row.stop_id).toBe(CANONICAL_STOP_ID);
  });

  it("nessun match → stop_id resta undefined (comportamento invariato)", async () => {
    const { admin, writes } = makeAdmin({ booking_groups: [{ id: GROUP_ID, tenant_id: TENANT }] });
    const res = await addBookingGroupStop(admin as never, actor, { bookingGroupId: GROUP_ID, city: "Tivoli", expected_pax: 20, direction: "arrival" });
    expect(res.ok).toBe(true);
    const row = writes.inserts.find((w) => w.table === "booking_group_stops")!.row;
    expect(row.stop_id).toBeUndefined();
  });
});

describe("addBookingGroupPassengers — serviceDate override + pickup_time reale (§B/§C/§D)", () => {
  const GROUP = { id: GROUP_ID, tenant_id: TENANT, kind: "bus_exclusive", service_date: "2026-09-13" };
  const STOP_WITH_CANONICAL = { id: STOP_ID, tenant_id: TENANT, booking_group_id: GROUP_ID, city: "Rimini", pickup_point: null, direction: "departure", stop_id: CANONICAL_STOP_ID };

  it("serviceDate esplicito (ritorno) vince su group.service_date (andata)", async () => {
    const { admin, writes } = makeAdmin({
      booking_groups: [GROUP],
      booking_group_stops: [STOP_WITH_CANONICAL],
      tenant_bus_line_stops: [{ id: CANONICAL_STOP_ID, tenant_id: TENANT, pickup_time: "18:00" }],
    });
    const res = await addBookingGroupPassengers(admin as never, actor, {
      bookingGroupId: GROUP_ID,
      bookingGroupStopId: STOP_ID,
      passengers: [{ customer_name: "Gruppo La Marra", pax: 50 }],
      serviceDate: "2026-09-20",
    });
    expect(res.ok).toBe(true);
    const svc = writes.inserts.find((w) => w.table === "services")!.row;
    expect(svc.date).toBe("2026-09-20"); // ritorno, NON group.service_date (13-09)
    expect(svc.direction).toBe("departure");
    // Obiettivo C: departure_date segue `date` fin dalla creazione (vista
    // Ritorni/Partenza deve trovarlo subito nel giorno giusto).
    expect(svc.departure_date).toBe("2026-09-20");
    expect(svc.arrival_date).toBeUndefined();
  });

  it("senza serviceDate esplicito → default group.service_date (andata, invariato)", async () => {
    const { admin, writes } = makeAdmin({
      booking_groups: [GROUP],
      booking_group_stops: [{ ...STOP_WITH_CANONICAL, direction: "arrival" }],
      tenant_bus_line_stops: [{ id: CANONICAL_STOP_ID, tenant_id: TENANT, pickup_time: "05:10" }],
    });
    const res = await addBookingGroupPassengers(admin as never, actor, {
      bookingGroupId: GROUP_ID,
      bookingGroupStopId: STOP_ID,
      passengers: [{ customer_name: "Gruppo La Marra", pax: 50 }],
    });
    expect(res.ok).toBe(true);
    const svc = writes.inserts.find((w) => w.table === "services")!.row;
    expect(svc.date).toBe("2026-09-13");
    // Obiettivo C: arrival_date segue `date` fin dalla creazione (vista
    // Arrivi/Andata deve trovarlo subito nel giorno giusto).
    expect(svc.arrival_date).toBe("2026-09-13");
    expect(svc.departure_date).toBeUndefined();
  });

  it("stop con canonico risolto → time = pickup_time reale, non 00:00", async () => {
    const { admin, writes } = makeAdmin({
      booking_groups: [GROUP],
      booking_group_stops: [STOP_WITH_CANONICAL],
      tenant_bus_line_stops: [{ id: CANONICAL_STOP_ID, tenant_id: TENANT, pickup_time: "18:00" }],
    });
    await addBookingGroupPassengers(admin as never, actor, {
      bookingGroupId: GROUP_ID,
      bookingGroupStopId: STOP_ID,
      passengers: [{ customer_name: "Gruppo La Marra", pax: 50 }],
    });
    const svc = writes.inserts.find((w) => w.table === "services")!.row;
    expect(svc.time).toBe("18:00");
  });

  it("stop SENZA canonico risolto → placeholder 00:00 invariato (mai un orario inventato)", async () => {
    const { admin, writes } = makeAdmin({
      booking_groups: [GROUP],
      booking_group_stops: [{ ...STOP_WITH_CANONICAL, stop_id: null }],
    });
    await addBookingGroupPassengers(admin as never, actor, {
      bookingGroupId: GROUP_ID,
      bookingGroupStopId: STOP_ID,
      passengers: [{ customer_name: "Gruppo La Marra", pax: 50 }],
    });
    const svc = writes.inserts.find((w) => w.table === "services")!.row;
    expect(svc.time).toBe("00:00");
  });

  it("serviceDate malformata → 400, nessuna scrittura", async () => {
    const { admin, writes } = makeAdmin({ booking_groups: [GROUP], booking_group_stops: [STOP_WITH_CANONICAL] });
    const res = await addBookingGroupPassengers(admin as never, actor, {
      bookingGroupId: GROUP_ID,
      bookingGroupStopId: STOP_ID,
      passengers: [{ customer_name: "X", pax: 1 }],
      serviceDate: "20-09-2026",
    });
    expect(res.ok).toBe(false);
    expect((res as { status: number }).status).toBe(400);
    expect(writes.inserts).toHaveLength(0);
  });
});

describe("operationalizeBookingGroup — bus_exclusive mai su bus condiviso (§P)", () => {
  const svc = (id: string, kind: string, over: Row = {}) => ({
    id, tenant_id: TENANT, booking_group_id: GROUP_ID, booking_group_stop_id: STOP_ID,
    is_draft: true, status: "needs_review", pax: 50, customer_name: "Gruppo La Marra", date: "2026-09-13",
    time: "05:10", direction: "arrival", bus_city_origin: "Rimini", meeting_point: null,
    hotel_id: null, booking_service_kind: kind, ...over,
  });
  const STOP = { id: STOP_ID, tenant_id: TENANT, booking_group_id: GROUP_ID, city: "Rimini", pickup_point: null, stop_id: CANONICAL_STOP_ID, expected_pax: 50 };

  it("kind=bus_exclusive: NON chiama autoAllocateBusService, warning allocation_pending", async () => {
    const GROUP = { id: GROUP_ID, tenant_id: TENANT, kind: "bus_exclusive", service_date: "2026-09-13", expected_pax: 50, status: "passengers_defined", outbound_ferry_company: "x", outbound_ferry_time: "x", return_ferry_company: "x", return_ferry_time: "x" };
    const { admin } = makeAdmin({
      booking_groups: [GROUP], booking_group_stops: [STOP],
      services: [svc("s1", "bus_city_hotel")],
      booking_group_bus_reservations: [],
    });
    const res = await operationalizeBookingGroup(admin as never, actor, { bookingGroupId: GROUP_ID });
    expect(mocks.autoAllocateBusService).not.toHaveBeenCalled();
    expect(res.data && "operationalized" in res.data ? res.data.operationalized[0]!.warnings : []).toContain("allocation_pending");
  });

  it("kind=bus_group: chiama autoAllocateBusService normalmente (comportamento invariato)", async () => {
    const GROUP = { id: GROUP_ID, tenant_id: TENANT, kind: "bus_group", service_date: "2026-09-13", expected_pax: 50, status: "passengers_defined", outbound_ferry_company: "x", outbound_ferry_time: "x", return_ferry_company: "x", return_ferry_time: "x" };
    const { admin } = makeAdmin({
      booking_groups: [GROUP], booking_group_stops: [STOP],
      services: [svc("s1", "bus_city_hotel")],
      booking_group_bus_reservations: [],
    });
    await operationalizeBookingGroup(admin as never, actor, { bookingGroupId: GROUP_ID });
    expect(mocks.autoAllocateBusService).toHaveBeenCalledTimes(1);
  });
});
