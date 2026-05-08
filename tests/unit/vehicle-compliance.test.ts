import { describe, it, expect } from "vitest";
import {
  diffDays,
  addDays,
  expiryStatus,
  worstStatus,
  buildStatusLabel,
  getEffectiveExpiry,
  getWarnWindowDays,
  INSURANCE_GRACE_DAYS,
  WARN_DAYS,
  INSURANCE_WARN_WINDOW_DAYS,
} from "@/lib/vehicle-compliance";

describe("diffDays", () => {
  it("valore positivo per data futura", () => {
    expect(diffDays("2026-01-01", "2026-01-11")).toBe(10);
  });

  it("valore negativo per data passata", () => {
    expect(diffDays("2026-01-11", "2026-01-01")).toBe(-10);
  });

  it("zero per stessa data", () => {
    expect(diffDays("2026-06-15", "2026-06-15")).toBe(0);
  });

  it("gestisce cambio mese", () => {
    expect(diffDays("2026-01-28", "2026-02-04")).toBe(7);
  });

  it("gestisce anno bisestile", () => {
    expect(diffDays("2024-02-28", "2024-03-01")).toBe(2);
  });
});

describe("addDays", () => {
  it("aggiunge giorni a una data", () => {
    expect(addDays("2026-01-01", 10)).toBe("2026-01-11");
  });

  it("gestisce cambio mese", () => {
    expect(addDays("2026-01-28", 5)).toBe("2026-02-02");
  });

  it("gestisce cambio anno", () => {
    expect(addDays("2025-12-30", 3)).toBe("2026-01-02");
  });

  it("aggiunge INSURANCE_GRACE_DAYS giorni (proroga assicurazione, art. 170-bis CdA = 15gg)", () => {
    // Costante aggiornata a 15 giorni (era 14) per allineamento normativo
    expect(addDays("2026-10-01", INSURANCE_GRACE_DAYS)).toBe("2026-10-16");
  });

  it("aggiunge 0 giorni (nessuna variazione)", () => {
    expect(addDays("2026-05-15", 0)).toBe("2026-05-15");
  });
});

describe("expiryStatus", () => {
  it("missing se daysLeft è null", () => {
    expect(expiryStatus(null)).toBe("missing");
  });

  it("expired se daysLeft < 0", () => {
    expect(expiryStatus(-1)).toBe("expired");
    expect(expiryStatus(-30)).toBe("expired");
  });

  it("critical se daysLeft === 0", () => {
    expect(expiryStatus(0)).toBe("critical");
  });

  it("critical se daysLeft <= 7", () => {
    expect(expiryStatus(1)).toBe("critical");
    expect(expiryStatus(7)).toBe("critical");
  });

  it("warning se daysLeft è 8 (primo dopo critical)", () => {
    expect(expiryStatus(8)).toBe("warning");
  });

  it("warning se daysLeft <= 30", () => {
    expect(expiryStatus(15)).toBe("warning");
    expect(expiryStatus(30)).toBe("warning");
  });

  it("ok se daysLeft > 30", () => {
    expect(expiryStatus(31)).toBe("ok");
    expect(expiryStatus(365)).toBe("ok");
  });
});

describe("worstStatus", () => {
  it("ok per array vuoto (default)", () => {
    expect(worstStatus([])).toBe("ok");
  });

  it("restituisce l'unico stato per array singolo", () => {
    expect(worstStatus(["critical"])).toBe("critical");
    expect(worstStatus(["expired"])).toBe("expired");
    expect(worstStatus(["ok"])).toBe("ok");
  });

  it("expired vince su tutti gli altri", () => {
    expect(worstStatus(["ok", "warning", "critical", "expired", "missing"])).toBe("expired");
  });

  it("critical vince su warning, missing, ok", () => {
    expect(worstStatus(["ok", "warning", "critical", "missing"])).toBe("critical");
  });

  it("warning vince su missing e ok", () => {
    expect(worstStatus(["ok", "missing", "warning"])).toBe("warning");
  });

  it("missing vince solo su ok", () => {
    expect(worstStatus(["ok", "missing"])).toBe("missing");
  });

  it("ok quando tutti sono ok", () => {
    expect(worstStatus(["ok", "ok", "ok"])).toBe("ok");
  });
});

describe("buildStatusLabel", () => {
  it("SCADUTO da N giorni per valori negativi", () => {
    expect(buildStatusLabel(-1)).toBe("SCADUTO da 1 giorni");
    expect(buildStatusLabel(-30)).toBe("SCADUTO da 30 giorni");
  });

  it("SCADE OGGI per 0 giorni", () => {
    expect(buildStatusLabel(0)).toBe("SCADE OGGI");
  });

  it("forma singolare 'giorno' per 1 giorno", () => {
    expect(buildStatusLabel(1)).toBe("Scade tra 1 giorno");
  });

  it("forma plurale 'giorni' per 2+ giorni", () => {
    expect(buildStatusLabel(2)).toBe("Scade tra 2 giorni");
    expect(buildStatusLabel(30)).toBe("Scade tra 30 giorni");
  });
});

describe("getEffectiveExpiry", () => {
  it("aggiunge INSURANCE_GRACE_DAYS (15gg) per Assicurazione", () => {
    // 2026-10-01 + 15 = 2026-10-16 (aggiornato da 14 a 15 per art. 170-bis CdA)
    expect(getEffectiveExpiry("Assicurazione", "2026-10-01")).toBe("2026-10-16");
  });

  it("Collaudo → fine del mese di scadenza (regola ministeriale)", () => {
    // Il collaudo ha validità fino al ultimo giorno del mese di scadenza
    expect(getEffectiveExpiry("Collaudo", "2026-10-01")).toBe("2026-10-31");
  });

  it("non modifica la data per Bollo", () => {
    expect(getEffectiveExpiry("Bollo", "2026-10-01")).toBe("2026-10-01");
  });

  it("non modifica la data per Estintore", () => {
    expect(getEffectiveExpiry("Estintore", "2026-06-15")).toBe("2026-06-15");
  });

  it("non modifica la data per Tachigrafo", () => {
    expect(getEffectiveExpiry("Tachigrafo", "2026-06-15")).toBe("2026-06-15");
  });
});

describe("getWarnWindowDays", () => {
  it("restituisce INSURANCE_WARN_WINDOW_DAYS (61) per Assicurazione", () => {
    expect(getWarnWindowDays("Assicurazione")).toBe(INSURANCE_WARN_WINDOW_DAYS);
    expect(getWarnWindowDays("Assicurazione")).toBe(61);
  });

  it("restituisce WARN_DAYS (60) per tutti gli altri tipi", () => {
    expect(getWarnWindowDays("Collaudo")).toBe(WARN_DAYS);
    expect(getWarnWindowDays("Bollo")).toBe(WARN_DAYS);
    expect(getWarnWindowDays("Estintore")).toBe(WARN_DAYS);
    expect(getWarnWindowDays("Tachigrafo")).toBe(WARN_DAYS);
    expect(getWarnWindowDays("altro")).toBe(60);
  });
});

describe("costanti esportate", () => {
  it("INSURANCE_GRACE_DAYS è 15 (art. 170-bis CdA)", () => {
    // Aggiornato da 14 a 15 giorni per allineamento normativo
    expect(INSURANCE_GRACE_DAYS).toBe(15);
  });

  it("WARN_DAYS è 60", () => {
    expect(WARN_DAYS).toBe(60);
  });

  it("INSURANCE_WARN_WINDOW_DAYS è 61", () => {
    expect(INSURANCE_WARN_WINDOW_DAYS).toBe(61);
  });
});
