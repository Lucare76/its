import { describe, it, expect } from "vitest";
import { normalizeHotelText, resolveHotelMatch, type HotelMatchRow } from "@/lib/server/hotel-matching";

describe("normalizeHotelText", () => {
  it("converte in minuscolo", () => {
    expect(normalizeHotelText("HOTEL MARE")).not.toMatch(/[A-Z]/);
  });

  it("rimuove gli accenti", () => {
    expect(normalizeHotelText("Côte d'Azur")).not.toMatch(/[àáâãäåèéêëìíîïòóôõöùúûü]/i);
  });

  it("rimuove la parola 'hotel' come stop-word", () => {
    expect(normalizeHotelText("Hotel Cristallo")).not.toContain("hotel");
  });

  it("rimuove 'terme', 'resort', 'spa', 'grand', 'park'", () => {
    const result = normalizeHotelText("Grand Hotel Terme Resort Spa Park");
    expect(result).not.toMatch(/\b(terme|resort|spa|grand|park)\b/);
  });

  it("rimuove la punteggiatura comune", () => {
    const result = normalizeHotelText("Hotel \"San Giorgio\", Palace.");
    expect(result).not.toMatch(/[".,']/);
  });

  it("collassa spazi multipli", () => {
    expect(normalizeHotelText("Hotel   Bella   Vista")).not.toContain("  ");
  });

  it("restituisce stringa vuota per null", () => {
    expect(normalizeHotelText(null)).toBe("");
  });

  it("restituisce stringa vuota per undefined", () => {
    expect(normalizeHotelText(undefined)).toBe("");
  });

  it("mantiene lettere e numeri", () => {
    const result = normalizeHotelText("Albergo 4 Stagioni");
    expect(result).toContain("4");
    expect(result).toContain("stagioni");
  });
});

describe("resolveHotelMatch", () => {
  const hotels: HotelMatchRow[] = [
    { id: "h1", name: "Hotel Cristallo Palace" },
    { id: "h2", name: "Albergo Panorama" },
    { id: "h3", name: "Hotel Bellavista", aliases: ["Vista Mare", "BellaVista"] },
    { id: "h4", name: "Hotel Terme President" },
  ];

  it("match esatto → restituisce l'id corretto", () => {
    expect(resolveHotelMatch(hotels, "Hotel Cristallo Palace")).toBe("h1");
  });

  it("match senza stop-word 'hotel' → ancora trovato", () => {
    expect(resolveHotelMatch(hotels, "Cristallo Palace")).toBe("h1");
  });

  it("match senza stop-word 'terme' → ancora trovato", () => {
    expect(resolveHotelMatch(hotels, "Hotel President")).toBe("h4");
  });

  it("match tramite alias → restituisce l'id corretto", () => {
    expect(resolveHotelMatch(hotels, "Vista Mare")).toBe("h3");
  });

  it("match case-insensitive", () => {
    expect(resolveHotelMatch(hotels, "hotel cristallo palace")).toBe("h1");
    expect(resolveHotelMatch(hotels, "HOTEL CRISTALLO PALACE")).toBe("h1");
  });

  it("nessun match per nome completamente diverso → restituisce null", () => {
    expect(resolveHotelMatch(hotels, "Ristorante da Luigi")).toBeNull();
  });

  it("nome vuoto → restituisce null se nessun default", () => {
    expect(resolveHotelMatch(hotels, "")).toBeNull();
  });

  it("nome vuoto → restituisce defaultHotelId se fornito", () => {
    expect(resolveHotelMatch(hotels, "", "default-id")).toBe("default-id");
  });

  it("nessun match + defaultHotelId → restituisce defaultHotelId", () => {
    expect(resolveHotelMatch(hotels, "xyz non esiste", "fallback-id")).toBe("fallback-id");
  });

  it("array hotel vuoto → restituisce null", () => {
    expect(resolveHotelMatch([], "Hotel Cristallo")).toBeNull();
  });

  it("match parziale con token sufficienti → supera soglia 70", () => {
    // "Albergo Panorama" ha token ["albergo","panorama"], "Panorama" ha token ["panorama"]
    // coverage = 1/2 = 0.5 → 40 punti, potrebbe non superare 70. Testiamo il comportamento reale.
    const result = resolveHotelMatch(hotels, "Panorama");
    // "panorama" è un token in comune: coverage = 1/1 wanted × 80 = 80 ≥ 70 → match
    expect(result).toBe("h2");
  });

  it("abbinamento con normalized_name se fornito", () => {
    const hotelsWithNorm: HotelMatchRow[] = [
      { id: "hn1", name: "H. B. S. r.l.", normalized_name: "Hotel Bella Spiaggia" },
    ];
    expect(resolveHotelMatch(hotelsWithNorm, "Bella Spiaggia")).toBe("hn1");
  });
});

describe("resolveHotelMatch — nomi Excel bus vs DB Ischia", () => {
  const ischiaHotels: HotelMatchRow[] = [
    { id: "h-sv", name: "SAN VALENTINO TERME" },
    { id: "h-cp", name: "CENTRAL PARK TERME" },
    { id: "h-dp", name: "DON PEPE" },
    { id: "h-ps", name: "PUNTA DEL SOLE" },
    { id: "h-to", name: "TRAMONTO D'ORO" },
    { id: "h-ga", name: "GRAND HOTEL TERME DI AUGUSTO" },
    { id: "h-rt", name: "ROYAL TERME" },
    { id: "h-sm", name: "STELLA MARIS" },
    { id: "h-so", name: "SORRISO" },
    { id: "h-hw", name: "HOLIDAY WEB" },
    { id: "h-rf", name: "RE FERDINANDO" },
    { id: "h-cr", name: "CRISTALLO" },
    { id: "h-br", name: "BRISTOL" },
  ];

  const testCases: Array<[string, string]> = [
    ["SAN VALENTINO", "h-sv"],
    ["CENTRAL PARK", "h-cp"],
    ["DON PEPE", "h-dp"],
    ["PUNTA DEL SOLE", "h-ps"],
    ["TRAMONTO D'ORO", "h-to"],
    ["GRAND HOTEL TERME DI AUGUSTO", "h-ga"],
    ["ROYAL TERME", "h-rt"],
    ["STELLA MARIS", "h-sm"],
    ["SORRISO", "h-so"],
    ["HOLIDAY WEB", "h-hw"],
  ];

  for (const [excelName, expectedId] of testCases) {
    it(`"${excelName}" → matcha correttamente`, () => {
      const result = resolveHotelMatch(ischiaHotels, excelName, null);
      expect(result).toBe(expectedId);
    });
  }

  it("nome parziale 'AUGUSTO' matcha GRAND HOTEL TERME DI AUGUSTO", () => {
    expect(resolveHotelMatch(ischiaHotels, "AUGUSTO", null)).toBe("h-ga");
  });

  it("nome con typo minore non matcha nomi completamente diversi", () => {
    expect(resolveHotelMatch(ischiaHotels, "RISTORANTE PIPPO", null)).toBeNull();
  });
});
