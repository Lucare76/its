import { describe, it, expect } from "vitest";
import {
  buildSnavConvocationTemplateParams,
  buildSnavConvocationPreviewText,
  hasValidSnavTemplateParamCount,
  DEFAULT_SNAV_CONVOCATION_TEMPLATE,
  SNAV_TEMPLATE_PARAM_COUNT,
} from "@/lib/snav-convocation-template";

const exampleRow = {
  customerName: "Luca",
  departureDateLabel: "DOMENICA 30 AGOSTO",
  hotel: "Hotel Park Imperial",
  passengers: "3",
  pickupTime: "16:40",
  vesselTime: "17:40",
};

describe("partenze_snav — template name / env", () => {
  it("defaults to partenze_snav", () => {
    expect(DEFAULT_SNAV_CONVOCATION_TEMPLATE).toBe(process.env.WHATSAPP_SNAV_CONVOCATION_TEMPLATE?.trim() || "partenze_snav");
  });
});

describe("buildSnavConvocationTemplateParams — exactly 6 ordered params", () => {
  it("builds {{1}}..{{6}} in the definitive SNAV mapping", () => {
    expect(buildSnavConvocationTemplateParams(exampleRow)).toEqual({
      "1": "Luca",
      "2": "DOMENICA 30 AGOSTO",
      "3": "Hotel Park Imperial",
      "4": "3",
      "5": "16:40",
      "6": "17:40",
    });
  });

  it("hasValidSnavTemplateParamCount requires exactly 6", () => {
    expect(SNAV_TEMPLATE_PARAM_COUNT).toBe(6);
    expect(hasValidSnavTemplateParamCount(buildSnavConvocationTemplateParams(exampleRow))).toBe(true);
    expect(hasValidSnavTemplateParamCount({ "1": "a", "2": "b" })).toBe(false);
    expect(hasValidSnavTemplateParamCount({ "1": "a", "2": "b", "3": "c", "4": "d", "5": "e", "6": "f", "7": "g" })).toBe(false);
  });
});

describe("buildSnavConvocationPreviewText — must equal the approved partenze_snav body", () => {
  it("matches byte-for-byte for the worked example", () => {
    expect(buildSnavConvocationPreviewText(exampleRow)).toBe(
      `Gentile Luca 👋

🚢 PROGRAMMA DELLA TUA PARTENZA – DOMENICA 30 AGOSTO

🏨 Hotel: Hotel Park Imperial
👥 Passeggeri: 3

🧳 Ti ricordiamo che il prelevamento con bagagli è previsto all’esterno dell’hotel alle ore 16:40.

⛴️ Successivamente, imbarco da Casamicciola con aliscafo SNAV delle ore 17:40 per Napoli.

🎫 Ricorda di portare con te i biglietti dell’aliscafo: saranno necessari per accedere all’imbarco.

Ti consigliamo di essere pronto qualche minuto prima dell’orario indicato. 😊

Buon viaggio!
Ischia Transfer Service 🚐🌊`,
    );
  });

  it("contains the expected fragments", () => {
    const preview = buildSnavConvocationPreviewText(exampleRow);
    expect(preview).toContain("Gentile Luca");
    expect(preview).toContain("DOMENICA 30 AGOSTO");
    expect(preview).toContain("Hotel Park Imperial");
    expect(preview).toContain("Passeggeri: 3");
    expect(preview).toContain("16:40");
    expect(preview).toContain("17:40");
    expect(preview).toContain("Casamicciola");
    expect(preview).toContain("SNAV");
    expect(preview).toContain("Napoli");
  });

  it("never contains GMT / 1899 / tratta / compagnia / riferimento", () => {
    const preview = buildSnavConvocationPreviewText(exampleRow).toLowerCase();
    expect(preview).not.toContain("gmt");
    expect(preview).not.toContain("1899");
    expect(preview).not.toContain("tratta");
    expect(preview).not.toContain("compagnia");
    expect(preview).not.toContain("riferimento");
    expect(preview).not.toContain("porto");
  });
});
