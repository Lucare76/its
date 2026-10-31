import { beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { closeInactiveWhatsAppThreads } from "@/lib/server/whatsapp/auto-close";

const NOW = new Date("2026-10-31T12:00:00Z");
const OLD = "2026-10-30T11:59:59Z";
const EXACT = "2026-10-30T12:00:00Z";
type Row = Record<string, unknown>;
function thread(id = "001", extra: Row = {}): Row {
  return { id, tenant_id: "tenant-a", status: "open", match_status: "matched", unread_count: 0, last_message_at: OLD, updated_at: OLD, ...extra };
}
function message(id = "001", extra: Row = {}): Row {
  return { thread_id: id, tenant_id: "tenant-a", direction: "outbound", status: "sent", timestamp: OLD, created_at: OLD, raw_message: {}, ...extra };
}

// Exercise the actual Supabase query serialization and conditional PATCH with
// a stateful HTTP fixture, including an inbound arriving between read and write.
function fixture(threads = [thread()], messages = [message()], options: { race?: (row: Row) => void; fail?: string } = {}) {
  const requests: Array<{ method: string; url: URL }> = [];
  const matches = (row: Row, url: URL) => [...url.searchParams.entries()].every(([key, filter]) => {
    if (["select", "order", "limit"].includes(key)) return true;
    const dot = filter.indexOf(".");
    const op = filter.slice(0, dot), value = filter.slice(dot + 1);
    if (op === "not") return value === "is.null" && row[key] != null;
    if (op === "eq") return String(row[key]) === value;
    if (op === "lt") return row[key] != null && Date.parse(String(row[key])) < Date.parse(value);
    if (op === "gt") return String(row[key]) > value;
    throw new Error(`Unexpected filter ${filter}`);
  });
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    requests.push({ method, url });
    const table = url.pathname.split("/").at(-1)!;
    if (table === options.fail) return new Response(JSON.stringify({ message: "database private diagnostic" }), { status: 500 });
    if (method === "PATCH") {
      const row = threads.find(r => r.id === url.searchParams.get("id")?.slice(3));
      if (row && options.race) options.race(row);
      const changed = threads.filter(r => matches(r, url));
      changed.forEach(r => Object.assign(r, JSON.parse(String(init?.body))));
      return Response.json(changed.map(r => ({ id: r.id })));
    }
    const source = table === "whatsapp_threads" ? threads : messages;
    const rows = source.filter(r => matches(r, url)).sort((a, b) => table === "whatsapp_threads"
      ? String(a.id).localeCompare(String(b.id))
      : String(b.timestamp).localeCompare(String(a.timestamp)));
    return Response.json(rows.slice(0, Number(url.searchParams.get("limit") ?? 1000)));
  };
  const admin = createClient("https://fixture.supabase.co", "unit-test-key", { global: { fetch: fetcher }, auth: { persistSession: false, autoRefreshToken: false } });
  return { admin, threads, requests };
}

describe("WhatsApp inactivity closure", () => {
  it("closes after 24 hours, keeps history, and is idempotent", async () => {
    const f = fixture();
    expect(await closeInactiveWhatsAppThreads(f.admin, NOW)).toMatchObject({ scanned: 1, closed: 1 });
    expect(f.threads[0].status).toBe("closed");
    expect(await closeInactiveWhatsAppThreads(f.admin, NOW)).toMatchObject({ scanned: 0, closed: 0 });
    expect(f.requests.every(r => r.method !== "DELETE")).toBe(true);
  });
  it.each([
    { last_message_at: EXACT },
    { last_message_at: "2026-10-31T11:00:00Z" },
    { unread_count: 1 }, { status: "needs_review" },
    { match_status: "needs_review" }, { match_status: "ambiguous" },
    { match_status: "unmatched" }, { status: "closed" },
    { updated_at: "2026-10-31T11:00:00Z" }, { tenant_id: null },
  ])("preserves recent, unread, review, reopened or unowned chat: %j", async extra => {
    const f = fixture([thread("001", extra)]);
    expect((await closeInactiveWhatsAppThreads(f.admin, NOW)).closed).toBe(0);
  });
  it.each([
    { direction: "inbound" }, { status: "failed" }, { status: "queued" },
    { timestamp: null }, { raw_message: { source: "office_closed_auto_reply" } },
  ])("does not hide unanswered inbound, failures or automatic replies: %j", async extra => {
    const f = fixture([thread()], [message("001", extra)]);
    expect((await closeInactiveWhatsAppThreads(f.admin, NOW)).closed).toBe(0);
  });
  it("does not close a thread with missing, inconsistent or tied message history", async () => {
    for (const messages of [[], [message("001", { timestamp: "2026-10-29T12:00:00Z" })], [message(), message("001", { direction: "inbound" })]]) {
      const f = fixture([thread()], messages);
      expect((await closeInactiveWhatsAppThreads(f.admin, NOW)).closed).toBe(0);
    }
  });
  it.each([
    { unread_count: 1 }, { status: "needs_review" },
    { last_message_at: NOW.toISOString() }, { updated_at: NOW.toISOString() },
    { match_status: "needs_review" },
  ])("a concurrent response or operator action wins over auto-close: %j", async change => {
    const f = fixture([thread()], [message()], { race: r => Object.assign(r, change) });
    expect((await closeInactiveWhatsAppThreads(f.admin, NOW)).closed).toBe(0);
    expect(f.threads[0].status).not.toBe("closed");
  });
  it("uses the exact tenant when reading messages and updating a thread", async () => {
    const f = fixture([thread()], [message("001", { tenant_id: "tenant-b" })]);
    expect((await closeInactiveWhatsAppThreads(f.admin, NOW)).closed).toBe(0);
    const good = fixture([thread("001", { tenant_id: "tenant-b" })], [message("001", { tenant_id: "tenant-b" })]);
    expect((await closeInactiveWhatsAppThreads(good.admin, NOW)).closed).toBe(1);
    expect(good.requests.find(r => r.method === "PATCH")?.url.searchParams.get("tenant_id")).toBe("eq.tenant-b");
  });
  it("paginates beyond the first hundred while mutations shrink the open list", async () => {
    const ids = Array.from({ length: 105 }, (_, i) => String(i).padStart(3, "0"));
    const f = fixture(ids.map(id => thread(id)), ids.map(id => message(id)));
    expect(await closeInactiveWhatsAppThreads(f.admin, NOW)).toMatchObject({ scanned: 105, closed: 105 });
  });
  it.each(["whatsapp_threads", "whatsapp_messages"])("propagates %s database failures for cron monitoring", async fail => {
    const f = fixture([thread()], [message()], { fail });
    await expect(closeInactiveWhatsAppThreads(f.admin, NOW)).rejects.toBeDefined();
  });
});

const m = vi.hoisted(() => ({ admin: vi.fn(), close: vi.fn(), start: vi.fn(), complete: vi.fn() }));
vi.mock("@/lib/server/whatsapp", () => ({ createAdminClient: m.admin }));
vi.mock("@/lib/server/job-health", () => ({ startJobRun: m.start, completeJobRun: m.complete }));
import { GET } from "@/app/api/cron/whatsapp-auto-close/route";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CRON_SECRET", "test-cron-secret");
  m.start.mockResolvedValue("job-1");
  m.complete.mockResolvedValue(undefined);
});
describe("Auto-close scheduler authentication", () => {
  it.each([undefined, "Bearer wrong"])("rejects missing/wrong auth without database access", async auth => {
    const r = await GET(new NextRequest("https://example.test/api/cron/whatsapp-auto-close", { headers: auth ? { authorization: auth } : {} }));
    expect(r.status).toBe(401);
    expect(m.admin).not.toHaveBeenCalled();
  });
  it("fails closed when the cron secret is missing", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await GET(new NextRequest("https://example.test/api/cron/whatsapp-auto-close", { headers: { authorization: "Bearer " } }))).status).toBe(401);
  });
  it("runs the database closure and records results without sending WhatsApp or email", async () => {
    const f = fixture();
    m.admin.mockReturnValue(f.admin);
    const r = await GET(new NextRequest("https://example.test/api/cron/whatsapp-auto-close", { headers: { authorization: "Bearer test-cron-secret" } }));
    // Real wall clock might differ from the deterministic function tests.
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true });
    expect(m.complete).toHaveBeenCalledWith(expect.objectContaining({ runId: "job-1", status: "success" }));
  });
  it("reports errors without exposing raw database diagnostics", async () => {
    m.admin.mockReturnValue(fixture([thread()], [message()], { fail: "whatsapp_threads" }).admin);
    const r = await GET(new NextRequest("https://example.test/api/cron/whatsapp-auto-close", { headers: { authorization: "Bearer test-cron-secret" } }));
    expect(r.status).toBe(500);
    expect(JSON.stringify(await r.json())).not.toContain("private diagnostic");
    expect(m.complete).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
  });
});
