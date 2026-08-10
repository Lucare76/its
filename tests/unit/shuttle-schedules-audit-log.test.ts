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

// Trova la prossima data (a partire da minOffsetDays giorni da oggi) che
// cade nel giorno della settimana richiesto (0=domenica...6=sabato),
// per i test che devono preservare un giorno settimanale specifico senza
// dipendere da date hardcoded che finiscono nel passato.
function nextWeekdayIsoDate(targetDow: number, minOffsetDays: number) {
  for (let offset = minOffsetDays; offset < minOffsetDays + 14; offset++) {
    const date = isoDate(offset);
    if (new Date(`${date}T12:00:00`).getDay() === targetDow) return date;
  }
  throw new Error(`Nessuna data trovata per il giorno settimanale ${targetDow}`);
}
function addDaysIso(dateStr: string, days: number) {
  const d = new Date(`${dateStr}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

type Row = Record<string, unknown>;

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
 * Tenant-aware, mutating in-memory fake for "hotels" / "services" /
 * "assignments". Supports controlled insert failures (flat or "fail on the
 * Nth insert() call", to simulate a mid-chunk failure without seeding
 * hundreds of real rows one by one).
 */
function createFakeSupabase(seed: { hotels?: Row[]; services?: Row[]; assignments?: Row[] } = {}) {
  const hotels: Row[] = [...(seed.hotels ?? [])];
  const services: Row[] = [...(seed.services ?? [])];
  const assignments: Row[] = [...(seed.assignments ?? [])];
  const calls = {
    hotelsSelect: 0,
    servicesSelect: 0,
    assignmentsSelect: 0,
    delete: 0,
    insertCalls: [] as number[],
    insertedRows: [] as Row[],
  };
  let insertErrorOnCall: number | null = null;
  let flatInsertError: string | null = null;
  let flatDeleteError: string | null = null;

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
        filtered = filtered.filter((row) => (row[field] as string) >= (value as string));
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
        return Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
      },
    };
    return builder;
  }

  function makeDeleteBuilder() {
    let filtered = services;
    const builder = {
      eq(field: string, value: unknown) {
        filtered = filtered.filter((row) => row[field] === value);
        return builder;
      },
      is(field: string, value: null) {
        filtered = filtered.filter((row) => row[field] === value);
        return builder;
      },
      gte(field: string, value: unknown) {
        filtered = filtered.filter((row) => (row[field] as string) >= (value as string));
        return builder;
      },
      then(resolve: (v: { error: { message: string } | null }) => unknown, reject?: (e: unknown) => unknown) {
        calls.delete++;
        if (flatDeleteError) {
          return Promise.resolve({ error: { message: flatDeleteError } }).then(resolve, reject);
        }
        const idsToRemove = new Set(filtered.map((row) => row.id));
        for (let i = services.length - 1; i >= 0; i--) {
          if (idsToRemove.has(services[i].id)) services.splice(i, 1);
        }
        return Promise.resolve({ error: null }).then(resolve, reject);
      },
    };
    return builder;
  }

  const admin = {
    from(table: string) {
      if (table === "hotels") {
        return {
          select() {
            calls.hotelsSelect++;
            return makeSelectBuilder(hotels);
          },
        };
      }
      if (table === "services") {
        return {
          select() {
            calls.servicesSelect++;
            return makeSelectBuilder(services);
          },
          delete() {
            return makeDeleteBuilder();
          },
          insert(rows: Row[]) {
            const callIndex = calls.insertCalls.length + 1;
            calls.insertCalls.push(rows.length);
            if (flatInsertError || insertErrorOnCall === callIndex) {
              return Promise.resolve({ error: { message: flatInsertError ?? `chunk ${callIndex} failed` } });
            }
            calls.insertedRows.push(...rows);
            services.push(...rows.map((row) => ({ id: `svc-${Math.random().toString(36).slice(2)}`, ...row })));
            return Promise.resolve({ error: null });
          },
        };
      }
      if (table === "assignments") {
        return {
          select() {
            calls.assignmentsSelect++;
            return makeSelectBuilder(assignments);
          },
        };
      }
      throw new Error(`Unexpected table in test fake: ${table}`);
    },
  };

  return {
    admin,
    services,
    hotels,
    assignments,
    calls,
    setInsertErrorOnCall(n: number) {
      insertErrorOnCall = n;
    },
    setFlatInsertError(message: string) {
      flatInsertError = message;
    },
    setFlatDeleteError(message: string) {
      flatDeleteError = message;
    },
  };
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

function authorizeAs(tenantId: string, fake: ReturnType<typeof createFakeSupabase>, role: string = "operator") {
  mocks.authorizeServiceRoleRequest.mockResolvedValue({
    admin: fake.admin,
    user: { id: "user-1", email: "op@test.dev" },
    membership: { tenant_id: tenantId, role, suspended: false },
  });
}

function eventsNamed(name: string) {
  return mocks.auditLog.mock.calls.map(([payload]) => payload).filter((payload) => payload.event === name);
}

function allEvents() {
  return mocks.auditLog.mock.calls.map(([payload]) => payload);
}

const FORBIDDEN_SUBSTRINGS = ["phone", "telefono", "whatsapp", "token", "authorization", "notes", "requestBody", "stack"];

function assertNoForbiddenData(payload: unknown) {
  const text = JSON.stringify(payload).toLowerCase();
  for (const forbidden of FORBIDDEN_SUBSTRINGS) {
    expect(text).not.toContain(forbidden.toLowerCase());
  }
}

describe("shuttle-schedules API — aggregated audit log (M1-08 / F-04)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------
  // POST
  // ---------------------------------------------------------------------
  describe("POST", () => {
    it("1. POST valido produce esattamente un evento shuttle_schedule_created", async () => {
      const fake = createFakeSupabase({ hotels: [{ id: HOTEL_A, tenant_id: TENANT_A }] });
      authorizeAs(TENANT_A, fake);

      const res = await callPost(basePayload({ hotel_id: HOTEL_A }));
      expect(res.status).toBe(200);

      expect(eventsNamed("shuttle_schedule_created")).toHaveLength(1);
    });

    it("2. tenantId e userId provengono dall'autenticazione, non dal body", async () => {
      const fake = createFakeSupabase({});
      authorizeAs(TENANT_A, fake);

      await callPost(basePayload());

      const [event] = eventsNamed("shuttle_schedule_created");
      expect(event.tenantId).toBe(TENANT_A);
      expect(event.userId).toBe("user-1");
    });

    it("3. insertedCount corrisponde alle righe realmente inserite", async () => {
      const fake = createFakeSupabase({});
      authorizeAs(TENANT_A, fake);

      await callPost(basePayload());

      const [event] = eventsNamed("shuttle_schedule_created");
      expect(event.details.insertedCount).toBe(fake.calls.insertedRows.length);
      expect(event.details.insertedCount).toBeGreaterThan(0);
    });

    it("4. previous è null", async () => {
      const fake = createFakeSupabase({});
      authorizeAs(TENANT_A, fake);

      await callPost(basePayload());

      const [event] = eventsNamed("shuttle_schedule_created");
      expect(event.details.previous).toBeNull();
    });

    it("5. next contiene esclusivamente i campi consentiti", async () => {
      const fake = createFakeSupabase({});
      authorizeAs(TENANT_A, fake);

      await callPost(basePayload());

      const [event] = eventsNamed("shuttle_schedule_created");
      const allowedKeys = [
        "hotelId",
        "bookingServiceKind",
        "customerName",
        "direction",
        "departureTime",
        "meetingPoint",
        "vessel",
        "validFrom",
        "validTo",
        "weekdays",
      ].sort();
      expect(Object.keys(event.details.next).sort()).toEqual(allowedKeys);
    });

    it("6. tenant_id malevolo nel body non modifica il tenant del log", async () => {
      const fake = createFakeSupabase({});
      authorizeAs(TENANT_A, fake);

      await callPost(basePayload({ tenant_id: TENANT_B } as Record<string, unknown>));

      const [event] = eventsNamed("shuttle_schedule_created");
      expect(event.tenantId).toBe(TENANT_A);
    });

    it("7. hotel cross-tenant non produce evento di successo", async () => {
      const fake = createFakeSupabase({ hotels: [{ id: HOTEL_B, tenant_id: TENANT_B }] });
      authorizeAs(TENANT_A, fake);

      const res = await callPost(basePayload({ hotel_id: HOTEL_B }));

      expect(res.status).toBe(400);
      expect(eventsNamed("shuttle_schedule_created")).toHaveLength(0);
    });

    it("8. errore insert non produce evento di successo", async () => {
      const fake = createFakeSupabase({});
      fake.setFlatInsertError("insert failed");
      authorizeAs(TENANT_A, fake);

      const res = await callPost(basePayload());

      expect(res.status).toBe(500);
      expect(eventsNamed("shuttle_schedule_created")).toHaveLength(0);
    });

    it("9. fallimento di un chunk intermedio non produce evento di successo", async () => {
      const fake = createFakeSupabase({});
      fake.setInsertErrorOnCall(2); // first chunk succeeds, second fails
      authorizeAs(TENANT_A, fake);

      // 700-day range forces 2 insert chunks (chunk size = 500).
      const res = await callPost(basePayload({ valid_from: TODAY, valid_to: isoDate(700) }));

      expect(res.status).toBe(500);
      expect(fake.calls.insertCalls.length).toBeGreaterThanOrEqual(2);
      expect(eventsNamed("shuttle_schedule_created")).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------
  // PATCH
  // ---------------------------------------------------------------------
  describe("PATCH", () => {
    it("10. PATCH valido produce esattamente un evento shuttle_schedule_updated", async () => {
      const fake = createFakeSupabase({ services: [], assignments: [] });
      authorizeAs(TENANT_A, fake);

      const res = await callPatch(SHARED_SCHEDULE_ID, basePayload());
      expect(res.status).toBe(200);

      expect(eventsNamed("shuttle_schedule_updated")).toHaveLength(1);
    });

    it("11/12. previous rappresenta la chiave precedente, next la nuova programmazione", async () => {
      const fake = createFakeSupabase({ services: [], assignments: [] });
      authorizeAs(TENANT_A, fake);

      await callPatch(SHARED_SCHEDULE_ID, basePayload({ departure_time: "10:00" }));

      const [event] = eventsNamed("shuttle_schedule_updated");
      expect(event.details.previous.departureTime).toBe(SHARED_KEY.departure_time);
      expect(event.details.next.departureTime).toBe("10:00");
      expect(event.details.previous.customerName).toBe(SHARED_KEY.customer_name);
    });

    it("13/14/15. deletedCount/insertedCount/deletedDateFrom/deletedDateTo corrispondono al range effettivo", async () => {
      const dateA = isoDate(2);
      const dateB = isoDate(4);
      const rowA = serviceRow(TENANT_A, { date: dateA });
      const rowB = serviceRow(TENANT_A, { date: dateB });
      const fake = createFakeSupabase({ services: [rowA, rowB], assignments: [] });
      authorizeAs(TENANT_A, fake);

      await callPatch(SHARED_SCHEDULE_ID, basePayload({ valid_from: TODAY, valid_to: TOMORROW }));

      const [event] = eventsNamed("shuttle_schedule_updated");
      expect(event.details.deletedCount).toBe(2);
      expect(event.details.deletedDateFrom).toBe(dateA);
      expect(event.details.deletedDateTo).toBe(dateB);
      expect(event.details.insertedCount).toBe(fake.calls.insertedRows.length);
    });

    it("16. cambio orario è visibile nel diff previous/next", async () => {
      const fake = createFakeSupabase({ services: [], assignments: [] });
      authorizeAs(TENANT_A, fake);

      await callPatch(SHARED_SCHEDULE_ID, basePayload({ departure_time: "11:15" }));

      const [event] = eventsNamed("shuttle_schedule_updated");
      expect(event.details.previous.departureTime).not.toBe(event.details.next.departureTime);
      expect(event.details.next.departureTime).toBe("11:15");
    });

    it("17. riduzione periodo è visibile nel diff (validTo diverso)", async () => {
      const rowA = serviceRow(TENANT_A, { date: "2026-08-05" });
      const rowB = serviceRow(TENANT_A, { date: "2026-08-25" });
      const fake = createFakeSupabase({ services: [rowA, rowB], assignments: [] });
      authorizeAs(TENANT_A, fake);

      await callPatch(SHARED_SCHEDULE_ID, basePayload({ valid_from: TODAY, valid_to: "2026-08-10" }));

      const [event] = eventsNamed("shuttle_schedule_updated");
      expect(event.details.previous.validTo).toBe("2026-08-25");
      expect(event.details.next.validTo).toBe("2026-08-10");
    });

    it("18. modifica giorni è visibile nel diff quando i giorni precedenti sono ricostruibili dalle righe esistenti", async () => {
      // Two existing rows on different weekdays let us reconstruct "previous"
      // weekdays reliably from the actual future rows about to be deleted.
      // Date dinamiche: mondayDate è il prossimo lunedì futuro, tuesdayDate è
      // il giorno immediatamente successivo (sempre martedì per costruzione).
      const mondayDate = nextWeekdayIsoDate(1, 2);
      const tuesdayDate = addDaysIso(mondayDate, 1);
      const rowMonday = serviceRow(TENANT_A, { date: mondayDate }); // Monday
      const rowTuesday = serviceRow(TENANT_A, { date: tuesdayDate }); // Tuesday
      const fake = createFakeSupabase({ services: [rowMonday, rowTuesday], assignments: [] });
      authorizeAs(TENANT_A, fake);

      await callPatch(SHARED_SCHEDULE_ID, basePayload({ valid_from: TODAY, valid_to: TOMORROW, days_of_week: [1] }));

      const [event] = eventsNamed("shuttle_schedule_updated");
      expect(event.details.previous.weekdays.sort()).toEqual([1, 2]);
      expect(event.details.next.weekdays).toEqual([1]);
    });

    it("19. PATCH semanticamente identico produce comunque un evento di aggiornamento riuscito (nessuna logica no-op)", async () => {
      const fake = createFakeSupabase({ services: [], assignments: [] });
      authorizeAs(TENANT_A, fake);

      await callPatch(SHARED_SCHEDULE_ID, basePayload());

      expect(eventsNamed("shuttle_schedule_updated")).toHaveLength(1);
    });

    it("20. F-01 con HTTP 409 non produce evento di successo", async () => {
      const fake = createFakeSupabase({
        services: [serviceRow(TENANT_A, { status: "confirmed" })],
        assignments: [],
      });
      authorizeAs(TENANT_A, fake);

      const res = await callPatch(SHARED_SCHEDULE_ID, basePayload());

      expect(res.status).toBe(409);
      expect(eventsNamed("shuttle_schedule_updated")).toHaveLength(0);
    });

    it("21. F-10 con HTTP 400 non produce evento di successo", async () => {
      const fake = createFakeSupabase({ hotels: [{ id: HOTEL_B, tenant_id: TENANT_B }], services: [], assignments: [] });
      authorizeAs(TENANT_A, fake);

      const res = await callPatch(SHARED_SCHEDULE_ID, basePayload({ hotel_id: HOTEL_B }));

      expect(res.status).toBe(400);
      expect(eventsNamed("shuttle_schedule_updated")).toHaveLength(0);
    });

    it("22. id malformato con HTTP 400 non produce evento di successo", async () => {
      const fake = createFakeSupabase({});
      authorizeAs(TENANT_A, fake);

      const res = await callPatch("%%%invalid%%%", basePayload());

      expect(res.status).toBe(400);
      expect(eventsNamed("shuttle_schedule_updated")).toHaveLength(0);
    });

    it("23. errore DELETE non produce evento di successo", async () => {
      const fake = createFakeSupabase({ services: [], assignments: [] });
      fake.setFlatDeleteError("delete failed");
      authorizeAs(TENANT_A, fake);

      const res = await callPatch(SHARED_SCHEDULE_ID, basePayload());

      expect(res.status).toBe(500);
      expect(eventsNamed("shuttle_schedule_updated")).toHaveLength(0);
    });

    it("24. DELETE riuscita seguita da INSERT fallito: nessun evento di successo, evento di errore con deletePhaseCompleted:true e deletedCount", async () => {
      const rowA = serviceRow(TENANT_A, { date: isoDate(2) });
      const fake = createFakeSupabase({ services: [rowA], assignments: [] });
      fake.setFlatInsertError("insert failed after delete");
      authorizeAs(TENANT_A, fake);

      const res = await callPatch(SHARED_SCHEDULE_ID, basePayload({ valid_from: TODAY, valid_to: TOMORROW }));
      expect(res.status).toBe(500);

      expect(eventsNamed("shuttle_schedule_updated")).toHaveLength(0);
      const [errorEvent] = eventsNamed("shuttle_schedules_update_failed");
      expect(errorEvent.details.deletePhaseCompleted).toBe(true);
      expect(errorEvent.details.deletedCount).toBe(1);
      // The row was already deleted from the shared store — real partial state.
      expect(fake.services.some((row) => row.id === rowA.id)).toBe(false);
    });

    it("25. errore prima della DELETE: evento di errore con deletePhaseCompleted:false", async () => {
      const fake = createFakeSupabase({ services: [], assignments: [] });
      // Force the guard's own select to error before any delete happens.
      const brokenAdmin = {
        from(table: string) {
          if (table === "services") {
            return {
              select() {
                return {
                  eq() {
                    return this;
                  },
                  gte() {
                    return this;
                  },
                  is() {
                    return this;
                  },
                  then(resolve: (v: { data: null; error: { message: string } }) => unknown) {
                    return Promise.resolve({ data: null, error: { message: "guard query failed" } }).then(resolve);
                  },
                };
              },
              delete() {
                throw new Error("delete must not be called before the guard succeeds");
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

      const res = await callPatch(SHARED_SCHEDULE_ID, basePayload());
      expect(res.status).toBe(500);

      const [errorEvent] = eventsNamed("shuttle_schedules_update_failed");
      expect(errorEvent.details.deletePhaseCompleted).toBe(false);
    });
  });

  // ---------------------------------------------------------------------
  // DELETE
  // ---------------------------------------------------------------------
  describe("DELETE", () => {
    it("26. DELETE valida produce esattamente un evento shuttle_schedule_deleted", async () => {
      const fake = createFakeSupabase({ services: [serviceRow(TENANT_A)], assignments: [] });
      authorizeAs(TENANT_A, fake);

      const res = await callDelete(SHARED_SCHEDULE_ID);
      expect(res.status).toBe(200);

      expect(eventsNamed("shuttle_schedule_deleted")).toHaveLength(1);
    });

    it("27/28/29. previous valorizzato, next null, insertedCount 0", async () => {
      const fake = createFakeSupabase({ services: [serviceRow(TENANT_A)], assignments: [] });
      authorizeAs(TENANT_A, fake);

      await callDelete(SHARED_SCHEDULE_ID);

      const [event] = eventsNamed("shuttle_schedule_deleted");
      expect(event.details.previous).not.toBeNull();
      expect(event.details.previous.customerName).toBe(SHARED_KEY.customer_name);
      expect(event.details.next).toBeNull();
      expect(event.details.insertedCount).toBe(0);
    });

    it("30. deletedCount e range corretti", async () => {
      const rowA = serviceRow(TENANT_A, { date: "2026-09-01" });
      const rowB = serviceRow(TENANT_A, { date: "2026-09-05" });
      const fake = createFakeSupabase({ services: [rowA, rowB], assignments: [] });
      authorizeAs(TENANT_A, fake);

      await callDelete(SHARED_SCHEDULE_ID);

      const [event] = eventsNamed("shuttle_schedule_deleted");
      expect(event.details.deletedCount).toBe(2);
      expect(event.details.deletedDateFrom).toBe("2026-09-01");
      expect(event.details.deletedDateTo).toBe("2026-09-05");
    });

    it("31. F-01 blocca senza evento di successo", async () => {
      const fake = createFakeSupabase({
        services: [serviceRow(TENANT_A, { status: "confirmed" })],
        assignments: [],
      });
      authorizeAs(TENANT_A, fake);

      const res = await callDelete(SHARED_SCHEDULE_ID);

      expect(res.status).toBe(409);
      expect(eventsNamed("shuttle_schedule_deleted")).toHaveLength(0);
    });

    it("32. id malformato mantiene il comportamento attuale (500) e non produce evento di successo", async () => {
      const fake = createFakeSupabase({});
      authorizeAs(TENANT_A, fake);

      const res = await callDelete("%%%invalid%%%");

      expect(res.status).toBe(500);
      expect(eventsNamed("shuttle_schedule_deleted")).toHaveLength(0);
    });

    it("33. errore database non produce evento di successo", async () => {
      const fake = createFakeSupabase({ services: [serviceRow(TENANT_A)], assignments: [] });
      fake.setFlatDeleteError("delete failed");
      authorizeAs(TENANT_A, fake);

      const res = await callDelete(SHARED_SCHEDULE_ID);

      expect(res.status).toBe(500);
      expect(eventsNamed("shuttle_schedule_deleted")).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------
  // Tenant isolation
  // ---------------------------------------------------------------------
  describe("Tenant isolation", () => {
    it("34. tutti gli eventi usano il tenantId della sessione", async () => {
      const fake = createFakeSupabase({ services: [], assignments: [] });
      authorizeAs(TENANT_A, fake);

      await callPost(basePayload());
      await callPatch(SHARED_SCHEDULE_ID, basePayload());
      await callDelete(SHARED_SCHEDULE_ID);

      for (const event of allEvents()) {
        expect(event.tenantId).toBe(TENANT_A);
      }
    });

    it("35. chiavi identiche tra tenant: deletedCount conteggia solo le righe del tenant autenticato", async () => {
      const rowA = serviceRow(TENANT_A, { date: TOMORROW });
      const rowB1 = serviceRow(TENANT_B, { date: TOMORROW });
      const rowB2 = serviceRow(TENANT_B, { date: isoDate(2) });
      const fake = createFakeSupabase({ services: [rowA, rowB1, rowB2], assignments: [] });
      authorizeAs(TENANT_A, fake);

      await callDelete(SHARED_SCHEDULE_ID);

      const [event] = eventsNamed("shuttle_schedule_deleted");
      expect(event.details.deletedCount).toBe(1);
      // Tenant B's rows must survive, untouched by tenant A's operation.
      expect(fake.services.filter((row) => row.tenant_id === TENANT_B)).toHaveLength(2);
    });

    it("36. nessun dettaglio del tenant B appare in previous/next/conteggi/range", async () => {
      const rowA = serviceRow(TENANT_A, { date: "2026-08-01" });
      const rowB = serviceRow(TENANT_B, { date: "1999-01-01", customer_name: "Solo Tenant B" });
      const fake = createFakeSupabase({ services: [rowA, rowB], assignments: [] });
      authorizeAs(TENANT_A, fake);

      await callDelete(SHARED_SCHEDULE_ID);

      const [event] = eventsNamed("shuttle_schedule_deleted");
      const text = JSON.stringify(event);
      expect(text).not.toContain("1999-01-01");
      expect(text).not.toContain("Solo Tenant B");
      expect(text).not.toContain(TENANT_B);
    });
  });

  // ---------------------------------------------------------------------
  // Privacy
  // ---------------------------------------------------------------------
  describe("Privacy", () => {
    it("37. i details non contengono campi vietati (phone, whatsapp, token, notes, requestBody, stack, serviceIds)", async () => {
      const fake = createFakeSupabase({ services: [serviceRow(TENANT_A)], assignments: [] });
      authorizeAs(TENANT_A, fake);

      await callPost(basePayload({ notes: "nota interna riservata" }));
      await callPatch(SHARED_SCHEDULE_ID, basePayload({ notes: "altra nota" }));
      await callDelete(SHARED_SCHEDULE_ID);

      for (const event of allEvents()) {
        assertNoForbiddenData(event);
        expect(event.details).not.toHaveProperty("serviceIds");
        expect(JSON.stringify(event.details)).not.toContain("nota interna riservata");
      }
    });

    it("38. l'id derivato completo (stringa base64url) non è registrato nei nuovi eventi di successo", async () => {
      const fake = createFakeSupabase({ services: [], assignments: [] });
      authorizeAs(TENANT_A, fake);

      await callPatch(SHARED_SCHEDULE_ID, basePayload());
      await callDelete(SHARED_SCHEDULE_ID);

      const successEvents = [...eventsNamed("shuttle_schedule_updated"), ...eventsNamed("shuttle_schedule_deleted")];
      for (const event of successEvents) {
        expect(JSON.stringify(event)).not.toContain(SHARED_SCHEDULE_ID);
      }
    });
  });
});
