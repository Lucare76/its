type BillingPartyRule = {
  name: string;
  parserKey?: string;
  patterns: RegExp[];
};

const RULES: BillingPartyRule[] = [
  {
    name: "Zigoloviaggi s.r.l.",
    parserKey: "agency_bus_operations",
    patterns: [/zigolo\s*viaggi/i, /pietro\s+calise/i]
  }
];

export function resolveBillingPartyFromRegistry(input: {
  parserKey?: string | null;
  sourceText?: string | null;
}) {
  const parserKey = input.parserKey ?? null;
  const sourceText = String(input.sourceText ?? "");
  if (!sourceText.trim()) return null;

  for (const rule of RULES) {
    if (rule.parserKey && rule.parserKey !== parserKey) continue;
    if (rule.patterns.every((pattern) => pattern.test(sourceText))) return rule.name;
    if (rule.patterns.some((pattern) => pattern.test(sourceText))) return rule.name;
  }

  return null;
}
