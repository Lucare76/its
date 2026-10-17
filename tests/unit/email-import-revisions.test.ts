import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ flags: vi.fn(), parse: vi.fn(), extract: vi.fn(), fetch: vi.fn() }));
vi.mock("imapflow", () => ({ ImapFlow: class {
  connect = vi.fn(); logout = vi.fn();
  getMailboxLock = vi.fn(async () => ({ release: vi.fn() }));
  search = vi.fn(async () => [1]); fetchOne = mocks.fetch; messageFlagsAdd = mocks.flags;
} }));
vi.mock("mailparser", () => ({ simpleParser: mocks.parse }));
vi.mock("@/lib/server/claude-email-extract", () => ({ claudeEmailExtract: mocks.extract }));
vi.mock("@/lib/server/pdf-text", () => ({ isPdfAttachment: () => true, extractPdfTextFromBase64: async () => "PDF 26/014732" }));
vi.mock("@/lib/server/ai-usage-log", () => ({ logAiUsage: async () => null, updateAiUsageImportId: vi.fn() }));
import { runEmailOperationalImport } from "@/lib/server/email-test-import";

function setup(options: { sameMessage?: boolean; samePractice?: boolean; saveError?: boolean; lookupError?: boolean } = {}) {
  const inserted: Record<string, unknown>[] = [];
  const filters: unknown[][] = [];
  const admin = { from: vi.fn((table: string) => {
    let fingerprint = false;
    const q = {
      select: vi.fn(() => q), limit: vi.fn(() => q),
      eq: vi.fn((...args: unknown[]) => { filters.push(args); if (args[0] === "parsed_json->>message_fingerprint") fingerprint = true; return q; }),
      ilike: vi.fn(() => q),
      maybeSingle: vi.fn(async () => ({ data: table === "inbound_emails" && (fingerprint ? options.sameMessage : options.samePractice) ? { id: "original" } : null, error: options.lookupError ? { message: "DB unavailable" } : null })),
      insert: vi.fn((row: Record<string, unknown>) => { inserted.push(row); return q; }),
      single: vi.fn(async () => ({ data: options.saveError ? null : { id: "revision" }, error: options.saveError ? { message: "DB unavailable" } : null }))
    };
    return q;
  }) };
  return { inserted, filters, run: () => runEmailOperationalImport({ admin, user: {}, membership: { tenant_id: "tenant-a", role: "admin" } } as unknown as Parameters<typeof runEmailOperationalImport>[0]) };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("IMAP_HOST", "mail.test"); vi.stubEnv("IMAP_USER", "info@test.it"); vi.stubEnv("IMAP_PASS", "test"); vi.stubEnv("EMAIL_IMAP_MARK_SEEN", "true");
  mocks.fetch.mockResolvedValue({ source: Buffer.from("new message"), internalDate: new Date() });
  mocks.parse.mockResolvedValue({ from: { value: [{ address: "biglietteria@alesteviaggi.it" }] }, subject: "MODIFICA 26/014732", text: "Cambio date", attachments: [{ filename: "revision.pdf", contentType: "application/pdf", content: Buffer.from("pdf") }] });
  mocks.extract.mockResolvedValue({ agency: "Aleste", form: { numero_pratica: "26/014732", cliente_nome: "Guerriero Tiziana", data_arrivo: "2026-10-18" }, usage: { inputTokens: 1, outputTokens: 1 }, reviewWarnings: [] });
});
describe("IMAP booking revisions", () => {
  it("saves a new message for an existing practice for operator review", async () => {
    const t = setup({ samePractice: true });
    expect((await t.run()).draftsCreated).toBe(1);
    const email = t.inserted.find(r => r.parsed_json)!;
    expect(email.parsed_json).toMatchObject({ previous_inbound_email_id: "original", practice_revision: true, review_status: "needs_operator_review", duplicate_alert: true });
    expect((email.parsed_json as { review_warnings: string[] }).review_warnings[0]).toContain("26/014732");
    expect(t.filters).toContainEqual(["tenant_id", "tenant-a"]);
    expect(mocks.flags).toHaveBeenCalledWith(1, ["\\Seen"]);
  });
  it("skips only an identical message already acquired, before extraction", async () => {
    const t = setup({ sameMessage: true });
    expect((await t.run()).draftsCreated).toBe(0);
    expect(t.inserted).toHaveLength(0); expect(mocks.extract).not.toHaveBeenCalled();
  });
  it("continues to acquire new practices", async () => {
    const t = setup(); expect((await t.run()).draftsCreated).toBe(1);
    expect(t.inserted[0].parsed_json).toMatchObject({ practice_revision: false });
  });
  it("keeps the message unread when saving fails so it can be retried", async () => {
    const t = setup({ saveError: true }); await expect(t.run()).rejects.toThrow("Salvataggio email fallito");
    expect(mocks.flags).not.toHaveBeenCalled();
  });
  it("does not consume messages when the identity lookup fails", async () => {
    const t = setup({ lookupError: true }); await expect(t.run()).rejects.toThrow("Verifica email");
    expect(mocks.flags).not.toHaveBeenCalled();
  });
});
