import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendEmail } from "@/lib/server/send-email";

describe("sendEmail: inoltro allegati e destinatario di prova", () => {
  beforeEach(() => {
    vi.stubEnv("RESEND_API_KEY", "test-key");
    vi.stubEnv("EMAIL_TEST_REDIRECT", "");
    vi.stubEnv("NOTIFY_BCC_EMAIL", "");
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it("conserva l'allegato quando il redirect di prova sostituisce destinatari e copie", async () => {
    vi.stubEnv("EMAIL_TEST_REDIRECT", "luca_renna@hotmail.com");
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"id":"message-1"}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const attachments = [{ filename: "estratto.xlsx", content: "test-base64-content" }];
    expect(await sendEmail({
      to: "agency@example.com", cc: "cc@example.com", bcc: "bcc@example.com",
      subject: "TEST", html: "<p>Test</p>", attachments,
    })).toEqual({ ok: true });
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.to).toEqual(["luca_renna@hotmail.com"]);
    expect(payload.attachments).toEqual(attachments);
    expect(payload).not.toHaveProperty("cc");
    expect(payload).not.toHaveProperty("bcc");
  });

  it("le email senza allegati mantengono il payload precedente", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"id":"message-1"}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await sendEmail({ to: "luca_renna@hotmail.com", subject: "TEST", html: "<p>Test</p>" });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty("attachments");
  });
});
