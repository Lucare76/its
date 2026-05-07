import type { SupabaseClient } from "@supabase/supabase-js";

export type PlaceType = "hotel" | "locality" | "poi" | "attraction" | "port" | "airport" | "station";
export type ImportPlaceType = PlaceType | "address" | "other";

export type PlaceRow = {
  id: string;
  name: string;
  normalized_name: string;
  place_type: PlaceType;
  address?: string | null;
  city?: string | null;
  zone?: string | null;
  confidence?: number | null;
  aliases?: string[];
};

export type PlaceMatch =
  | { status: "matched"; place: PlaceRow; confidence: number }
  | { status: "ambiguous"; candidates: PlaceRow[]; confidence: number }
  | { status: "not_found"; confidence: 0 };

const TYPE_ALIASES: Record<string, ImportPlaceType> = {
  hotel: "hotel",
  albergo: "hotel",
  struttura: "hotel",
  localita: "locality",
  località: "locality",
  luogo: "locality",
  comune: "locality",
  poi: "poi",
  attrazione: "attraction",
  attraction: "attraction",
  porto: "port",
  port: "port",
  aeroporto: "airport",
  airport: "airport",
  stazione: "station",
  station: "station",
  indirizzo: "address",
  address: "address",
  altro: "other",
  other: "other"
};

export function normalizePlaceText(value: string | null | undefined) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/['".,]/g, " ")
    .replace(/\b(?:hotel|albergo|terme|resort|spa|grand|park)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseImportPlaceType(value: string | null | undefined): ImportPlaceType | null {
  const normalized = normalizePlaceText(value);
  return TYPE_ALIASES[normalized] ?? null;
}

function scorePlace(raw: string, place: PlaceRow) {
  const wanted = normalizePlaceText(raw);
  const names = [place.name, place.normalized_name, ...(place.aliases ?? [])].map(normalizePlaceText).filter(Boolean);
  if (!wanted || names.length === 0) return 0;
  if (names.some((name) => name === wanted)) return 100;
  if (names.some((name) => name.length >= 5 && (name.includes(wanted) || wanted.includes(name)))) return 92;

  const wantedTokens = wanted.split(" ").filter(Boolean);
  let best = 0;
  for (const name of names) {
    const candidateTokens = new Set(name.split(" ").filter(Boolean));
    const shared = wantedTokens.filter((token) => candidateTokens.has(token));
    if (shared.length === 0) continue;
    best = Math.max(best, Math.round((shared.length / Math.max(wantedTokens.length, 1)) * 80));
  }
  return best;
}

export async function loadTenantPlaces(admin: SupabaseClient, tenantId: string): Promise<PlaceRow[]> {
  const { data: places } = await admin
    .from("places")
    .select("id, name, normalized_name, place_type, address, city, zone, confidence")
    .eq("tenant_id", tenantId)
    .eq("active", true)
    .limit(10000);

  const rows = (places ?? []) as PlaceRow[];
  if (rows.length === 0) return [];

  const { data: aliases } = await admin
    .from("place_aliases")
    .select("place_id, alias")
    .eq("tenant_id", tenantId)
    .limit(10000);

  const aliasesByPlace = new Map<string, string[]>();
  for (const row of (aliases ?? []) as Array<{ place_id: string; alias: string }>) {
    const bucket = aliasesByPlace.get(row.place_id) ?? [];
    bucket.push(row.alias);
    aliasesByPlace.set(row.place_id, bucket);
  }

  return rows.map((place) => ({ ...place, aliases: aliasesByPlace.get(place.id) ?? [] }));
}

export function resolvePlaceMatch(
  places: PlaceRow[],
  rawName: string,
  expectedType: ImportPlaceType | null | undefined
): PlaceMatch {
  const wanted = normalizePlaceText(rawName);
  if (!wanted) return { status: "not_found", confidence: 0 };
  if (expectedType === "address" || expectedType === "other") return { status: "not_found", confidence: 0 };

  const compatiblePlaces = expectedType
    ? places.filter((place) => place.place_type === expectedType || (expectedType === "poi" && place.place_type === "attraction"))
    : places;

  const scored = compatiblePlaces
    .map((place) => ({ place, score: scorePlace(rawName, place) }))
    .filter((item) => item.score >= 70)
    .sort((left, right) => right.score - left.score);

  const best = scored[0];
  if (!best) return { status: "not_found", confidence: 0 };

  const sameScore = scored.filter((item) => item.score === best.score);
  if (sameScore.length > 1 && best.score < 100) {
    return { status: "ambiguous", candidates: sameScore.map((item) => item.place), confidence: best.score };
  }

  return { status: "matched", place: best.place, confidence: best.score };
}
