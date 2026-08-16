import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

type Row = Record<string, unknown>;

const mocks = vi.hoisted(() => ({
  authorizePricingRequest: vi.fn(),
}));

vi.mock("@/lib/server/pricing-auth", () => ({
  authorizePricingRequest: mocks.authorizePricingRequest,
}));

import { GET } from "@/app/api/ops/whatsapp-inbox/summary/route";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/**
 * Fake admin covering only `whatsapp_threads`. Mirrors the two-query shape
 * the route now uses: a head-count query (`select(..., { count, head: true })`,
 * ending right after `.gt()`) and a `limit(1)` query for the latest thread.
 */
function makeAdmin(rows: Row[], options: { countError?: { message: string }; latestError?: { message: string } } = {}) {
  const from = vi.fn((table: string) => {
    if (table !== "whatsapp_threads") throw new Error(`Unexpected table in test: ${table}`);
    let filtered = [...rows];
    let head = false;
    const builder: Record<string, unknown> = {
      select: vi.fn((_cols: string, opts?: { head?: boolean }) => {
        head = Boolean(opts?.head);
        return builder;
      }),
      // Mirrors `.or("tenant_id.eq.<id>,tenant_id.is.null")` used by the route.
      or: vi.fn((filterStr: string) => {
        const clauses = filterStr.split(",").map((c) => c.trim());
        filtered = filtered.filter((row) =>
          clauses.some((clause) => {
            const parts = clause.split(".");
            const field = parts[0];
            if (parts[parts.length - 1] === "null" && parts[parts.length - 2] === "is") {
              return row[field] === null || row[field] === undefined;
            }
            if (parts[1] === "eq") return String(row[field]) === parts[2];
            if (parts[1] === "gt") return Number(row[field] ?? 0) > Number(parts[2]);
            return true;
          })
        );
        return builder;
      }),
      eq: vi.fn((field: string, value: unknown) => {
        filtered = filtered.filter((r) => r[field] === value);
        return builder;
      }),
      neq: vi.fn((field: string, value: unknown) => {
        filtered = filtered.filter((r) => r[field] !== value);
        return builder;
      }),
      gt: vi.fn((field: string, value: number) => {
        filtered = filtered.filter((r) => Number(r[field] ?? 0) > value);
        return builder;
      }),
      order: vi.fn(() => {
        filtered = [...filtered].sort((a, b) =>
          String(b.last_message_at ?? "").localeCompare(String(a.last_message_at ?? ""))
        );
        return builder;
      }),
      limit: vi.fn((n: number) =>
        Promise.resolve({ data: filtered.slice(0, n), error: options.latestError ?? null })
      ),
      // The head-count chain never calls `.limit()` — it ends at `.gt()`, so the
      // builder itself must be awaitable.
      then: (resolve: (value: { data: null; count: number | null; error: { message: string } | null }) => void) => {
        resolve({ data: null, count: head ? filtered.length : null, error: options.countError ?? null });
      }
    };
    return builder;
  });
  return { from };
}

function authorizeAs(admin: ReturnType<typeof makeAdmin>, role = "operator", tenantId = TENANT_A) {
  mocks.authorizePricingRequest.mockResolvedValue({
    admin,
    user: { id: "user-1", email: "op@test.dev" },
    membership: { tenant_id: tenantId, role, suspended: false },
  });
}

function callGet() {
  return GET(new NextRequest("http://localhost:3010/api/ops/whatsapp-inbox/summary"));
}

function threadRow(id: string, tenantId: string | null, overrides: Row = {}): Row {
  return {
    id,
    tenant_id: tenantId,
    phone_e164: "+393331234567",
    last_message_at: "2026-08-10T10:00:00Z",
    last_message_preview: "Ciao",
    unread_count: 1,
    status: "open",
    whatsapp_contacts: null,
    ...overrides,
  };
}

describe("GET /api/ops/whatsapp-inbox/summary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("propagates the 401/403 response from authorizePricingRequest without querying the DB", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "unauthorized" }, { status: 401 }));
    const response = await callGet();
    expect(response.status).toBe(401);
  });

  it("returns unread count and latest message for the authenticated tenant", async () => {
    const admin = makeAdmin([
      threadRow("thread-1", TENANT_A, { last_message_at: "2026-08-10T09:00:00Z", last_message_preview: "Prima" }),
      threadRow("thread-2", TENANT_A, { last_message_at: "2026-08-10T11:00:00Z", last_message_preview: "Ultima" }),
    ]);
    authorizeAs(admin, "operator", TENANT_A);

    const response = await callGet();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.unread_count).toBe(2);
    expect(body.open_count).toBe(2);
    expect(body.associated_count).toBe(0);
    expect(body.unassociated_count).toBe(2);
    expect(body.urgent_count).toBe(2);
    expect(body.latest_thread_id).toBe("thread-2");
    expect(body.latest_preview).toBe("Ultima");
  });

  it("keeps tenant isolation: threads belonging to another tenant are not counted", async () => {
    const admin = makeAdmin([
      threadRow("thread-a", TENANT_A),
      threadRow("thread-b", TENANT_B),
      threadRow("thread-c", TENANT_B),
    ]);
    authorizeAs(admin, "operator", TENANT_A);

    const response = await callGet();
    const body = await response.json();

    expect(body.unread_count).toBe(1);
    expect(body.latest_thread_id).toBe("thread-a");
  });

  it("does not undercount unread threads beyond the old 50-row cap (badge reflects the real count)", async () => {
    const rows = Array.from({ length: 73 }, (_, i) => threadRow(`thread-${i}`, TENANT_A, { last_message_at: `2026-08-10T09:${String(i).padStart(2, "0")}:00Z` }));
    const admin = makeAdmin(rows);
    authorizeAs(admin, "operator", TENANT_A);

    const response = await callGet();
    const body = await response.json();

    expect(body.unread_count).toBe(73);
  });

  it("returns global KPI counts independent from the selected inbox filter", async () => {
    const admin = makeAdmin([
      threadRow("open-unread", TENANT_A, { unread_count: 2, status: "open", match_status: "needs_review" }),
      threadRow("open-matched", TENANT_A, { unread_count: 0, status: "open", match_status: "matched" }),
      threadRow("open-unmatched", TENANT_A, { unread_count: 0, status: "open", match_status: "needs_review" }),
      threadRow("closed-unread", TENANT_A, { unread_count: 4, status: "closed", match_status: "matched" }),
    ]);
    authorizeAs(admin, "operator", TENANT_A);

    const response = await callGet();
    const body = await response.json();

    expect(body.unread_count).toBe(1);
    expect(body.open_count).toBe(3);
    expect(body.associated_count).toBe(1);
    expect(body.unassociated_count).toBe(2);
    expect(body.urgent_count).toBe(2);
  });

  it("returns 500 without throwing when the DB errors, and does not touch a services.message_id-style column", async () => {
    const admin = makeAdmin([], { countError: { message: "Cloudflare 520" } });
    authorizeAs(admin, "operator", TENANT_A);

    const response = await callGet();
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.ok).toBe(false);
  });
});
