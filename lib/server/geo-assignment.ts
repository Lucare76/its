export type GeoArea = "nord_ovest" | "est_sud" | null;
export type GeoSeverity = "ok" | "warning" | "block";

export type GeographicCompatibilityResult = {
  compatible: boolean;
  severity: GeoSeverity;
  requiredMinutes: number;
  availableMinutes: number;
  marginMinutes: number;
  fromZone: string | null;
  toZone: string | null;
  fromArea: GeoArea;
  toArea: GeoArea;
  reason: string;
};

export type GeographicCompatibilityService = {
  id?: string | null;
  label?: string | null;
  startTime: string;
  endTime?: string | null;
  startZone?: string | null;
  endZone?: string | null;
  startArea?: GeoArea;
  endArea?: GeoArea;
};

export type GeographicCompatibilityConfig = {
  sameAreaMinutes?: number;
  crossAreaMinutes?: number;
  unknownZoneMinutes?: number;
  warningMarginMinutes?: number;
};

const DEFAULT_CONFIG = {
  sameAreaMinutes: 10,
  crossAreaMinutes: 20,
  unknownZoneMinutes: 15,
  warningMarginMinutes: 5,
};

const NORTH_WEST_ZONE_PATTERNS = [
  "casamicciola",
  "lacco",
  "forio",
  "sant'angelo",
  "sant angelo",
  "panza",
  "serrara",
  "fontana",
  "cuotto",
  "citara",
];

const EAST_SOUTH_ZONE_PATTERNS = [
  "ischia porto",
  "porto ischia",
  "ischia ponte",
  "barano",
  "fiaiano",
  "cartaromana",
  "testaccio",
  "ischia",
];

export function minutesFromTime(value: string | null | undefined): number {
  const [hourRaw = "0", minuteRaw = "0"] = String(value ?? "").slice(0, 5).split(":");
  const hour = Number.parseInt(hourRaw, 10);
  const minute = Number.parseInt(minuteRaw, 10);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return 0;
  return hour * 60 + minute;
}

export function formatMinutesAsTime(totalMinutes: number): string {
  const normalized = ((totalMinutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
}

export function normalizeGeoZone(value: string | null | undefined): string | null {
  const raw = String(value ?? "").trim();
  if (!raw || raw === "—" || raw.toLowerCase() === "sconosciuto") return null;
  const lower = raw.toLowerCase();
  if (lower.includes("casamicciola")) return "Casamicciola";
  if (lower.includes("lacco")) return "Lacco Ameno";
  if (lower.includes("forio")) return "Forio";
  if (lower.includes("sant") || lower.includes("angelo")) return "Sant'Angelo";
  if (lower.includes("panza")) return "Panza";
  if (lower.includes("serrara") || lower.includes("fontana")) return "Serrara Fontana";
  if (lower.includes("ischia ponte")) return "Ischia Ponte";
  if (lower.includes("ischia porto") || lower.includes("porto ischia") || lower.includes("uscita arrivi")) return "Ischia Porto";
  if (lower === "ischia") return "Ischia Porto";
  if (lower.includes("barano")) return "Barano";
  if (lower.includes("fiaiano")) return "Fiaiano";
  if (lower.includes("cartaromana")) return "Cartaromana";
  return raw;
}

export function zoneToGeoArea(zone: string | null | undefined): GeoArea {
  const normalized = normalizeGeoZone(zone);
  const lower = normalized?.toLowerCase() ?? "";
  if (!lower) return null;
  if (NORTH_WEST_ZONE_PATTERNS.some((pattern) => lower.includes(pattern))) return "nord_ovest";
  if (EAST_SOUTH_ZONE_PATTERNS.some((pattern) => lower.includes(pattern))) return "est_sud";
  return null;
}

export function requiredTransferMinutes(fromArea: GeoArea, toArea: GeoArea, config: GeographicCompatibilityConfig = {}): number {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  if (!fromArea || !toArea) return cfg.unknownZoneMinutes;
  return fromArea === toArea ? cfg.sameAreaMinutes : cfg.crossAreaMinutes;
}

export function validateGeographicCompatibility(
  previousService: GeographicCompatibilityService,
  nextService: GeographicCompatibilityService,
  config: GeographicCompatibilityConfig = {}
): GeographicCompatibilityResult {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const fromZone = normalizeGeoZone(previousService.endZone ?? previousService.startZone);
  const toZone = normalizeGeoZone(nextService.startZone ?? nextService.endZone);
  const fromArea = previousService.endArea ?? zoneToGeoArea(fromZone);
  const toArea = nextService.startArea ?? zoneToGeoArea(toZone);
  const previousEnd = minutesFromTime(previousService.endTime ?? previousService.startTime);
  const nextStart = minutesFromTime(nextService.startTime);
  const availableMinutes = nextStart - previousEnd;
  const requiredMinutes = requiredTransferMinutes(fromArea, toArea, cfg);
  const marginMinutes = availableMinutes - requiredMinutes;

  if (availableMinutes < requiredMinutes) {
    return {
      compatible: false,
      severity: "block",
      requiredMinutes,
      availableMinutes,
      marginMinutes,
      fromZone,
      toZone,
      fromArea,
      toArea,
      reason: `Trasferimento geografico insufficiente: ${availableMinutes} minuti disponibili, ${requiredMinutes} richiesti da ${fromZone ?? "zona sconosciuta"} a ${toZone ?? "zona sconosciuta"}.`,
    };
  }

  if (!fromArea || !toArea) {
    return {
      compatible: true,
      severity: "warning",
      requiredMinutes,
      availableMinutes,
      marginMinutes,
      fromZone,
      toZone,
      fromArea,
      toArea,
      reason: `Zona non completa: verifica manualmente il trasferimento da ${fromZone ?? "zona sconosciuta"} a ${toZone ?? "zona sconosciuta"}.`,
    };
  }

  if (marginMinutes < cfg.warningMarginMinutes) {
    return {
      compatible: true,
      severity: "warning",
      requiredMinutes,
      availableMinutes,
      marginMinutes,
      fromZone,
      toZone,
      fromArea,
      toArea,
      reason: `Margine geografico stretto: ${availableMinutes} minuti disponibili, ${requiredMinutes} richiesti.`,
    };
  }

  return {
    compatible: true,
    severity: "ok",
    requiredMinutes,
    availableMinutes,
    marginMinutes,
    fromZone,
    toZone,
    fromArea,
    toArea,
    reason: "Compatibile.",
  };
}

export function strongestGeographicResult(results: GeographicCompatibilityResult[]): GeographicCompatibilityResult | null {
  if (!results.length) return null;
  return [...results].sort((a, b) => {
    const severityScore: Record<GeoSeverity, number> = { block: 0, warning: 1, ok: 2 };
    return severityScore[a.severity] - severityScore[b.severity] || a.marginMinutes - b.marginMinutes;
  })[0] ?? null;
}

export function geographicBlockMessage(driverName: string, result: GeographicCompatibilityResult): string {
  return [
    "ASSEGNAZIONE IMPOSSIBILE",
    "",
    `L'autista ${driverName} ha gia un servizio in zona ${result.fromZone ?? "sconosciuta"}.`,
    `Il nuovo servizio richiede presenza in zona ${result.toZone ?? "sconosciuta"}.`,
    "",
    `Tempo disponibile: ${result.availableMinutes} minuti.`,
    `Tempo minimo richiesto: ${result.requiredMinutes} minuti.`,
    "",
    "Scegli un altro autista o riassegna uno dei servizi.",
  ].join("\n");
}
