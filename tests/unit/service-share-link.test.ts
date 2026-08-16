import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

/**
 * HARDENING SPRINT 1 — FASE 8. Share Link (`share_token`/`share_expires_at`)
 * now exist on the real DB (migration 0011 applied). Covers: token
 * generation, valid lookup, missing token, expired token, revoke,
 * regeneration (token uniqueness at the application layer — the DB-level
 * UNIQUE constraint itself isn't unit-testable without a live DB), and the
 * error-mapping split added this sprint (DB/schema error -> 500 + server
 * log, not-found -> 404, invalid payload -> 400), with no token/PII ever
 * logged.
 */

type Row = Record<string, unknown>;

function createFakeServicesAdmin(rows: Row[]) {
  let forcedError: { message: string } | null = null;

  function makeBuilder(op: "select" | "update", updatePayload?: Row) {
    let filtered = rows;
    const builder = {
      eq(field: string, value: unknown) {
        filtered = filtered.filter((r) => r[field] === value);
        return builder;
      },
      select(_cols?: string) {
        if (op === "update" && updatePayload && !forcedError) {
          for (const row of filtered) Object.assign(row, updatePayload);
        }
        return builder;
      },
      maybeSingle() {
        if (forcedError) return Promise.resolve({ data: null, error: forcedError });
        return Promise.resolve({ data: filtered[0] ? { ...filtered[0] } : null, error: null });
      },
      then(resolve: (v: { data: null; error: { message: string } | null }) => unknown, reject?: (e: unknown) => unknown) {
        if (forcedError) return Promise.resolve({ data: null, error: forcedError }).then(resolve, reject);
        if (op === "update" && updatePayload) {
          for (const row of filtered) Object.assign(row, updatePayload);
        }
        return Promise.resolve({ data: null, error: null }).then(resolve, reject);
      }
    };
    return builder;
  }

  return {
    admin: {
      from(_table: string) {
        return {
          select(_cols?: string) {
            return makeBuilder("select");
          },
          update(payload: Row) {
            return makeBuilder("update", payload);
          }
        };
      }
    },
    setError(err: { message: string } | null) {
      forcedError = err;
    },
    rows
  };
}

const mocks = vi.hoisted(() => ({
  authorizeServiceRoleRequest: vi.fn(),
  createClient: vi.fn()
}));

vi.mock("@/lib/server/pricing-auth", () => ({
  authorizeServiceRoleRequest: mocks.authorizeServiceRoleRequest
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: mocks.createClient
}));

import { POST, DELETE } from "@/app/api/services/share-link/route";
import { getSharedServiceByToken } from "@/lib/server/service-share";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SERVICE_1 = "51111111-1111-4111-8111-111111111111";

function serviceRow(overrides: Row = {}): Row {
  return {
    id: SERVICE_1,
    tenant_id: TENANT_A,
    date: "2026-08-20",
    time: "10:00:00",
    customer_name: "Mario Rossi",
    pax: 2,
    vessel: "Alilauro",
    meeting_point: "Porto",
    share_token: null,
    share_expires_at: null,
    hotels: { name: "Hotel Test", zone: "Ischia Porto" },
    ...overrides
  };
}

function authorizeAs(admin: unknown, tenantId = TENANT_A) {
  mocks.authorizeServiceRoleRequest.mockResolvedValue({
    admin,
    user: { id: "op-1", email: "op@test.dev" },
    membership: { tenant_id: tenantId, role: "operator", suspended: false }
  });
}

function postReq(body: Record<string, unknown>) {
  return new NextRequest("https://example.test/api/services/share-link", {
    method: "POST",
    headers: { "Content-Type": "application/json", authorization: "Bearer token" },
    body: JSON.stringify(body)
  });
}

function deleteReq(body: Record<string, unknown>) {
  return new NextRequest("https://example.test/api/services/share-link", {
    method: "DELETE",
    headers: { "Content-Type": "application/json", authorization: "Bearer token" },
    body: JSON.stringify(body)
  });
}

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mocks.authorizeServiceRoleRequest.mockReset();
  mocks.createClient.mockReset();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
});

describe("POST /api/services/share-link — generazione token", () => {
  it("1. genera un token esadecimale e un share_url, con scadenza di default 7 giorni", async () => {
    const fake = createFakeServicesAdmin([serviceRow()]);
    authorizeAs(fake.admin);

    const res = await POST(postReq({ service_id: SERVICE_1 }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.share_token).toMatch(/^[0-9a-f]{48}$/);
    expect(body.share_url).toContain(`/share/service/${body.share_token}`);

    const expiresMs = new Date(body.share_expires_at).getTime() - Date.now();
    expect(expiresMs).toBeGreaterThan(6.9 * 24 * 60 * 60 * 1000);
    expect(expiresMs).toBeLessThan(7.1 * 24 * 60 * 60 * 1000);
  });

  it("6. rigenerazione: una seconda POST sovrascrive il token con uno diverso (unicità applicativa)", async () => {
    const fake = createFakeServicesAdmin([serviceRow()]);
    authorizeAs(fake.admin);

    const res1 = await POST(postReq({ service_id: SERVICE_1 }));
    const token1 = (await res1.json()).share_token;

    const res2 = await POST(postReq({ service_id: SERVICE_1 }));
    const token2 = (await res2.json()).share_token;

    expect(token1).not.toBe(token2);
    expect(fake.rows[0].share_token).toBe(token2);
  });

  it("tenant isolation: un service di un altro tenant restituisce 404, non lo modifica", async () => {
    const fake = createFakeServicesAdmin([serviceRow({ tenant_id: TENANT_B })]);
    authorizeAs(fake.admin, TENANT_A);

    const res = await POST(postReq({ service_id: SERVICE_1 }));
    expect(res.status).toBe(404);
    expect(fake.rows[0].share_token).toBeNull();
  });

  it("input invalido (service_id non-UUID) -> 400", async () => {
    const fake = createFakeServicesAdmin([serviceRow()]);
    authorizeAs(fake.admin);

    const res = await POST(postReq({ service_id: "not-a-uuid" }));
    expect(res.status).toBe(400);
  });

  it("auth non valida -> passthrough della risposta di authorizeServiceRoleRequest", async () => {
    mocks.authorizeServiceRoleRequest.mockResolvedValue(NextResponse.json({ error: "unauthorized" }, { status: 401 }));
    const res = await POST(postReq({ service_id: SERVICE_1 }));
    expect(res.status).toBe(401);
  });

  it("errore DB/schema -> 500 con messaggio generico, loggato server-side senza token/PII", async () => {
    const fake = createFakeServicesAdmin([serviceRow()]);
    fake.setError({ message: 'column "share_token" does not exist' });
    authorizeAs(fake.admin);

    const res = await POST(postReq({ service_id: SERVICE_1 }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Errore interno");
    expect(body.error).not.toMatch(/share_token|column|does not exist/);
    expect(consoleErrorSpy).toHaveBeenCalled();
    const loggedArgs = JSON.stringify(consoleErrorSpy.mock.calls);
    expect(loggedArgs).toMatch(/does not exist/);
    expect(loggedArgs).not.toContain("Mario Rossi");
  });
});

describe("DELETE /api/services/share-link — revoca", () => {
  it("5. revoca: azzera share_token e share_expires_at", async () => {
    const fake = createFakeServicesAdmin([serviceRow({ share_token: "abc123", share_expires_at: "2026-09-01T00:00:00.000Z" })]);
    authorizeAs(fake.admin);

    const res = await DELETE(deleteReq({ service_id: SERVICE_1 }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(fake.rows[0].share_token).toBeNull();
    expect(fake.rows[0].share_expires_at).toBeNull();
  });

  it("errore DB su revoca -> 500, loggato senza dati cliente", async () => {
    const fake = createFakeServicesAdmin([serviceRow()]);
    fake.setError({ message: "connection failed" });
    authorizeAs(fake.admin);

    const res = await DELETE(deleteReq({ service_id: SERVICE_1 }));
    expect(res.status).toBe(500);
    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(JSON.stringify(consoleErrorSpy.mock.calls)).not.toContain("Mario Rossi");
  });
});

describe("getSharedServiceByToken — lookup pubblico", () => {
  function mockLookupAdmin(rows: Row[]) {
    const fake = createFakeServicesAdmin(rows);
    mocks.createClient.mockReturnValue(fake.admin);
    return fake;
  }

  it("2/8. token valido: ritorna i dettagli del servizio (lookup pubblico)", async () => {
    mockLookupAdmin([
      serviceRow({ share_token: "a".repeat(48), share_expires_at: new Date(Date.now() + 86_400_000).toISOString() })
    ]);

    const result = await getSharedServiceByToken("a".repeat(48));
    expect(result).not.toBeNull();
    expect(result?.id).toBe(SERVICE_1);
    expect(result?.hotel_name).toBe("Hotel Test");
    expect(result?.hotel_zone).toBe("Ischia Porto");
  });

  it("3. token inesistente: ritorna null", async () => {
    mockLookupAdmin([serviceRow({ share_token: "a".repeat(48) })]);
    const result = await getSharedServiceByToken("b".repeat(48));
    expect(result).toBeNull();
  });

  it("4. token scaduto: ritorna null anche se il token esiste", async () => {
    mockLookupAdmin([
      serviceRow({ share_token: "a".repeat(48), share_expires_at: new Date(Date.now() - 86_400_000).toISOString() })
    ]);
    const result = await getSharedServiceByToken("a".repeat(48));
    expect(result).toBeNull();
  });

  it("token troppo corto: ritorna null senza interrogare il DB", async () => {
    const result = await getSharedServiceByToken("short");
    expect(result).toBeNull();
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it("errore DB/schema -> null, loggato server-side senza il token", async () => {
    const fake = mockLookupAdmin([serviceRow({ share_token: "a".repeat(48) })]);
    fake.setError({ message: 'column "share_token" does not exist' });

    const token = "a".repeat(48);
    const result = await getSharedServiceByToken(token);

    expect(result).toBeNull();
    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(JSON.stringify(consoleErrorSpy.mock.calls)).not.toContain(token);
  });

  it("lookup pubblico non espone altri servizi: solo la riga con il token esatto viene ritornata", async () => {
    mockLookupAdmin([
      serviceRow({ id: "other-service", tenant_id: TENANT_B, share_token: "b".repeat(48), customer_name: "Altro Cliente" }),
      serviceRow({ share_token: "a".repeat(48) })
    ]);
    const result = await getSharedServiceByToken("a".repeat(48));
    expect(result?.id).toBe(SERVICE_1);
    expect(result?.customer_name).not.toBe("Altro Cliente");
  });
});
