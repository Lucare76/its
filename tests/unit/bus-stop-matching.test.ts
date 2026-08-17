import { describe, it, expect } from "vitest";
import {
  normalizeBusText,
  expandAbbreviations,
  stopMatches,
  stopMatchesFuzzy,
} from "@/lib/server/bus-service-resolver";
import { resolveBusStop } from "@/lib/server/bus-lines-catalog";

const makeStop = (stop_name: string, city?: string) => ({
  id: "stop-1",
  bus_line_id: "line-1",
  direction: "arrival" as const,
  stop_name,
  city: city ?? stop_name,
  pickup_note: null,
  active: true,
});

describe("normalizeBusText", () => {
  it("normalizza in minuscolo senza accenti", () => {
    expect(normalizeBusText("CITTÀ DI CASTELLO")).toBe("citta di castello");
  });

  it("rimuove punteggiatura", () => {
    expect(normalizeBusText("P. SAN GIOVANNI")).toBe("p san giovanni");
  });

  it("gestisce null/undefined", () => {
    expect(normalizeBusText(null)).toBe("");
    expect(normalizeBusText(undefined)).toBe("");
  });
});

describe("expandAbbreviations", () => {
  it("espande P. in Ponte", () => {
    expect(expandAbbreviations("P. SAN GIOVANNI")).toBe("ponte SAN GIOVANNI");
  });

  it("espande S. in Santa", () => {
    expect(expandAbbreviations("S. MARIA DEGLI ANGELI")).toBe("santa MARIA DEGLI ANGELI");
  });

  it("espande C. in Citta", () => {
    expect(expandAbbreviations("C. DI CASTELLO")).toBe("citta DI CASTELLO");
  });

  it("non espande abbreviazioni nel mezzo di parole", () => {
    expect(expandAbbreviations("SPOLETO")).toBe("SPOLETO");
  });

  it("gestisce abbreviazioni multiple", () => {
    expect(expandAbbreviations("S. MARIA P. SAN GIOVANNI")).toBe("santa MARIA ponte SAN GIOVANNI");
  });
});

describe("stopMatches — exact", () => {
  it("matcha per nome fermata esatto", () => {
    const stop = makeStop("PERUGIA");
    expect(stopMatches(stop, ["perugia"])).toBe(true);
  });

  it("matcha per città", () => {
    const stop = makeStop("FOLIGNO", "Foligno");
    expect(stopMatches(stop, ["foligno"])).toBe(true);
  });

  it("non matcha abbreviazioni", () => {
    const stop = makeStop("PONTE SAN GIOVANNI");
    expect(stopMatches(stop, ["p san giovanni"])).toBe(false);
  });
});

describe("stopMatchesFuzzy — contains", () => {
  it("matcha quando il candidato è contenuto nel nome fermata", () => {
    const stop = makeStop("PONTE SAN GIOVANNI");
    expect(stopMatchesFuzzy(stop, ["san giovanni"])).toBe(true);
  });

  it("matcha quando il nome fermata è contenuto nel candidato", () => {
    const stop = makeStop("TERNI");
    expect(stopMatchesFuzzy(stop, ["terni terminal atc"])).toBe(true);
  });

  it("non matcha stringhe completamente diverse", () => {
    const stop = makeStop("PERUGIA");
    expect(stopMatchesFuzzy(stop, ["roma"])).toBe(false);
  });
});

describe("matching completo abbreviazioni Excel → DB", () => {
  const stops = [
    makeStop("PONTE SAN GIOVANNI"),
    makeStop("SANTA MARIA DEGLI ANGELI"),
    makeStop("CITTA DI CASTELLO"),
    makeStop("PERUGIA"),
    makeStop("FOLIGNO"),
    makeStop("GUBBIO"),
  ];

  const testCases: Array<[string, string]> = [
    ["P. SAN GIOVANNI", "PONTE SAN GIOVANNI"],
    ["S. MARIA DEGLI ANGELI", "SANTA MARIA DEGLI ANGELI"],
    ["C. DI CASTELLO", "CITTA DI CASTELLO"],
    ["PERUGIA", "PERUGIA"],
    ["GUBBIO", "GUBBIO"],
    ["FOLIGNO", "FOLIGNO"],
  ];

  for (const [excelCity, expectedStop] of testCases) {
    it(`"${excelCity}" → "${expectedStop}"`, () => {
      const normalizedRaw = normalizeBusText(excelCity);
      const expanded = normalizeBusText(expandAbbreviations(excelCity));
      const candidates = [normalizedRaw, expanded].filter(Boolean);

      const exact = stops.find((s) => stopMatches(s, [normalizedRaw]));
      const derived = stops.find((s) => stopMatches(s, candidates));
      const fuzzy = stops.find((s) => stopMatchesFuzzy(s, candidates));
      const match = exact ?? derived ?? fuzzy ?? null;

      expect(match).not.toBeNull();
      expect(match!.stop_name).toBe(expectedStop);
    });
  }
});

describe("resolveBusStop — catalogo linee", () => {
  it("ROMA TIBURTINA → CENTRO (Linea 7)", () => {
    const result = resolveBusStop("ROMA TIBURTINA");
    expect(result).not.toBeNull();
    expect(result!.familyCode).toBe("CENTRO");
  });

  it("ROMA ANAGNINA → CENTRO (Linea 7)", () => {
    const result = resolveBusStop("ROMA ANAGNINA");
    expect(result).not.toBeNull();
    expect(result!.familyCode).toBe("CENTRO");
  });

  it("VALMONTONE → CENTRO", () => {
    const result = resolveBusStop("VALMONTONE");
    expect(result).not.toBeNull();
    expect(result!.familyCode).toBe("CENTRO");
  });

  it("PERUGIA → CENTRO", () => {
    const result = resolveBusStop("PERUGIA");
    expect(result).not.toBeNull();
    expect(result!.familyCode).toBe("CENTRO");
  });

  it("FOLIGNO → CENTRO", () => {
    const result = resolveBusStop("FOLIGNO");
    expect(result).not.toBeNull();
    expect(result!.familyCode).toBe("CENTRO");
  });

  it("CASSINO → ITALIA", () => {
    const result = resolveBusStop("CASSINO");
    expect(result).not.toBeNull();
    expect(result!.familyCode).toBe("ITALIA");
  });
});
