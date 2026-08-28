import { describe, it, expect } from "vitest";
import {
  buildMedmarConvocationTemplateParams,
  buildMedmarConvocationPreviewText,
  hasValidMedmarTemplateParamCount,
  MEDMAR_TEMPLATE_PARAM_COUNT,
} from "@/lib/medmar-convocation-template";

const exampleRow = {
  customerName: "Luca",
  departureDateLabel: "LUNEDÌ 07 SETTEMBRE",
  hotel: "Hotel La Villa",
  passengers: "2",
  pickupTime: "10:00",
  vesselTime: "11:10",
};

describe("buildMedmarConvocationTemplateParams", () => {
  it("builds exactly 6 ordered {{1}}..{{6}} params in the definitive Meta mapping", () => {
    const params = buildMedmarConvocationTemplateParams(exampleRow);
    expect(params).toEqual({
      "1": "Luca",
      "2": "LUNEDÌ 07 SETTEMBRE",
      "3": "Hotel La Villa",
      "4": "2",
      "5": "10:00",
      "6": "11:10",
    });
  });

  it("hasValidMedmarTemplateParamCount requires exactly 6 params", () => {
    expect(MEDMAR_TEMPLATE_PARAM_COUNT).toBe(6);
    expect(hasValidMedmarTemplateParamCount(buildMedmarConvocationTemplateParams(exampleRow))).toBe(true);
    expect(hasValidMedmarTemplateParamCount({ "1": "a", "2": "b" })).toBe(false);
    expect(hasValidMedmarTemplateParamCount({ "1": "a", "2": "b", "3": "c", "4": "d", "5": "e", "6": "f", "7": "g" })).toBe(false);
  });
});

describe("buildMedmarConvocationPreviewText — must be byte-for-byte the partenze_medmar template", () => {
  it("matches the approved template exactly for the worked example", () => {
    const preview = buildMedmarConvocationPreviewText(exampleRow);
    expect(preview).toBe(
      `Ciao Luca 👋

🚢 PROGRAMMA DELLA TUA PARTENZA – LUNEDÌ 07 SETTEMBRE

🏨 Hotel: Hotel La Villa
👥 Passeggeri: 2

🧳 Ti ricordiamo che il prelevamento con bagagli è previsto all’esterno dell’hotel alle ore 10:00.

⛴️ Successivamente, imbarco con nave MEDMAR delle ore 11:10.

🎫 Ricorda di portare con te i biglietti del traghetto: saranno necessari per accedere all’imbarco.

Ti consigliamo di essere pronto qualche minuto prima dell’orario indicato. 😊

Buon viaggio!
Ischia Transfer Service 🚐🌊`,
    );
  });

  it("contains the expected fragments and none of the retired old-template fragments", () => {
    const preview = buildMedmarConvocationPreviewText(exampleRow);
    expect(preview).toContain("Ciao Luca");
    expect(preview).toContain("LUNEDÌ 07 SETTEMBRE");
    expect(preview).toContain("Hotel La Villa");
    expect(preview).toContain("Passeggeri: 2");
    expect(preview).toContain("10:00");
    expect(preview).toContain("11:10");

    expect(preview).not.toContain("GMT");
    expect(preview).not.toContain("1899");
    expect(preview).not.toContain("Tratta");
    expect(preview).not.toContain("Riferimento");
    expect(preview).not.toContain("Compagnia");
    expect(preview).not.toContain("ti comunichiamo la convocazione per la tua traversata");
  });
});
