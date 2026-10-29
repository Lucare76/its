import { describe, it, expect, vi, beforeEach } from "vitest";
const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@/lib/server/onboarding-email-transport", () => ({ sendOnboardingTransactionalEmail: mocks.send }));
vi.mock("@/lib/app-url", () => ({ getConfiguredAppUrl: () => "https://ischia-transfer.vercel.app" }));
import { notifyAccessRequestAdmins } from "@/lib/server/access-request-admin-notify";

function setup(failInsert = false) {
  const rows: Record<string, unknown>[] = []; const filters: unknown[] = [];
  const admin = { from(table: string) {
    const q = { select: () => q, order: () => q, limit: () => q,
      eq: (key: string, value: string) => { filters.push([table, key, value]); return q; }, in: () => q,
      insert: (values: Record<string, unknown>[]) => { rows.push(...values); return q; },
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: table === "tenants" ? [{ id: "tenant-a" }] : table === "memberships" ? [
        { user_id: "a", role: "admin", suspended: false }, { user_id: "b", role: "supervisor", suspended: null },
        { user_id: "c", role: "admin", suspended: true }, { user_id: "d", role: "agency", suspended: false },
      ] : null, error: table === "notifications" && failInsert ? { message: "insert failed" } : null }).then(resolve) };
    return q;
  }, auth: { admin: { getUserById: vi.fn(async (id: string) => ({ data: { user: { email: `${id}@example.com` } }, error: null })) } } };
  return { admin, rows, filters };
}
const input = { requestId: "request-1", fullName: '<img src=x onerror="bad">', email: "agency@example.com", agencyName: "TEST" };
describe("notifica nuove richieste agli amministratori", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.send.mockResolvedValue({ status: "sent", error: null }); });
  it("notifica admin e supervisor attivi, con tenant e link protetto", async () => {
    const f = setup(); const r = await notifyAccessRequestAdmins(f.admin as never, input);
    expect(r).toEqual({ in_app: 2, email_sent: 2, errors: [] });
    expect(f.rows.map(x => x.user_id)).toEqual(["a", "b"]);
    expect(f.rows.every(x => x.tenant_id === "tenant-a" && x.reference_id === "request-1" && x.link === "/settings/users")).toBe(true);
    expect(mocks.send.mock.calls.map(x => x[0].to)).toEqual(["a@example.com", "b@example.com"]);
    expect(mocks.send.mock.calls[0][0].html).toContain("&lt;img");
  });
  it("rispetta il tenant esplicito già verificato dal server", async () => {
    const f = setup(); await notifyAccessRequestAdmins(f.admin as never, { ...input, tenantId: "tenant-b" });
    expect(f.filters).toContainEqual(["memberships", "tenant_id", "tenant-b"]);
    expect(f.rows.every(x => x.tenant_id === "tenant-b")).toBe(true);
  });
  it("se la campanella fallisce tenta comunque l'email e riporta l'errore", async () => {
    const f = setup(true); const r = await notifyAccessRequestAdmins(f.admin as never, input);
    expect(r).toMatchObject({ in_app: 0, email_sent: 2, errors: ["insert failed"] });
  });
  it("un invio rifiutato non blocca gli altri amministratori", async () => {
    mocks.send.mockRejectedValueOnce(new Error("provider error"));
    const r = await notifyAccessRequestAdmins(setup().admin as never, input);
    expect(r).toMatchObject({ in_app: 2, email_sent: 1, errors: ["provider error"] });
  });
});
