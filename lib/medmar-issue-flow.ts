/**
 * Fase 2B.4 — state machine puro (nessun React/JSX) per il flusso UI a due
 * step "prepara -> conferma" dell'emissione Medmar One Click. Estratto in
 * un modulo separato perche' questo repo non ha infrastruttura per test di
 * rendering React (nessun jsdom/@testing-library/react in package.json,
 * vitest.config.ts usa environment: "node" e include solo *.test.ts) — le
 * transizioni di stato restano comunque testabili con vitest puro.
 *
 * Il token di conferma vive SOLO in questo stato React in-memory: nessuna
 * funzione qui scrive mai a localStorage/sessionStorage/cookie.
 */

export type MedmarPrepareRouteLeg = {
  direction: "outward" | "return";
  route: { from: string; to: string } | null;
  date: string;
  requested_time: string | null;
  matched_departure_time: string | null;
  vessel: string | null;
  id_corsa: number | string | null;
  source: "live" | "local_fallback" | null;
};

export type MedmarDeliveryDiagnostics = {
  medmar_recipient: { type: "technical"; email: string };
  final_recipient:
    | { type: "agency"; name: string; email: string }
    | { type: "customer"; name: string; email: string };
};

export type MedmarPrepareSuccessPayload = {
  confirmation_token: string;
  expires_at: string;
  expected_total_cents: number;
  route: { outward: MedmarPrepareRouteLeg | null; return: MedmarPrepareRouteLeg | null };
  pax: number;
  issuing_enabled: boolean;
  service_ids: string[];
  delivery: MedmarDeliveryDiagnostics;
};

export type MedmarIssueSuccessResult = {
  ok: true;
  status: "completed";
  medmar_id_prenotazione: string;
  medmar_numero: string;
  final_total_cents: number;
  existing: boolean;
};

export type MedmarPrepareState =
  | { phase: "idle" }
  | { phase: "preparing" }
  | ({ phase: "prepared" } & MedmarPrepareSuccessPayload)
  | { phase: "prepare_failed"; status: string; error: string }
  | ({ phase: "issuing" } & MedmarPrepareSuccessPayload)
  | { phase: "issued"; result: MedmarIssueSuccessResult }
  | { phase: "issue_failed"; status: string; error: string; retry_allowed: boolean };

export type MedmarPrepareEvent =
  | { type: "RESET" }
  | { type: "PREPARE_START" }
  | { type: "PREPARE_SUCCESS"; payload: MedmarPrepareSuccessPayload }
  | { type: "PREPARE_FAILURE"; status: string; error: string }
  | { type: "CONFIRM_START" }
  | { type: "ISSUE_SUCCESS"; result: MedmarIssueSuccessResult }
  | { type: "ISSUE_FAILURE"; status: string; error: string; retry_allowed: boolean }
  | { type: "TOKEN_EXPIRED" };

function preparePayloadOf(state: Extract<MedmarPrepareState, { phase: "prepared" }>): MedmarPrepareSuccessPayload {
  const { phase: _phase, ...payload } = state;
  return payload;
}

/**
 * Riduttore puro. `CONFIRM_START` e' idempotente rispetto ai doppi click:
 * se lo stato non e' gia' "prepared" (es. e' gia' "issuing"), l'evento e'
 * ignorato — un secondo CONFIRM_START ravvicinato non produce una seconda
 * transizione verso "issuing".
 */
export function medmarPrepareReducer(state: MedmarPrepareState, event: MedmarPrepareEvent): MedmarPrepareState {
  switch (event.type) {
    case "RESET":
      return { phase: "idle" };
    case "PREPARE_START":
      return { phase: "preparing" };
    case "PREPARE_SUCCESS":
      return { phase: "prepared", ...event.payload };
    case "PREPARE_FAILURE":
      return { phase: "prepare_failed", status: event.status, error: event.error };
    case "CONFIRM_START":
      if (state.phase !== "prepared") return state;
      return { phase: "issuing", ...preparePayloadOf(state) };
    case "ISSUE_SUCCESS":
      return { phase: "issued", result: event.result };
    case "ISSUE_FAILURE":
      return { phase: "issue_failed", status: event.status, error: event.error, retry_allowed: event.retry_allowed };
    case "TOKEN_EXPIRED":
      return { phase: "prepare_failed", status: "confirmation_expired", error: "Conferma scaduta. Ripeti la verifica." };
    default:
      return state;
  }
}

export function isTokenExpired(state: MedmarPrepareState, now: number = Date.now()): boolean {
  if (state.phase !== "prepared" && state.phase !== "issuing") return false;
  return new Date(state.expires_at).getTime() <= now;
}

/**
 * Unico punto che decide se la CTA finale puo' essere abilitata: richiede
 * un token "prepared", non scaduto, E la capability server-derived
 * issuing_enabled dalla response /prepare. La UI deve ANCHE richiedere il
 * kill switch locale MEDMAR_ISSUING_UI_ENABLED (non incluso qui perche'
 * quello resta un flag di fase, non parte dello state machine dati).
 */
export function canConfirmIssue(state: MedmarPrepareState, now: number = Date.now()): boolean {
  return state.phase === "prepared" && state.issuing_enabled && !isTokenExpired(state, now);
}

export function isRetryableIssueFailure(state: MedmarPrepareState): boolean {
  return state.phase === "issue_failed" && state.retry_allowed;
}

/**
 * UX 2-click (biglietti-medmar PARTE 1): decide se, subito dopo un
 * preflight riuscito, la UI deve incatenare automaticamente la
 * preparazione (POST /prepare) senza un secondo click intermedio a vuoto.
 * Stesso gate gia' usato per mostrare il pulsante "Prepara" nel vecchio
 * flusso a 3 click: `can_issue && is_live`.
 */
export function shouldAutoPrepareAfterPreflight(result: { can_issue: boolean; is_live: boolean }): boolean {
  return result.can_issue && result.is_live;
}

/** Confronto scope: previene un token preparato per A e usato per B. */
export function serviceIdsMatch(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((id, i) => id === sortedB[i]);
}
