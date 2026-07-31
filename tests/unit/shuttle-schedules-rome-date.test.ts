import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type Row = Record<string, unknown>;

// --- Part 1: pure function tests, fully deterministic via the `now` param,
// no global clock manipulation involved. ---

const mocksForPure = vi.hoisted(() => ({
  authorizeServiceRoleRequest: vi.fn(),
  auditLog: vi.fn(),
}));

vi.mock("@/lib/server/pricing-auth", () => ({
  authorizeServiceRoleRequest: mocksForPure.authorizeServiceRoleRequest,
}));
vi.mock("@/lib/server/ops-audit", () => ({
  auditLog: mocksForPure.auditLog,
}));

import { todayIsoDate as todayIsoDateFromCreate } from "@/app/api/shuttle-schedules/route";
import { todayIsoDate as todayIsoDateFromPatch } from "@/app/api/shuttle-schedules/[id]/route";
import { PATCH, DELETE } from "@/app/api/shuttle-schedules/[id]/route";
import { buildShuttleScheduleId } from "@/lib/shuttle-schedules";

describe("todayIsoDate — Europe/Rome, deterministic via explicit `now`", () => {
  // Same 12 cases run against both module-local implementations to prove
  // there is no implementation drift between the two duplicated definitions.
  const implementations: Array<[string, (now?: Date) => string]> = [
    ["app/api/shuttle-schedules/route.ts", todayIsoDateFromCreate],
    ["app/api/shuttle-schedules/[id]/route.ts", todayIsoDateFromPatch],
  ];

  for (const [label, todayIsoDate] of implementations) {
    describe(label, () => {
      it("1. ora solare — 23:30 UTC del 15/01 è già 16/01 a Roma", () => {
        expect(todayIsoDate(new Date("2026-01-15T23:30:00.000Z"))).toBe("2026-01-16");
      });

      it("2. ora legale — 22:30 UTC del 15/07 è già 16/07 a Roma", () => {
        expect(todayIsoDate(new Date("2026-07-15T22:30:00.000Z"))).toBe("2026-07-16");
      });

      it("3. ora centrale della giornata — stesso giorno in UTC e a Roma", () => {
        expect(todayIsoDate(new Date("2026-07-15T10:00:00.000Z"))).toBe("2026-07-15");
      });

      it("4. fine anno — 23:30 UTC del 31/12 è già 01/01 dell'anno successivo a Roma", () => {
        expect(todayIsoDate(new Date("2026-12-31T23:30:00.000Z"))).toBe("2027-01-01");
      });

      it("5. rollover di fine mese — 23:30 UTC del 31/01 è già 01/02 a Roma", () => {
        expect(todayIsoDate(new Date("2026-01-31T23:30:00.000Z"))).toBe("2026-02-01");
      });

      it("6. transizione verso ora legale (ultima domenica di marzo) — l'offset cambia da +1 a +2, non è fisso", () => {
        // Same wall-clock UTC hour (22:30), before vs after the spring-forward
        // switch (2026-03-29 01:00 UTC): the resulting Rome date differs
        // because the UTC offset used changes from CET(+1) to CEST(+2).
        expect(todayIsoDate(new Date("2026-03-28T22:30:00.000Z"))).toBe("2026-03-28");
        expect(todayIsoDate(new Date("2026-03-29T22:30:00.000Z"))).toBe("2026-03-30");
      });

      it("7. transizione verso ora solare (ultima domenica di ottobre) — basato su Europe/Rome, non offset fisso", () => {
        // Fall-back switch (2026-10-25 01:00 UTC): CEST(+2) → CET(+1).
        expect(todayIsoDate(new Date("2026-10-24T21:30:00.000Z"))).toBe("2026-10-24");
        expect(todayIsoDate(new Date("2026-10-25T21:30:00.000Z"))).toBe("2026-10-25");
      });

      it("8. indipendenza dal timezone del processo — stesso risultato indipendentemente da TZ dell'ambiente Node", () => {
        // Intl.DateTimeFormat with an explicit `timeZone` option ignores
        // process.env.TZ entirely; this asserts the computed value matches
        // the known-correct Rome date regardless of the runner's local TZ.
        const result = todayIsoDate(new Date("2026-07-15T22:30:00.000Z"));
        expect(result).toBe("2026-07-16");
        expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      });

      it("nessun offset fisso: NON restituisce il formato locale italiano (es. 31/07/2026)", () => {
        const result = todayIsoDate(new Date("2026-07-31T10:00:00.000Z"));
        expect(result).toBe("2026-07-31");
        expect(result).not.toMatch(/\//);
      });
    });
  }
});

// --- Part 2: handler-level tests. Verify the actual value passed to
// .gte("date", ...) inside the real PATCH/DELETE flow, using a fake Supabase
// admin client that records the exact filter arguments applied. ---

type FakeSupabase = ReturnType<typeof createFakeSupabase>;

function createFakeSupabase(seed: { services?: Row[]; assignments?: Row[] } = {}) {
  const services = [...(seed.services ?? [])];
  const assignments = [...(seed.assignments ?? [])];
  const calls = { delete: 0, insert: 0, gteDateValues: [] as string[] };

  function makeSelectBuilder(rows: Row[]) {
    let filtered = rows;
    const builder = {
      eq(field: string, value: unknown) {
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
        if (field === "date") calls.gteDateValues.push(value as string);
        filtered = filtered.filter((row) => (row[field] as string) >= (value as string));
        return builder;
      },
      limit() {
        return builder;
      },
      then(resolve: (v: { data: Row[] | null; error: null }) => unknown, reject?: (e: unknown) => unknown) {
        return Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
      },
    };
    return builder;
  }

  function makeDeleteBuilder() {
    const builder = {
      eq() {
        return builder;
      },
      gte(field: string, value: unknown) {
        if (field === "date") calls.gteDateValues.push(value as string);
        return builder;
      },
      is() {
        return builder;
      },
      then(resolve: (v: { error: null }) => unknown, reject?: (e: unknown) => unknown) {
        return Promise.resolve({ error: null }).then(resolve, reject);
      },
    };
    return builder;
  }

  const admin = {
    from(table: string) {
      if (table === "services") {
        return {
          select() {
            return makeSelectBuilder(services);
          },
          delete() {
            calls.delete++;
            return makeDeleteBuilder();
          },
          insert(_rows: unknown) {
            calls.insert++;
            return Promise.resolve({ error: null });
          },
        };
      }
      if (table === "assignments") {
        return {
          select() {
            return makeSelectBuilder(assignments);
          },
        };
      }
      if (table === "hotels") {
        return {
          select() {
            return makeSelectBuilder([]);
          },
        };
      }
      throw new Error(`Unexpected table in test fake: ${table}`);
    },
  };

  return { admin, calls };
}

function authorizeAs(tenantId: string, fake: FakeSupabase) {
  mocksForPure.authorizeServiceRoleRequest.mockResolvedValue({
    admin: fake.admin,
    user: { id: "user-1", email: "op@test.dev" },
    membership: { tenant_id: tenantId, role: "operator", suspended: false },
  });
}

const SCHEDULE_KEY = {
  hotel_id: null as string | null,
  booking_service_kind: "navetta" as const,
  customer_name: "Hotel Test",
  direction: "departure" as const,
  departure_time: "09:30",
  meeting_point: null,
  vessel: "Navetta",
};
const SCHEDULE_ID = buildShuttleScheduleId(SCHEDULE_KEY);

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
function callPatch(body: Record<string, unknown>) {
  return PATCH(makePatchRequest(body), { params: Promise.resolve({ id: SCHEDULE_ID }) });
}
function callDelete() {
  return DELETE(makeDeleteRequest(), { params: Promise.resolve({ id: SCHEDULE_ID }) });
}

function futurePayload(overrides: Record<string, unknown> = {}) {
  return {
    hotel_id: null,
    booking_service_kind: "navetta",
    customer_name: "Hotel Test",
    direction: "departure",
    departure_time: "09:30",
    meeting_point: null,
    vessel: "Navetta",
    valid_from: "2026-07-16",
    valid_to: "2026-07-20",
    days_of_week: null,
    notes: null,
    ...overrides,
  };
}

describe("PATCH/DELETE /api/shuttle-schedules/[id] — la data passata a .gte(\"date\", ...) è quella di Roma", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("9. PATCH alle 22:30 UTC in piena estate usa il giorno successivo italiano nel filtro .gte(\"date\", ...)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T22:30:00.000Z"));

    const fake = createFakeSupabase({ services: [], assignments: [] });
    authorizeAs(TENANT_A, fake);

    const res = await callPatch(futurePayload());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    // Both hasOperationalFutureServices and deleteMatchingFutureServices call
    // .gte("date", todayIsoDate()); every recorded value must be the Rome date.
    expect(fake.calls.gteDateValues.length).toBeGreaterThan(0);
    for (const value of fake.calls.gteDateValues) {
      expect(value).toBe("2026-07-16");
    }
  });

  it("10. DELETE alle 22:30 UTC in piena estate usa il giorno successivo italiano nel filtro .gte(\"date\", ...)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T22:30:00.000Z"));

    const fake = createFakeSupabase({ services: [], assignments: [] });
    authorizeAs(TENANT_A, fake);

    const res = await callDelete();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(fake.calls.gteDateValues.length).toBeGreaterThan(0);
    for (const value of fake.calls.gteDateValues) {
      expect(value).toBe("2026-07-16");
    }
  });

  it("11. Regressione F-01: una corsa datata 'oggi' a Roma (ma 'ieri' in UTC) con assignment resta protetta", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T22:30:00.000Z")); // Rome: 2026-07-16, 00:30

    const service: Row = {
      id: "svc-1",
      tenant_id: TENANT_A,
      date: "2026-07-16", // Rome "today"
      direction: SCHEDULE_KEY.direction,
      time: SCHEDULE_KEY.departure_time,
      customer_name: SCHEDULE_KEY.customer_name,
      vessel: SCHEDULE_KEY.vessel,
      hotel_id: SCHEDULE_KEY.hotel_id,
      meeting_point: SCHEDULE_KEY.meeting_point,
      booking_service_kind: SCHEDULE_KEY.booking_service_kind,
      status: "new",
    };
    const fake = createFakeSupabase({
      services: [service],
      assignments: [{ id: "a1", tenant_id: TENANT_A, service_id: "svc-1" }],
    });
    authorizeAs(TENANT_A, fake);

    const res = await callDelete();
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("SHUTTLE_HAS_OPERATIONAL_SERVICES");
    expect(fake.calls.delete).toBe(0);
  });

  it("12. Regressione: fuori dalla finestra critica il comportamento resta invariato (orario reale, nessun mock del clock)", async () => {
    const fake = createFakeSupabase({ services: [], assignments: [] });
    authorizeAs(TENANT_A, fake);

    const realToday = new Date().toISOString().slice(0, 10);
    const realTomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const res = await callPatch(futurePayload({ valid_from: realToday, valid_to: realTomorrow }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(fake.calls.delete).toBe(1);
    expect(fake.calls.insert).toBe(1);
  });
});
