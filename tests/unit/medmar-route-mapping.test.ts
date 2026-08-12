import { describe, it, expect } from "vitest";
import { getIdTrattaForRouteCode, getExpectedPortsForRouteCode, isMirrorRouteCode } from "@/lib/server/medmar-booking/route-mapping";
import type { MedmarTicketRouteCode } from "@/lib/medmar-ticket-memory";

// Test diretto (nessun mock) sulla tabella reale delle 6 tratte verificate
// Fase 1.6. Se questi valori vengono alterati per errore, questo file deve
// fallire — è la rete di sicurezza contro una tratta rimappata a un
// id_tratta sbagliato o a port IDs ignorati.

describe("route-mapping — le 6 tratte verificate", () => {
  const EXPECTED: Array<{
    route: MedmarTicketRouteCode;
    idTratta: number;
    idPortoPartenza: number;
    idPortoArrivo: number;
  }> = [
    { route: "ischia_napoli", idTratta: 47, idPortoPartenza: 41, idPortoArrivo: 1 },
    { route: "napoli_ischia", idTratta: 59, idPortoPartenza: 1, idPortoArrivo: 41 },
    { route: "ischia_pozzuoli", idTratta: 14, idPortoPartenza: 41, idPortoArrivo: 44 },
    { route: "pozzuoli_ischia", idTratta: 56, idPortoPartenza: 44, idPortoArrivo: 41 },
    { route: "casamicciola_pozzuoli", idTratta: 50, idPortoPartenza: 2, idPortoArrivo: 44 },
    { route: "pozzuoli_casamicciola", idTratta: 53, idPortoPartenza: 44, idPortoArrivo: 2 },
  ];

  it.each(EXPECTED)("$route -> id_tratta=$idTratta, porti $idPortoPartenza/$idPortoArrivo", ({ route, idTratta, idPortoPartenza, idPortoArrivo }) => {
    expect(getIdTrattaForRouteCode(route)).toBe(idTratta);
    expect(getExpectedPortsForRouteCode(route)).toEqual({ idPortoPartenza, idPortoArrivo });
  });

  it("sensitivity: id_tratta di ischia_pozzuoli è 14 (id_tratta), MAI confuso con id_listino (anch'esso 14 per coincidenza)", () => {
    // id_listino non è modellato da questo modulo: se qualcuno introducesse
    // per errore un valore diverso da id_tratta qui, questo test lo cattura.
    expect(getIdTrattaForRouteCode("ischia_pozzuoli")).toBe(14);
  });

  const UNVERIFIED: MedmarTicketRouteCode[] = ["napoli_casamicciola", "casamicciola_napoli"];

  it.each(UNVERIFIED)("%s non è una delle 6 tratte verificate -> id_tratta e porti null (nessun ID inventato)", (route) => {
    expect(getIdTrattaForRouteCode(route)).toBeNull();
    expect(getExpectedPortsForRouteCode(route)).toBeNull();
  });

  it("sensitivity: nessuna tratta verificata ha porti duplicati/scambiati per errore rispetto alle altre 5", () => {
    // Ogni coppia (idPortoPartenza, idPortoArrivo) deve essere unica tra le 6 tratte.
    const pairs = EXPECTED.map((e) => `${e.idPortoPartenza}->${e.idPortoArrivo}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });
});

describe("route-mapping — isMirrorRouteCode (coerenza andata/ritorno)", () => {
  it.each([
    ["ischia_napoli", "napoli_ischia"],
    ["napoli_ischia", "ischia_napoli"],
    ["ischia_pozzuoli", "pozzuoli_ischia"],
    ["pozzuoli_ischia", "ischia_pozzuoli"],
    ["casamicciola_pozzuoli", "pozzuoli_casamicciola"],
    ["pozzuoli_casamicciola", "casamicciola_pozzuoli"],
  ] as const)("%s <-> %s sono speculari", (a, b) => {
    expect(isMirrorRouteCode(a, b)).toBe(true);
  });

  it("andata Napoli->Ischia + ritorno Ischia->Pozzuoli NON sono speculari (porti diversi)", () => {
    expect(isMirrorRouteCode("napoli_ischia", "ischia_pozzuoli")).toBe(false);
  });

  it("una tratta non è mai speculare di se stessa", () => {
    expect(isMirrorRouteCode("ischia_napoli", "ischia_napoli")).toBe(false);
  });
});
