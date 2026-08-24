/**
 * Regression: NOTIFY_BCC_EMAIL può contenere più indirizzi (virgola/punto e
 * virgola/spazi, stesso formato di EMAIL_TEST_REDIRECT). Prima di questo fix
 * sendEmail() li passava a Resend come un'unica stringa non divisa
 * (["a@x.it,b@y.it"]), che Resend rifiuta con 422 "Invalid bcc field" non
 * appena contiene più di un indirizzo — scoperto testando dal vivo l'email
 * di notifica contestazione prezzo.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { sendEmail } from "@/lib/server/send-email";

const ORIGINAL_ENV = { ...process.env };

function mockFetchOk() {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => "",
    json: async () => ({ id: "resend-id" }),
  } as unknown as Response);
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env.RESEND_API_KEY = "test-key";
  delete process.env.EMAIL_TEST_REDIRECT;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe("sendEmail — NOTIFY_BCC_EMAIL con più indirizzi", () => {
  it("virgola: divide in array, nessun indirizzo unico con virgola dentro", async () => {
    process.env.NOTIFY_BCC_EMAIL = "ops1@test.it,ops2@test.it";
    const fetchSpy = mockFetchOk();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await sendEmail({ to: "cliente@test.it", subject: "Test", html: "<p>Test</p>" });

    expect(result.ok).toBe(true);
    const payload = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(payload.bcc).toEqual(["ops1@test.it", "ops2@test.it"]);
  });

  it("punto e virgola con spazi: divide correttamente e rimuove voci vuote", async () => {
    process.env.NOTIFY_BCC_EMAIL = " ops1@test.it ; ops2@test.it ";
    const fetchSpy = mockFetchOk();
    vi.stubGlobal("fetch", fetchSpy);

    await sendEmail({ to: "cliente@test.it", subject: "Test", html: "<p>Test</p>" });

    const payload = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(payload.bcc).toEqual(["ops1@test.it", "ops2@test.it"]);
  });

  it("singolo indirizzo: comportamento invariato", async () => {
    process.env.NOTIFY_BCC_EMAIL = "ops@test.it";
    const fetchSpy = mockFetchOk();
    vi.stubGlobal("fetch", fetchSpy);

    await sendEmail({ to: "cliente@test.it", subject: "Test", html: "<p>Test</p>" });

    const payload = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(payload.bcc).toEqual(["ops@test.it"]);
  });

  it("si somma al bcc esplicito passato a sendEmail", async () => {
    process.env.NOTIFY_BCC_EMAIL = "ops1@test.it,ops2@test.it";
    const fetchSpy = mockFetchOk();
    vi.stubGlobal("fetch", fetchSpy);

    await sendEmail({ to: "cliente@test.it", subject: "Test", html: "<p>Test</p>", bcc: "extra@test.it" });

    const payload = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(payload.bcc).toEqual(["ops1@test.it", "ops2@test.it", "extra@test.it"]);
  });
});
