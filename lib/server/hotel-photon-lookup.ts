import { z } from "zod";
import { isWithinIschiaBounds } from "@/lib/hotel-geocoding";

const featureSchema = z.object({
  geometry: z.object({ type: z.literal("Point"), coordinates: z.tuple([z.number().finite(), z.number().finite()]) }),
  properties: z.object({
    name: z.string().optional(), street: z.string().optional(), housenumber: z.string().optional(),
    city: z.string().optional(), countrycode: z.string().optional(), type: z.string().optional(),
    osm_key: z.string().optional(), osm_value: z.string().optional(), osm_type: z.string().optional(), osm_id: z.number().optional()
  })
});

function words(value: string) {
  return value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !["via", "piazza", "strada", "hotel", "pensione", "terme", "villa", "forio", "ischia", "italia"].includes(word));
}

export async function searchHotelPhoton(input: { query: string; name?: string | null; address?: string | null; city?: string | null }) {
  const queries = [...new Set([input.query, [input.address, input.city].filter(Boolean).join(", "), [input.name, input.city].filter(Boolean).join(", ")].map((q) => q.trim()).filter((q) => q.length > 3))].slice(0, 3);
  const wanted = new Set(words([input.query, input.name, input.address].filter(Boolean).join(" ")));
  for (const [index, query] of queries.entries()) {
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, 1100));
    const url = new URL("/api/", process.env.PHOTON_GEOCODING_URL || "https://photon.komoot.io");
    url.searchParams.set("q", query);
    url.searchParams.set("limit", "5");
    url.searchParams.set("bbox", "13.82,40.67,13.99,40.77");
    url.searchParams.set("lat", "40.73");
    url.searchParams.set("lon", "13.9");
    const response = await fetch(url.toString(), { signal: AbortSignal.timeout(8000), next: { revalidate: 86400 }, headers: { "User-Agent": "IschiaTransfer/1.0 (info@campanialimousine.com)" } });
    if (!response.ok) throw new Error("Ricerca alternativa non disponibile");
    const payload: unknown = await response.json();
    const features = z.object({ features: z.array(z.unknown()) }).safeParse(payload);
    if (!features.success) continue;
    const results = features.data.features.flatMap((feature) => {
      const parsed = featureSchema.safeParse(feature);
      if (!parsed.success) return [];
      const { properties: p, geometry } = parsed.data;
      const [lng, lat] = geometry.coordinates;
      if (!isWithinIschiaBounds(lat, lng) || (p.countrycode && p.countrycode.toUpperCase() !== "IT")) return [];
      const precise = p.type === "house" || p.osm_key === "building" || (p.osm_key === "tourism" && ["hotel", "guest_house", "hostel", "apartment", "resort"].includes(p.osm_value ?? ""));
      const street = p.type === "street" || p.osm_key === "highway";
      if (!precise && !street) return [];
      const candidateWords = words([p.name, p.street].filter(Boolean).join(" "));
      if (!candidateWords.length || candidateWords.filter((word) => wanted.has(word)).length / candidateWords.length < 0.6) return [];
      const label = [...new Set([p.name, [p.street, p.housenumber].filter(Boolean).join(" "), p.city].filter(Boolean))].join(", ");
      return [{ lat, lng, label: street && !precise ? `${label} (posizione della via: verifica il civico e l'ingresso)` : label, place_id: p.osm_id ? `photon:${p.osm_type ?? ""}:${p.osm_id}` : null, score: precise ? 100 : 70, query }];
    });
    if (results.length) return results;
  }
  return [];
}
