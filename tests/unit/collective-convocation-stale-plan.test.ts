import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({ authorize: vi.fn(), load: vi.fn(), assign: vi.fn(), registry: vi.fn() }));
vi.mock("@/lib/server/pricing-auth", () => ({ authorizePricingRequest: mocks.authorize }));
vi.mock("@/lib/server/collective-convocations", () => ({ loadCollectiveConvocations: mocks.load }));
vi.mock("@/lib/server/assign-service-core", () => ({ assignServiceCore: mocks.assign }));
vi.mock("@/lib/server/driver-registry", () => ({ listDriverRegistry: mocks.registry }));
vi.mock("@/lib/server/ops-audit", () => ({ auditLog: vi.fn() }));
import { POST } from "@/app/api/ops/piano-giorno/assignment-plan/confirm-all/route";
const request = () => new NextRequest("https://example.test/api", { method: "POST", body: JSON.stringify({ date: "2026-10-18" }) });
beforeEach(() => {
  vi.clearAllMocks();
  const query: Record<string, unknown> = {};
  for (const key of ["select", "eq"]) query[key] = vi.fn(() => query);
  query.maybeSingle = vi.fn(async () => ({ data: { id: "plan", generated_at: "2026-11-21T12:00:00Z" }, error: null }));
  mocks.authorize.mockResolvedValue({ admin: { from: vi.fn(() => query) }, membership: { tenant_id: "tenant-a" } });
});
it.each([true, false])("rejects a stale plan after TUTTI changed (active=%s)", async (active) => {
  mocks.load.mockResolvedValue([{ active, updated_at: "2026-11-21T12:01:00+00:00" }]);
  expect((await POST(request())).status).toBe(409);
  expect(mocks.assign).not.toHaveBeenCalled();
  expect(mocks.registry).not.toHaveBeenCalled();
});
it("fails closed if the collective settings cannot be verified", async () => {
  mocks.load.mockRejectedValue(new Error("unavailable"));
  expect((await POST(request())).status).toBe(503);
  expect(mocks.assign).not.toHaveBeenCalled();
});
