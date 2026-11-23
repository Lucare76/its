import { describe, expect, it } from "vitest";
import { utaNetFromGross } from "@/lib/fuel-cost";

describe("costo netto UTA", () => {
  it("conserva quattro decimali dopo aver scorporato l'IVA dal pagato", () => {
    expect(utaNetFromGross(50)).toBe(40.9836);
    expect(utaNetFromGross(386.01)).toBe(316.4016);
  });
});
