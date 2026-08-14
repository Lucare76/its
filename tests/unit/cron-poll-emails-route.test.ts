import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * Sprint Performance 8 — GET /api/cron/poll-emails passa da pollEmailNow()
 * con force=false, così cron (Vercel Cron / cron-job.org) e refresh manuale
 * condividono lo stesso lock/cooldown. Copre auth CRON_SECRET, wiring verso
 * pollEmailNow con force=false, gestione skip/imported/error, e invio push
 * solo quando l'import ha prodotto nuovi draft.
 */

const mocks = vi.hoisted(() => ({
  pollEmailNow: vi.fn(),
  sendPushToTenantRoles: vi.fn(),
  maybeSingle: vi.fn(),
}));

vi.mock("@/lib/server/email-poll", () => ({
  pollEmailNow: mocks.pollEmailNow,
}));
vi.mock("@/lib/server/web-push", () => ({
  sendPushToTenantRoles: mocks.sendPushToTenantRoles,
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        limit: () => ({
          maybeSingle: mocks.maybeSingle,
        }),
      }),
    }),
  }),
}));

import { GET } from "@/app/api/cron/poll-emails/route";

function callGet() {
  return GET(
    new NextRequest("http://localhost:3010/api/cron/poll-emails", {
      headers: { authorization: "Bearer test-cron-secret" },
    })
  );
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = "test-cron-secret";
  process.env.INBOUND_DEFAULT_TENANT_ID = "tenant-1";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
  mocks.maybeSingle.mockResolvedValue({ data: null });
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("GET /api/cron/poll-emails — wiring pollEmailNow", () => {
  it("Authorization mancante/errata: 401, pollEmailNow non chiamato", async () => {
    const res = await GET(new NextRequest("http://localhost:3010/api/cron/poll-emails"));
    expect(res.status).toBe(401);
    expect(mocks.pollEmailNow).not.toHaveBeenCalled();
  });

  it("chiama pollEmailNow con force=false", async () => {
    mocks.pollEmailNow.mockResolvedValue({
      status: "imported",
      imported: 0,
      detail: { mailbox: "INBOX", unreadFound: 0, emailsProcessed: 0, pdfFound: 0, draftsCreated: 0, duplicateWarnings: 0, skippedNoPdf: 0 },
    });

    await callGet();

    expect(mocks.pollEmailNow).toHaveBeenCalledTimes(1);
    const [, options] = mocks.pollEmailNow.mock.calls[0];
    expect(options).toEqual({ force: false });
  });

  it("status skipped_in_progress: risponde ok, nessuna push inviata", async () => {
    mocks.pollEmailNow.mockResolvedValue({ status: "skipped_in_progress", imported: 0, last_success_at: null });

    const res = await callGet();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("skipped_in_progress");
    expect(mocks.sendPushToTenantRoles).not.toHaveBeenCalled();
  });

  it("import con nuovi draft: invia push agli admin/operator", async () => {
    mocks.pollEmailNow.mockResolvedValue({
      status: "imported",
      imported: 2,
      started_at: "2026-08-14T10:00:00.000Z",
      finished_at: "2026-08-14T10:00:05.000Z",
      last_success_at: "2026-08-14T10:00:05.000Z",
      detail: { mailbox: "INBOX", unreadFound: 2, emailsProcessed: 2, pdfFound: 2, draftsCreated: 2, duplicateWarnings: 0, skippedNoPdf: 0 },
    });

    const res = await callGet();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.draftsCreated).toBe(2);
    expect(mocks.sendPushToTenantRoles).toHaveBeenCalledTimes(1);
    expect(mocks.sendPushToTenantRoles).toHaveBeenCalledWith("tenant-1", ["admin", "operator"], expect.any(Object));
  });

  it("import senza nuovi draft: nessuna push inviata", async () => {
    mocks.pollEmailNow.mockResolvedValue({
      status: "imported",
      imported: 0,
      detail: { mailbox: "INBOX", unreadFound: 0, emailsProcessed: 0, pdfFound: 0, draftsCreated: 0, duplicateWarnings: 0, skippedNoPdf: 0 },
    });

    await callGet();

    expect(mocks.sendPushToTenantRoles).not.toHaveBeenCalled();
  });

  it("status error con imap_not_configured: risponde 200 con flag dedicato", async () => {
    mocks.pollEmailNow.mockResolvedValue({ status: "error", imported: 0, error: "Missing IMAP_HOST/IMAP_USER/IMAP_PASS env vars", imap_not_configured: true });

    const res = await callGet();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.imap_not_configured).toBe(true);
  });

  it("status error IMAP non raggiungibile: risponde 200 (non critico)", async () => {
    mocks.pollEmailNow.mockResolvedValue({ status: "error", imported: 0, error: "IMAP connection ECONNREFUSED" });

    const res = await callGet();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(false);
  });

  it("status error generico: risponde 500", async () => {
    mocks.pollEmailNow.mockResolvedValue({ status: "error", imported: 0, error: "Boom inaspettato" });

    const res = await callGet();

    expect(res.status).toBe(500);
  });
});
