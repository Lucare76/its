import { describe, expect, it } from "vitest";
import {
  buildBusImportPickupTimesMap,
  cleanBusImportPickupTime,
  resolveBusImportDeparturePickupTime,
} from "@/lib/server/bus-import-pickup";

const LINE_CENTRO = "line-centro";
const linesById = new Map([[LINE_CENTRO, { family_code: "CENTRO" }]]);

describe("bus import pickup lookup", () => {
  it("service con pickup presente: legge la source of truth hotel_pickup_times per la Linea Centro", () => {
    const map = buildBusImportPickupTimesMap([
      {
        hotel_name: "HOTEL TERME FELIX",
        pickup_time_linea_italia: "05:15:00",
        pickup_time_linea_centro: "10:10:00",
        pickup_time_linea_adriatica: "10:10:00",
      },
    ]);

    expect(resolveBusImportDeparturePickupTime("HOTEL TERME FELIX", LINE_CENTRO, map, linesById)).toBe("10:10");
  });

  it("service con pickup calcolato dal catalogo: normalizza spazi, accenti e suffisso secondi", () => {
    const map = buildBusImportPickupTimesMap([
      {
        hotel_name: "GRAND HOTEL DELLE TERME RE FERDINANDO",
        pickup_time_linea_italia: "05:15:00",
        pickup_time_linea_centro: "10:10:00",
        pickup_time_linea_adriatica: "10:10:00",
      },
    ]);

    expect(resolveBusImportDeparturePickupTime(" grand  hotel delle terme re ferdinando ", LINE_CENTRO, map, linesById)).toBe("10:10");
  });

  it("equivalente ANGELUZZI / SOLEMARE: nessun fallback inventato se l'hotel manca dal catalogo", () => {
    const map = buildBusImportPickupTimesMap([]);

    expect(resolveBusImportDeparturePickupTime("SOLEMARE", LINE_CENTRO, map, linesById)).toBeNull();
  });

  it("equivalente GALLO KIMBERLY / HOTEL SAN GIOVANNI TERME: nessun fallback inventato se l'hotel manca dal catalogo", () => {
    const map = buildBusImportPickupTimesMap([]);

    expect(resolveBusImportDeparturePickupTime("HOTEL SAN GIOVANNI TERME", LINE_CENTRO, map, linesById)).toBeNull();
  });

  it("00:00 non e' mai considerato un pickup reale", () => {
    expect(cleanBusImportPickupTime("00:00:00")).toBeNull();
    expect(cleanBusImportPickupTime("00:00")).toBeNull();
  });
});
