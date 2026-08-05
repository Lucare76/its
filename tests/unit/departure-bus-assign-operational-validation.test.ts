import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SERVICE_X1 = "a1111111-1111-4111-8111-111111111111";
const SERVICE_X2 = "a2222222-2222-4222-8222-222222222222";
const SERVICE_B1 = "b1111111-1111-4111-8111-111111111111";
const DRIVER_A = "d1111111-1111-4111-8111-111111111111";
const DATE_1 = "2026-08-10";
const DATE_2 = "2026-08-11";

type Row = Record<string, unknown>;

/**
 * Fake Supabase in-memory, tenant-aware, per departure-bus-assign (FUNC-01).
 * A differenza del fake SEC-01 (tenant isolation), qui i dati operativi
 * (date, orari, zone hotel, altri giri del driver) sono seedabili per
 * esercitare davvero i guard di disponibilità e geografia, non solo bypassarli.
 */
function createOperationalSupabase(
  seed: {
    services?: Row[];
    assignments?: Row[];
    dailyAvailabilityConfirmations?: Row[];
    hotels?: Row[];
    memberships?: Row[];
  } = {}
) {
  const services: Row[] = [...(seed.services ?? [])];
  const assignments: Row[] = [...(seed.assignments ?? [])];
  const dailyAvailabilityConfirmations: Row[] = [...(seed.dailyAvailabilityConfirmations ?? [])];
  const hotels: Row[] = [...(seed.hotels ?? [])];
  // SEC-05 residuo: DRIVER_A è il driver di default in tutti gli scenari di
  // questo file (concentrato su FUNC-01, non su ownership del driver). Se il
  // seed esplicita "memberships" (es. per il nome nei messaggi geo), quella
  // lista sostituisce comunque il default: chi la fornisce se ne assume
  // l'onere di includere role:"driver" per DRIVER_A dove serve.
  const memberships: Row[] = seed.memberships ?? [{ tenant_id: TENANT_A, user_id: DRIVER_A, role: "driver" }];

  const calls = {
    assignmentsDelete: 0,
    assignmentsInsert: 0,
    insertedRows: [] as Row[],
    dailyAvailabilityQueried: 0,
    geoAssignmentsQueried: 0,
  };

  // Errore applicato solo dalla 2a select su "services" in poi: la 1a è
  // sempre l'ownership check SEC-01 (già coperto in
  // departure-bus-assign-tenant-isolation.test.ts), la 2a è il nuovo
  // caricamento dati operativi del batch (FUNC-01) che questo file testa.
  let servicesError: { message: string } | null = null;
  let servicesSelectCallCount = 0;
  let availabilityError: { message: string } | null = null;
  let geoAssignmentsError: { message: string } | null = null;

  function makeServicesSelectBuilder() {
    let filtered = services;
    const builder = {
      eq(field: string, value: unknown) {
        filtered = filtered.filter((row) => row[field] === value);
        return builder;
      },
      in(field: string, values: unknown[]) {
        filtered = filtered.filter((row) => values.includes(row[field]));
        return builder;
      },
      then(resolve: (v: { data: Row[] | null; error: { message: string } | null }) => unknown, reject?: (e: unknown) => unknown) {
        servicesSelectCallCount++;
        if (servicesError && servicesSelectCallCount >= 2) {
          return Promise.resolve({ data: null, error: servicesError }).then(resolve, reject);
        }
        return Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
      },
    };
    return builder;
  }

  function makeDailyAvailabilityBuilder() {
    let filtered = dailyAvailabilityConfirmations;
    const builder = {
      eq(field: string, value: unknown) {
        filtered = filtered.filter((row) => row[field] === value);
        return builder;
      },
      in(field: string, values: unknown[]) {
        filtered = filtered.filter((row) => values.includes(row[field]));
        return builder;
      },
      then(resolve: (v: { data: Row[] | null; error: { message: string } | null }) => unknown, reject?: (e: unknown) => unknown) {
        calls.dailyAvailabilityQueried++;
        if (availabilityError) {
          return Promise.resolve({ data: null, error: availabilityError }).then(resolve, reject);
        }
        return Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
      },
    };
    return builder;
  }

  function makeAssignmentsSelectBuilder() {
    let filtered = assignments;
    const builder = {
      eq(field: string, value: unknown) {
        filtered = filtered.filter((row) => row[field] === value);
        return builder;
      },
      not(field: string, _op: string, value: unknown) {
        filtered = filtered.filter((row) => (row[field] ?? null) !== value);
        return builder;
      },
      then(resolve: (v: { data: Row[] | null; error: { message: string } | null }) => unknown, reject?: (e: unknown) => unknown) {
        calls.geoAssignmentsQueried++;
        if (geoAssignmentsError) {
          return Promise.resolve({ data: null, error: geoAssignmentsError }).then(resolve, reject);
        }
        // Emula il join services!inner(...): allega la riga services corrispondente.
        const withJoin = filtered.map((row) => ({
          ...row,
          services: services.find((s) => s.id === row.service_id) ?? null,
        }));
        return Promise.resolve({ data: withJoin, error: null }).then(resolve, reject);
      },
    };
    return builder;
  }

  function makeAssignmentsDeleteBuilder() {
    let filtered = assignments;
    const builder = {
      eq(field: string, value: unknown) {
        filtered = filtered.filter((row) => row[field] === value);
        return builder;
      },
      in(field: string, values: unknown[]) {
        filtered = filtered.filter((row) => values.includes(row[field]));
        return builder;
      },
      then(resolve: (v: { data: null; error: null }) => unknown, reject?: (e: unknown) => unknown) {
        calls.assignmentsDelete++;
        const toRemove = new Set(filtered);
        for (let i = assignments.length - 1; i >= 0; i--) {
          if (toRemove.has(assignments[i])) assignments.splice(i, 1);
        }
        return Promise.resolve({ data: null, error: null }).then(resolve, reject);
      },
    };
    return builder;
  }

  function makeHotelsSelectBuilder() {
    let filtered = hotels;
    const builder = {
      eq(field: string, value: unknown) {
        filtered = filtered.filter((row) => row[field] === value);
        return builder;
      },
      in(field: string, values: unknown[]) {
        filtered = filtered.filter((row) => values.includes(row[field]));
        return builder;
      },
      then(resolve: (v: { data: Row[]; error: null }) => unknown, reject?: (e: unknown) => unknown) {
        return Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
      },
    };
    return builder;
  }

  function makeMembershipsSelectBuilder() {
    let filtered = memberships;
    const builder = {
      eq(field: string, value: unknown) {
        filtered = filtered.filter((row) => row[field] === value);
        return builder;
      },
      maybeSingle() {
        return Promise.resolve({ data: filtered[0] ?? null, error: null });
      },
    };
    return builder;
  }

  const admin = {
    from(table: string) {
      if (table === "services") {
        return { select: () => makeServicesSelectBuilder() };
      }
      if (table === "daily_availability_confirmations") {
        return { select: () => makeDailyAvailabilityBuilder() };
      }
      if (table === "assignments") {
        return {
          select: () => makeAssignmentsSelectBuilder(),
          delete: () => makeAssignmentsDeleteBuilder(),
          insert(rows: Row[]) {
            calls.assignmentsInsert++;
            calls.insertedRows.push(...rows);
            assignments.push(...rows);
            return Promise.resolve({ error: null });
          },
          // RACE-01: la route ora usa upsert al posto di delete+insert.
          upsert(rows: Row[], _options?: { onConflict?: string; ignoreDuplicates?: boolean }) {
            calls.assignmentsInsert++;
            calls.insertedRows.push(...rows);
            for (const row of rows) {
              const idx = assignments.findIndex((a) => a.service_id === row.service_id && a.tenant_id === row.tenant_id);
              if (idx >= 0) assignments[idx] = { ...assignments[idx], ...row };
              else assignments.push(row);
            }
            return Promise.resolve({ error: null });
          },
        };
      }
      if (table === "hotels") {
        return { select: () => makeHotelsSelectBuilder() };
      }
      if (table === "memberships") {
        return { select: () => makeMembershipsSelectBuilder() };
      }
      throw new Error(`Unexpected table in test fake: ${table}`);
    },
  };

  return {
    admin,
    services,
    assignments,
    calls,
    setServicesError(err: { message: string } | null) {
      servicesError = err;
    },
    setAvailabilityError(err: { message: string } | null) {
      availabilityError = err;
    },
    setGeoAssignmentsError(err: { message: string } | null) {
      geoAssignmentsError = err;
    },
  };
}

const mocks = vi.hoisted(() => ({
  authorizePricingRequest: vi.fn(),
  auditLog: vi.fn(),
  sendPushToUser: vi.fn(),
}));

vi.mock("@/lib/server/pricing-auth", () => ({
  authorizePricingRequest: mocks.authorizePricingRequest,
}));
vi.mock("@/lib/server/ops-audit", () => ({
  auditLog: mocks.auditLog,
}));
vi.mock("@/lib/server/web-push", () => ({
  sendPushToUser: mocks.sendPushToUser,
}));

import { POST } from "@/app/api/ops/departure-bus-assign/route";

function serviceRow(id: string, overrides: Row = {}): Row {
  return {
    id,
    tenant_id: TENANT_A,
    date: DATE_1,
    time: "10:00:00",
    pickup_hotel: null,
    direction: "departure",
    hotel_id: null,
    meeting_point: null,
    ...overrides,
  };
}

function confirmedDate(date: string, tenantId: string = TENANT_A): Row {
  return { tenant_id: tenantId, date, confirmed: true };
}

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost:3010/api/ops/departure-bus-assign", {
    method: "POST",
    headers: { "Content-Type": "application/json", authorization: "Bearer test-token" },
    body: JSON.stringify(body),
  });
}
function callPost(body: Record<string, unknown>) {
  return POST(makeRequest(body));
}

function authorizeAs(fake: ReturnType<typeof createOperationalSupabase>, role: string = "operator") {
  mocks.authorizePricingRequest.mockResolvedValue({
    admin: fake.admin,
    user: { id: "user-1", email: "op@test.dev" },
    membership: { tenant_id: TENANT_A, role, suspended: false },
  });
}

function assignBody(overrides: Record<string, unknown> = {}) {
  return {
    action: "assign_driver",
    service_ids: [SERVICE_X1, SERVICE_X2],
    driver_user_id: DRIVER_A,
    vehicle_label: "DEP_BUS:1",
    ...overrides,
  };
}

describe("Validazione operativa — departure-bus-assign API (FUNC-01)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("1. assegnazione valida: disponibilità confermata e geografia compatibile -> 200, scrittura eseguita", async () => {
    const fake = createOperationalSupabase({
      services: [serviceRow(SERVICE_X1), serviceRow(SERVICE_X2)],
      dailyAvailabilityConfirmations: [confirmedDate(DATE_1)],
    });
    authorizeAs(fake);

    const res = await callPost(assignBody());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    // RACE-01: assign_driver ora scrive con upsert, mai più con delete+insert.
    expect(fake.calls.assignmentsDelete).toBe(0);
    expect(fake.calls.assignmentsInsert).toBe(1);
    expect(fake.calls.insertedRows).toHaveLength(2);
  });

  it("2. disponibilità non confermata -> 409 DAILY_AVAILABILITY_NOT_CONFIRMED, zero DELETE/INSERT", async () => {
    const fake = createOperationalSupabase({
      services: [serviceRow(SERVICE_X1), serviceRow(SERVICE_X2)],
      dailyAvailabilityConfirmations: [],
    });
    authorizeAs(fake);

    const res = await callPost(assignBody());
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toEqual({
      ok: false,
      error: "DAILY_AVAILABILITY_NOT_CONFIRMED",
      message: "La disponibilità giornaliera non è stata ancora confermata.",
    });
    expect(fake.calls.assignmentsDelete).toBe(0);
    expect(fake.calls.assignmentsInsert).toBe(0);
  });

  it("3. una delle date del batch non confermata -> intera operazione bloccata", async () => {
    const fake = createOperationalSupabase({
      services: [serviceRow(SERVICE_X1, { date: DATE_1 }), serviceRow(SERVICE_X2, { date: DATE_2 })],
      // Solo DATE_1 confermata: DATE_2 manca.
      dailyAvailabilityConfirmations: [confirmedDate(DATE_1)],
    });
    authorizeAs(fake);

    const res = await callPost(assignBody());
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("DAILY_AVAILABILITY_NOT_CONFIRMED");
    expect(fake.calls.assignmentsDelete).toBe(0);
    expect(fake.calls.assignmentsInsert).toBe(0);
  });

  it("4. errore nella query di disponibilità -> 500 fail-closed, zero scritture, nessun dettaglio DB esposto", async () => {
    const fake = createOperationalSupabase({
      services: [serviceRow(SERVICE_X1), serviceRow(SERVICE_X2)],
    });
    fake.setAvailabilityError({ message: "connection refused: internal db detail xyz" });
    authorizeAs(fake);

    const res = await callPost(assignBody());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(body.error).not.toMatch(/connection refused/i);
    expect(body.error).not.toMatch(/internal db detail/i);
    expect(fake.calls.assignmentsDelete).toBe(0);
    expect(fake.calls.assignmentsInsert).toBe(0);
    expect(mocks.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: "departure_bus_assign_availability_check_failed", level: "error" })
    );
  });

  it("5. conflitto geografico reale -> 409 DRIVER_GEOGRAPHIC_CONFLICT, zero scritture", async () => {
    // Il driver ha già un giro (grp-1) a Forio (nord-ovest) alle 09:00; il
    // nuovo batch parte alle 09:05 con partenza da un hotel a Ischia Porto
    // (est-sud): margine insufficiente per il trasferimento cross-area.
    const fake = createOperationalSupabase({
      services: [
        serviceRow(SERVICE_X1, { time: "09:05:00", hotel_id: "hotel-1" }),
        { id: "existing-svc", tenant_id: TENANT_A, date: DATE_1, time: "09:00:00", pickup_hotel: null, direction: "departure", hotel_id: null, meeting_point: "Forio" },
      ],
      assignments: [
        {
          id: "asg-existing",
          tenant_id: TENANT_A,
          service_id: "existing-svc",
          driver_user_id: DRIVER_A,
          group_id: "grp-1",
          vehicle_label: "DEP_BUS:old",
        },
      ],
      dailyAvailabilityConfirmations: [confirmedDate(DATE_1)],
      hotels: [{ id: "hotel-1", zone: "Ischia Porto" }],
      memberships: [{ tenant_id: TENANT_A, user_id: DRIVER_A, role: "driver", full_name: "Mario Rossi" }],
    });
    authorizeAs(fake);

    const res = await callPost(assignBody({ service_ids: [SERVICE_X1] }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toEqual({
      ok: false,
      error: "DRIVER_GEOGRAPHIC_CONFLICT",
      message: "L'autista ha un altro servizio incompatibile con questo gruppo bus.",
    });
    expect(fake.calls.assignmentsDelete).toBe(0);
    expect(fake.calls.assignmentsInsert).toBe(0);
    // Risposta generica: nessun dettaglio di zona/minuti/nome autista esposto.
    const raw = JSON.stringify(body);
    expect(raw).not.toMatch(/Mario Rossi/);
    expect(raw).not.toMatch(/Forio/);
    expect(raw).not.toMatch(/minuti/i);
  });

  it("6. nessun conflitto geografico: comportamento invariato (200)", async () => {
    const fake = createOperationalSupabase({
      services: [
        serviceRow(SERVICE_X1, { time: "12:00:00", hotel_id: "hotel-1" }),
        { id: "existing-svc", tenant_id: TENANT_A, date: DATE_1, time: "09:00:00", pickup_hotel: null, direction: "departure", hotel_id: null, meeting_point: "Ischia Porto" },
      ],
      assignments: [
        {
          id: "asg-existing",
          tenant_id: TENANT_A,
          service_id: "existing-svc",
          driver_user_id: DRIVER_A,
          group_id: "grp-1",
          vehicle_label: "DEP_BUS:old",
        },
      ],
      dailyAvailabilityConfirmations: [confirmedDate(DATE_1)],
      hotels: [{ id: "hotel-1", zone: "Ischia Porto" }],
      memberships: [{ tenant_id: TENANT_A, user_id: DRIVER_A, role: "driver", full_name: "Mario Rossi" }],
    });
    authorizeAs(fake);

    const res = await callPost(assignBody({ service_ids: [SERVICE_X1] }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(fake.calls.assignmentsInsert).toBe(1);
  });

  it("7. batch trattato come unica finestra geografica, non servizio per servizio (nessun falso conflitto interno)", async () => {
    // Due tappe dello stesso bus, orari diversi e zone diverse: se validate
    // singolarmente l'una contro l'altra genererebbero un falso conflitto.
    // Trattate come un'unica finestra di giro, non devono bloccare nulla.
    const fake = createOperationalSupabase({
      services: [
        serviceRow(SERVICE_X1, { time: "09:00:00", hotel_id: "hotel-nord" }),
        serviceRow(SERVICE_X2, { time: "09:02:00", hotel_id: "hotel-sud" }),
      ],
      dailyAvailabilityConfirmations: [confirmedDate(DATE_1)],
      hotels: [
        { id: "hotel-nord", zone: "Forio" },
        { id: "hotel-sud", zone: "Ischia Porto" },
      ],
    });
    authorizeAs(fake);

    const res = await callPost(assignBody());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(fake.calls.assignmentsInsert).toBe(1);
  });

  it("8. i servizi del batch corrente sono esclusi dal confronto con sé stessi (riassegnazione stesso driver)", async () => {
    // Il batch corrente è già assegnato allo stesso driver con lo stesso
    // group_id/service_id: la validazione non deve trattarli come "altro giro".
    const fake = createOperationalSupabase({
      services: [serviceRow(SERVICE_X1)],
      assignments: [
        { id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_X1, driver_user_id: DRIVER_A, group_id: "grp-self", vehicle_label: "DEP_BUS:1" },
      ],
      dailyAvailabilityConfirmations: [confirmedDate(DATE_1)],
    });
    authorizeAs(fake);

    const res = await callPost(assignBody({ service_ids: [SERVICE_X1] }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
  });

  it("9. warning geografico (zona sconosciuta): non blocca, comportamento coerente con assign-service", async () => {
    // Zona di uno dei due lati sconosciuta -> severity "warning", non "block":
    // assign-service lascia passare, quindi anche departure-bus-assign deve procedere.
    const fake = createOperationalSupabase({
      services: [
        // Gap di 35 minuti: >= ai 15 minuti richiesti per zona sconosciuta
        // (altrimenti sarebbe "block", non "warning" — vedi requiredTransferMinutes)
        // e >= alla finestra fissa di 30 minuti usata da CONC-02 residuo (guard
        // successivo, indipendente): un gap di soli 20 minuti genererebbe ora
        // un overlap driver reale e legittimo (409 DRIVER_OVERLAP), non testato
        // qui — questo test resta mirato solo al comportamento del warning geo.
        serviceRow(SERVICE_X1, { time: "09:35:00", hotel_id: null, meeting_point: null }),
        { id: "existing-svc", tenant_id: TENANT_A, date: DATE_1, time: "09:00:00", pickup_hotel: null, direction: "departure", hotel_id: null, meeting_point: null },
      ],
      assignments: [
        { id: "asg-existing", tenant_id: TENANT_A, service_id: "existing-svc", driver_user_id: DRIVER_A, group_id: "grp-1", vehicle_label: "DEP_BUS:old" },
      ],
      dailyAvailabilityConfirmations: [confirmedDate(DATE_1)],
    });
    authorizeAs(fake);

    const res = await callPost(assignBody({ service_ids: [SERVICE_X1] }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
  });

  it("10. SEC-01 cross-tenant ancora bloccato prima dei nuovi guard: 404, zero query availability/geo", async () => {
    const fake = createOperationalSupabase({
      services: [{ id: SERVICE_B1, tenant_id: TENANT_B, date: DATE_1, time: "10:00:00", pickup_hotel: null, direction: "departure", hotel_id: null, meeting_point: null }],
    });
    authorizeAs(fake);

    const res = await callPost(assignBody({ service_ids: [SERVICE_B1] }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "Uno o più servizi non trovati." });
    expect(fake.calls.dailyAvailabilityQueried).toBe(0);
    expect(fake.calls.geoAssignmentsQueried).toBe(0);
    expect(fake.calls.assignmentsInsert).toBe(0);
  });

  it("11. action remove_driver invariata: nessun guard di disponibilità/geografia applicato", async () => {
    const fake = createOperationalSupabase({
      services: [serviceRow(SERVICE_X1)],
      assignments: [{ id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_X1, driver_user_id: DRIVER_A, vehicle_label: "DEP_BUS:1" }],
      dailyAvailabilityConfirmations: [],
    });
    authorizeAs(fake);

    const res = await callPost({ action: "remove_driver", service_ids: [SERVICE_X1] });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(fake.calls.dailyAvailabilityQueried).toBe(0);
    expect(fake.calls.geoAssignmentsQueried).toBe(0);
    expect(fake.assignments).toHaveLength(0);
  });

  it("12. action create_driver_account invariata: nessun guard FUNC-01 coinvolto", async () => {
    mocks.authorizePricingRequest.mockResolvedValue({
      admin: {
        from(table: string) {
          throw new Error(`create_driver_account non deve toccare la tabella ${table}`);
        },
      },
      user: { id: "user-1", email: "op@test.dev" },
      membership: { tenant_id: TENANT_A, role: "operator", suspended: false },
    });

    const res = await callPost({ action: "create_driver_account", driver_profile_id: "", email: "" });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toEqual({ ok: false, error: "driver_profile_id e email richiesti" });
  });

  it("13. upsertErr esistente sulla scrittura finale invariato (500, messaggio del throw esistente)", async () => {
    const fake = createOperationalSupabase({
      services: [serviceRow(SERVICE_X1)],
      dailyAvailabilityConfirmations: [confirmedDate(DATE_1)],
    });
    // Forza l'errore sull'upsert finale (RACE-01: era insert, ora upsert; comportamento del throw preesistente invariato).
    const originalFrom = fake.admin.from.bind(fake.admin);
    (fake.admin as { from: (table: string) => unknown }).from = (table: string) => {
      const base = originalFrom(table) as Record<string, unknown>;
      if (table === "assignments") {
        return {
          ...base,
          upsert() {
            return Promise.resolve({ error: { message: "duplicate key value violates unique constraint" } });
          },
        };
      }
      return base;
    };
    authorizeAs(fake);

    const res = await callPost(assignBody({ service_ids: [SERVICE_X1] }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/duplicate key/);
  });

  it("14a. utente non autenticato: 401, zero query operative", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Sessione non valida." }, { status: 401 }));
    const fake = createOperationalSupabase({ services: [serviceRow(SERVICE_X1)] });

    const res = await callPost(assignBody({ service_ids: [SERVICE_X1] }));

    expect(res.status).toBe(401);
    expect(fake.calls.dailyAvailabilityQueried).toBe(0);
    expect(fake.calls.assignmentsInsert).toBe(0);
  });

  it("14b. ruolo non autorizzato: 403, zero query operative", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Ruolo non autorizzato." }, { status: 403 }));
    const fake = createOperationalSupabase({ services: [serviceRow(SERVICE_X1)] });

    const res = await callPost(assignBody({ service_ids: [SERVICE_X1] }));

    expect(res.status).toBe(403);
    expect(fake.calls.dailyAvailabilityQueried).toBe(0);
    expect(fake.calls.assignmentsInsert).toBe(0);
  });

  it("15. nessun dato DB grezzo (codice/constraint/stack) nella risposta 500 di disponibilità", async () => {
    const fake = createOperationalSupabase({ services: [serviceRow(SERVICE_X1)] });
    fake.setAvailabilityError({ message: 'duplicate key value violates unique constraint "daily_avail_x"' });
    authorizeAs(fake);

    const res = await callPost(assignBody({ service_ids: [SERVICE_X1] }));
    const raw = JSON.stringify(await res.json());

    expect(raw.toLowerCase()).not.toMatch(/unique constraint/);
    expect(raw.toLowerCase()).not.toMatch(/\bstack\b/);
    expect(raw).not.toMatch(/daily_avail_x/);
  });

  it("16. sensibile alla rimozione del guard di disponibilità: senza il guard il batch verrebbe assegnato lo stesso", async () => {
    // Verifica che il guard sia realmente ciò che produce il 409: se il seed
    // NON contiene alcuna conferma, la route deve fermarsi qui (409) e non
    // arrivare mai a interrogare la geo-validazione o a scrivere.
    const fake = createOperationalSupabase({
      services: [serviceRow(SERVICE_X1)],
      dailyAvailabilityConfirmations: [],
    });
    authorizeAs(fake);

    const res = await callPost(assignBody({ service_ids: [SERVICE_X1] }));

    expect(res.status).toBe(409);
    expect(fake.calls.geoAssignmentsQueried).toBe(0);
    expect(fake.calls.assignmentsInsert).toBe(0);
  });

  it("17. sensibile alla rimozione del guard geografico: un conflitto reale deve produrre 409 e zero scritture", async () => {
    const fake = createOperationalSupabase({
      services: [
        serviceRow(SERVICE_X1, { time: "09:05:00", hotel_id: "hotel-1" }),
        { id: "existing-svc", tenant_id: TENANT_A, date: DATE_1, time: "09:00:00", pickup_hotel: null, direction: "departure", hotel_id: null, meeting_point: "Forio" },
      ],
      assignments: [
        { id: "asg-existing", tenant_id: TENANT_A, service_id: "existing-svc", driver_user_id: DRIVER_A, group_id: "grp-1", vehicle_label: "DEP_BUS:old" },
      ],
      dailyAvailabilityConfirmations: [confirmedDate(DATE_1)],
      hotels: [{ id: "hotel-1", zone: "Ischia Porto" }],
      memberships: [{ tenant_id: TENANT_A, user_id: DRIVER_A, role: "driver", full_name: "Mario Rossi" }],
    });
    authorizeAs(fake);

    const res = await callPost(assignBody({ service_ids: [SERVICE_X1] }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("DRIVER_GEOGRAPHIC_CONFLICT");
    expect(fake.calls.assignmentsDelete).toBe(0);
    expect(fake.calls.assignmentsInsert).toBe(0);
    expect(fake.assignments).toHaveLength(1); // solo la riga esistente, nessuna nuova scrittura
  });

  it("18. errore nel caricamento dei dati operativi del batch -> 500 fail-closed, zero scritture", async () => {
    const fake = createOperationalSupabase({ services: [serviceRow(SERVICE_X1)] });
    fake.setServicesError({ message: "connection refused: internal db detail xyz" });
    authorizeAs(fake);

    const res = await callPost(assignBody({ service_ids: [SERVICE_X1] }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(body.error).not.toMatch(/connection refused/i);
    expect(fake.calls.assignmentsInsert).toBe(0);
  });

  it("19. FUNC-01 (group_id=null residuo): un giro bus precedente assegnato via departure-bus-assign (group_id=null) è ora visibile e blocca un conflitto geografico reale", async () => {
    // Prima del fix, la query di validateDriverGeographicBatch filtrava
    // group_id IS NOT NULL: le assegnazioni scritte da questa stessa route
    // (che ha sempre group_id=null, per design — non usa trip_groups) erano
    // invisibili a qualunque controllo geografico successivo. Qui l'unica
    // riga "esistente" ha group_id=null, esattamente come scriverebbe
    // questa route: deve comunque generare un conflitto reale rilevato.
    const fake = createOperationalSupabase({
      services: [
        serviceRow(SERVICE_X1, { time: "09:05:00", hotel_id: "hotel-1" }),
        { id: "existing-svc", tenant_id: TENANT_A, date: DATE_1, time: "09:00:00", pickup_hotel: null, direction: "departure", hotel_id: null, meeting_point: "Forio" },
      ],
      assignments: [
        {
          id: "asg-existing",
          tenant_id: TENANT_A,
          service_id: "existing-svc",
          driver_user_id: DRIVER_A,
          group_id: null,
          vehicle_label: "DEP_BUS:old",
        },
      ],
      dailyAvailabilityConfirmations: [confirmedDate(DATE_1)],
      hotels: [{ id: "hotel-1", zone: "Ischia Porto" }],
    });
    authorizeAs(fake);

    const res = await callPost(assignBody({ service_ids: [SERVICE_X1] }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toEqual({
      ok: false,
      error: "DRIVER_GEOGRAPHIC_CONFLICT",
      message: "L'autista ha un altro servizio incompatibile con questo gruppo bus.",
    });
    expect(fake.calls.assignmentsDelete).toBe(0);
    expect(fake.calls.assignmentsInsert).toBe(0);
  });

  it("20. FUNC-01 (group_id=null residuo): un giro bus precedente group_id=null geograficamente compatibile non blocca (200)", async () => {
    const fake = createOperationalSupabase({
      services: [
        serviceRow(SERVICE_X1, { time: "20:00:00", hotel_id: "hotel-1" }),
        { id: "existing-svc", tenant_id: TENANT_A, date: DATE_1, time: "09:00:00", pickup_hotel: null, direction: "departure", hotel_id: null, meeting_point: "Forio" },
      ],
      assignments: [
        { id: "asg-existing", tenant_id: TENANT_A, service_id: "existing-svc", driver_user_id: DRIVER_A, group_id: null, vehicle_label: "DEP_BUS:old" },
      ],
      dailyAvailabilityConfirmations: [confirmedDate(DATE_1)],
      hotels: [{ id: "hotel-1", zone: "Ischia Porto" }],
    });
    authorizeAs(fake);

    const res = await callPost(assignBody({ service_ids: [SERVICE_X1] }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
  });
});
