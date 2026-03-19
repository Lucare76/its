function clean(value?: string | null) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function simplifyHotelName(value?: string | null) {
  const normalized = clean(value)?.toLowerCase() ?? null;
  if (!normalized) return null;
  return normalized
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['".,]/g, " ")
    .replace(/\b(?:hotel|club|terme)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const SOSANDRA_HOTEL_ALIASES: Array<{ canonical: string; aliases: string[] }> = [
  {
    canonical: "Hotel Terme President",
    aliases: ["Hotel Terme President", "Club Hotel President", "Hotel President", "President"]
  },
  {
    canonical: "Hotel Cristallo Palace",
    aliases: ["Hotel Cristallo Palace", "Cristallo Palace", "Hotel Cristallo"]
  },
  {
    canonical: "Hotel Re Ferdinando",
    aliases: ["Hotel Re Ferdinando", "Re Ferdinando"]
  },
  {
    canonical: "Hotel Felix",
    aliases: ["Hotel Felix", "Felix"]
  },
  {
    canonical: "Hotel Terme Augusto",
    aliases: ["Hotel Terme Augusto", "Terme Augusto", "Augusto"]
  },
  {
    canonical: "Hotel Saint Raphael",
    aliases: ["Hotel Saint Raphael", "Saint Raphael", "St Raphael", "Saint-Raphael"]
  }
];

export function canonicalizeKnownHotelName(value?: string | null) {
  const normalized = simplifyHotelName(value);
  if (!normalized) return clean(value);

  for (const entry of SOSANDRA_HOTEL_ALIASES) {
    for (const alias of entry.aliases) {
      if (simplifyHotelName(alias) === normalized) {
        return entry.canonical;
      }
    }
  }

  return clean(value);
}

