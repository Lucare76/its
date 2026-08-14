import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

/**
 * Sprint Performance 8 — POST /api/email/operational-import passa da
 * pollEmailNow() invece di chiamare direttamente runEmailOperationalImport.
 * Copre: force=1 propagato al querystring, mappatura status
 * imported/skipped_in_progress/skipped_recent/error verso la risposta JSON.
 */

const mocks = vi.hoisted(() => ({
  authorizePricingRequest: vi.fn(),
  pollEmailNow: vi.fn(),
}));

vi.mock("@/lib/server/pricing-auth", () => ({
  authorizePricingRequest: mocks.authorizePricingRequest,
}));
vi.mock("@/lib/server/email-poll", () => ({
  pollEmailNow: mocks.pollEmailNow,
}));

import { POST } from "@/app/api/email/operational-import/route";

const FAKE_AUTH = {
  admin: {} as unknown,
  user: { id: "u1", email: "op@test.dev" },
  membership: { tenant_id: "tenant-1", role: "operator", suspended: false },
};

function callPost(url = "http://localhost:3010/api/email/operational-import") {
  return POST(new NextRequest(url, { method: "POST" }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorizePricingRequest.mockResolvedValue(FAKE_AUTH);
});

describe("POST /api/email/operational-import — wiring pollEmailNow", () => {
  it("senza querystring force: chiama pollEmailNow con force=false", async () => {
    mocks.pollEmailNow.mockResolvedValue({ status: "imported", imported: 0, detail: { mailbox: "INBOX", unreadFound: 0, emailsProcessed: 0, pdfFound: 0, draftsCreated: 0, duplicateWarnings: 0, skippedNoPdf: 0 } });

    await callPost();

    expect(mocks.pollEmailNow).toHaveBeenCalledWith(FAKE_AUTH, { force: false });
  });

  it("con ?force=1: chiama pollEmailNow con force=true", async () => {
    mocks.pollEmailNow.mockResolvedValue({ status: "imported", imported: 0, detail: { mailbox: "INBOX", unreadFound: 0, emailsProcessed: 0, pdfFound: 0, draftsCreated: 0, duplicateWarnings: 0, skippedNoPdf: 0 } });

    await callPost("http://localhost:3010/api/email/operational-import?force=1");

    expect(mocks.pollEmailNow).toHaveBeenCalledWith(FAKE_AUTH, { force: true });
  });

  it("status imported: risponde ok con i dettagli dell'import", async () => {
    mocks.pollEmailNow.mockResolvedValue({
      status: "imported",
      imported: 3,
      started_at: "2026-08-14T10:00:00.000Z",
      finished_at: "2026-08-14T10:00:05.000Z",
      last_success_at: "2026-08-14T10:00:05.000Z",
      detail: { mailbox: "INBOX", unreadFound: 3, emailsProcessed: 3, pdfFound: 3, draftsCreated: 3, duplicateWarnings: 0, skippedNoPdf: 0 },
    });

    const res = await callPost();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.status).toBe("imported");
    expect(body.draftsCreated).toBe(3);
  });

  it("status skipped_in_progress: risponde ok senza aprire una nuova connessione", async () => {
    mocks.pollEmailNow.mockResolvedValue({ status: "skipped_in_progress", imported: 0, last_success_at: null });

    const res = await callPost("http://localhost:3010/api/email/operational-import?force=1");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.status).toBe("skipped_in_progress");
    expect(body.skipped).toBe(true);
    expect(body.draftsCreated).toBe(0);
  });

  it("status skipped_recent: risponde ok con skipped=true", async () => {
    mocks.pollEmailNow.mockResolvedValue({ status: "skipped_recent", imported: 0, last_success_at: "2026-08-14T09:59:30.000Z" });

    const res = await callPost();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("skipped_recent");
    expect(body.skipped).toBe(true);
  });

  it("status error con imap_not_configured: risponde 200 con flag dedicato", async () => {
    mocks.pollEmailNow.mockResolvedValue({ status: "error", imported: 0, error: "Missing IMAP_HOST/IMAP_USER/IMAP_PASS env vars", imap_not_configured: true });

    const res = await callPost();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.imap_not_configured).toBe(true);
  });

  it("status error generico: risponde 500", async () => {
    mocks.pollEmailNow.mockResolvedValue({ status: "error", imported: 0, error: "IMAP timeout" });

    const res = await callPost();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("IMAP timeout");
  });

  it("auth non autorizzato: non chiama pollEmailNow", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Sessione non valida." }, { status: 401 }));

    const res = await callPost();

    expect(res.status).toBe(401);
    expect(mocks.pollEmailNow).not.toHaveBeenCalled();
  });
});
