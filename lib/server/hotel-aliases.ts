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
    aliases: ["Hotel Terme President", "Club Hotel President", "Hotel President", "President", "Presdient"]
  },
  {
    canonical: "Hotel Cristallo Palace",
    aliases: ["Hotel Cristallo Palace", "Cristallo Palace", "Hotel Cristallo"]
  },
  {
    canonical: "Grand Hotel delle Terme Re Ferdinando",
    aliases: ["Hotel Re Ferdinando", "Re Ferdinando", "Re Ferdinanod", "Grand Hotel delle Terme Re Ferdinando"]
  },
  {
    canonical: "Hotel Terme Felix",
    aliases: ["Hotel Felix", "Felix", "Hotel Terme Felix"]
  },
  {
    canonical: "Grand Hotel Terme di Augusto",
    aliases: ["Hotel Terme Augusto", "Terme Augusto", "Augusto", "Grand Hotel Terme di Augusto"]
  },
  {
    canonical: "Hotel Saint Raphael",
    aliases: ["Hotel Saint Raphael", "Saint Raphael", "St Raphael", "Saint-Raphael"]
  },
  {
    canonical: "Hotel Terme Colella",
    aliases: ["Hotel Terme Colella", "Colella"]
  },
  {
    canonical: "San Valentino Terme",
    aliases: ["San Valentino Terme", "San Valentino"]
  },
  {
    canonical: "Parco Hotel Terme Villa Teresa",
    aliases: ["Parco Hotel Terme Villa Teresa", "Villa Teresa"]
  },
  {
    canonical: "Hotel Floridiana Terme",
    aliases: ["Hotel Floridiana Terme", "Floridiana"]
  },
  {
    canonical: "Hotel Terme Oriente",
    aliases: ["Hotel Terme Oriente", "Oriente"]
  },
  {
    canonical: "Hotel Aragonese",
    aliases: ["Hotel Aragonese", "Aragonese", "Aregonese"]
  },
  {
    canonical: "Royal Palm Hotel Terme",
    aliases: ["Royal Palm Hotel Terme", "Royal Palm"]
  },
  {
    canonical: "Hotel Eden Park",
    aliases: ["Hotel Eden Park", "Eden Park"]
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
