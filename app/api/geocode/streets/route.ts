import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

// Cerca strade/luoghi vicino a coordinate date (per il campo Fermata)
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q")?.trim();
  const lat = req.nextUrl.searchParams.get("lat");
  const lng = req.nextUrl.searchParams.get("lng");

  if (!q || q.length < 2) return NextResponse.json({ results: [] });

  try {
    // Photon con location bias sulle coordinate della città selezionata
    const params = new URLSearchParams({ q, limit: "6", lang: "it" });
    if (lat && lng) { params.set("lat", lat); params.set("lon", lng); }

    const res = await fetch(`https://photon.komoot.io/api/?${params.toString()}`, {
      headers: { "Accept-Language": "it" },
    });
    if (!res.ok) return NextResponse.json({ results: [] });

    const data = (await res.json()) as {
      features: Array<{
        geometry: { coordinates: [number, number] };
        properties: {
          name?: string;
          country?: string;
          street?: string;
          housenumber?: string;
          city?: string;
          district?: string;
          osm_value?: string;
        };
      }>;
    };

    const results = data.features
      .filter((f) => f.properties.country === "Italy" || f.properties.country === "Italia")
      .map((f) => {
        const p = f.properties;
        const name = p.name ?? p.street ?? "";
        const detail = [p.district ?? p.city].filter(Boolean).join(", ");
        return { label: name, detail, lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] };
      })
      .filter((r) => r.label);

    return NextResponse.json({ results });
  } catch {
    return NextResponse.json({ results: [] });
  }
}
