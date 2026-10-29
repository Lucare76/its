import { afterEach, describe, expect, it, vi } from "vitest";
import { searchHotelPhoton } from "@/lib/server/hotel-photon-lookup";
const street = { type: "Feature", properties: { name: "Via Filippo Di Lustro", city: "Forio", countrycode: "IT", type: "street", osm_key: "highway", osm_value: "pedestrian", osm_id: 290491110, osm_type: "W" }, geometry: { type: "Point", coordinates: [13.8600136, 40.7377938] } };
const input = { query: "Via Filippo di Lustro 9 Forio", name: "Pensione Di Lustro", address: "Via Filippo di Lustro 9", city: "Forio" };
afterEach(() => vi.unstubAllGlobals());
function provider(features: unknown[]) { const fn = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ features }) }); vi.stubGlobal("fetch", fn); return fn; }
describe("alternative hotel geolocation", () => {
  it("finds Di Lustro's street in Forio and identifies it as a street rather than a verified entrance", async () => {
    const fetch = provider([street]);
    const results = await searchHotelPhoton(input);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ lat: 40.7377938, lng: 13.8600136, score: 70 });
    expect(results[0].label).toContain("verifica il civico e l'ingresso");
    const url = new URL(fetch.mock.calls[0][0]);
    expect(url.searchParams.get("bbox")).toBe("13.82,40.67,13.99,40.77");
  });
  it.each([
    { ...street, geometry: { type: "Point", coordinates: [12.5, 41.9] } },
    { ...street, properties: { ...street.properties, countrycode: "FR" } },
    { ...street, properties: { name: "Forio", type: "city", osm_key: "place", osm_value: "town" } },
    { ...street, properties: { ...street.properties, name: "Via Filippo Turati" } },
    { geometry: { type: "Point", coordinates: [null, 40.73] }, properties: {} }
  ])("rejects out-of-island, municipality, unrelated and malformed candidates", async (feature) => {
    provider([feature]);
    expect(await searchHotelPhoton({ query: input.query })).toEqual([]);
  });
  it("accepts an accommodation point with matching name", async () => {
    provider([{ ...street, properties: { ...street.properties, type: "house", name: "Pensione Di Lustro", osm_key: "tourism", osm_value: "guest_house" } }]);
    const results = await searchHotelPhoton(input);
    expect(results[0].score).toBe(100);
    expect(results[0].label).not.toContain("posizione della via");
  });
});
