import { describe, expect, it } from "vitest";
import { getWhatsAppOfficeHoursStatus } from "@/lib/server/whatsapp/office-hours";

describe("getWhatsAppOfficeHoursStatus", () => {
  it("considera aperto lunedi alle 09:00 Europe/Rome", () => {
    const result = getWhatsAppOfficeHoursStatus("2026-06-29T07:00:00.000Z");

    expect(result.result).toBe("in_orario");
    expect(result.closureWindowKey).toBeNull();
    expect(result.timestampEuropeRome).toContain("09:00:00");
  });

  it("considera aperto sabato alle 19:29 Europe/Rome", () => {
    const result = getWhatsAppOfficeHoursStatus("2026-06-27T17:29:00.000Z");

    expect(result.isOpen).toBe(true);
    expect(result.result).toBe("in_orario");
  });

  it("considera chiuso dalle 19:30 Europe/Rome", () => {
    const result = getWhatsAppOfficeHoursStatus("2026-06-29T17:30:00.000Z");

    expect(result.isOpen).toBe(false);
    expect(result.result).toBe("fuori_orario");
    expect(result.closureWindowKey).toBe("office_closed:2026-06-29T19:30:00+Europe/Rome");
  });

  it("mantiene una sola finestra da sabato sera a lunedi prima apertura", () => {
    const saturdayNight = getWhatsAppOfficeHoursStatus("2026-03-28T19:00:00.000Z");
    const sundayDuringDstSwitch = getWhatsAppOfficeHoursStatus("2026-03-29T10:00:00.000Z");
    const mondayBeforeOpening = getWhatsAppOfficeHoursStatus("2026-03-30T06:30:00.000Z");

    expect(saturdayNight.closureWindowKey).toBe("office_closed:2026-03-28T19:30:00+Europe/Rome");
    expect(sundayDuringDstSwitch.isSunday).toBe(true);
    expect(sundayDuringDstSwitch.closureWindowKey).toBe(saturdayNight.closureWindowKey);
    expect(mondayBeforeOpening.closureWindowKey).toBe(saturdayNight.closureWindowKey);
  });

  it("apre una nuova finestra quando l'ufficio riapre e richiude", () => {
    const mondayBeforeOpening = getWhatsAppOfficeHoursStatus("2026-06-29T06:30:00.000Z");
    const mondayNight = getWhatsAppOfficeHoursStatus("2026-06-29T20:00:00.000Z");

    expect(mondayBeforeOpening.closureWindowKey).toBe("office_closed:2026-06-27T19:30:00+Europe/Rome");
    expect(mondayNight.closureWindowKey).toBe("office_closed:2026-06-29T19:30:00+Europe/Rome");
  });
});
