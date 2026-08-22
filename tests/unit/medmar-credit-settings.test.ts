import { describe, expect, it } from "vitest";
import {
  sumMedmarTopupsCents,
  sumMedmarIssuedCentsForCredit,
  resolveMedmarManualCredit,
  MEDMAR_DEFAULT_SAFETY_THRESHOLD_CENTS,
  type MedmarCreditSettingsRow,
} from "@/lib/server/medmar-booking/credit-settings";

describe("sumMedmarTopupsCents", () => {
  it("1. somma piu' ricariche", () => {
    expect(sumMedmarTopupsCents([{ amount_cents: 10000 }, { amount_cents: 5000 }])).toBe(15000);
  });

  it("2. nessuna ricarica -> 0", () => {
    expect(sumMedmarTopupsCents([])).toBe(0);
  });

  it("3. ignora importi non finiti (mai NaN propagato)", () => {
    expect(sumMedmarTopupsCents([{ amount_cents: 1000 }, { amount_cents: Number.NaN }])).toBe(1000);
  });
});

describe("sumMedmarIssuedCentsForCredit", () => {
  it("1. somma solo le emissioni completed con final_total_cents valorizzato", () => {
    const rows = [
      { status: "completed", final_total_cents: 5000 },
      { status: "completed", final_total_cents: 3000 },
      { status: "preflight_started", final_total_cents: 9999 },
      { status: "completed", final_total_cents: null },
    ];
    expect(sumMedmarIssuedCentsForCredit(rows)).toBe(8000);
  });

  it("2. nessuna riga -> 0", () => {
    expect(sumMedmarIssuedCentsForCredit([])).toBe(0);
  });
});

describe("resolveMedmarManualCredit — priorita' DB > env > unavailable", () => {
  const settings: MedmarCreditSettingsRow = {
    initial_credit_cents: 100000,
    safety_threshold_cents: 25000,
    updated_at: "2026-08-22T08:00:00.000Z",
  };

  it("1. setting DB presente -> 'manual_estimated', available = iniziale + ricariche - emesso", () => {
    const result = resolveMedmarManualCredit({
      settings,
      totalTopupsCents: 20000,
      totalIssuedCents: 30000,
    });
    expect(result).toEqual({
      type: "manual_estimated",
      initial_credit_cents: 100000,
      total_topups_cents: 20000,
      total_issued_cents: 30000,
      available_cents: 90000, // 100000 + 20000 - 30000
      safety_threshold_cents: 25000,
      updated_at: "2026-08-22T08:00:00.000Z",
    });
  });

  it("2. ricariche multiple gia' sommate a monte -> il calcolo usa il totale passato", () => {
    const result = resolveMedmarManualCredit({ settings, totalTopupsCents: 0, totalIssuedCents: 0 });
    expect(result.available_cents).toBe(100000);
  });

  it("3. manca setting DB, env valida -> fallback 'env_estimated' (mai 'manual_estimated' senza DB)", () => {
    const result = resolveMedmarManualCredit({
      settings: null,
      totalTopupsCents: 0,
      totalIssuedCents: 0,
      envManualCreditCents: "150000",
    });
    expect(result.type).toBe("env_estimated");
    expect(result.available_cents).toBe(150000);
    expect(result.initial_credit_cents).toBeNull();
    expect(result.safety_threshold_cents).toBe(MEDMAR_DEFAULT_SAFETY_THRESHOLD_CENTS);
  });

  it("4. manca setting DB ed env -> 'unavailable', mai un valore inventato", () => {
    const result = resolveMedmarManualCredit({ settings: null, totalTopupsCents: 0, totalIssuedCents: 0 });
    expect(result).toEqual({
      type: "unavailable",
      initial_credit_cents: null,
      total_topups_cents: null,
      total_issued_cents: null,
      available_cents: null,
      safety_threshold_cents: MEDMAR_DEFAULT_SAFETY_THRESHOLD_CENTS,
      updated_at: null,
    });
  });

  it("5. setting DB presente ha SEMPRE priorita' sull'env, anche se l'env e' configurata", () => {
    const result = resolveMedmarManualCredit({
      settings,
      totalTopupsCents: 0,
      totalIssuedCents: 0,
      envManualCreditCents: "999999999",
    });
    expect(result.type).toBe("manual_estimated");
    expect(result.available_cents).toBe(100000);
  });

  it("6. env non numerica -> 'unavailable' (mai un parse silenzioso a 0)", () => {
    const result = resolveMedmarManualCredit({ settings: null, totalTopupsCents: 0, totalIssuedCents: 0, envManualCreditCents: "non-un-numero" });
    expect(result.type).toBe("unavailable");
  });

  it("7. env negativa -> 'unavailable'", () => {
    const result = resolveMedmarManualCredit({ settings: null, totalTopupsCents: 0, totalIssuedCents: 0, envManualCreditCents: "-100" });
    expect(result.type).toBe("unavailable");
  });

  it("8. available_cents puo' essere negativo (credito esaurito), mai clampato silenziosamente", () => {
    const result = resolveMedmarManualCredit({ settings, totalTopupsCents: 0, totalIssuedCents: 500000 });
    expect(result.available_cents).toBe(-400000);
  });
});
