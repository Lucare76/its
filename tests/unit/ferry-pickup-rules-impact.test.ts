import { describe, expect, it } from "vitest";
import {
  serviceMatchesRuleForImpact,
  mergeRuleOverride,
  kindMatchesTransportType,
  resolveAgencyLogicFromName,
  type ImpactRule,
  type ImpactServiceCandidate,
} from "@/lib/ferry-pickup-rules-impact";

function rule(overrides: Partial<ImpactRule> = {}): ImpactRule {
  return {
    direction: "from_ischia",
    transport_type: "direct",
    company: "snav",
    departure_time: "07:10",
    transport_from: null,
    transport_to: null,
    zone: "ischia",
    hotel_id: null,
    agency_logic: "aleste",
    ...overrides,
  };
}

function service(overrides: Partial<ImpactServiceCandidate> = {}): ImpactServiceCandidate {
  return {
    id: "svc-1",
    time: "07:10",
    hotel_id: null,
    booking_service_kind: "formula_snav",
    billing_party_name: "ALESTE VIAGGI",
    vessel: null,
    hotel_zone_raw: "Ischia Porto",
    ...overrides,
  };
}

describe("serviceMatchesRuleForImpact — regressione bug 2026-08-30 (zona non normalizzata)", () => {
  it("1. hotels.zone testo libero capitalizzato ('Ischia Porto') fa match con rule.zone='ischia' (prima del fix: mai)", () => {
    expect(serviceMatchesRuleForImpact(rule({ zone: "ischia" }), service({ hotel_zone_raw: "Ischia Porto" }))).toBe(true);
  });

  it("2. stesso bug con 'Ischia Ponte' -> normalizza comunque a 'ischia' (caso reale del rule id ccf47250 sul DB)", () => {
    expect(serviceMatchesRuleForImpact(rule({ zone: "ischia" }), service({ hotel_zone_raw: "Ischia Ponte" }))).toBe(true);
  });

  it("3. 'Forio' normalizza a 'forio', non matcha una regola zone='ischia'", () => {
    expect(serviceMatchesRuleForImpact(rule({ zone: "ischia" }), service({ hotel_zone_raw: "Forio" }))).toBe(false);
  });

  it("4. 'Lacco Ameno' normalizza a 'lacco', matcha una regola zone='lacco'", () => {
    expect(serviceMatchesRuleForImpact(rule({ zone: "lacco" }), service({ hotel_zone_raw: "Lacco Ameno" }))).toBe(true);
  });
});

describe("serviceMatchesRuleForImpact — modifica pickup_time con servizi futuri", () => {
  it("5. il match non dipende da pickup_time (non è un campo di scope): un servizio futuro nella stessa fascia/zona/compagnia risulta comunque impattato", () => {
    // pickup_time non è nemmeno un campo di ImpactRule: la modifica 06:30->06:25
    // segnalata nel bug report non cambia il matching, cambia solo il valore
    // che i clienti riceveranno — corretto che il match resti identico.
    expect(serviceMatchesRuleForImpact(rule({}), service({}))).toBe(true);
  });
});

describe("serviceMatchesRuleForImpact — modifica nave (departure_time/company) con servizi futuri", () => {
  it("6. cambiare departure_time nel draft (07:10 -> 09:45) fa sparire il match su un servizio ancora alle 07:10", () => {
    const draft = mergeRuleOverride(rule({}), { departure_time: "09:45" });
    expect(serviceMatchesRuleForImpact(draft, service({ time: "07:10" }))).toBe(false);
  });

  it("7. cambiare company (snav -> medmar) nel draft: un servizio formula_snav non matcha più una regola medmar", () => {
    const draft = mergeRuleOverride(rule({ company: "snav" }), { company: "medmar" });
    expect(serviceMatchesRuleForImpact(draft, service({ booking_service_kind: "formula_snav" }))).toBe(false);
  });

  it("7b. transfer_port_hotel con vessel SNAV non conta come impatto per una regola MEDMAR allo stesso orario (company-aware fix)", () => {
    const medmarRule = rule({ company: "medmar" });
    const snavPortHotelService = service({ booking_service_kind: "transfer_port_hotel", vessel: "SNAV 07:10" });
    expect(serviceMatchesRuleForImpact(medmarRule, snavPortHotelService)).toBe(false);
  });

  it("7c. transfer_port_hotel con vessel MEDMAR conta come impatto per la regola MEDMAR corrispondente", () => {
    const medmarRule = rule({ company: "medmar" });
    const medmarPortHotelService = service({ booking_service_kind: "transfer_port_hotel", vessel: "MEDMAR 07:10" });
    expect(serviceMatchesRuleForImpact(medmarRule, medmarPortHotelService)).toBe(true);
  });
});

describe("serviceMatchesRuleForImpact — sent_convocations (a monte: solo il servizio conta, il conteggio convocazioni è nel route)", () => {
  it("8. un servizio matchato è il presupposto per contare le convocazioni già inviate (verificato lato route con .in(service_id))", () => {
    // Il conteggio sent_convocations vive nel route handler (query separata su
    // medmar/snav_convocation_rows filtrata per service_id in [...matched]).
    // Qui verifichiamo solo il presupposto: se il servizio non matcha, non
    // puo' mai entrare nel set di service_id passato a quella query.
    expect(serviceMatchesRuleForImpact(rule({}), service({}))).toBe(true);
  });
});

describe("serviceMatchesRuleForImpact — impact 0 quando non c'è nessun servizio futuro reale coinvolto", () => {
  it("9. nessun servizio nella lista -> il chiamante (route) restituisce futureServices=0, save diretto lecito", () => {
    const services: ImpactServiceCandidate[] = [];
    const matched = services.filter((s) => serviceMatchesRuleForImpact(rule({}), s));
    expect(matched.length).toBe(0);
  });
});

describe("serviceMatchesRuleForImpact — agency_logic", () => {
  it("10. billing_party_name con 'Sosandra' -> agency_logic sosandra, non matcha una regola aleste", () => {
    expect(serviceMatchesRuleForImpact(rule({ agency_logic: "aleste" }), service({ billing_party_name: "SOSANDRA TOUR" }))).toBe(false);
  });

  it("11. resolveAgencyLogicFromName: qualunque nome senza 'sosandra' è aleste (default)", () => {
    expect(resolveAgencyLogicFromName("Zigolo Viaggi")).toBe("aleste");
    expect(resolveAgencyLogicFromName(null)).toBe("aleste");
    expect(resolveAgencyLogicFromName("Sosandra Travel")).toBe("sosandra");
  });
});

describe("kindMatchesTransportType", () => {
  it("12. train/flight/direct sono riconosciuti correttamente", () => {
    expect(kindMatchesTransportType("transfer_train_hotel", "train")).toBe(true);
    expect(kindMatchesTransportType("transfer_airport_hotel", "flight")).toBe(true);
    expect(kindMatchesTransportType("formula_medmar_pozzuoli", "direct")).toBe(true);
    expect(kindMatchesTransportType("transfer_port_hotel", "direct")).toBe(true);
    expect(kindMatchesTransportType("excursion", "direct")).toBe(false);
    expect(kindMatchesTransportType("transfer_train_hotel", "flight")).toBe(false);
  });
});

describe("mergeRuleOverride — whitelist esplicita", () => {
  it("13. solo i campi in IMPACT_OVERRIDABLE_FIELDS vengono sovrascritti, il resto resta invariato", () => {
    const base = rule({ zone: "forio", company: "snav" });
    const merged = mergeRuleOverride(base, { zone: "lacco" });
    expect(merged.zone).toBe("lacco");
    expect(merged.company).toBe("snav"); // non toccato
  });

  it("14. train/flight: finestra transport_from/to nel draft sostituisce quella salvata per il matching", () => {
    const trainRule = rule({ transport_type: "train", company: "medmar", departure_time: "12:00", transport_from: "07:00", transport_to: "09:00", zone: null });
    const draft = mergeRuleOverride(trainRule, { transport_from: "10:00", transport_to: "11:00" });
    const svc = service({ time: "08:00", booking_service_kind: "transfer_train_hotel" });
    // Con la vecchia finestra (07:00-09:00) avrebbe matchato; col draft (10:00-11:00) no.
    expect(serviceMatchesRuleForImpact(draft, svc)).toBe(false);
    expect(serviceMatchesRuleForImpact(trainRule, svc)).toBe(true);
  });
});

describe("serviceMatchesRuleForImpact — hotel_id batte zone (Livello 1 > Livello 2, stessa gerarchia del resolver)", () => {
  it("15. regola hotel-specifica: match solo se hotel_id coincide, la zona del servizio non conta", () => {
    const hotelRule = rule({ hotel_id: "hotel-x", zone: null });
    expect(serviceMatchesRuleForImpact(hotelRule, service({ hotel_id: "hotel-x", hotel_zone_raw: "Forio" }))).toBe(true);
    expect(serviceMatchesRuleForImpact(hotelRule, service({ hotel_id: "hotel-y", hotel_zone_raw: "Ischia Porto" }))).toBe(false);
  });
});
