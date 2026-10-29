import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { canonicalizeKnownHotelName } from "@/lib/server/hotel-aliases";
const mocks = vi.hoisted(() => ({ authorize: vi.fn() }));
vi.mock("@/lib/server/pricing-auth", () => ({ authorizePricingRequest: mocks.authorize }));
import { GET } from "@/app/api/admin/hotels/geo-lookup/route";
const provider = vi.fn();
beforeEach(() => {
  provider.mockReset();
  vi.stubGlobal("fetch", provider);
  const builder = { select: () => builder, eq: () => builder, maybeSingle: async () => ({ data: { name: "AV TERME COLELLA", address: "Ischia", city: "Ischia", zone: "Ischia Porto" } }) };
  mocks.authorize.mockResolvedValue({ admin: { from: () => builder }, membership: { tenant_id: "tenant-a" } });
});
afterEach(() => vi.unstubAllGlobals());
function request() { return new NextRequest("https://its.test/api/admin/hotels/geo-lookup?q=AV%20TERME%20COLELLA%2C%20Ischia&hotel_id=hotel-a"); }
const island = { lat: "40.7268816", lon: "13.9095474", display_name: "Isola d'Ischia, Barano d'Ischia", class: "place", type: "island", addresstype: "island" };
describe("Colella aliases and geographic lookup", () => {
  it.each(["AV TERME COLELLA", "AV Club Terme Colella", "AV Club Colella"])("recognizes %s as the canonical hotel used by email/PDF import", name => {
    expect(canonicalizeKnownHotelName(name)).toBe("Hotel Terme Colella");
  });
  it("never suggests the centre of the island as the hotel position", async () => {
    provider.mockResolvedValue({ ok: true, json: async () => [island] });
    const response = await GET(request());
    expect((await response.json()).results).toEqual([]);
  });
  it("retries with the canonical hotel name and keeps the precise Forio result", async () => {
    provider.mockImplementation(async (url: string) => ({ ok: true, json: async () => new URL(url).searchParams.get("q")?.startsWith("Hotel Terme Colella,") ? [{ lat: "40.73539", lon: "13.86833", display_name: "Hotel Terme Colella, Forio", class: "tourism", type: "hotel", addresstype: "tourism" }] : [island] }));
    const body = await (await GET(request())).json();
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({ lat: 40.73539, lng: 13.86833, label: "Hotel Terme Colella, Forio" });
    expect(provider.mock.calls.some(([url]) => new URL(url).searchParams.get("q")?.startsWith("Hotel Terme Colella,"))).toBe(true);
  });
});
