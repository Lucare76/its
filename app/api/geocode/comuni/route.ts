import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q")?.trim();
  if (!q || q.length < 2) return NextResponse.json({ results: [] });

  const encoded = encodeURIComponent(q);

  const [photonRes, gnRes] = await Promise.allSettled([
    fetch(`https://photon.komoot.io/api/?q=${encoded}&limit=6&lang=it&bbox=6.6,35.5,18.5,47.1`, {
      headers: { "Accept-Language": "it" },
    }),
    // name_startsWith = cerca per nome comune (più preciso di q= che fa full-text)
    fetch(
      `https://secure.geonames.org/searchJSON?name_startsWith=${encoded}&country=IT&featureClass=P&maxRows=10&lang=it&orderby=relevance&username=Lucare76`
    ),
  ]);

  type Result = { shortName: string; displayName: string; lat: number; lng: number };
  const results: Result[] = [];
  const seen = new Set<string>();

  if (photonRes.status === "fulfilled" && photonRes.value.ok) {
    const data = (await photonRes.value.json()) as {
      features: Array<{
        geometry: { coordinates: [number, number] };
        properties: { name?: string; country?: string; county?: string; state?: string; city?: string };
      }>;
    };
    for (const f of data.features) {
      const p = f.properties;
      if (p.country !== "Italy" && p.country !== "Italia") continue;
      const name = p.name ?? "";
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      const parts = [p.county ?? p.city, p.state].filter(Boolean).join(", ");
      results.push({ shortName: name, displayName: parts ? `${name} — ${parts}` : name, lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] });
    }
  }

  if (gnRes.status === "fulfilled" && gnRes.value.ok) {
    const data = (await gnRes.value.json()) as {
      geonames?: Array<{ name: string; adminName2?: string; adminName1?: string; lat: string; lng: string }>;
    };
    for (const g of data.geonames ?? []) {
      if (!g.name || seen.has(g.name.toLowerCase())) continue;
      seen.add(g.name.toLowerCase());
      const parts = [g.adminName2, g.adminName1].filter(Boolean).join(", ");
      results.push({ shortName: g.name, displayName: parts ? `${g.name} — ${parts}` : g.name, lat: parseFloat(g.lat), lng: parseFloat(g.lng) });
    }
  }

  return NextResponse.json({ results });
}
