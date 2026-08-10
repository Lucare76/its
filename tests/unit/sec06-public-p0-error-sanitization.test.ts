import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Test SEC-06 P0 — sanitizzazione errori sulle 4 route pubbliche non autenticate:
 *   1. GET /api/qr/bus/[bookingId]/[direction]/[token]
 *   2. GET/POST /api/agency/confirm/[token]
 *   3. GET/POST /api/agency/bookings/approve/[token]
 *   4. GET/POST /api/agency/action
 *
 * Prima del fix, i catch generici di ciascuna route restituivano al client
 * `error instanceof Error ? error.message : "..."` — un'eccezione runtime
 * qualsiasi (config mancante, errore DB inatteso, ecc.) esponeva il
 * messaggio raw interno. Il fix logga il messaggio raw solo server-side via
 * `auditLog` (stesso pattern già validato in cancel-respond/vehicle-token/
 * agency-review — nessun nuovo helper introdotto) e restituisce un
 * fallback generico in italiano, preservando status HTTP e response shape.
 */

type Row = Record<string, unknown>;

function createFakeAdmin(seed: Partial<Record<string, Row[]>> = {}) {
  const tables: Record<string, Row[]> = {
    booking_approval_tokens: [],
    services: [],
    agencies: [],
    price_lists: [],
    pricing_rules: [],
    status_events: [],
    booking_qr_codes: [],
    ...seed,
  };
  const errors: Record<string, { message: string }> = {};
  const throwers: Record<string, string> = {};
  const calls: Record<string, number> = {};

  function bump(key: string) {
    calls[key] = (calls[key] ?? 0) + 1;
  }

  function maybeThrow(key: string) {
    if (throwers[key]) throw new Error(throwers[key]);
  }

  function makeSelectBuilder(table: string) {
    let filtered = tables[table];
    const errKey = `${table}:select`;
    const builder = {
      eq(field: string, value: unknown) {
        filtered = filtered.filter((r) => r[field] === value);
        return builder;
      },
      lte() {
        return builder;
      },
      or() {
        return builder;
      },
      order() {
        return builder;
      },
      limit(n: number) {
        filtered = filtered.slice(0, n);
        return builder;
      },
      maybeSingle() {
        bump(errKey);
        maybeThrow(errKey);
        if (errors[errKey]) return Promise.resolve({ data: null, error: errors[errKey] });
        return Promise.resolve({ data: filtered[0] ?? null, error: null });
      },
      single() {
        bump(errKey);
        maybeThrow(errKey);
        if (errors[errKey]) return Promise.resolve({ data: null, error: errors[errKey] });
        return Promise.resolve({ data: filtered[0] ?? null, error: filtered[0] ? null : { message: "no rows" } });
      },
      then(resolve: (v: { data: Row[] | null; error: { message: string } | null }) => unknown, reject?: (e: unknown) => unknown) {
        bump(errKey);
        try {
          maybeThrow(errKey);
        } catch (e) {
          return Promise.reject(e).then(resolve, reject);
        }
        if (errors[errKey]) return Promise.resolve({ data: null, error: errors[errKey] }).then(resolve, reject);
        return Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
      },
    };
    return builder;
  }

  const admin = {
    from(table: string) {
      return {
        select() {
          return makeSelectBuilder(table);
        },
        update(payload: Row) {
          let filtered = tables[table];
          const errKey = `${table}:update`;
          const builder = {
            eq(field: string, value: unknown) {
              filtered = filtered.filter((r) => r[field] === value);
              return builder;
            },
            then(resolve: (v: { data: Row[] | null; error: { message: string } | null }) => unknown, reject?: (e: unknown) => unknown) {
              bump(errKey);
              try {
                maybeThrow(errKey);
              } catch (e) {
                return Promise.reject(e).then(resolve, reject);
              }
              if (errors[errKey]) return Promise.resolve({ data: null, error: errors[errKey] }).then(resolve, reject);
              for (const row of filtered) Object.assign(row, payload);
              return Promise.resolve({ data: null, error: null }).then(resolve, reject);
            },
          };
          return builder;
        },
        insert(rowsOrRow: Row | Row[]) {
          const rowsArr = Array.isArray(rowsOrRow) ? rowsOrRow : [rowsOrRow];
          const errKey = `${table}:insert`;
          const inserted = rowsArr.map((r, i) => ({ id: (r.id as string) ?? `${table}-${Date.now()}-${i}`, ...r }));
          return {
            then(resolve: (v: { data: Row[] | null; error: { message: string } | null }) => unknown, reject?: (e: unknown) => unknown) {
              bump(errKey);
              try {
                maybeThrow(errKey);
              } catch (e) {
                return Promise.reject(e).then(resolve, reject);
              }
              if (errors[errKey]) return Promise.resolve({ data: null, error: errors[errKey] }).then(resolve, reject);
              tables[table].push(...inserted);
              return Promise.resolve({ data: inserted, error: null }).then(resolve, reject);
            },
          };
        },
      };
    },
  };

  return {
    admin,
    tables,
    calls,
    setError(table: string, op: "select" | "insert" | "update", err: { message: string }) {
      errors[`${table}:${op}`] = err;
    },
    setThrow(table: string, op: "select" | "insert" | "update", message: string) {
      throwers[`${table}:${op}`] = message;
    },
  };
}

const RAW_DB_ERROR =
  'duplicate key value violates unique constraint "booking_approval_tokens_token_key" on relation "booking_approval_tokens", column "token" SQLSTATE=23505';
const RAW_DB_ERROR_2 =
  'update or delete on table "services" violates foreign key constraint "fk_services_agency" relation "services" column "agency_id"';

function assertNoForbiddenFields(body: Record<string, unknown>) {
  expect(body).not.toHaveProperty("details");
  expect(body).not.toHaveProperty("hint");
  expect(body).not.toHaveProperty("code");
  expect(body).not.toHaveProperty("stack");
}

function assertNoRawFragments(rawText: string) {
  expect(rawText).not.toContain("duplicate key");
  expect(rawText).not.toContain("unique constraint");
  expect(rawText).not.toContain("SQLSTATE");
  expect(rawText).not.toContain("relation");
  expect(rawText).not.toContain("foreign key constraint");
  expect(rawText).not.toContain("booking_approval_tokens_token_key");
  expect(rawText).not.toContain("fk_services_agency");
}

// ---------------------------------------------------------------------------
// 1. QR/BUS — GET /api/qr/bus/[bookingId]/[direction]/[token]
// ---------------------------------------------------------------------------

const qrMocks = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  validateBusBookingQr: vi.fn(),
  parseBusQrDirection: vi.fn(),
  auditLog: vi.fn(),
}));

vi.mock("@/lib/server/supabase-admin", () => ({
  createAdminClient: qrMocks.createAdminClient,
}));
vi.mock("@/lib/server/bus-booking-qr", () => ({
  validateBusBookingQr: qrMocks.validateBusBookingQr,
  parseBusQrDirection: qrMocks.parseBusQrDirection,
}));

// ---------------------------------------------------------------------------
// 2/3/4. AGENCY routes — usano @supabase/supabase-js direttamente
// ---------------------------------------------------------------------------

const agencyMocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  auditLog: vi.fn(),
  sendEmailUtil: vi.fn(),
  sendAgencyConfirmedEmail: vi.fn(),
  sendAgencyRejectedEmail: vi.fn(),
  verifyAgencyActionToken: vi.fn(),
  sendEmail: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: agencyMocks.createClient,
}));
vi.mock("@/lib/server/ops-audit", () => ({
  auditLog: qrMocks.auditLog,
}));
vi.mock("@/lib/server/send-email", () => ({
  sendEmail: agencyMocks.sendEmailUtil,
}));
vi.mock("@/lib/server/agency-approval-email", () => ({
  sendAgencyConfirmedEmail: agencyMocks.sendAgencyConfirmedEmail,
  sendAgencyRejectedEmail: agencyMocks.sendAgencyRejectedEmail,
}));
vi.mock("@/lib/server/agency-action-token", () => ({
  verifyAgencyActionToken: agencyMocks.verifyAgencyActionToken,
}));

import { GET as qrBusGet } from "@/app/api/qr/bus/[bookingId]/[direction]/[token]/route";
import { GET as confirmGet, POST as confirmPost } from "@/app/api/agency/confirm/[token]/route";
import { GET as approveGet, POST as approvePost } from "@/app/api/agency/bookings/approve/[token]/route";
import { GET as actionGet, POST as actionPost } from "@/app/api/agency/action/route";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SERVICE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOKEN_ROW_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const BOOKING_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const AGENCY_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
  qrMocks.parseBusQrDirection.mockImplementation((v: string) => (["outbound", "return"].includes(v) ? v : null));
});

describe("SEC-06 P0 — GET /api/qr/bus/[bookingId]/[direction]/[token]", () => {
  function callGet(bookingId = BOOKING_ID, direction = "outbound", token = "tok") {
    return qrBusGet(new Request(`http://localhost:3010/api/qr/bus/${bookingId}/${direction}/${token}`), {
      params: Promise.resolve({ bookingId, direction, token }),
    });
  }

  it("1. success invariato: stato valid -> ok:true con payload di validazione", async () => {
    qrMocks.createAdminClient.mockReturnValue({});
    qrMocks.validateBusBookingQr.mockResolvedValue({
      state: "valid",
      bookingId: BOOKING_ID,
      tenantId: TENANT_A,
      direction: "outbound",
      qrCode: { id: "qr-1" },
      booking: { bookingId: BOOKING_ID },
      message: "QR valido.",
    });

    const res = await callGet();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.state).toBe("valid");
  });

  it("2. token valido/business invariato: stato invalid (business, non eccezione) -> ok:false, 200, messaggio business", async () => {
    qrMocks.createAdminClient.mockReturnValue({});
    qrMocks.validateBusBookingQr.mockResolvedValue({
      state: "invalid",
      bookingId: null,
      tenantId: null,
      direction: null,
      qrCode: null,
      booking: null,
      message: "QR non valido o non trovato.",
    });

    const res = await callGet();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.message).toBe("QR non valido o non trovato.");
  });

  it("3. direzione non valida invariata: 400 business", async () => {
    const res = await callGet(BOOKING_ID, "sideways");
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toEqual({ ok: false, state: "invalid", message: "Direzione non valida." });
  });

  it("4. DB failure raw non presente anche quando il token è (apparentemente) invalido: eccezione durante la validazione -> 500 generico", async () => {
    qrMocks.createAdminClient.mockReturnValue({});
    qrMocks.validateBusBookingQr.mockRejectedValue(new Error(RAW_DB_ERROR));

    const res = await callGet();
    const rawText = await res.clone().text();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ ok: false, state: "invalid", message: "Errore durante la validazione del QR." });
    assertNoRawFragments(rawText);
  });

  it("5. raw relation/constraint/table/column non presente nella risposta", async () => {
    qrMocks.createAdminClient.mockReturnValue({});
    qrMocks.validateBusBookingQr.mockRejectedValue(new Error(RAW_DB_ERROR_2));

    const res = await callGet();
    const rawText = await res.clone().text();

    assertNoRawFragments(rawText);
  });

  it("6. status/shape invariati sul ramo di errore: solo ok/state/message", async () => {
    qrMocks.createAdminClient.mockReturnValue({});
    qrMocks.validateBusBookingQr.mockRejectedValue(new Error(RAW_DB_ERROR));

    const res = await callGet();
    const body = await res.json();

    expect(Object.keys(body).sort()).toEqual(["message", "ok", "state"]);
    assertNoForbiddenFields(body);
  });

  it("7. endpoint resta pubblico: nessuna auth richiesta per raggiungere la business logic", async () => {
    qrMocks.createAdminClient.mockReturnValue({});
    qrMocks.validateBusBookingQr.mockResolvedValue({
      state: "valid",
      bookingId: BOOKING_ID,
      tenantId: TENANT_A,
      direction: "outbound",
      qrCode: null,
      booking: null,
      message: "QR valido.",
    });

    const res = await callGet();

    expect(res.status).not.toBe(401);
    expect(res.status).toBe(200);
  });

  it("8. logging server-side avviene una sola volta con il messaggio raw nei details", async () => {
    qrMocks.createAdminClient.mockReturnValue({});
    qrMocks.validateBusBookingQr.mockRejectedValue(new Error(RAW_DB_ERROR));

    await callGet();

    expect(qrMocks.auditLog).toHaveBeenCalledTimes(1);
    const logged = qrMocks.auditLog.mock.calls[0][0];
    expect(logged.event).toBe("qr_bus_validate_failed");
    expect(logged.level).toBe("error");
    expect(logged.details.message).toBe(RAW_DB_ERROR);
  });
});

// ---------------------------------------------------------------------------
// AGENCY CONFIRM
// ---------------------------------------------------------------------------

function baseTokenRowConfirm(overrides: Row = {}) {
  return {
    id: TOKEN_ROW_ID,
    tenant_id: TENANT_A,
    service_id: SERVICE_ID,
    resolved_price_cents: 5000,
    action: "confirmed",
    agency_response: null,
    agency_response_at: null,
    agency_token: "agency-tok",
    ...overrides,
  };
}

function baseServiceConfirm(overrides: Row = {}) {
  return {
    id: SERVICE_ID,
    tenant_id: TENANT_A,
    customer_name: "Mario Rossi",
    customer_first_name: "Mario",
    customer_last_name: "Rossi",
    pax: 2,
    arrival_date: "2026-09-01",
    arrival_time: "10:00",
    departure_date: null,
    departure_time: null,
    booking_service_kind: "transfer_port_hotel",
    transport_code: null,
    bus_city_origin: null,
    excursion_details: null,
    notes: null,
    agency_id: null,
    agencies: null,
    hotels: { name: "Hotel Test" },
    ...overrides,
  };
}

describe("SEC-06 P0 — GET/POST /api/agency/confirm/[token]", () => {
  function callGet(token = "agency-tok") {
    return confirmGet(new NextRequest(`http://localhost:3010/api/agency/confirm/${token}`), {
      params: Promise.resolve({ token }),
    });
  }
  function callPost(bodyPayload: Record<string, unknown>, token = "agency-tok") {
    return confirmPost(
      new NextRequest(`http://localhost:3010/api/agency/confirm/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bodyPayload),
      }),
      { params: Promise.resolve({ token }) }
    );
  }

  it("GET success invariato: dati servizio + prezzo", async () => {
    const fake = createFakeAdmin({
      booking_approval_tokens: [baseTokenRowConfirm()],
      services: [baseServiceConfirm()],
    });
    agencyMocks.createClient.mockReturnValue(fake.admin);

    const res = await callGet();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.service.customer_name).toBe("Mario Rossi");
    expect(body.price_cents).toBe(5000);
  });

  it("GET business error invariato: link non valido -> 404", async () => {
    const fake = createFakeAdmin({ booking_approval_tokens: [] });
    agencyMocks.createClient.mockReturnValue(fake.admin);

    const res = await callGet();
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ error: "Link non valido." });
  });

  it("GET business error invariato: non ancora confermato -> 409", async () => {
    const fake = createFakeAdmin({
      booking_approval_tokens: [baseTokenRowConfirm({ action: "pending" })],
    });
    agencyMocks.createClient.mockReturnValue(fake.admin);

    const res = await callGet();
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toContain("non è ancora stata confermata");
  });

  it("GET business error invariato: risposta già registrata -> 410", async () => {
    const fake = createFakeAdmin({
      booking_approval_tokens: [baseTokenRowConfirm({ agency_response: "accepted" })],
    });
    agencyMocks.createClient.mockReturnValue(fake.admin);

    const res = await callGet();
    const body = await res.json();

    expect(res.status).toBe(410);
    expect(body.already_responded).toBe(true);
  });

  it("leak 1 (GET catch) sanitizzato: eccezione interna raw non raggiunge il client", async () => {
    const fake = createFakeAdmin({ booking_approval_tokens: [baseTokenRowConfirm()] });
    fake.setThrow("booking_approval_tokens", "select", RAW_DB_ERROR);
    agencyMocks.createClient.mockReturnValue(fake.admin);

    const res = await callGet();
    const rawText = await res.clone().text();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ error: "Errore interno." });
    assertNoRawFragments(rawText);
    assertNoForbiddenFields(body);
  });

  it("POST success invariato: registra risposta 'accepted'", async () => {
    const fake = createFakeAdmin({
      booking_approval_tokens: [baseTokenRowConfirm()],
    });
    agencyMocks.createClient.mockReturnValue(fake.admin);

    const res = await callPost({ response: "accepted" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, response: "accepted" });
  });

  it("POST business error invariato: payload non valido -> 400", async () => {
    const fake = createFakeAdmin({ booking_approval_tokens: [baseTokenRowConfirm()] });
    agencyMocks.createClient.mockReturnValue(fake.admin);

    const res = await callPost({ response: "not-a-valid-enum" });

    expect(res.status).toBe(400);
  });

  it("leak 2 (POST catch) sanitizzato: eccezione interna raw non raggiunge il client", async () => {
    const fake = createFakeAdmin({ booking_approval_tokens: [baseTokenRowConfirm()] });
    fake.setThrow("booking_approval_tokens", "select", RAW_DB_ERROR_2);
    agencyMocks.createClient.mockReturnValue(fake.admin);

    const res = await callPost({ response: "accepted" });
    const rawText = await res.clone().text();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ error: "Errore interno." });
    assertNoRawFragments(rawText);
    assertNoForbiddenFields(body);
  });

  it("status invariati sui rami business (404/409/410) e sanitizzazione (500)", async () => {
    const fakeMissing = createFakeAdmin({ booking_approval_tokens: [] });
    agencyMocks.createClient.mockReturnValue(fakeMissing.admin);
    expect((await callGet()).status).toBe(404);

    const fakeThrow = createFakeAdmin({ booking_approval_tokens: [baseTokenRowConfirm()] });
    fakeThrow.setThrow("booking_approval_tokens", "select", RAW_DB_ERROR);
    agencyMocks.createClient.mockReturnValue(fakeThrow.admin);
    expect((await callGet()).status).toBe(500);
  });

  it("auditLog invocato una sola volta per errore sanitizzato, con evento stabile", async () => {
    const fake = createFakeAdmin({ booking_approval_tokens: [baseTokenRowConfirm()] });
    fake.setThrow("booking_approval_tokens", "select", RAW_DB_ERROR);
    agencyMocks.createClient.mockReturnValue(fake.admin);

    await callGet();

    expect(qrMocks.auditLog).toHaveBeenCalledTimes(1);
    const logged = qrMocks.auditLog.mock.calls[0][0];
    expect(logged.event).toBe("agency_confirm_get_failed");
    expect(logged.level).toBe("error");
    expect(logged.details.message).toBe(RAW_DB_ERROR);
  });
});

// ---------------------------------------------------------------------------
// AGENCY BOOKINGS APPROVE
// ---------------------------------------------------------------------------

const FUTURE_EXPIRY = "2099-01-01T00:00:00Z";
const PAST_EXPIRY = "2020-01-01T00:00:00Z";

function baseTokenRowApprove(overrides: Row = {}) {
  return {
    id: TOKEN_ROW_ID,
    tenant_id: TENANT_A,
    service_id: SERVICE_ID,
    token: "approve-tok",
    action: null,
    expires_at: FUTURE_EXPIRY,
    used_at: null,
    ...overrides,
  };
}

function baseServiceApprove(overrides: Row = {}) {
  return {
    id: SERVICE_ID,
    tenant_id: TENANT_A,
    customer_name: "Anna Bianchi",
    customer_first_name: "Anna",
    customer_last_name: "Bianchi",
    customer_email: "anna@example.com",
    phone: "+390000000000",
    pax: 3,
    date: "2026-09-05",
    time: "09:00",
    arrival_date: "2026-09-05",
    arrival_time: "09:00",
    departure_date: null,
    departure_time: null,
    transport_code: null,
    bus_city_origin: null,
    excursion_details: null,
    notes: null,
    booking_service_kind: "transfer_port_hotel",
    agency_id: AGENCY_ID,
    approval_status: "pending",
    email_confirmation_to: null,
    hotels: { name: "Hotel Approve" },
    ...overrides,
  };
}

describe("SEC-06 P0 — GET/POST /api/agency/bookings/approve/[token]", () => {
  function callGet(token = "approve-tok") {
    return approveGet(new NextRequest(`http://localhost:3010/api/agency/bookings/approve/${token}`), {
      params: Promise.resolve({ token }),
    });
  }
  function callPost(bodyPayload: Record<string, unknown>, token = "approve-tok") {
    return approvePost(
      new NextRequest(`http://localhost:3010/api/agency/bookings/approve/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bodyPayload),
      }),
      { params: Promise.resolve({ token }) }
    );
  }

  it("GET success invariato: dati servizio + pricing suggerito", async () => {
    const fake = createFakeAdmin({
      booking_approval_tokens: [baseTokenRowApprove()],
      services: [baseServiceApprove()],
      agencies: [{ id: AGENCY_ID, name: "Agenzia Test" }],
    });
    agencyMocks.createClient.mockReturnValue(fake.admin);

    const res = await callGet();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.service.customer_name).toBe("Anna Bianchi");
    expect(body.pricing.source).toBe("no_price_list");
  });

  it("GET business error invariato: link non valido -> 404", async () => {
    const fake = createFakeAdmin({ booking_approval_tokens: [] });
    agencyMocks.createClient.mockReturnValue(fake.admin);

    const res = await callGet();
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ error: "Link non valido o scaduto." });
  });

  it("GET business error invariato: link scaduto -> 410", async () => {
    const fake = createFakeAdmin({
      booking_approval_tokens: [baseTokenRowApprove({ expires_at: PAST_EXPIRY })],
    });
    agencyMocks.createClient.mockReturnValue(fake.admin);

    const res = await callGet();
    const body = await res.json();

    expect(res.status).toBe(410);
    expect(body.error).toBe("Link scaduto (48 ore).");
  });

  it("GET business error invariato: link già usato -> 410", async () => {
    const fake = createFakeAdmin({
      booking_approval_tokens: [baseTokenRowApprove({ used_at: new Date().toISOString(), action: "confirmed" })],
    });
    agencyMocks.createClient.mockReturnValue(fake.admin);

    const res = await callGet();
    const body = await res.json();

    expect(res.status).toBe(410);
    expect(body.already_used).toBe(true);
    expect(body.action).toBe("confirmed");
  });

  it("leak 1 (GET catch) sanitizzato: eccezione interna raw non raggiunge il client", async () => {
    const fake = createFakeAdmin({ booking_approval_tokens: [baseTokenRowApprove()] });
    fake.setThrow("booking_approval_tokens", "select", RAW_DB_ERROR);
    agencyMocks.createClient.mockReturnValue(fake.admin);

    const res = await callGet();
    const rawText = await res.clone().text();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ error: "Errore interno." });
    assertNoRawFragments(rawText);
    assertNoForbiddenFields(body);
  });

  it("POST success invariato: conferma con prezzo -> ok:true", async () => {
    const fake = createFakeAdmin({
      booking_approval_tokens: [baseTokenRowApprove()],
      services: [baseServiceApprove()],
      agencies: [{ id: AGENCY_ID, name: "Agenzia Test" }],
    });
    agencyMocks.createClient.mockReturnValue(fake.admin);
    agencyMocks.sendAgencyConfirmedEmail.mockResolvedValue({ status: "sent", error: null });

    const res = await callPost({ action: "confirmed", price_cents: 8000 });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.action).toBe("confirmed");
    expect(body.email_status).toBe("sent");
  });

  it("POST business error invariato: prezzo obbligatorio mancante -> 400", async () => {
    const fake = createFakeAdmin({ booking_approval_tokens: [baseTokenRowApprove()] });
    agencyMocks.createClient.mockReturnValue(fake.admin);

    const res = await callPost({ action: "confirmed" });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("Il prezzo è obbligatorio per confermare.");
  });

  it("leak 2 (POST catch) sanitizzato: eccezione interna raw non raggiunge il client", async () => {
    const fake = createFakeAdmin({ booking_approval_tokens: [baseTokenRowApprove()] });
    fake.setThrow("booking_approval_tokens", "select", RAW_DB_ERROR_2);
    agencyMocks.createClient.mockReturnValue(fake.admin);

    const res = await callPost({ action: "confirmed", price_cents: 8000 });
    const rawText = await res.clone().text();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ error: "Errore interno." });
    assertNoRawFragments(rawText);
    assertNoForbiddenFields(body);
  });

  it("status invariati sui rami business (404/410) e sanitizzazione (500)", async () => {
    const fakeMissing = createFakeAdmin({ booking_approval_tokens: [] });
    agencyMocks.createClient.mockReturnValue(fakeMissing.admin);
    expect((await callGet()).status).toBe(404);

    const fakeThrow = createFakeAdmin({ booking_approval_tokens: [baseTokenRowApprove()] });
    fakeThrow.setThrow("booking_approval_tokens", "select", RAW_DB_ERROR);
    agencyMocks.createClient.mockReturnValue(fakeThrow.admin);
    expect((await callGet()).status).toBe(500);
  });

  it("auditLog invocato una sola volta per errore sanitizzato, con evento stabile", async () => {
    const fake = createFakeAdmin({ booking_approval_tokens: [baseTokenRowApprove()] });
    fake.setThrow("booking_approval_tokens", "select", RAW_DB_ERROR);
    agencyMocks.createClient.mockReturnValue(fake.admin);

    await callGet();

    expect(qrMocks.auditLog).toHaveBeenCalledTimes(1);
    const logged = qrMocks.auditLog.mock.calls[0][0];
    expect(logged.event).toBe("agency_bookings_approve_get_failed");
    expect(logged.level).toBe("error");
    expect(logged.details.message).toBe(RAW_DB_ERROR);
  });
});

// ---------------------------------------------------------------------------
// AGENCY ACTION
// ---------------------------------------------------------------------------

function basePayload(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    sid: SERVICE_ID,
    aid: AGENCY_ID,
    tid: TENANT_A,
    act: "cancel",
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
}

function baseServiceAction(overrides: Row = {}) {
  return {
    id: SERVICE_ID,
    tenant_id: TENANT_A,
    date: "2026-09-10",
    time: "12:00",
    customer_name: "Luca Verdi",
    pax: 2,
    status: "confirmed",
    direction: "arrival",
    hotel_id: null,
    hotels: { name: "Hotel Action" },
    agency_id: AGENCY_ID,
    agencies: { name: "Agenzia Action" },
    ...overrides,
  };
}

describe("SEC-06 P0 — GET/POST /api/agency/action", () => {
  function callGet(token = "hmac-tok") {
    return actionGet(new NextRequest(`http://localhost:3010/api/agency/action?token=${token}`));
  }
  function callPost(bodyPayload: Record<string, unknown>) {
    return actionPost(
      new NextRequest("http://localhost:3010/api/agency/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bodyPayload),
      })
    );
  }

  it("GET success invariato: dati servizio", async () => {
    agencyMocks.verifyAgencyActionToken.mockReturnValue(basePayload());
    const fake = createFakeAdmin({ services: [baseServiceAction()] });
    agencyMocks.createClient.mockReturnValue(fake.admin);

    const res = await callGet();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.service.customer_name).toBe("Luca Verdi");
    expect(body.action).toBe("cancel");
  });

  it("GET business/token error invariato: token HMAC non valido -> 400 (nessuna chiamata DB)", async () => {
    agencyMocks.verifyAgencyActionToken.mockReturnValue(null);
    const fake = createFakeAdmin({ services: [baseServiceAction()] });
    agencyMocks.createClient.mockReturnValue(fake.admin);

    const res = await callGet();
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toEqual({ error: "Token non valido o scaduto." });
    expect(fake.calls["services:select"]).toBeUndefined();
  });

  it("GET business error invariato: servizio non trovato -> 404", async () => {
    agencyMocks.verifyAgencyActionToken.mockReturnValue(basePayload());
    const fake = createFakeAdmin({ services: [] });
    agencyMocks.createClient.mockReturnValue(fake.admin);

    const res = await callGet();
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ error: "Servizio non trovato." });
  });

  it("leak GET sanitizzato: eccezione interna raw non raggiunge il client", async () => {
    agencyMocks.verifyAgencyActionToken.mockReturnValue(basePayload());
    const fake = createFakeAdmin({ services: [baseServiceAction()] });
    fake.setThrow("services", "select", RAW_DB_ERROR);
    agencyMocks.createClient.mockReturnValue(fake.admin);

    const res = await callGet();
    const rawText = await res.clone().text();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ error: "Errore interno." });
    assertNoRawFragments(rawText);
    assertNoForbiddenFields(body);
  });

  it("POST success invariato: annulla servizio -> ok:true, cancelled:true", async () => {
    agencyMocks.verifyAgencyActionToken.mockReturnValue(basePayload());
    const fake = createFakeAdmin({ services: [baseServiceAction()] });
    agencyMocks.createClient.mockReturnValue(fake.admin);

    const res = await callPost({ token: "hmac-tok", reason: "test" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, cancelled: true });
    expect(fake.tables.services.find((s) => s.id === SERVICE_ID)?.status).toBe("cancelled");
  });

  it("POST business/token invariato: act diverso da cancel -> 400", async () => {
    agencyMocks.verifyAgencyActionToken.mockReturnValue(basePayload({ act: "other" }));
    const fake = createFakeAdmin({ services: [baseServiceAction()] });
    agencyMocks.createClient.mockReturnValue(fake.admin);

    const res = await callPost({ token: "hmac-tok" });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toEqual({ error: "Token non valido o scaduto." });
  });

  it("POST business invariato: già annullato -> ok:true, already_cancelled:true (nessuna mutazione aggiuntiva)", async () => {
    agencyMocks.verifyAgencyActionToken.mockReturnValue(basePayload());
    const fake = createFakeAdmin({ services: [baseServiceAction({ status: "cancelled" })] });
    agencyMocks.createClient.mockReturnValue(fake.admin);

    const res = await callPost({ token: "hmac-tok" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, already_cancelled: true });
    expect(fake.calls["services:update"]).toBeUndefined();
    expect(fake.calls["status_events:insert"]).toBeUndefined();
  });

  it("leak POST sanitizzato: eccezione interna raw non raggiunge il client", async () => {
    agencyMocks.verifyAgencyActionToken.mockReturnValue(basePayload());
    const fake = createFakeAdmin({ services: [baseServiceAction()] });
    fake.setThrow("services", "update", RAW_DB_ERROR_2);
    agencyMocks.createClient.mockReturnValue(fake.admin);

    const res = await callPost({ token: "hmac-tok" });
    const rawText = await res.clone().text();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ error: "Errore interno." });
    assertNoRawFragments(rawText);
    assertNoForbiddenFields(body);
  });

  it("status invariati su GET/POST (400/404/500)", async () => {
    agencyMocks.verifyAgencyActionToken.mockReturnValue(null);
    expect((await callGet()).status).toBe(400);

    agencyMocks.verifyAgencyActionToken.mockReturnValue(basePayload());
    const fakeMissing = createFakeAdmin({ services: [] });
    agencyMocks.createClient.mockReturnValue(fakeMissing.admin);
    expect((await callGet()).status).toBe(404);

    const fakeThrow = createFakeAdmin({ services: [baseServiceAction()] });
    fakeThrow.setThrow("services", "select", RAW_DB_ERROR);
    agencyMocks.createClient.mockReturnValue(fakeThrow.admin);
    expect((await callGet()).status).toBe(500);
  });

  it("response shape invariata sul ramo success GET/POST", async () => {
    agencyMocks.verifyAgencyActionToken.mockReturnValue(basePayload());
    const fakeGet = createFakeAdmin({ services: [baseServiceAction()] });
    agencyMocks.createClient.mockReturnValue(fakeGet.admin);
    const getBody = await (await callGet()).json();
    expect(Object.keys(getBody).sort()).toEqual(["action", "ok", "service"]);

    const fakePost = createFakeAdmin({ services: [baseServiceAction()] });
    agencyMocks.createClient.mockReturnValue(fakePost.admin);
    const postBody = await (await callPost({ token: "hmac-tok" })).json();
    expect(postBody).toEqual({ ok: true, cancelled: true });
  });

  it("auditLog invocato una sola volta per ciascun errore sanitizzato, con eventi distinti GET/POST e tenantId/serviceId dal payload", async () => {
    agencyMocks.verifyAgencyActionToken.mockReturnValue(basePayload());

    const fakeGet = createFakeAdmin({ services: [baseServiceAction()] });
    fakeGet.setThrow("services", "select", RAW_DB_ERROR);
    agencyMocks.createClient.mockReturnValue(fakeGet.admin);
    await callGet();

    expect(qrMocks.auditLog).toHaveBeenCalledTimes(1);
    const getLog = qrMocks.auditLog.mock.calls[0][0];
    expect(getLog.event).toBe("agency_action_get_failed");
    expect(getLog.tenantId).toBe(TENANT_A);
    expect(getLog.serviceId).toBe(SERVICE_ID);
    expect(getLog.details.message).toBe(RAW_DB_ERROR);

    vi.clearAllMocks();
    agencyMocks.verifyAgencyActionToken.mockReturnValue(basePayload());
    const fakePost = createFakeAdmin({ services: [baseServiceAction()] });
    fakePost.setThrow("services", "update", RAW_DB_ERROR_2);
    agencyMocks.createClient.mockReturnValue(fakePost.admin);
    await callPost({ token: "hmac-tok" });

    expect(qrMocks.auditLog).toHaveBeenCalledTimes(1);
    const postLog = qrMocks.auditLog.mock.calls[0][0];
    expect(postLog.event).toBe("agency_action_post_failed");
    expect(postLog.tenantId).toBe(TENANT_A);
    expect(postLog.serviceId).toBe(SERVICE_ID);
    expect(postLog.details.message).toBe(RAW_DB_ERROR_2);
  });
});

// ---------------------------------------------------------------------------
// TRASVERSALI
// ---------------------------------------------------------------------------

describe("SEC-06 P0 — trasversali", () => {
  it("nessuna auth aggiunta: tutte le 4 route restano raggiungibili senza Authorization/sessione", async () => {
    qrMocks.createAdminClient.mockReturnValue({});
    qrMocks.validateBusBookingQr.mockResolvedValue({
      state: "valid", bookingId: BOOKING_ID, tenantId: TENANT_A, direction: "outbound", qrCode: null, booking: null, message: "QR valido.",
    });
    const qrRes = await qrBusGet(new Request(`http://localhost:3010/api/qr/bus/${BOOKING_ID}/outbound/tok`), {
      params: Promise.resolve({ bookingId: BOOKING_ID, direction: "outbound", token: "tok" }),
    });
    expect(qrRes.status).not.toBe(401);

    const fakeConfirm = createFakeAdmin({
      booking_approval_tokens: [baseTokenRowConfirm()],
      services: [baseServiceConfirm()],
    });
    agencyMocks.createClient.mockReturnValue(fakeConfirm.admin);
    const confirmRes = await confirmGet(new NextRequest("http://localhost:3010/api/agency/confirm/agency-tok"), {
      params: Promise.resolve({ token: "agency-tok" }),
    });
    expect(confirmRes.status).not.toBe(401);

    const fakeApprove = createFakeAdmin({
      booking_approval_tokens: [baseTokenRowApprove()],
      services: [baseServiceApprove()],
    });
    agencyMocks.createClient.mockReturnValue(fakeApprove.admin);
    const approveRes = await approveGet(new NextRequest("http://localhost:3010/api/agency/bookings/approve/approve-tok"), {
      params: Promise.resolve({ token: "approve-tok" }),
    });
    expect(approveRes.status).not.toBe(401);

    agencyMocks.verifyAgencyActionToken.mockReturnValue(basePayload());
    const fakeAction = createFakeAdmin({ services: [baseServiceAction()] });
    agencyMocks.createClient.mockReturnValue(fakeAction.admin);
    const actionRes = await actionGet(new NextRequest("http://localhost:3010/api/agency/action?token=hmac-tok"));
    expect(actionRes.status).not.toBe(401);
  });
});
