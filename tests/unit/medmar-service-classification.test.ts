import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { isMedmarService } from "@/lib/medmar-service-classification";

describe("isMedmarService — regola condivisa UI/preflight", () => {
  it("A. vessel contenente MEDMAR -> Medmar", () => {
    expect(isMedmarService({ vessel: "MEDMAR", booking_service_kind: null })).toBe(true);
  });

  it("B. formula_medmar_napoli senza Medmar nel vessel -> Medmar", () => {
    expect(isMedmarService({ vessel: "Napoli Porta di Massa", booking_service_kind: "formula_medmar_napoli" })).toBe(true);
  });

  it("C. formula_medmar_pozzuoli senza Medmar nel vessel -> Medmar", () => {
    expect(isMedmarService({ vessel: null, booking_service_kind: "formula_medmar_pozzuoli" })).toBe(true);
  });

  it("D. transfer_port_hotel con transport_code MEDMAR -> Medmar", () => {
    expect(isMedmarService({ vessel: "Ischia Porto", booking_service_kind: "transfer_port_hotel", transport_code: "MEDMAR Pozzuoli 09:40" })).toBe(true);
  });

  it("E. transfer_port_hotel con transport_code SNAV -> NON Medmar", () => {
    expect(isMedmarService({ vessel: "Ischia Porto", booking_service_kind: "transfer_port_hotel", transport_code: "SNAV Napoli 10:15" })).toBe(false);
  });

  it("transport_code MEDMAR su un kind diverso da transfer_port_hotel -> NON Medmar", () => {
    expect(isMedmarService({ vessel: "Ischia Porto", booking_service_kind: "transfer_hotel_hotel", transport_code: "MEDMAR" })).toBe(false);
  });

  it("F. servizio normale senza indicatori Medmar -> NON Medmar", () => {
    expect(isMedmarService({ vessel: "SNAV", booking_service_kind: "formula_snav", transport_code: null })).toBe(false);
    expect(isMedmarService({})).toBe(false);
  });
});

describe("G. UI e preflight usano la stessa funzione condivisa", () => {
  const sources = [
    "app/(app)/biglietti-medmar/page.tsx",
    "lib/server/medmar-booking/preflight.ts",
    "app/api/services/medmar-delivery-summary/route.ts",
  ];

  for (const file of sources) {
    it(`${file} importa isMedmarService da lib/medmar-service-classification e non la ridefinisce`, () => {
      const source = readFileSync(resolve(process.cwd(), file), "utf8");
      expect(source).toMatch(/import\s*\{[^}]*\bisMedmarService\b[^}]*\}\s*from\s*"@\/lib\/medmar-service-classification"/);
      expect(source).not.toMatch(/function\s+isMedmarService\s*\(/);
    });
  }
});
