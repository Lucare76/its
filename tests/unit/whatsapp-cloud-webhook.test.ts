import { createHmac } from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  processWhatsAppWebhook: vi.fn(),
  insert: vi.fn()
}));

vi.mock("@/lib/server/whatsapp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/whatsapp")>();
  return {
    ...actual,
    createAdminClient: mocks.createAdminClient
  };
});

vi.mock("@/lib/server/whatsapp/webhook-processing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/whatsapp/webhook-processing")>();
  return {
    ...actual,
    processWhatsAppWebhook: mocks.processWhatsAppWebhook
  };
});

import { GET, POST } from "@/app/api/whatsapp/webhook/route";

function signedRequest(payload: unknown, secret = "app-secret") {
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  return new NextRequest("http://localhost:3010/api/whatsapp/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Hub-Signature-256": signature
    },
    body
  });
}

function makeAdmin(insertResult: unknown = { data: { id: "event-1" }, error: null }) {
  const single = vi.fn().mockResolvedValue(insertResult);
  const select = vi.fn(() => ({ single }));
  mocks.insert.mockReturnValue({ select });
  return {
    from: vi.fn((table: string) => {
      if (table === "whatsapp_webhook_events") {
        return { insert: mocks.insert };
      }
      return {};
    })
  };
}

describe("GET /api/whatsapp/webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.WHATSAPP_VERIFY_TOKEN = "verify-ok";
  });

  it("returns the Meta challenge as text when the verify token matches", async () => {
    const response = await GET(new NextRequest("http://localhost:3010/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=verify-ok&hub.challenge=abc123"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe("abc123");
  });

  it("returns 403 when the verify token is wrong", async () => {
    const response = await GET(new NextRequest("http://localhost:3010/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc123"));
    expect(response.status).toBe(403);
  });
});

describe("POST /api/whatsapp/webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.WHATSAPP_APP_SECRET = "app-secret";
    mocks.createAdminClient.mockReturnValue(makeAdmin());
    mocks.processWhatsAppWebhook.mockResolvedValue({ messages: 1, statuses: 0, contacts: 1, errors: [] });
  });

  it("returns 401 when the signature is missing", async () => {
    const response = await POST(new NextRequest("http://localhost:3010/api/whatsapp/webhook", {
      method: "POST",
      body: JSON.stringify({ object: "whatsapp_business_account", entry: [] })
    }));
    expect(response.status).toBe(401);
  });

  it("returns 401 when the signature is invalid", async () => {
    const response = await POST(new NextRequest("http://localhost:3010/api/whatsapp/webhook", {
      method: "POST",
      headers: { "X-Hub-Signature-256": "sha256=bad" },
      body: JSON.stringify({ object: "whatsapp_business_account", entry: [] })
    }));
    expect(response.status).toBe(401);
  });

  it("archives a valid signed webhook and processes it", async () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [{ changes: [{ value: { messages: [{ id: "wamid.1", from: "393331234567", type: "text", text: { body: "Confermo" } }] } }] }]
    };

    const response = await POST(signedRequest(payload));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, messages: 1 });
    expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({
      event_type: "message",
      dedupe_key: "message:wamid.1",
      signature_valid: true
    }));
    expect(mocks.processWhatsAppWebhook).toHaveBeenCalledWith(expect.anything(), payload, "event-1");
  });

  it("returns 200 without reprocessing duplicate webhook events", async () => {
    mocks.createAdminClient.mockReturnValue(makeAdmin({ data: null, error: { code: "23505", message: "duplicate" } }));
    const response = await POST(signedRequest({
      object: "whatsapp_business_account",
      entry: [{ changes: [{ value: { statuses: [{ id: "wamid.1", status: "read", timestamp: "1770000000" }] } }] }]
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true, duplicate: true });
    expect(mocks.processWhatsAppWebhook).not.toHaveBeenCalled();
  });

  it("does not crash on unknown signed payloads", async () => {
    mocks.processWhatsAppWebhook.mockResolvedValueOnce({ messages: 0, statuses: 0, contacts: 0, errors: [] });
    const response = await POST(signedRequest({ object: "whatsapp_business_account", entry: [] }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, messages: 0, statuses: 0 });
  });
});

