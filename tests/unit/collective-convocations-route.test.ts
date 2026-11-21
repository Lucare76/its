import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
const mocks = vi.hoisted(() => ({ authorize: vi.fn(), load: vi.fn() }));
vi.mock("@/lib/server/pricing-auth", () => ({ authorizePricingRequest: mocks.authorize }));
vi.mock("@/lib/server/collective-convocations", () => ({ loadCollectiveConvocations: mocks.load }));
import { GET, POST } from "@/app/api/ops/piano-giorno/collective-convocations/route";
import { buildArrivalConvocations } from "@/lib/piano-arrival-convocations";

const service = { id: "s1", direction: "arrival", status: "new", time: "15:40", pax: 2,
  vessel: "MEDMAR", meeting_point: "Ischia Porto", origin_place_type: "port", origin_place_id: "port-1", hotel_id: "h1" };
const payload = { date: "2026-10-18", event_key: buildArrivalConvocations([service], new Map())[0].id,
  active: true, last_departure: "16:30", margin_min: 25, margin_max: 35 };
let from: ReturnType<typeof vi.fn>;
let query: Record<string, ReturnType<typeof vi.fn>>;
const request = (data: unknown = payload) => new NextRequest("https://example.test/api?date=2026-10-18", { method: "POST", body: JSON.stringify(data) });
beforeEach(() => {
  vi.clearAllMocks();
  query = {};
  for (const key of ["select", "eq", "neq"]) query[key] = vi.fn(() => query);
  query.limit = vi.fn(async () => ({ data: [service], error: null }));
  query.upsert = vi.fn(async () => ({ error: null }));
  from = vi.fn(() => query);
  mocks.authorize.mockResolvedValue({ admin: { from }, membership: { tenant_id: "tenant-a" }, user: { id: "user-a" } });
  mocks.load.mockResolvedValue([]);
});
describe("collective convocations API", () => {
  it("rejects unauthenticated callers before any database access", async () => {
    mocks.authorize.mockResolvedValue(NextResponse.json({ error: "Unauthorized" }, { status: 401 }));
    expect((await POST(request())).status).toBe(401);
    expect((await GET(new NextRequest("https://example.test/?date=2026-10-18"))).status).toBe(401);
    expect(from).not.toHaveBeenCalled();
  });
  it("loads only the authorized tenant and requested day", async () => {
    const result = await GET(new NextRequest("https://example.test/?date=2026-10-18"));
    expect(result.status).toBe(200);
    expect(mocks.load).toHaveBeenCalledWith(expect.anything(), "tenant-a", "2026-10-18");
  });
  it("rejects invalid dates and tenant injection", async () => {
    expect((await GET(new NextRequest("https://example.test/?date=bad"))).status).toBe(400);
    expect((await POST(request({ ...payload, tenant_id: "other" }))).status).toBe(400);
    expect(from).not.toHaveBeenCalled();
  });
  it("saves only the selected event and never creates trips or assignments", async () => {
    expect((await POST(request())).status).toBe(200);
    expect(query.eq).toHaveBeenCalledWith("tenant_id", "tenant-a");
    expect(query.eq).toHaveBeenCalledWith("date", "2026-10-18");
    expect(query.upsert).toHaveBeenCalledWith(expect.objectContaining({ ...payload, tenant_id: "tenant-a", updated_by: "user-a" }), { onConflict: "tenant_id,date,event_key" });
    expect(from.mock.calls.map(([table]) => table)).toEqual(["services", "collective_ferry_convocations"]);
  });
  it("rejects a ferry absent from the authorized day", async () => {
    query.limit.mockResolvedValue({ data: [], error: null });
    expect((await POST(request())).status).toBe(400);
    expect(query.upsert).not.toHaveBeenCalled();
  });
  it("rejects departure before ferry arrival", async () => {
    expect((await POST(request({ ...payload, last_departure: "15:00" }))).status).toBe(400);
    expect(query.upsert).not.toHaveBeenCalled();
  });
  it("retains an inactive row to invalidate stale plans on cancellation", async () => {
    expect((await POST(request({ ...payload, active: false }))).status).toBe(200);
    expect(from.mock.calls.map(([table]) => table)).toEqual(["collective_ferry_convocations"]);
    expect(query.upsert).toHaveBeenCalledWith(expect.objectContaining({ active: false }), expect.anything());
  });
  it("does not report success after a failed write", async () => {
    query.upsert.mockResolvedValue({ error: { message: "write failed" } });
    expect((await POST(request())).status).toBe(500);
  });
});
