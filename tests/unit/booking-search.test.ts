import { describe, it, expect } from "vitest";
import { matchesBookingSearch, filterBookingsBySearch, type BookingSearchRecord } from "@/lib/booking-search";

interface TestRecord extends BookingSearchRecord {
  id: string;
}

const marcotulli: TestRecord = {
  id: "1",
  customer_name: "Marcotulli Silvia",
  phone: "+39 333-123 4567",
  billing_party_name: null,
  agency_id: "agency-la-villa",
  hotel_name: "La Villa",
  transport_code: "ITALO 8903 / ITALO 8938",
  train_departure_number: "ITALO 8938",
};

const gerardo: TestRecord = {
  id: "2",
  customer_name: "Gerardo D'Addio",
  phone: "3491112233",
  billing_party_name: null,
  agency_id: "agency-royal-palm",
  hotel_name: "Royal Palm Hotel Terme",
  transport_code: "MEDMAR Napoli 17:00",
};

const noAgencyBooking: TestRecord = {
  id: "3",
  customer_name: "Mario Rossi",
  phone: "3331119999",
  billing_party_name: "Agenzia Fatturazione Diretta",
  agency_id: null,
};

const inactiveAgencyBooking: TestRecord = {
  id: "4",
  customer_name: "Anna Bianchi",
  phone: "3200001111",
  billing_party_name: null,
  agency_id: "agency-disattivata",
};

// Simula agenciesMap costruita SENZA filtro active=true (fix applicato in inbox/page.tsx):
// contiene sia agenzie attive che disattivate.
const agencyNameById = new Map<string, string>([
  ["agency-la-villa", "LA VILLA"],
  ["agency-royal-palm", "ROYAL PALM HOTEL TERME"],
  ["agency-disattivata", "Agenzia Storica (disattivata)"],
]);

const allRecords = [marcotulli, gerardo, noAgencyBooking, inactiveAgencyBooking];

describe("matchesBookingSearch — campo nome/cognome/telefono", () => {
  it("trova per nome", () => {
    expect(matchesBookingSearch(marcotulli, "Silvia", "", agencyNameById)).toBe(true);
  });

  it("trova per cognome", () => {
    expect(matchesBookingSearch(marcotulli, "Marcotulli", "", agencyNameById)).toBe(true);
  });

  it("trova per nome parziale", () => {
    expect(matchesBookingSearch(marcotulli, "Silv", "", agencyNameById)).toBe(true);
  });

  it("trova per cognome parziale", () => {
    expect(matchesBookingSearch(gerardo, "Addio", "", agencyNameById)).toBe(true);
  });

  it("è case-insensitive", () => {
    expect(matchesBookingSearch(marcotulli, "silvia", "", agencyNameById)).toBe(true);
    expect(matchesBookingSearch(marcotulli, "SILVIA", "", agencyNameById)).toBe(true);
    expect(matchesBookingSearch(marcotulli, "SiLvIa", "", agencyNameById)).toBe(true);
  });

  it("trova per telefono con formattazione diversa (spazi/trattini/prefisso)", () => {
    expect(matchesBookingSearch(marcotulli, "3331234567", "", agencyNameById)).toBe(true);
    expect(matchesBookingSearch(marcotulli, "333-123-4567", "", agencyNameById)).toBe(true);
    expect(matchesBookingSearch(marcotulli, "+393331234567", "", agencyNameById)).toBe(true);
  });

  it("trova per parte del telefono", () => {
    expect(matchesBookingSearch(gerardo, "1112233", "", agencyNameById)).toBe(true);
  });

  it("non trova nulla per query senza corrispondenza", () => {
    expect(matchesBookingSearch(marcotulli, "Bianchi", "", agencyNameById)).toBe(false);
  });

  it("una query solo testuale non deve accidentalmente matchare il telefono di ogni record (regressione \\D su stringa vuota)", () => {
    // "xyz" non ha cifre: qDigits sarebbe "" — senza la guardia sulla lunghezza,
    // "qualsiasiTelefono".includes("") è sempre true e romperebbe la ricerca per nome.
    expect(matchesBookingSearch(marcotulli, "xyz", "", agencyNameById)).toBe(false);
    expect(matchesBookingSearch(gerardo, "xyz", "", agencyNameById)).toBe(false);
  });

  it("query da 1 carattere filtra gia' i risultati per suggerimento live", () => {
    expect(matchesBookingSearch(marcotulli, "s", "", agencyNameById)).toBe(true);
    expect(matchesBookingSearch(gerardo, "s", "", agencyNameById)).toBe(false);
  });

  it("trova per hotel e codici operativi", () => {
    expect(matchesBookingSearch(marcotulli, "villa", "", agencyNameById)).toBe(true);
    expect(matchesBookingSearch(marcotulli, "8938", "", agencyNameById)).toBe(true);
    expect(matchesBookingSearch(gerardo, "medmar", "", agencyNameById)).toBe(true);
  });
});

describe("matchesBookingSearch — campo agenzia", () => {
  it("trova per nome agenzia esatto", () => {
    expect(matchesBookingSearch(marcotulli, "", "LA VILLA", agencyNameById)).toBe(true);
  });

  it("trova per nome agenzia parziale", () => {
    expect(matchesBookingSearch(gerardo, "", "Royal", agencyNameById)).toBe(true);
  });

  it("è case-insensitive", () => {
    expect(matchesBookingSearch(marcotulli, "", "la villa", agencyNameById)).toBe(true);
  });

  it("usa billing_party_name quando presente, ignorando agency_id", () => {
    expect(matchesBookingSearch(noAgencyBooking, "", "Fatturazione", agencyNameById)).toBe(true);
  });

  it("trova anche prenotazioni legate ad agenzie disattivate (fix: agenciesMap non filtra più per active=true)", () => {
    expect(matchesBookingSearch(inactiveAgencyBooking, "", "Storica", agencyNameById)).toBe(true);
  });

  it("nessun risultato per agenzia inesistente", () => {
    expect(matchesBookingSearch(marcotulli, "", "Agenzia Fantasma", agencyNameById)).toBe(false);
  });

  it("combina filtro nome/telefono e agenzia (entrambi devono corrispondere)", () => {
    expect(matchesBookingSearch(marcotulli, "Silvia", "ROYAL", agencyNameById)).toBe(false);
    expect(matchesBookingSearch(marcotulli, "Silvia", "LA VILLA", agencyNameById)).toBe(true);
  });
});

describe("filterBookingsBySearch", () => {
  it("nessuna query attiva restituisce lista vuota (evita di scaricare tutto il dataset)", () => {
    expect(filterBookingsBySearch(allRecords, "", "", agencyNameById)).toEqual([]);
  });

  it("con una sola lettera mostra gia' risultati compatibili", () => {
    expect(filterBookingsBySearch(allRecords, "a", "", agencyNameById).length).toBeGreaterThan(0);
  });

  it("reset filtro: tornare a query vuota azzera i risultati coerentemente", () => {
    const withQuery = filterBookingsBySearch(allRecords, "Silvia", "", agencyNameById);
    expect(withQuery).toHaveLength(1);
    const afterReset = filterBookingsBySearch(allRecords, "", "", agencyNameById);
    expect(afterReset).toEqual([]);
  });

  it("applica il limite risultati (pagination reset implicito: sempre dal primo risultato utile)", () => {
    const manyRecords: TestRecord[] = Array.from({ length: 30 }, (_, i) => ({
      id: String(i),
      customer_name: `Mario Rossi ${i}`,
      phone: null,
      billing_party_name: null,
      agency_id: null,
    }));
    const results = filterBookingsBySearch(manyRecords, "Mario", "", agencyNameById);
    expect(results).toHaveLength(20);
    expect(results[0].id).toBe("0");
  });

  it("SENSITIVITY: agenzia con nome vuoto in mappa non produce match spurii", () => {
    expect(filterBookingsBySearch(allRecords, "", "zz-non-esiste", agencyNameById)).toEqual([]);
  });
});
