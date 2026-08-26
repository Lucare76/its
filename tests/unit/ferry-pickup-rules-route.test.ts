import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type Row = Record<string, unknown>;

function baseRule(overrides: Row = {}): Row {
  return {
    id: "rule-1",
    agency_logic: "aleste",
    transport_type: "flight",
    boat_type: "traghetto",
    transport_from: "08:05",
    transport_to: "08:30",
    company: "caremar",
    departure_time: "09:25",
    arrival_port: "ischia_porto",
    arrival_time: "11:00",
    valid_from: null,
    valid_to: null,
    days_of_week: null,
    season_notes: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

/** Fake Supabase admin client for the "ferry_pickup_rules" table only. */
function createFakeSupabase(seed: Row[] = []) {
  const rows: Row[] = [...seed];
  const calls = { insert: 0, update: 0, delete: 0 };

  function makeSelectBuilder(initial: Row[]) {
    let filtered = initial;
    let singleMode: "single" | "maybeSingle" | null = null;
    const builder = {
      eq(field: string, value: unknown) {
        filtered = filtered.filter((row) => row[field] === value);
        return builder;
      },
      order() {
        return builder;
      },
      single() {
        singleMode = "single";
        return builder;
      },
      maybeSingle() {
        singleMode = "maybeSingle";
        return builder;
      },
      then(resolve: (v: { data: unknown; error: null }) => unknown, reject?: (e: unknown) => unknown) {
        if (singleMode) {
          return Promise.resolve({ data: filtered[0] ?? null, error: null }).then(resolve, reject);
        }
        return Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
      },
    };
    return builder;
  }

  const admin = {
    from(table: string) {
      if (table !== "ferry_pickup_rules") throw new Error(`Unexpected table: ${table}`);
      return {
        select() {
          return makeSelectBuilder(rows);
        },
        insert(payload: Row) {
          calls.insert++;
          const created = { id: `rule-${rows.length + 1}`, created_at: "2026-01-01T00:00:00Z", ...payload };
          rows.push(created);
          return {
            select() {
              return {
                single() {
                  return Promise.resolve({ data: created, error: null });
                },
              };
            },
          };
        },
        update(payload: Row) {
          calls.update++;
          return {
            eq(_field: string, value: unknown) {
              const idx = rows.findIndex((r) => r.id === value);
              if (idx >= 0) rows[idx] = { ...rows[idx], ...payload };
              return {
                select() {
                  return {
                    single() {
                      return Promise.resolve({ data: rows[idx] ?? null, error: null });
                    },
                  };
                },
              };
            },
          };
        },
        delete() {
          calls.delete++;
          return {
            eq(_field: string, value: unknown) {
              const idx = rows.findIndex((r) => r.id === value);
              if (idx >= 0) rows.splice(idx, 1);
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  };

  return { admin, rows, calls };
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

import { GET, POST } from "@/app/api/ferry-pickup-rules/route";
import { PATCH, DELETE } from "@/app/api/ferry-pickup-rules/[id]/route";

function authorizeAs(role: string, fake: ReturnType<typeof createFakeSupabase>) {
  mocks.authorizeServiceRoleRequest.mockImplementation(async (_req: unknown, options: { roles: string[] }) => {
    if (!options.roles.includes(role)) {
      const { NextResponse } = await import("next/server");
      return NextResponse.json({ error: "Ruolo non autorizzato." }, { status: 403 });
    }
    return {
      admin: fake.admin,
      user: { id: "user-1", email: "op@test.dev" },
      membership: { tenant_id: TENANT_A, role, suspended: false },
    };
  });
}

function makeGetRequest() {
  return new NextRequest("http://localhost:3010/api/ferry-pickup-rules", {
    headers: { authorization: "Bearer test-token" },
  });
}
function makePostRequest(body: Row) {
  return new NextRequest("http://localhost:3010/api/ferry-pickup-rules", {
    method: "POST",
    headers: { "Content-Type": "application/json", authorization: "Bearer test-token" },
    body: JSON.stringify(body),
  });
}
function makePatchRequest(body: Row) {
  return new NextRequest("http://localhost:3010/api/ferry-pickup-rules/rule-1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", authorization: "Bearer test-token" },
    body: JSON.stringify(body),
  });
}
function makeDeleteRequest() {
  return new NextRequest("http://localhost:3010/api/ferry-pickup-rules/rule-1", {
    method: "DELETE",
    headers: { authorization: "Bearer test-token" },
  });
}

function validCreatePayload(overrides: Row = {}): Row {
  return {
    agency_logic: "aleste",
    transport_type: "flight",
    boat_type: "traghetto",
    transport_from: "10:00",
    transport_to: "11:00",
    company: "medmar",
    departure_time: "12:00",
    arrival_port: "ischia_porto",
    arrival_time: "13:00",
    ...overrides,
  };
}

function eventsNamed(name: string) {
  return mocks.auditLog.mock.calls.map(([payload]) => payload).filter((payload) => payload.event === name);
}

describe("ferry-pickup-rules API — permessi supervisor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("1. supervisor può leggere le regole (GET)", async () => {
    const fake = createFakeSupabase([baseRule()]);
    authorizeAs("supervisor", fake);
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(200);
  });

  it("2. supervisor può creare una regola (POST)", async () => {
    const fake = createFakeSupabase([]);
    authorizeAs("supervisor", fake);
    const res = await POST(makePostRequest(validCreatePayload()));
    expect(res.status).toBe(201);
  });

  it("3. supervisor può modificare una regola (PATCH)", async () => {
    const fake = createFakeSupabase([baseRule()]);
    authorizeAs("supervisor", fake);
    const res = await PATCH(makePatchRequest({ season_notes: "aggiornata" }), { params: Promise.resolve({ id: "rule-1" }) });
    expect(res.status).toBe(200);
  });

  it("4. supervisor può eliminare una regola (DELETE)", async () => {
    const fake = createFakeSupabase([baseRule()]);
    authorizeAs("supervisor", fake);
    const res = await DELETE(makeDeleteRequest(), { params: Promise.resolve({ id: "rule-1" }) });
    expect(res.status).toBe(200);
  });

  it("nessuna situazione in cui supervisor vede una UI abilitata ma l'API rifiuta: le 4 operazioni CRUD sono tutte 2xx per supervisor", async () => {
    const fake = createFakeSupabase([baseRule()]);
    authorizeAs("supervisor", fake);
    const getRes = await GET(makeGetRequest());
    const postRes = await POST(makePostRequest(validCreatePayload({ transport_from: "14:00", transport_to: "15:00" })));
    const patchRes = await PATCH(makePatchRequest({ season_notes: "x" }), { params: Promise.resolve({ id: "rule-1" }) });
    const deleteRes = await DELETE(makeDeleteRequest(), { params: Promise.resolve({ id: "rule-1" }) });
    for (const res of [getRes, postRes, patchRes, deleteRes]) {
      expect(res.status).toBeLessThan(300);
    }
  });
});

describe("ferry-pickup-rules API — validazione orari e overlap lato server (bypass client)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("POST con transport_from >= transport_to viene rifiutato con 400", async () => {
    const fake = createFakeSupabase([]);
    authorizeAs("admin", fake);
    const res = await POST(makePostRequest(validCreatePayload({ transport_from: "14:00", transport_to: "10:00" })));
    expect(res.status).toBe(400);
    expect(fake.calls.insert).toBe(0);
  });

  it("POST con overlap reale contro una regola esistente viene rifiutato con 409 e messaggio descrittivo", async () => {
    const existing = baseRule({ id: "rule-existing", transport_from: "08:35", transport_to: "10:00", company: "caremar" });
    const fake = createFakeSupabase([existing]);
    authorizeAs("admin", fake);
    const res = await POST(makePostRequest(validCreatePayload({ transport_from: "09:00", transport_to: "09:30" })));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("CAREMAR");
    expect(fake.calls.insert).toBe(0);
  });

  it("PATCH che sposta una regola su una fascia già occupata da un'altra viene rifiutato con 409, escludendo se stessa", async () => {
    const target = baseRule({ id: "rule-1", transport_from: "08:05", transport_to: "08:30" });
    const other = baseRule({ id: "rule-2", transport_from: "10:05", transport_to: "10:45" });
    const fake = createFakeSupabase([target, other]);
    authorizeAs("admin", fake);
    const res = await PATCH(makePatchRequest({ transport_from: "10:10", transport_to: "10:40" }), { params: Promise.resolve({ id: "rule-1" }) });
    expect(res.status).toBe(409);
  });

  it("PATCH senza cambi di finestra (stessa regola) non confligge con se stessa", async () => {
    const target = baseRule({ id: "rule-1" });
    const fake = createFakeSupabase([target]);
    authorizeAs("admin", fake);
    const res = await PATCH(makePatchRequest({ season_notes: "nota" }), { params: Promise.resolve({ id: "rule-1" }) });
    expect(res.status).toBe(200);
  });
});

describe("ferry-pickup-rules API — audit (OBIETTIVO 4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("22. CREATE riuscito produce un evento ferry_pickup_rule_created con id, utente e ruolo", async () => {
    const fake = createFakeSupabase([]);
    authorizeAs("operator", fake);
    await POST(makePostRequest(validCreatePayload()));

    const [event] = eventsNamed("ferry_pickup_rule_created");
    expect(event).toBeDefined();
    expect(event.tenantId).toBe(TENANT_A);
    expect(event.userId).toBe("user-1");
    expect(event.role).toBe("operator");
    expect(event.details.ruleId).toBeDefined();
    expect(event.details.previous).toBeNull();
  });

  it("23. UPDATE riuscito produce un evento ferry_pickup_rule_updated con snapshot prima/dopo", async () => {
    const existing = baseRule({ id: "rule-1", season_notes: "vecchia" });
    const fake = createFakeSupabase([existing]);
    authorizeAs("admin", fake);
    await PATCH(makePatchRequest({ season_notes: "nuova" }), { params: Promise.resolve({ id: "rule-1" }) });

    const [event] = eventsNamed("ferry_pickup_rule_updated");
    expect(event).toBeDefined();
    expect(event.details.ruleId).toBe("rule-1");
    expect(event.details.previous.season_notes).toBe("vecchia");
    expect(event.details.next.season_notes).toBe("nuova");
  });

  it("24. DELETE riuscito produce un evento ferry_pickup_rule_deleted con lo snapshot della regola eliminata", async () => {
    const existing = baseRule({ id: "rule-1", company: "medmar" });
    const fake = createFakeSupabase([existing]);
    authorizeAs("admin", fake);
    await DELETE(makeDeleteRequest(), { params: Promise.resolve({ id: "rule-1" }) });

    const [event] = eventsNamed("ferry_pickup_rule_deleted");
    expect(event).toBeDefined();
    expect(event.details.ruleId).toBe("rule-1");
    expect(event.details.previous.company).toBe("medmar");
    expect(event.details.next).toBeNull();
  });

  it("un CREATE bloccato da overlap NON produce un evento di successo", async () => {
    const existing = baseRule({ id: "rule-existing" });
    const fake = createFakeSupabase([existing]);
    authorizeAs("admin", fake);
    await POST(makePostRequest(validCreatePayload({ transport_from: "08:10", transport_to: "08:25" })));
    expect(eventsNamed("ferry_pickup_rule_created")).toHaveLength(0);
  });
});
