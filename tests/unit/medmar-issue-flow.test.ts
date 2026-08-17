import { describe, it, expect } from "vitest";
import {
  medmarPrepareReducer,
  canConfirmIssue,
  isTokenExpired,
  isRetryableIssueFailure,
  serviceIdsMatch,
  type MedmarPrepareState,
  type MedmarPrepareSuccessPayload,
} from "@/lib/medmar-issue-flow";

const SVC_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SVC_B = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

function preparedPayload(overrides: Partial<MedmarPrepareSuccessPayload> = {}): MedmarPrepareSuccessPayload {
  return {
    confirmation_token: "token-abc",
    expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    expected_total_cents: 1150,
    route: {
      outward: {
        direction: "outward",
        route: { from: "NAPOLI", to: "ISCHIA" },
        date: "2026-08-20",
        requested_time: "08:40",
        matched_departure_time: "08:40:00",
        vessel: "MEDMAR GIULIA",
        id_corsa: 131943,
        source: "live",
      },
      return: null,
    },
    pax: 1,
    issuing_enabled: false,
    service_ids: [SVC_A],
    delivery: {
      medmar_recipient: { type: "technical", email: "info@ischiatransferservice.it" },
      final_recipient: { type: "customer", name: "Mario Rossi", email: "mario@example.test" },
    },
    ...overrides,
  };
}

describe("medmarPrepareReducer — transizioni base (FASE L 2-5, 8)", () => {
  it("idle --PREPARE_START--> preparing", () => {
    const next = medmarPrepareReducer({ phase: "idle" }, { type: "PREPARE_START" });
    expect(next.phase).toBe("preparing");
  });

  it("preparing --PREPARE_SUCCESS--> prepared, con token/route/prezzo/pax dal payload server (FASE L.4/L.5)", () => {
    const payload = preparedPayload();
    const next = medmarPrepareReducer({ phase: "preparing" }, { type: "PREPARE_SUCCESS", payload });
    expect(next.phase).toBe("prepared");
    if (next.phase !== "prepared") throw new Error("unreachable");
    expect(next.confirmation_token).toBe("token-abc");
    expect(next.expected_total_cents).toBe(1150);
    expect(next.route.outward?.vessel).toBe("MEDMAR GIULIA");
    expect(next.pax).toBe(1);
  });

  it("preparing --PREPARE_FAILURE--> prepare_failed (FASE L.8)", () => {
    const next = medmarPrepareReducer({ phase: "preparing" }, { type: "PREPARE_FAILURE", status: "manual_review", error: "Dati cliente incompleti." });
    expect(next).toEqual({ phase: "prepare_failed", status: "manual_review", error: "Dati cliente incompleti." });
  });
});

describe("medmarPrepareReducer — CONFIRM_START e doppio submit (FASE L.11, sensitivity #13)", () => {
  it("prepared --CONFIRM_START--> issuing, mantiene i dati del prepare", () => {
    const payload = preparedPayload({ issuing_enabled: true });
    const next = medmarPrepareReducer({ phase: "prepared", ...payload }, { type: "CONFIRM_START" });
    expect(next.phase).toBe("issuing");
    if (next.phase !== "issuing") throw new Error("unreachable");
    expect(next.confirmation_token).toBe("token-abc");
  });

  it("CONFIRM_START due volte di fila: la seconda e' un no-op (nessuna doppia /issue)", () => {
    const payload = preparedPayload({ issuing_enabled: true });
    const afterFirst = medmarPrepareReducer({ phase: "prepared", ...payload }, { type: "CONFIRM_START" });
    const afterSecond = medmarPrepareReducer(afterFirst, { type: "CONFIRM_START" });
    expect(afterSecond).toBe(afterFirst);
    expect(afterSecond.phase).toBe("issuing");
  });

  it("CONFIRM_START da idle/preparing/prepare_failed/issued e' un no-op (nessun issue senza prepared)", () => {
    const states: MedmarPrepareState[] = [
      { phase: "idle" },
      { phase: "preparing" },
      { phase: "prepare_failed", status: "manual_review", error: "x" },
      { phase: "issued", result: { ok: true, status: "completed", medmar_id_prenotazione: "1", medmar_numero: "N1", final_total_cents: 1150, existing: false } },
    ];
    for (const state of states) {
      const next = medmarPrepareReducer(state, { type: "CONFIRM_START" });
      expect(next).toBe(state);
    }
  });
});

describe("medmarPrepareReducer — esiti issue (FASE L.9-10, G, H)", () => {
  it("issuing --ISSUE_SUCCESS--> issued, existing=true mostrabile senza nuova emissione (FASE H)", () => {
    const result = { ok: true as const, status: "completed" as const, medmar_id_prenotazione: "1", medmar_numero: "N1", final_total_cents: 1150, existing: true };
    const next = medmarPrepareReducer({ phase: "issuing", ...preparedPayload() }, { type: "ISSUE_SUCCESS", result });
    expect(next).toEqual({ phase: "issued", result });
  });

  it("issuing --ISSUE_FAILURE remote_state_unknown--> issue_failed, retry_allowed sempre false (nessun pulsante retry)", () => {
    const next = medmarPrepareReducer(
      { phase: "issuing", ...preparedPayload() },
      { type: "ISSUE_FAILURE", status: "remote_state_unknown", error: "Stato Medmar da verificare manualmente. Non riprovare l'emissione.", retry_allowed: false }
    );
    expect(next.phase).toBe("issue_failed");
    expect(isRetryableIssueFailure(next)).toBe(false);
  });

  it("TOKEN_EXPIRED --> prepare_failed con status confirmation_expired e testo richiesto", () => {
    const next = medmarPrepareReducer({ phase: "prepared", ...preparedPayload() }, { type: "TOKEN_EXPIRED" });
    expect(next).toEqual({ phase: "prepare_failed", status: "confirmation_expired", error: "Conferma scaduta. Ripeti la verifica." });
  });
});

describe("canConfirmIssue — gate finale (FASE L.6, E, sensitivity #11)", () => {
  it("false quando issuing_enabled e' false anche se il token e' valido e non scaduto", () => {
    const state: MedmarPrepareState = { phase: "prepared", ...preparedPayload({ issuing_enabled: false }) };
    expect(canConfirmIssue(state)).toBe(false);
  });

  it("true solo quando prepared, issuing_enabled true, e non scaduto", () => {
    const state: MedmarPrepareState = { phase: "prepared", ...preparedPayload({ issuing_enabled: true }) };
    expect(canConfirmIssue(state)).toBe(true);
  });

  it("false per ogni fase diversa da prepared (FASE L.12: nessun issue senza confirmation_token)", () => {
    const phases: MedmarPrepareState[] = [
      { phase: "idle" },
      { phase: "preparing" },
      { phase: "prepare_failed", status: "x", error: "x" },
      { phase: "issuing", ...preparedPayload({ issuing_enabled: true }) },
      { phase: "issued", result: { ok: true, status: "completed", medmar_id_prenotazione: "1", medmar_numero: "N1", final_total_cents: 1150, existing: false } },
      { phase: "issue_failed", status: "x", error: "x", retry_allowed: true },
    ];
    for (const state of phases) {
      expect(canConfirmIssue(state)).toBe(false);
    }
  });
});

describe("isTokenExpired — scadenza (FASE C, L.7)", () => {
  it("false subito dopo prepare", () => {
    const state: MedmarPrepareState = { phase: "prepared", ...preparedPayload() };
    expect(isTokenExpired(state)).toBe(false);
  });

  it("true dopo il tempo di scadenza (nessun refresh automatico: lo stato resta 'prepared' finche' non arriva TOKEN_EXPIRED)", () => {
    const state: MedmarPrepareState = {
      phase: "prepared",
      ...preparedPayload({ expires_at: new Date(Date.now() - 1000).toISOString() }),
    };
    expect(isTokenExpired(state)).toBe(true);
    expect(state.phase).toBe("prepared");
  });

  it("false per fasi che non contengono un token (idle/preparing/prepare_failed/issued)", () => {
    expect(isTokenExpired({ phase: "idle" })).toBe(false);
    expect(isTokenExpired({ phase: "preparing" })).toBe(false);
    expect(isTokenExpired({ phase: "prepare_failed", status: "x", error: "x" })).toBe(false);
  });
});

describe("serviceIdsMatch — scope token (FASE O, sensitivity #5)", () => {
  it("true per stessi id in qualunque ordine", () => {
    expect(serviceIdsMatch([SVC_A, SVC_B], [SVC_B, SVC_A])).toBe(true);
  });

  it("false se un token preparato per il gruppo A viene usato per il gruppo B", () => {
    expect(serviceIdsMatch([SVC_A], [SVC_B])).toBe(false);
  });

  it("false se la lunghezza differisce", () => {
    expect(serviceIdsMatch([SVC_A], [SVC_A, SVC_B])).toBe(false);
  });
});
