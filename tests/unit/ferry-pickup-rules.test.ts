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
    direction: "to_ischia",
    boat_type: "traghetto",
    hotel_id: null,
    zone: null,
    transport_from: "08:00",
    transport_to: "09:00",
    company: "medmar",
    departure_time: "09:30",
    embark_port: null,
    arrival_port: "ischia_porto",
    arrival_time: "10:30",
    pickup_time: null,
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

describe("findFerryPickupRule — gap voluti tra fasce consecutive (fix 2026-09-03)", () => {
  // Riproduce le 4 fasce reali del seed di produzione (agency_logic=aleste,
  // transport_type=train, boat_type=traghetto, stagione estiva 2026):
  // 12:15-13:30 / 13:35-13:55 / 14:00-14:15 / 14:20-15:45, con gap voluti tra
  // una fascia e la successiva (mai errori di configurazione).
  const windows = [
    rule({ transport_type: "train", transport_from: "12:15", transport_to: "13:30", departure_time: "13:00", company: "medmar-a" }),
    rule({ transport_type: "train", transport_from: "13:35", transport_to: "13:55", departure_time: "14:20", company: "medmar-b" }),
    rule({ transport_type: "train", transport_from: "14:00", transport_to: "14:15", departure_time: "14:45", company: "medmar-c" }),
    rule({ transport_type: "train", transport_from: "14:20", transport_to: "15:45", departure_time: "16:00", company: "medmar-d" }),
  ];

  it("match normale invariato: 13:40 usa la fascia 13:35-13:55", () => {
    const match = findFerryPickupRule(windows, "aleste", "train", "traghetto", "13:40", "2026-08-30");
    expect(match?.company).toBe("medmar-b");
  });

  it("primo gap: 13:32 (tra 13:30 e 13:35) usa la fascia successiva 13:35-13:55", () => {
    const match = findFerryPickupRule(windows, "aleste", "train", "traghetto", "13:32", "2026-08-30");
    expect(match?.company).toBe("medmar-b");
  });

  it("caso GALLINA ROSELLA: 13:58 (tra 13:55 e 14:00) usa la fascia successiva 14:00-14:15", () => {
    const match = findFerryPickupRule(windows, "aleste", "train", "traghetto", "13:58", "2026-08-30");
    expect(match?.company).toBe("medmar-c");
    expect(match?.departureTime).toBe("14:45");
  });

  it("altro gap: 14:18 (tra 14:15 e 14:20) usa la fascia successiva 14:20-15:45", () => {
    const match = findFerryPickupRule(windows, "aleste", "train", "traghetto", "14:18", "2026-08-30");
    expect(match?.company).toBe("medmar-d");
  });

  it("boundary esatto fine fascia: 13:55 resta nella fascia 13:35-13:55 (non scavalca al gap)", () => {
    const match = findFerryPickupRule(windows, "aleste", "train", "traghetto", "13:55", "2026-08-30");
    expect(match?.company).toBe("medmar-b");
  });

  it("boundary esatto inizio fascia: 14:00 usa la fascia 14:00-14:15 (match diretto, non gap)", () => {
    const match = findFerryPickupRule(windows, "aleste", "train", "traghetto", "14:00", "2026-08-30");
    expect(match?.company).toBe("medmar-c");
  });

  it("dopo l'ultima fascia: nessuna invenzione, comportamento invariato (null)", () => {
    const match = findFerryPickupRule(windows, "aleste", "train", "traghetto", "16:00", "2026-08-30");
    expect(match).toBeNull();
  });

  it("prima della prima fascia: nessuna invenzione, comportamento invariato (null)", () => {
    const match = findFerryPickupRule(windows, "aleste", "train", "traghetto", "10:00", "2026-08-30");
    expect(match).toBeNull();
  });

  it("il gap non salta verso un agency_logic diverso: una regola sosandra nel gap non viene mai proposta per aleste", () => {
    const rulesWithForeignAgency = [
      windows[0]!,
      rule({ transport_type: "train", agency_logic: "sosandra", transport_from: "13:35", transport_to: "13:55", departure_time: "99:99", company: "sosandra-only" }),
      windows[2]!,
    ];
    const match = findFerryPickupRule(rulesWithForeignAgency, "aleste", "train", "traghetto", "13:32", "2026-08-30");
    // Nessuna fascia 'aleste' valida dopo 13:32 se non quella di livello 3 (14:00-14:15): il gap salta quella, non la sosandra.
    expect(match?.company).toBe("medmar-c");
  });

  it("il gap non salta verso un transport_type diverso: una regola 'flight' nel gap non viene mai proposta per 'train'", () => {
    const rulesWithForeignType = [
      windows[0]!,
      rule({ transport_type: "flight", transport_from: "13:35", transport_to: "13:55", departure_time: "99:99", company: "flight-only" }),
      windows[2]!,
    ];
    const match = findFerryPickupRule(rulesWithForeignType, "aleste", "train", "traghetto", "13:32", "2026-08-30");
    expect(match?.company).toBe("medmar-c");
  });

  it("il gap non salta verso un boat_type diverso: una regola 'aliscafo' nel gap non viene mai proposta per 'traghetto'", () => {
    const rulesWithForeignBoat = [
      windows[0]!,
      rule({ transport_type: "train", boat_type: "aliscafo", transport_from: "13:35", transport_to: "13:55", departure_time: "99:99", company: "aliscafo-only" }),
      windows[2]!,
    ];
    const match = findFerryPickupRule(rulesWithForeignBoat, "aleste", "train", "traghetto", "13:32", "2026-08-30");
    expect(match?.company).toBe("medmar-c");
  });

  it("il gap non salta verso una stagione diversa: una regola fuori stagione nel gap non viene mai proposta", () => {
    const rulesWithOffSeason = [
      windows[0]!,
      rule({ transport_type: "train", transport_from: "13:35", transport_to: "13:55", departure_time: "99:99", company: "winter-only", valid_from: "2026-09-16", valid_to: "2027-04-30" }),
      windows[2]!,
    ];
    const match = findFerryPickupRule(rulesWithOffSeason, "aleste", "train", "traghetto", "13:32", "2026-08-30");
    expect(match?.company).toBe("medmar-c");
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

describe("findFerryPickupRule — solo direction=to_ischia (ARRIVI), mai regole PARTENZA", () => {
  it("una regola from_ischia con la stessa fascia/agenzia/tipo non viene mai proposta per un arrivo", () => {
    const rules = [
      rule({ direction: "from_ischia", hotel_id: "hotel-x", transport_from: "08:00", transport_to: "09:00", company: "snav", pickup_time: "07:00" }),
      rule({ direction: "to_ischia", transport_from: "08:00", transport_to: "09:00", company: "medmar" }),
    ];
    const match = findFerryPickupRule(rules, "aleste", "flight", "traghetto", "08:30", "2026-07-01");
    expect(match?.company).toBe("medmar");
  });

  it("righe legacy senza direction esplicita (undefined) sono trattate come to_ischia (default di migrazione)", () => {
    const legacyRow = rule({ company: "caremar" });
    // simula una riga letta dal DB prima della migration (colonna assente = undefined a runtime)
    delete (legacyRow as { direction?: unknown }).direction;
    const match = findFerryPickupRule([legacyRow], "aleste", "flight", "traghetto", "08:30", "2026-07-01");
    expect(match?.company).toBe("caremar");
  });
});

describe("findConflictingRule — direction e scope hotel/zona/generale", () => {
  it("stessa fascia ma direction diversa (to_ischia vs from_ischia) NON è conflitto", () => {
    const existing = [rule({ direction: "to_ischia", transport_from: "08:00", transport_to: "09:00" })];
    const candidate = rule({ direction: "from_ischia", hotel_id: "hotel-colella", zone: "forio", transport_from: "08:00", transport_to: "09:00" });
    expect(findConflictingRule(existing, candidate)).toBeNull();
  });

  it("una regola HOTEL non è mai in conflitto con una regola ZONA per la stessa fascia: è un override lecito", () => {
    const existing = [rule({ direction: "from_ischia", hotel_id: null, zone: "forio", transport_from: "13:20", transport_to: "16:50" })];
    const candidate = rule({ direction: "from_ischia", hotel_id: "hotel-colella", zone: "forio", transport_from: "13:20", transport_to: "16:50" });
    expect(findConflictingRule(existing, candidate)).toBeNull();
  });

  it("due regole HOTEL identiche (stesso hotel_id) con fasce sovrapposte SONO in conflitto reale", () => {
    const existing = [rule({ direction: "from_ischia", hotel_id: "hotel-colella", zone: "forio", transport_from: "13:00", transport_to: "15:00" })];
    const candidate = rule({ direction: "from_ischia", hotel_id: "hotel-colella", zone: "forio", transport_from: "14:00", transport_to: "17:00" });
    expect(findConflictingRule(existing, candidate)).not.toBeNull();
  });

  it("due regole ZONA diverse (forio vs lacco) con fasce sovrapposte NON sono in conflitto", () => {
    const existing = [rule({ direction: "from_ischia", hotel_id: null, zone: "forio", transport_from: "13:00", transport_to: "15:00" })];
    const candidate = rule({ direction: "from_ischia", hotel_id: null, zone: "lacco", transport_from: "13:00", transport_to: "15:00" });
    expect(findConflictingRule(existing, candidate)).toBeNull();
  });

  it("due regole GENERALI (hotel_id e zone entrambi null) con fasce sovrapposte SONO in conflitto", () => {
    const existing = [rule({ direction: "from_ischia", hotel_id: null, zone: null, transport_from: "13:00", transport_to: "15:00" })];
    const candidate = rule({ direction: "from_ischia", hotel_id: null, zone: null, transport_from: "14:00", transport_to: "16:00" });
    expect(findConflictingRule(existing, candidate)).not.toBeNull();
  });
});

describe("findConflictingRule — regole DIRETTE (transport_type='direct', match su departure_time esatto)", () => {
  function directRule(overrides: Partial<FerryPickupRule> = {}): FerryPickupRule {
    return rule({
      transport_type: "direct",
      direction: "from_ischia",
      boat_type: "aliscafo",
      transport_from: null,
      transport_to: null,
      company: "snav",
      departure_time: "07:10",
      embark_port: "casamicciola",
      arrival_port: "napoli_beverello",
      zone: "forio",
      pickup_time: "06:20",
      ...overrides,
    });
  }

  it("stesso departure_time, stessa zona/agenzia: conflitto reale (stessa nave configurata due volte)", () => {
    const existing = [directRule({ departure_time: "07:10" })];
    const candidate = directRule({ departure_time: "07:10" });
    expect(findConflictingRule(existing, candidate)).not.toBeNull();
  });

  it("departure_time diversi: nessun conflitto (sono due corse diverse, non una finestra da confrontare)", () => {
    const existing = [directRule({ departure_time: "07:10" })];
    const candidate = directRule({ departure_time: "09:45" });
    expect(findConflictingRule(existing, candidate)).toBeNull();
  });

  it("stesso departure_time ma zone diverse: nessun conflitto (scope diverso)", () => {
    const existing = [directRule({ departure_time: "07:10", zone: "forio" })];
    const candidate = directRule({ departure_time: "07:10", zone: "lacco" });
    expect(findConflictingRule(existing, candidate)).toBeNull();
  });

  it("stesso departure_time ma agency_logic diversa: nessun conflitto", () => {
    const existing = [directRule({ departure_time: "07:10", agency_logic: "aleste" })];
    const candidate = directRule({ departure_time: "07:10", agency_logic: "sosandra" });
    expect(findConflictingRule(existing, candidate)).toBeNull();
  });

  it("una regola HOTEL diretta non è in conflitto con una regola ZONA diretta per lo stesso departure_time: override lecito", () => {
    const existing = [directRule({ departure_time: "07:10", hotel_id: null, zone: "forio" })];
    const candidate = directRule({ departure_time: "07:10", hotel_id: "hotel-colella", zone: "forio" });
    expect(findConflictingRule(existing, candidate)).toBeNull();
  });

  it("modificare una regola diretta non confligge con se stessa (excludeId)", () => {
    const existing = directRule({ id: "direct-1", departure_time: "07:10" });
    const candidate = { ...existing, pickup_time: "06:25" };
    expect(findConflictingRule([existing], candidate, existing.id)).toBeNull();
  });

  it("regola direct vs regola train con stesso agency_logic/zone/direction: mai in conflitto (transport_type diverso)", () => {
    const existing = [rule({ transport_type: "train", direction: "from_ischia", zone: "forio", transport_from: "07:00", transport_to: "09:00" })];
    const candidate = directRule({ departure_time: "07:10", zone: "forio" });
    expect(findConflictingRule(existing, candidate)).toBeNull();
  });
});
