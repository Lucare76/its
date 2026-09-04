// Mirror client-side, leggero e sola-lettura, della normalizzazione usata
// lato server (lib/server/bus-network-loader.ts::normalizeStopText) per dare
// un hint immediato in UI su possibili near-duplicate mentre si digita.
// NON è la fonte autorevole: la validazione/blocco reale avviene sempre
// server-side in lib/server/bus-line-stops.ts, mai qui.

export function normalizeStopTextClient(value?: string | null) {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

function tokensOf(value: string) {
  return normalizeStopTextClient(value).split(" ").filter(Boolean);
}

export type StopNameCandidate = { id: string; stopName: string; city: string };

export function findNearDuplicateStopNamesClient(stopName: string, candidates: StopNameCandidate[]): StopNameCandidate[] {
  const wanted = normalizeStopTextClient(stopName);
  if (!wanted) return [];
  const wantedTokens = new Set(tokensOf(stopName).filter((t) => t.length >= 4));
  return candidates.filter((candidate) => {
    const candidateNorm = normalizeStopTextClient(candidate.stopName);
    if (!candidateNorm || candidateNorm === wanted) return false;
    if (candidateNorm.includes(wanted) || wanted.includes(candidateNorm)) return true;
    return tokensOf(candidate.stopName).some((token) => token.length >= 4 && wantedTokens.has(token));
  });
}
