import { describe, it, expect } from "vitest";
import { detectMarioIntent } from "@/lib/server/mario-assistant/intent-parser";
import { parseRelativeOrIsoDate, parseTimeWindow } from "@/lib/server/mario-assistant/date-time";

// 2026-08-23 e' CEST (Europe/Rome = UTC+2): le 10:00 UTC sono le 12:00 locali.
const NOW = new Date("2026-08-23T10:00:00.000Z");

describe("detectMarioIntent (spec TEST MINIMI — Intent parser)", () => {
  it("1. 'come siamo messi oggi' -> operational_brief", () => {
    expect(detectMarioIntent("come siamo messi oggi", NOW).intent).toBe("operational_brief");
  });

  it("2. 'ITS sta funzionando bene?' -> health_status", () => {
    expect(detectMarioIntent("ITS sta funzionando bene?", NOW).intent).toBe("health_status");
  });

  it("3. 'quali problemi ci sono?' -> alerts", () => {
    expect(detectMarioIntent("quali problemi ci sono?", NOW).intent).toBe("alerts");
  });

  it("4. 'servizi senza autista' -> unassigned", () => {
    expect(detectMarioIntent("servizi senza autista", NOW).intent).toBe("unassigned");
  });

  it("5. 'chi è disponibile oggi?' -> driver_availability", () => {
    expect(detectMarioIntent("chi è disponibile oggi?", NOW).intent).toBe("driver_availability");
  });

  it("6. intent sconosciuto ('che tempo fa domani?') -> unsupported", () => {
    expect(detectMarioIntent("che tempo fa domani?", NOW).intent).toBe("unsupported");
  });

  // Copertura aggiuntiva sugli esempi espliciti della spec.
  it("'Fammi il punto della giornata' -> operational_brief", () => {
    expect(detectMarioIntent("Fammi il punto della giornata", NOW).intent).toBe("operational_brief");
  });
  it("'Ci sono problemi oggi?' -> operational_brief", () => {
    expect(detectMarioIntent("Ci sono problemi oggi?", NOW).intent).toBe("operational_brief");
  });
  it("'Ci sono problemi tecnici?' -> health_status", () => {
    expect(detectMarioIntent("Ci sono problemi tecnici?", NOW).intent).toBe("health_status");
  });
  it("'Come sta il sistema?' -> health_status", () => {
    expect(detectMarioIntent("Come sta il sistema?", NOW).intent).toBe("health_status");
  });
  it("'Cosa richiede attenzione?' -> alerts", () => {
    expect(detectMarioIntent("Cosa richiede attenzione?", NOW).intent).toBe("alerts");
  });
  it("'Ci sono problemi critici?' -> alerts con severity=critical", () => {
    const result = detectMarioIntent("Ci sono problemi critici?", NOW);
    expect(result.intent).toBe("alerts");
    expect(result.intent === "alerts" && result.params.severity).toBe("critical");
  });
  it("'Fammi vedere gli alert' -> alerts", () => {
    expect(detectMarioIntent("Fammi vedere gli alert", NOW).intent).toBe("alerts");
  });
  it("'Quali servizi sono senza autista?' -> unassigned", () => {
    expect(detectMarioIntent("Quali servizi sono senza autista?", NOW).intent).toBe("unassigned");
  });
  it("'Ci sono servizi non assegnati?' -> unassigned", () => {
    expect(detectMarioIntent("Ci sono servizi non assegnati?", NOW).intent).toBe("unassigned");
  });
  it("'Mostrami gli unassigned' -> unassigned", () => {
    expect(detectMarioIntent("Mostrami gli unassigned", NOW).intent).toBe("unassigned");
  });
  it("'Chi è libero oggi?' -> driver_availability", () => {
    expect(detectMarioIntent("Chi è libero oggi?", NOW).intent).toBe("driver_availability");
  });
  it("'Chi è disponibile questo pomeriggio?' -> driver_availability con timeWindow pomeriggio", () => {
    const result = detectMarioIntent("Chi è disponibile questo pomeriggio?", NOW);
    expect(result.intent).toBe("driver_availability");
    expect(result.intent === "driver_availability" && result.params.timeWindow?.fromMinutes).toBe(12 * 60);
  });
  it("'Chi posso usare dalle 15 alle 20?' -> driver_availability con finestra esplicita", () => {
    const result = detectMarioIntent("Chi posso usare dalle 15 alle 20?", NOW);
    expect(result.intent).toBe("driver_availability");
    expect(result.intent === "driver_availability" && result.params.timeWindow).toEqual({
      fromMinutes: 15 * 60,
      toMinutes: 20 * 60,
      label: "dalle 15:00 alle 20:00",
    });
  });

  it("18. write request ('Assegna Mario Rossi al servizio X') -> write_unsupported, mai un intent READ", () => {
    expect(detectMarioIntent("Assegna Mario Rossi al servizio X", NOW).intent).toBe("write_unsupported");
  });
  it("write request variante ('Cambia stato del servizio 123') -> write_unsupported", () => {
    expect(detectMarioIntent("Cambia stato del servizio 123", NOW).intent).toBe("write_unsupported");
  });
});

describe("parseRelativeOrIsoDate (spec TEST MINIMI — Date/time)", () => {
  it("7. 'oggi' -> data odierna Europe/Rome", () => {
    expect(parseRelativeOrIsoDate("controllami oggi per favore", NOW)).toBe("2026-08-23");
  });
  it("8. 'domani' -> data di domani Europe/Rome", () => {
    expect(parseRelativeOrIsoDate("controllami domani", NOW)).toBe("2026-08-24");
  });
  it("data ISO esplicita nel testo viene riconosciuta cosi' com'e'", () => {
    expect(parseRelativeOrIsoDate("guarda il 2026-09-01", NOW)).toBe("2026-09-01");
  });
  it("nessuna data menzionata -> undefined (il default e' compito del chiamante)", () => {
    expect(parseRelativeOrIsoDate("come va", NOW)).toBeUndefined();
  });
  it("10. timezone Europe/Rome: 'domani' attraversa la mezzanotte locale correttamente in CEST", () => {
    // NOW e' 2026-08-23T10:00 UTC = 12:00 locale (CEST) — "domani" deve restare il 24, non il 25.
    expect(parseRelativeOrIsoDate("domani", NOW)).toBe("2026-08-24");
  });
});

describe("FASE 3 — intent gruppi prenotazione (§22)", () => {
  it("'crea un gruppo prenotazione Parrocchia Natività da 50 persone' -> booking_group_write", () => {
    const r = detectMarioIntent("crea un gruppo prenotazione Parrocchia Natività da 50 persone", NOW);
    expect(r.intent).toBe("booking_group_write");
  });

  it("'aggiungi la fermata di Tivoli al gruppo Parrocchia Natività' -> booking_group_write", () => {
    expect(detectMarioIntent("aggiungi la fermata di Tivoli al gruppo Parrocchia Natività", NOW).intent).toBe("booking_group_write");
  });

  it("'riserva il bus per il gruppo Parrocchia Natività' -> booking_group_write", () => {
    expect(detectMarioIntent("riserva il bus per il gruppo Parrocchia Natività", NOW).intent).toBe("booking_group_write");
  });

  it("'rendi operativo il gruppo Parrocchia Natività' -> booking_group_write", () => {
    expect(detectMarioIntent("rendi operativo il gruppo Parrocchia Natività", NOW).intent).toBe("booking_group_write");
  });

  it("'il gruppo Parrocchia Natività è pronto?' -> booking_group_inspect", () => {
    const r = detectMarioIntent("il gruppo Parrocchia Natività è pronto?", NOW);
    expect(r.intent).toBe("booking_group_inspect");
    expect(r.params).toMatchObject({ query: expect.stringMatching(/parrocchia/i) });
  });

  it("'cosa manca al gruppo Parrocchia Natività per essere operativo' -> booking_group_inspect", () => {
    expect(detectMarioIntent("cosa manca al gruppo Parrocchia Natività per essere operativo", NOW).intent).toBe("booking_group_inspect");
  });

  it("'trova il gruppo prenotazione Parrocchia Natività' -> booking_group_find con query", () => {
    const r = detectMarioIntent("trova il gruppo prenotazione Parrocchia Natività", NOW);
    expect(r.intent).toBe("booking_group_find");
    expect(r.params).toMatchObject({ query: expect.stringMatching(/parrocchia/i) });
  });

  it("'dettaglio del gruppo Parrocchia Natività' -> booking_group_detail", () => {
    expect(detectMarioIntent("dettaglio del gruppo Parrocchia Natività", NOW).intent).toBe("booking_group_detail");
  });

  it("senza contesto 'gruppo/prenotazione' un verbo di modifica resta write_unsupported", () => {
    expect(detectMarioIntent("assegna Mario Rossi al servizio X", NOW).intent).toBe("write_unsupported");
  });

  it("una domanda non-gruppo non è dirottata sugli intent gruppo", () => {
    expect(detectMarioIntent("come siamo messi oggi", NOW).intent).toBe("operational_brief");
  });

  // FIX A.4.1 — bug reale: una scrittura in linguaggio naturale con nome
  // gruppo estraibile ma nessun verbo READ/WRITE riconosciuto NON deve essere
  // rubata da booking_group_find.
  it("'Possiamo caricare un bus di 50 persone con partenza da Rimini gruppo La Marra?' -> unsupported, mai booking_group_find", () => {
    const r = detectMarioIntent("Possiamo caricare un bus di 50 persone con partenza da Rimini gruppo La Marra?", NOW);
    expect(r.intent).not.toBe("booking_group_find");
    expect(r.intent).toBe("unsupported");
  });

  it("'Gruppo La Marra' nominale ambigua -> unsupported, non FIND per la sola presenza del nome", () => {
    expect(detectMarioIntent("Gruppo La Marra", NOW).intent).toBe("unsupported");
  });

  it("'Mostrami il gruppo La Marra' -> booking_group_find (segnale READ esplicito)", () => {
    const r = detectMarioIntent("Mostrami il gruppo La Marra", NOW);
    expect(r.intent).toBe("booking_group_find");
    expect(r.params).toMatchObject({ query: expect.stringMatching(/la marra/i) });
  });

  it("'Cerca il gruppo La Marra' -> booking_group_find", () => {
    expect(detectMarioIntent("Cerca il gruppo La Marra", NOW).intent).toBe("booking_group_find");
  });

  it("'Qual è la situazione del gruppo La Marra?' -> booking_group_detail", () => {
    expect(detectMarioIntent("Qual è la situazione del gruppo La Marra?", NOW).intent).toBe("booking_group_detail");
  });

  it("'Il gruppo La Marra è pronto?' -> booking_group_inspect", () => {
    expect(detectMarioIntent("Il gruppo La Marra è pronto?", NOW).intent).toBe("booking_group_inspect");
  });

  it.each([
    "Caricami un bus per La Marra da 50 persone",
    "Preparami un bus La Marra da 50 pax",
    "Organizzami il gruppo La Marra per 50 persone",
    "Mi serve un bus per La Marra",
    "Possiamo mettere 20 persone a Tivoli nel gruppo La Marra?",
    "Inserisci 30 persone nel gruppo La Marra",
  ])("write naturale non riconosciuta '%s' -> mai booking_group_find", (msg) => {
    expect(detectMarioIntent(msg, NOW).intent).not.toBe("booking_group_find");
  });
});

describe("parseTimeWindow (spec TEST MINIMI — Date/time)", () => {
  it("9. 'pomeriggio' -> 12:00-18:00", () => {
    expect(parseTimeWindow("disponibile questo pomeriggio")).toEqual({ fromMinutes: 720, toMinutes: 1080, label: "pomeriggio (12:00–18:00)" });
  });
  it("'mattina' -> 06:00-12:00", () => {
    expect(parseTimeWindow("libero di mattina")).toEqual({ fromMinutes: 360, toMinutes: 720, label: "mattina (06:00–12:00)" });
  });
  it("'sera' -> 18:00-23:59", () => {
    expect(parseTimeWindow("libero la sera")).toEqual({ fromMinutes: 1080, toMinutes: 1439, label: "sera (18:00–23:59)" });
  });
  it("nessuna fascia menzionata -> undefined", () => {
    expect(parseTimeWindow("chi è disponibile")).toBeUndefined();
  });
});
