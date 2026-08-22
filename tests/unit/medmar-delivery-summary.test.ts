import { describe, expect, it } from "vitest";
import {
  summarizeMedmarDeliveryAttempts,
  summarizeMedmarIssuedAndDelivered,
  estimateMedmarUpcoming3Days,
  resolveMedmarCreditInfo,
  evaluateMedmarCredit,
  MEDMAR_CREDIT_SAFETY_THRESHOLD_CENTS,
  type MedmarDeliverySummaryRow,
  type MedmarIssuingActivityRow,
  type MedmarDeliveryActivityRow,
  type MedmarCandidateServiceRow,
} from "@/lib/server/medmar-booking/delivery-summary";

const WINDOW_START = "2026-08-22T00:00:00.000Z"; // mezzanotte Europe/Rome (esempio: 2026-08-22 e' CEST, offset +2)
const NOW = "2026-08-22T10:00:00.000Z";

function row(overrides: Partial<MedmarDeliverySummaryRow>): MedmarDeliverySummaryRow {
  return {
    id: "row-1",
    issuing_attempt_id: "issuing-1",
    status: "awaiting_pdf",
    created_at: "2026-08-22T08:00:00.000Z",
    updated_at: "2026-08-22T08:00:00.000Z",
    delivered_at: null,
    medmar_numero: null,
    last_error_code: null,
    ...overrides,
  };
}

describe("summarizeMedmarDeliveryAttempts — contatore coda Medmar (biglietti-medmar PARTE 3)", () => {
  it("1. raggruppa correttamente ogni bucket (in attesa, pronti, in corso, errori)", () => {
    const rows: MedmarDeliverySummaryRow[] = [
      row({ id: "a1", status: "awaiting_pdf" }),
      row({ id: "a2", status: "pdf_not_found" }),
      row({ id: "r1", status: "pdf_found" }),
      row({ id: "r2", status: "pdf_cleaned" }),
      row({ id: "p1", status: "delivery_started" }),
      row({ id: "e1", status: "pdf_validation_failed" }),
      row({ id: "e2", status: "recipient_missing" }),
      row({ id: "e3", status: "delivery_failed" }),
      row({ id: "e4", status: "delivery_state_unknown" }),
      row({ id: "e5", status: "manual_review" }),
      row({ id: "e6", status: "pdf_ambiguous" }),
    ];
    const summary = summarizeMedmarDeliveryAttempts(rows, NOW, WINDOW_START);
    expect(summary.queue).toEqual({ awaiting_pdf: 2, ready: 2, in_progress: 1, errors: 6 });
  });

  it("2. 'delivered' non finisce in nessun bucket di coda (terminale)", () => {
    const rows: MedmarDeliverySummaryRow[] = [row({ id: "d1", status: "delivered", delivered_at: "2026-08-22T09:00:00.000Z" })];
    const summary = summarizeMedmarDeliveryAttempts(rows, NOW, WINDOW_START);
    expect(summary.queue).toEqual({ awaiting_pdf: 0, ready: 0, in_progress: 0, errors: 0 });
  });

  it("3. 'Emessi oggi' conta i record con created_at dentro la finestra, esclude quelli fuori finestra", () => {
    const rows: MedmarDeliverySummaryRow[] = [
      row({ id: "today-1", created_at: "2026-08-22T07:00:00.000Z" }),
      row({ id: "today-2", created_at: WINDOW_START }), // limite inclusivo
      row({ id: "yesterday", created_at: "2026-08-21T23:00:00.000Z" }),
    ];
    const summary = summarizeMedmarDeliveryAttempts(rows, NOW, WINDOW_START);
    expect(summary.today.issued).toBe(2);
  });

  it("4. 'Inviati oggi' conta solo i delivered con delivered_at dentro la finestra", () => {
    const rows: MedmarDeliverySummaryRow[] = [
      row({ id: "d-today", status: "delivered", created_at: "2026-08-20T07:00:00.000Z", delivered_at: "2026-08-22T09:00:00.000Z" }),
      row({ id: "d-yesterday", status: "delivered", created_at: "2026-08-21T07:00:00.000Z", delivered_at: "2026-08-21T20:00:00.000Z" }),
    ];
    const summary = summarizeMedmarDeliveryAttempts(rows, NOW, WINDOW_START);
    expect(summary.today.delivered).toBe(1);
  });

  it("5. i bucket di coda NON sono filtrati per data: un record bloccato da ieri resta visibile", () => {
    const rows: MedmarDeliverySummaryRow[] = [row({ id: "stale", status: "manual_review", created_at: "2026-08-19T07:00:00.000Z", updated_at: "2026-08-19T07:00:00.000Z" })];
    const summary = summarizeMedmarDeliveryAttempts(rows, NOW, WINDOW_START);
    expect(summary.queue.errors).toBe(1);
    expect(summary.today.issued).toBe(0);
  });

  it("6. oldest_pending sceglie il created_at piu' vecchio tra awaiting/ready/in_progress, ignora delivered/errori", () => {
    const rows: MedmarDeliverySummaryRow[] = [
      row({ id: "newer", status: "awaiting_pdf", created_at: "2026-08-22T08:00:00.000Z" }),
      row({ id: "oldest", status: "pdf_found", created_at: "2026-08-20T05:00:00.000Z" }),
      row({ id: "even-older-but-error", status: "manual_review", created_at: "2026-08-18T00:00:00.000Z" }),
      row({ id: "even-older-but-delivered", status: "delivered", created_at: "2026-08-17T00:00:00.000Z", delivered_at: "2026-08-17T01:00:00.000Z" }),
    ];
    const summary = summarizeMedmarDeliveryAttempts(rows, NOW, WINDOW_START);
    expect(summary.oldest_pending).toEqual({ id: "oldest", status: "pdf_found", created_at: "2026-08-20T05:00:00.000Z" });
  });

  it("7. last_delivered sceglie il delivered_at piu' recente", () => {
    const rows: MedmarDeliverySummaryRow[] = [
      row({ id: "d1", status: "delivered", delivered_at: "2026-08-21T10:00:00.000Z", medmar_numero: "MED-1" }),
      row({ id: "d2", status: "delivered", delivered_at: "2026-08-22T09:30:00.000Z", medmar_numero: "MED-2" }),
    ];
    const summary = summarizeMedmarDeliveryAttempts(rows, NOW, WINDOW_START);
    expect(summary.last_delivered).toEqual({ id: "d2", medmar_numero: "MED-2", delivered_at: "2026-08-22T09:30:00.000Z" });
  });

  it("8. last_error sceglie l'updated_at piu' recente tra i soli stati di errore", () => {
    const rows: MedmarDeliverySummaryRow[] = [
      row({ id: "e-old", status: "delivery_failed", updated_at: "2026-08-21T10:00:00.000Z", last_error_code: "resend_failed" }),
      row({ id: "e-new", status: "recipient_missing", updated_at: "2026-08-22T09:00:00.000Z", last_error_code: "no_recipient" }),
      row({ id: "not-error", status: "delivery_started", updated_at: "2026-08-22T09:59:00.000Z" }),
    ];
    const summary = summarizeMedmarDeliveryAttempts(rows, NOW, WINDOW_START);
    expect(summary.last_error).toEqual({ id: "e-new", status: "recipient_missing", last_error_code: "no_recipient", updated_at: "2026-08-22T09:00:00.000Z" });
  });

  it("9. nessuna riga -> tutti i conteggi a zero, nessun 'ultimo' presente", () => {
    const summary = summarizeMedmarDeliveryAttempts([], NOW, WINDOW_START);
    expect(summary.today).toEqual({ issued: 0, delivered: 0 });
    expect(summary.queue).toEqual({ awaiting_pdf: 0, ready: 0, in_progress: 0, errors: 0 });
    expect(summary.oldest_pending).toBeNull();
    expect(summary.last_delivered).toBeNull();
    expect(summary.last_error).toBeNull();
  });
});

function issuingRow(overrides: Partial<MedmarIssuingActivityRow>): MedmarIssuingActivityRow {
  return {
    id: "issuing-1",
    status: "completed",
    completed_at: "2026-08-22T08:00:00.000Z",
    final_total_cents: 5000,
    service_ids: ["svc-1"],
    ...overrides,
  };
}

function deliveryActivityRow(overrides: Partial<MedmarDeliveryActivityRow>): MedmarDeliveryActivityRow {
  return {
    issuing_attempt_id: "issuing-1",
    status: "delivered",
    delivered_at: "2026-08-22T08:05:00.000Z",
    ...overrides,
  };
}

describe("summarizeMedmarIssuedAndDelivered — importo emesso/inviato oggi (Credito e fabbisogno Medmar)", () => {
  it("1. issued_today_count/amount sommano solo le emissioni completate dentro la finestra", () => {
    const issuing = [
      issuingRow({ id: "i1", completed_at: "2026-08-22T07:00:00.000Z", final_total_cents: 3000 }),
      issuingRow({ id: "i2", completed_at: "2026-08-22T09:00:00.000Z", final_total_cents: 4500 }),
      issuingRow({ id: "i3", completed_at: "2026-08-21T23:00:00.000Z", final_total_cents: 9999 }), // ieri, escluso
    ];
    const summary = summarizeMedmarIssuedAndDelivered(issuing, [], WINDOW_START);
    expect(summary.issued_today_count).toBe(2);
    expect(summary.issued_today_amount_cents).toBe(7500);
  });

  it("2. last_issued_amount_cents prende l'emissione completed_at piu' recente in assoluto (anche fuori dalla finestra di oggi)", () => {
    const issuing = [
      issuingRow({ id: "old", completed_at: "2026-08-10T07:00:00.000Z", final_total_cents: 1111 }),
      issuingRow({ id: "newest", completed_at: "2026-08-22T09:30:00.000Z", final_total_cents: 6200 }),
    ];
    const summary = summarizeMedmarIssuedAndDelivered(issuing, [], WINDOW_START);
    expect(summary.last_issued_amount_cents).toBe(6200);
  });

  it("3. delivered_today_amount_cents e last_delivered_amount_cents risolvono l'importo via issuing_attempt_id (join locale)", () => {
    const issuing = [issuingRow({ id: "i1", final_total_cents: 2500 }), issuingRow({ id: "i2", final_total_cents: 3300 })];
    const delivery = [
      deliveryActivityRow({ issuing_attempt_id: "i1", delivered_at: "2026-08-22T08:00:00.000Z" }),
      deliveryActivityRow({ issuing_attempt_id: "i2", delivered_at: "2026-08-22T09:00:00.000Z" }),
    ];
    const summary = summarizeMedmarIssuedAndDelivered(issuing, delivery, WINDOW_START);
    expect(summary.delivered_today_count).toBe(2);
    expect(summary.delivered_today_amount_cents).toBe(5800);
    expect(summary.last_delivered_amount_cents).toBe(3300); // il piu' recente (09:00) e' i2
  });

  it("4. delivered_today_amount_cents e' null (non una somma parziale) se manca l'issuing attempt corrispondente", () => {
    const issuing = [issuingRow({ id: "i1", final_total_cents: 2500 })];
    const delivery = [
      deliveryActivityRow({ issuing_attempt_id: "i1", delivered_at: "2026-08-22T08:00:00.000Z" }),
      deliveryActivityRow({ issuing_attempt_id: "sconosciuto", delivered_at: "2026-08-22T09:00:00.000Z" }),
    ];
    const summary = summarizeMedmarIssuedAndDelivered(issuing, delivery, WINDOW_START);
    expect(summary.delivered_today_count).toBe(2);
    expect(summary.delivered_today_amount_cents).toBeNull();
  });

  it("5. nessun dato -> conteggi/importi a zero o null, mai un valore inventato", () => {
    const summary = summarizeMedmarIssuedAndDelivered([], [], WINDOW_START);
    expect(summary).toEqual({
      issued_today_count: 0,
      issued_today_amount_cents: 0,
      delivered_today_count: 0,
      delivered_today_amount_cents: 0,
      last_issued_amount_cents: null,
      last_delivered_amount_cents: null,
    });
  });
});

function candidateService(overrides: Partial<MedmarCandidateServiceRow>): MedmarCandidateServiceRow {
  return { id: "svc-1", customer_name: "Mario Rossi", notes: null, ...overrides };
}

describe("estimateMedmarUpcoming3Days — stima prossimi 3 giorni (Credito e fabbisogno Medmar)", () => {
  it("1. deduplica andata+ritorno della stessa prenotazione (stessa pratica) in UN solo biglietto stimato", () => {
    const services = [
      candidateService({ id: "svc-arrivo", notes: "[practice:PR-100]" }),
      candidateService({ id: "svc-partenza", notes: "[practice:PR-100]" }),
    ];
    const result = estimateMedmarUpcoming3Days(services, new Set(), [5000]);
    expect(result.upcoming_3d_estimated_tickets).toBe(1);
    expect(result.upcoming_3d_candidate_services).toBe(2);
  });

  it("2. senza pratica, deduplica andata+ritorno usando la coppia linked_service_id", () => {
    const services = [
      candidateService({ id: "svc-arrivo", linked_service_id: "svc-partenza", customer_name: "Mario Rossi", notes: null }),
      candidateService({ id: "svc-partenza", linked_service_id: "svc-arrivo", customer_name: "  MARIO   ROSSI ", notes: null }),
    ];
    const result = estimateMedmarUpcoming3Days(services, new Set(), [5000]);
    expect(result.upcoming_3d_estimated_tickets).toBe(1);
  });

  it("2b. due pratiche omonime con linked_service_id diversi restano distinte", () => {
    const services = [
      candidateService({ id: "old-arrival", linked_service_id: "old-return", customer_name: "PIETRO VITO", notes: null }),
      candidateService({ id: "old-return", linked_service_id: "old-arrival", customer_name: "PIETRO VITO", notes: null }),
      candidateService({ id: "new-arrival", linked_service_id: "new-return", customer_name: "PIETRO VITO", notes: null }),
      candidateService({ id: "new-return", linked_service_id: "new-arrival", customer_name: "PIETRO VITO", notes: null }),
    ];
    const result = estimateMedmarUpcoming3Days(services, new Set(), [5000]);
    expect(result.upcoming_3d_estimated_tickets).toBe(2);
  });

  it("3. clienti diversi -> biglietti stimati distinti, nessun accorpamento indebito", () => {
    const services = [candidateService({ id: "svc-a", customer_name: "Mario Rossi" }), candidateService({ id: "svc-b", customer_name: "Luigi Bianchi" })];
    const result = estimateMedmarUpcoming3Days(services, new Set(), [5000]);
    expect(result.upcoming_3d_estimated_tickets).toBe(2);
  });

  it("4. esclude i service gia' coperti da un'emissione completata (alreadyIssuedServiceIds)", () => {
    const services = [candidateService({ id: "svc-gia-emesso" }), candidateService({ id: "svc-da-emettere", customer_name: "Altro Cliente" })];
    const result = estimateMedmarUpcoming3Days(services, new Set(["svc-gia-emesso"]), [5000]);
    expect(result.upcoming_3d_candidate_services).toBe(1);
    expect(result.upcoming_3d_estimated_tickets).toBe(1);
  });

  it("5. importo stimato = media storica * biglietti stimati, source 'historical_average'", () => {
    const services = [candidateService({ id: "svc-a", customer_name: "A" }), candidateService({ id: "svc-b", customer_name: "B" })];
    const result = estimateMedmarUpcoming3Days(services, new Set(), [1000, 2000, 3000]); // media 2000
    expect(result.upcoming_3d_estimated_amount_cents).toBe(4000); // 2000 * 2 biglietti
    expect(result.upcoming_3d_amount_source).toBe("historical_average");
  });

  it("6. importo NON calcolabile (null, source 'unavailable') se ci sono biglietti stimati ma zero storico disponibile", () => {
    const services = [candidateService({ id: "svc-a" })];
    const result = estimateMedmarUpcoming3Days(services, new Set(), []);
    expect(result.upcoming_3d_estimated_tickets).toBe(1);
    expect(result.upcoming_3d_estimated_amount_cents).toBeNull();
    expect(result.upcoming_3d_amount_source).toBe("unavailable");
  });

  it("7. zero candidati -> zero biglietti stimati, importo 0 (mai null quando la stima e' banale)", () => {
    const result = estimateMedmarUpcoming3Days([], new Set(), [5000]);
    expect(result.upcoming_3d_estimated_tickets).toBe(0);
    expect(result.upcoming_3d_estimated_amount_cents).toBe(0);
  });
});

describe("resolveMedmarCreditInfo — credito reale/manuale/non disponibile (Credito e fabbisogno Medmar)", () => {
  it("1. nessuna env var configurata -> 'unavailable', credito MAI inventato", () => {
    expect(resolveMedmarCreditInfo({})).toEqual({ type: "unavailable", available_cents: null, as_of: null });
  });

  it("2. env var vuota/blank -> 'unavailable'", () => {
    expect(resolveMedmarCreditInfo({ MEDMAR_MANUAL_CREDIT_CENTS: "   " })).toEqual({ type: "unavailable", available_cents: null, as_of: null });
  });

  it("3. env var non numerica -> 'unavailable' (mai un parse silenzioso a 0)", () => {
    expect(resolveMedmarCreditInfo({ MEDMAR_MANUAL_CREDIT_CENTS: "non-un-numero" })).toEqual({ type: "unavailable", available_cents: null, as_of: null });
  });

  it("4. env var negativa -> 'unavailable'", () => {
    expect(resolveMedmarCreditInfo({ MEDMAR_MANUAL_CREDIT_CENTS: "-100" })).toEqual({ type: "unavailable", available_cents: null, as_of: null });
  });

  it("5. env var valida -> 'manual_estimated' con available_cents dal valore configurato, etichettato chiaramente come stimato/manuale (mai 'real')", () => {
    const result = resolveMedmarCreditInfo({ MEDMAR_MANUAL_CREDIT_CENTS: "150000" });
    expect(result.type).toBe("manual_estimated");
    expect(result.available_cents).toBe(150000);
  });
});

describe("evaluateMedmarCredit — logica sufficiente/attenzione/insufficiente/non valutabile (Credito e fabbisogno Medmar)", () => {
  it("1. sufficient: credito >= stima + soglia", () => {
    const result = evaluateMedmarCredit(100_000, 50_000); // 1000 - 500 = 500 residuo >= soglia 200
    expect(result.status).toBe("sufficient");
    expect(result.shortfall_cents).toBeNull();
  });

  it("2. warning: credito >= stima ma il residuo dopo la stima e' sotto soglia", () => {
    const result = evaluateMedmarCredit(50_100, 50_000); // residuo 100 < soglia 200
    expect(result.status).toBe("warning");
    expect(result.shortfall_cents).toBeNull();
  });

  it("3. sufficient al limite esatto della soglia (residuo == soglia)", () => {
    const result = evaluateMedmarCredit(50_000 + MEDMAR_CREDIT_SAFETY_THRESHOLD_CENTS, 50_000);
    expect(result.status).toBe("sufficient");
  });

  it("4. insufficient: credito < stima -> shortfall_cents valorizzato con l'importo mancante", () => {
    const result = evaluateMedmarCredit(30_000, 50_000);
    expect(result.status).toBe("insufficient");
    expect(result.shortfall_cents).toBe(20_000);
  });

  it("5. unknown: credito assente", () => {
    expect(evaluateMedmarCredit(null, 50_000).status).toBe("unknown");
  });

  it("6. unknown: importo stimato assente", () => {
    expect(evaluateMedmarCredit(100_000, null).status).toBe("unknown");
  });

  it("7. unknown: entrambi assenti", () => {
    expect(evaluateMedmarCredit(null, null).status).toBe("unknown");
  });

  it("8. la sufficienza dipende solo dal numero, non dall'origine del credito: un credito 'reale' futuro userebbe la stessa logica di un credito manuale con lo stesso importo", () => {
    const realCreditResult = evaluateMedmarCredit(100_000, 50_000);
    const manualCreditResult = evaluateMedmarCredit(100_000, 50_000);
    expect(realCreditResult).toEqual(manualCreditResult);
  });
});
