import { canonicalizeKnownHotelName } from "@/lib/server/hotel-aliases";

export type HotelMatchRow = {
  id: string;
  name: string;
  normalized_name?: string | null;
  aliases?: string[];
};

function normalizeHotelText(value: string | null | undefined) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/['".,]/g, " ")
    .replace(/\b(?:hotel|terme|resort|spa|club|grand|park|villa|relax|exclusive|boutique)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value: string) {
  return normalizeHotelText(value)
    .split(" ")
    .map((item) => item.trim())
    .filter(Boolean);
}

function scoreCandidate(wantedRaw: string, candidateRaw: string) {
  const wanted = normalizeHotelText(canonicalizeKnownHotelName(wantedRaw));
  const candidate = normalizeHotelText(canonicalizeKnownHotelName(candidateRaw));

  if (!wanted || !candidate) return 0;
  if (wanted === candidate) return 100;
  if (candidate.includes(wanted) || wanted.includes(candidate)) return 92;

  const wantedTokens = tokenize(wanted);
  const candidateTokens = new Set(tokenize(candidate));
  const shared = wantedTokens.filter((token) => candidateTokens.has(token));
  if (shared.length === 0) return 0;

  const coverage = shared.length / Math.max(wantedTokens.length, 1);
  const exactPrefix = candidate.startsWith(wanted) || wanted.startsWith(candidate) ? 6 : 0;
  return Math.round(coverage * 80) + exactPrefix;
}

export function resolveHotelMatch(hotels: HotelMatchRow[], rawHotelName: string, defaultHotelId?: string | null) {
  const canonicalWanted = canonicalizeKnownHotelName(rawHotelName);
  const wanted = normalizeHotelText(canonicalWanted);
  if (!wanted) {
    return defaultHotelId ?? null;
  }

  const scored = hotels
    .map((hotel) => ({
      id: hotel.id,
      score: Math.max(
        scoreCandidate(canonicalWanted ?? "", hotel.name),
        scoreCandidate(canonicalWanted ?? "", hotel.normalized_name ?? ""),
        ...(hotel.aliases ?? []).map((alias) => scoreCandidate(canonicalWanted ?? "", alias))
      )
    }))
    .sort((left, right) => right.score - left.score);

  const best = scored[0];
  if (best && best.score >= 70) {
    return best.id;
  }

  return defaultHotelId ?? null;
}
