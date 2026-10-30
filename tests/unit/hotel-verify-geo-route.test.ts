import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { evaluateHotelGeo } from "@/lib/hotel-geocoding";
const mocks = vi.hoisted(() => ({ authorize: vi.fn() }));
vi.mock("@/lib/server/pricing-auth", () => ({ authorizePricingRequest: mocks.authorize }));
import { POST } from "@/app/api/admin/hotels/[id]/verify-geo/route";

const tenant = "tenant-a";
const id = "hotel-a";
let rows: Array<Record<string, unknown>>;
let updateMode: "normal" | "empty" | "error" | "wrong";
const coords = { lat: 40.7301234, lng: 13.9001234 };
function admin() {
  return { from: () => {
    let patch: Record<string, unknown> | undefined;
    const filters: Array<[string, unknown]> = [];
    const query = {
      select: () => query,
      update: (value: Record<string, unknown>) => { patch = value; return query; },
      eq: (key: string, value: unknown) => { filters.push([key, value]); return query; },
      maybeSingle: async () => {
        const row = rows.find((entry) => filters.every(([key, value]) => entry[key] === value));
        if (patch && updateMode === "error") return { data: null, error: { message: "write failed" } };
        if (patch && updateMode === "empty") return { data: null, error: null };
        if (patch && row) Object.assign(row, patch);
        return { data: patch && updateMode === "wrong" ? { ...row, lat: 40.75 } : row ? { ...row } : null, error: null };
      }
    };
    return query;
  }};
}
function save(body = coords, hotelId = id) {
  return POST(new NextRequest(`https://its.test/api/admin/hotels/${hotelId}/verify-geo`, {
    method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" }
  }), { params: Promise.resolve({ id: hotelId }) });
}
beforeEach(() => {
  rows = [
    { id, tenant_id: tenant, name: "Hotel test", address: "Ischia", zone: "Ischia Porto", lat: 40.7418, lng: 13.9426 },
    { id: "foreign", tenant_id: "tenant-b", name: "Other hotel", lat: 40.73, lng: 13.9 }
  ];
  updateMode = "normal";
  mocks.authorize.mockReset();
  mocks.authorize.mockResolvedValue({ admin: admin(), membership: { tenant_id: tenant }, user: { id: "operator-a" } });
});
describe("hotel manual position persistence", () => {
  it("saves the exact manual pin and reopening the stored row keeps it verified even with an incomplete address", async () => {
    const response = await save();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.hotel).toMatchObject({ id, ...coords, geo_status: "verified", geo_source: "manual", geo_accuracy: "rooftop", geo_verified_by: "operator-a" });
    const reloaded = await admin().from().select().eq("id", id).eq("tenant_id", tenant).maybeSingle();
    expect(reloaded.data).toMatchObject(coords);
    expect(evaluateHotelGeo(reloaded.data as Parameters<typeof evaluateHotelGeo>[0]).status).toBe("verified");
    expect(rows[1].lat).toBe(40.73);
  });
  it("does not report success if no row was updated", async () => {
    updateMode = "empty";
    const response = await save();
    expect(response.status).toBe(409);
    expect((await response.json()).ok).toBe(false);
    expect(rows[0].lat).toBe(40.7418);
  });
  it("rejects a database result that does not match the submitted pin", async () => {
    updateMode = "wrong";
    expect((await save()).status).toBe(409);
  });
  it("surfaces write errors", async () => {
    updateMode = "error";
    expect((await save()).status).toBe(500);
  });
  it("cannot change a hotel in another tenant", async () => {
    expect((await save(coords, "foreign")).status).toBe(404);
    expect(rows[1].lat).toBe(40.73);
  });
  it("rejects coordinates outside Ischia without changing the row", async () => {
    expect((await save({ lat: 41.9, lng: 12.5 })).status).toBe(400);
    expect(rows[0].lat).toBe(40.7418);
  });
  it("requires authorized access", async () => {
    mocks.authorize.mockResolvedValue(NextResponse.json({ ok: false }, { status: 401 }));
    expect((await save()).status).toBe(401);
    expect(rows[0].lat).toBe(40.7418);
  });
});

describe("Napoli verification", () => {
  it("saves mainland coordinates, normalizes a stale island zone, and survives reload", async () => {
    Object.assign(rows[0], { city: "Napoli", zone: "Ischia Porto", address: "Piazza Principe Umberto I 23, Napoli" });
    const point = { lat: 40.853, lng: 14.269 };
    expect((await save(point)).status).toBe(200);
    expect(rows[0]).toMatchObject({ ...point, zone: "Napoli", city: "Napoli", geo_status: "verified" });
    const geo = evaluateHotelGeo(rows[0]);
    expect(geo.status).toBe("verified");
    expect(geo.routeUsable).toBe(false);
    expect(geo.confidence).toBe("ok");
  });
  it("rejects an island pin for a Napoli hotel", async () => {
    Object.assign(rows[0], { city: "Napoli" });
    expect((await save(coords)).status).toBe(400);
    expect(rows[0].lat).toBe(40.7418);
  });
});
