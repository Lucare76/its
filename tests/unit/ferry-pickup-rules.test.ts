import { describe, it, expect } from "vitest";
import {
  findConflictingRule,
  findFerryPickupRule,
  getRuleActivityStatus,
  isTransportWindowValid,
  resolveAgencyLogic,
  type FerryPickupRule,
} from "@/lib/ferry-pickup-rules";

let ruleCounter = 0;
function rule(overrides: Partial<FerryPickupRule> = {}): FerryPickupRule {
  ruleCounter += 1;
  return {
    id: `rule-${ruleCounter}`,
    agency_logic: "aleste",
    transport_type: "flight",
    boat_type: "traghetto",
    transport_from: "08:00",
    transport_to: "09:00",
    company: "medmar",
    departure_time: "09:30",
    arrival_port: "ischia_porto",
    arrival_time: "10:30",
    valid_from: null,
    valid_to: null,
    days_of_week: null,
    season_notes: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("isTransportWindowValid — OBIETTIVO 1", () => {
  it("5. 14:00 -> 10:00 viene rifiutato", () => {
    expect(isTransportWindowValid("14:00", "10:00")).toBe(false);
  });

  it("6. 08:00 -> 09:00 viene accettato", () => {
    expect(isTransportWindowValid("08:00", "09:00")).toBe(true);
  });

  it("7. orari uguali vengono rifiutati", () => {
    expect(isTransportWindowValid("10:00", "10:00")).toBe(false);
  });
});

describe("findConflictingRule — OBIETTIVO 2 (overlap reale secondo il matcher)", () => {
  it("8. overlap reale (stessa terna, finestre che si sovrappongono) viene rilevato", () => {
    const existing = rule({ transport_from: "08:35", transport_to: "10:00", company: "caremar" });
    const candidate = { ...rule({ transport_from: "09:00", transport_to: "10:30" }) };
    const conflict = findConflictingRule([existing], candidate);
    expect(conflict?.id).toBe(existing.id);
  });

  it("9. fasce adiacenti (08:00-09:00 / 09:00-10:00) NON sono overlap", () => {
    const existing = rule({ transport_from: "08:00", transport_to: "09:00" });
    const candidate = rule({ transport_from: "09:00", transport_to: "10:00" });
    expect(findConflictingRule([existing], candidate)).toBeNull();
  });

  it("10. la modifica di una regola non confligge con se stessa (excludeId)", () => {
    const existing = rule({ id: "same-rule", transport_from: "08:00", transport_to: "09:00" });
    const candidate = { ...existing, transport_from: "08:05" };
    expect(findConflictingRule([existing], candidate, existing.id)).toBeNull();
  });

  it("11. stessa fascia ma giorni settimana incompatibili non genera falso conflitto", () => {
    const existing = rule({ transport_from: "08:00", transport_to: "09:00", days_of_week: [1, 2] });
    const candidate = rule({ transport_from: "08:00", transport_to: "09:00", days_of_week: [6, 0] });
    expect(findConflictingRule([existing], candidate)).toBeNull();
  });

  it("11b. stessa fascia con giorni settimana che condividono almeno un giorno genera conflitto", () => {
    const existing = rule({ transport_from: "08:00", transport_to: "09:00", days_of_week: [1, 5] });
    const candidate = rule({ transport_from: "08:00", transport_to: "09:00", days_of_week: [5, 6] });
    expect(findConflictingRule([existing], candidate)?.id).toBe(existing.id);
  });

  it("12. stessa fascia ma periodi stagionali non sovrapposti non genera falso conflitto", () => {
    const existing = rule({ transport_from: "08:00", transport_to: "09:00", valid_from: "2026-05-01", valid_to: "2026-09-15" });
    const candidate = rule({ transport_from: "08:00", transport_to: "09:00", valid_from: "2026-09-16", valid_to: "2027-04-30" });
    expect(findConflictingRule([existing], candidate)).toBeNull();
  });

  it("12b. periodi stagionali sovrapposti generano conflitto", () => {
    const existing = rule({ transport_from: "08:00", transport_to: "09:00", valid_from: "2026-06-01", valid_to: "2026-09-30" });
    const candidate = rule({ transport_from: "08:00", transport_to: "09:00", valid_from: "2026-09-01", valid_to: "2027-04-30" });
    expect(findConflictingRule([existing], candidate)?.id).toBe(existing.id);
  });

  it("13. stessa fascia ma tipo mezzo (boat_type) incompatibile non genera falso conflitto", () => {
    const existing = rule({ transport_from: "08:00", transport_to: "09:00", boat_type: "traghetto" });
    const candidate = rule({ transport_from: "08:00", transport_to: "09:00", boat_type: "aliscafo" });
    expect(findConflictingRule([existing], candidate)).toBeNull();
  });

  it("14. stessa fascia ma agency_logic diverso (altro discriminator reale) non genera falso conflitto", () => {
    const existing = rule({ transport_from: "08:00", transport_to: "09:00", agency_logic: "aleste" });
    const candidate = rule({ transport_from: "08:00", transport_to: "09:00", agency_logic: "sosandra" });
    expect(findConflictingRule([existing], candidate)).toBeNull();
  });

  it("14b. transport_type diverso (treno vs volo) non genera falso conflitto", () => {
    const existing = rule({ transport_from: "08:00", transport_to: "09:00", transport_type: "flight" });
    const candidate = rule({ transport_from: "08:00", transport_to: "09:00", transport_type: "train" });
    expect(findConflictingRule([existing], candidate)).toBeNull();
  });

  it("15. una regola SNAV per un'agenzia diversa da Sosandra (agency_logic 'aleste') viene valutata dal matcher reale e NON scartata automaticamente", () => {
    const existingAleste = rule({
      agency_logic: "aleste",
      boat_type: "aliscafo",
      transport_from: "07:00",
      transport_to: "08:00",
      company: "medmar", // compagnia diversa, ma stessa terna+finestra: deve comunque confliggere
    });
    const candidateSnavAleste = rule({
      agency_logic: "aleste",
      boat_type: "aliscafo",
      transport_from: "07:30",
      transport_to: "08:30",
      company: "snav",
    });
    // Il conflitto si basa su agency_logic/transport_type/boat_type + finestra, MAI sulla compagnia:
    // una regola SNAV in agency_logic='aleste' compete regolarmente con le altre regole 'aleste'.
    expect(findConflictingRule([existingAleste], candidateSnavAleste)?.id).toBe(existingAleste.id);
  });

  it("16. una regola SNAV 'aleste' non confligge con una regola SNAV 'sosandra' identica per il resto: SNAV non è trattata come logica esclusiva di Sosandra né come gruppo a parte", () => {
    const snavAleste = rule({ agency_logic: "aleste", boat_type: "aliscafo", transport_from: "07:00", transport_to: "08:00", company: "snav" });
    const snavSosandra = rule({ agency_logic: "sosandra", boat_type: "aliscafo", transport_from: "07:00", transport_to: "08:00", company: "snav" });
    // Diverso agency_logic -> nessun conflitto, esattamente come per qualunque altra coppia di agency_logic diversi.
    expect(findConflictingRule([snavAleste], snavSosandra)).toBeNull();
    // Ma una seconda regola SNAV 'aleste' con finestra sovrapposta DEVE confliggere come qualsiasi altra coppia 'aleste'.
    const secondSnavAleste = rule({ agency_logic: "aleste", boat_type: "aliscafo", transport_from: "07:30", transport_to: "08:30", company: "snav" });
    expect(findConflictingRule([snavAleste], secondSnavAleste)?.id).toBe(snavAleste.id);
  });
});

describe("getRuleActivityStatus — OBIETTIVO 3", () => {
  const TODAY = "2026-07-10"; // giovedì

  it("17. restituisce 'active_today' quando data e giorno settimana sono compatibili", () => {
    const r = rule({ valid_from: "2026-05-01", valid_to: "2026-09-15", days_of_week: null });
    expect(getRuleActivityStatus(r, TODAY)).toBe("active_today");
  });

  it("18. restituisce 'off_season' quando la data non rientra nel periodo di validità", () => {
    const r = rule({ valid_from: "2026-09-16", valid_to: "2027-04-30" });
    expect(getRuleActivityStatus(r, TODAY)).toBe("off_season");
  });

  it("19. restituisce 'inactive_today' quando la stagione è valida ma il giorno settimana no", () => {
    // 2026-07-10 è giovedì (getDay()===4); la regola vale solo lun/mar (1,2)
    const r = rule({ valid_from: "2026-05-01", valid_to: "2026-09-15", days_of_week: [1, 2] });
    expect(getRuleActivityStatus(r, TODAY)).toBe("inactive_today");
  });

  it("20. una regola annuale (valid_from/valid_to null) è considerata valida per il periodo annuale", () => {
    const r = rule({ valid_from: null, valid_to: null, days_of_week: null });
    expect(getRuleActivityStatus(r, "2026-01-01")).toBe("active_today");
    expect(getRuleActivityStatus(r, "2026-12-31")).toBe("active_today");
  });

  it("21. una stagione a cavallo dell'anno (es. 2026-09-16 -> 2027-04-30) viene gestita correttamente", () => {
    const r = rule({ valid_from: "2026-09-16", valid_to: "2027-04-30", days_of_week: null });
    expect(getRuleActivityStatus(r, "2027-01-15")).toBe("active_today");
    expect(getRuleActivityStatus(r, "2026-09-15")).toBe("off_season");
    expect(getRuleActivityStatus(r, "2027-05-01")).toBe("off_season");
  });
});

describe("findFerryPickupRule — OBIETTIVO 5 (regressione matcher + ambiguità reale)", () => {
  it("25. una configurazione valida (nessun overlap) produce la stessa corsa nave prevista prima della modifica", () => {
    const rules = [
      rule({ agency_logic: "aleste", transport_type: "flight", boat_type: "traghetto", transport_from: "08:05", transport_to: "08:30", company: "caremar", departure_time: "09:25", arrival_port: "ischia_porto", arrival_time: "11:00" }),
      rule({ agency_logic: "aleste", transport_type: "flight", boat_type: "traghetto", transport_from: "08:35", transport_to: "10:00", company: "caremar", departure_time: "10:45", arrival_port: "ischia_porto", arrival_time: "12:15" }),
    ];
    const match = findFerryPickupRule(rules, "aleste", "flight", "traghetto", "08:20", "2026-07-01");
    expect(match?.company).toBe("caremar");
    expect(match?.departureTime).toBe("09:25");
  });

  it("26. una situazione realmente ambigua (due regole sosandra/flight/aliscafo 10:05-10:45 con periodi sovrapposti a settembre) viene rilevata da findConflictingRule prima del salvataggio", () => {
    // Riproduce la reale sovrapposizione presente nel seed di produzione
    // (migration 0187): 'snav' valido 2026-06-01..2026-09-30 e 'alilauro'
    // valido 2026-09-01..2027-04-30, stessa finestra 10:05-10:45 — per tutto
    // settembre 2026 il matcher sceglierebbe in modo implicito/fragile
    // tramite il tie-break su valid_from. Il nuovo guard la blocca in scrittura.
    const snav = rule({
      agency_logic: "sosandra", transport_type: "flight", boat_type: "aliscafo",
      transport_from: "10:05", transport_to: "10:45", company: "snav",
      valid_from: "2026-06-01", valid_to: "2026-09-30",
    });
    const alilauro = rule({
      agency_logic: "sosandra", transport_type: "flight", boat_type: "aliscafo",
      transport_from: "10:05", transport_to: "10:45", company: "alilauro",
      valid_from: "2026-09-01", valid_to: "2027-04-30",
    });
    expect(findConflictingRule([snav], alilauro)?.id).toBe(snav.id);

    // Il matcher, allo stato attuale (senza modificare il tie-break), risolve
    // comunque l'ambiguità in modo deterministico ma "fragile": vince il
    // valid_from più recente -> per settembre 2026 sceglie 'alilauro' anche
    // se i season_notes originali intendevano 'snav' fino a fine settembre.
    const both = [snav, alilauro];
    const matchInSeptember = findFerryPickupRule(both, "sosandra", "flight", "aliscafo", "10:20", "2026-09-15");
    expect(matchInSeptember?.company).toBe("alilauro");
  });

  it("27. SNAV continua a funzionare anche per le altre agenzie ('aleste') secondo la logica già esistente", () => {
    const rules = [
      rule({ agency_logic: "aleste", transport_type: "train", boat_type: "aliscafo", transport_from: "07:00", transport_to: "08:00", company: "snav", departure_time: "08:30", arrival_port: "casamicciola", arrival_time: "09:30" }),
    ];
    const match = findFerryPickupRule(rules, "aleste", "train", "aliscafo", "07:30", "2026-07-01");
    expect(match?.company).toBe("snav");
  });
});

describe("resolveAgencyLogic — VINCOLO 2 (SNAV non è esclusiva di Sosandra)", () => {
  it("riconosce 'sosandra' solo dal nome dell'agenzia, non dalla compagnia nave usata nelle sue regole", () => {
    expect(resolveAgencyLogic("Sosandra Viaggi")).toBe("sosandra");
    expect(resolveAgencyLogic("Aleste Viaggi")).toBe("aleste");
    expect(resolveAgencyLogic("Qualunque Altra Agenzia")).toBe("aleste");
    expect(resolveAgencyLogic(null)).toBe("aleste");
  });
});
