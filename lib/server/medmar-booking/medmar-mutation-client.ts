import { getMedmarAuthProvider, MedmarNotConfiguredError } from "./auth";
import type { MedmarBookingPayload, MedmarMutationClient, MedmarMutationTicketLine } from "./issue-types";

const MEDMAR_API_BASE_URL = process.env.MEDMAR_API_BASE_URL?.trim() || null;
const MEDMAR_API_PATH_PREFIX = "/production/biglietteria_api/public/index.php/api";
const MUTATION_TIMEOUT_MS = 10_000;

const TURN_PATH = `${MEDMAR_API_PATH_PREFIX}/turni`;
const LOCK_PATH = `${MEDMAR_API_PATH_PREFIX}/prenotazioni/lock-disponibilita`;
const BOOKING_PATH = `${MEDMAR_API_PATH_PREFIX}/prenotazioni`;
const MANUAL_PAYMENT_PATH = `${MEDMAR_API_PATH_PREFIX}/prenotazioni/pagamento/manuale`;
const UNLOCK_PATH = `${MEDMAR_API_PATH_PREFIX}/prenotazioni/scongela`;

export class MedmarIssuingDisabledError extends Error {
  constructor() {
    super("Emissione Medmar disabilitata.");
    this.name = "MedmarIssuingDisabledError";
  }
}

export class MedmarMutationRemoteUnknownError extends Error {
  constructor(message = "Stato Medmar ambiguo dopo chiamata mutativa.") {
    super(message);
    this.name = "MedmarMutationRemoteUnknownError";
  }
}

export class MedmarMutationDefinitiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MedmarMutationDefinitiveError";
  }
}

function assertIssuingEnabled() {
  if (process.env.MEDMAR_ISSUING_ENABLED !== "true") {
    throw new MedmarIssuingDisabledError();
  }
}

function assertBaseUrl(): string {
  if (!MEDMAR_API_BASE_URL) {
    throw new MedmarNotConfiguredError("MEDMAR_API_BASE_URL non configurato.");
  }
  return MEDMAR_API_BASE_URL;
}

function parseEnvelope<T>(json: unknown, label: string): T {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new MedmarMutationDefinitiveError(`Risposta ${label} non valida.`);
  }
  const obj = json as { return?: unknown; output?: unknown };
  if (obj.return !== true) {
    throw new MedmarMutationDefinitiveError(`Medmar ha rifiutato ${label}.`);
  }
  return obj.output as T;
}

async function postMutative<T>(path: string, body: unknown, label: string): Promise<T> {
  assertIssuingEnabled();
  const baseUrl = assertBaseUrl();
  const session = await getMedmarAuthProvider().getValidToken();
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.bearerToken}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(MUTATION_TIMEOUT_MS),
    });
  } catch {
    throw new MedmarMutationRemoteUnknownError(`Timeout o rete durante ${label}: verificare manualmente Medmar.`);
  }

  if (response.status >= 500) {
    throw new MedmarMutationRemoteUnknownError(`Medmar ha risposto ${response.status} durante ${label}: stato remoto da verificare.`);
  }
  if (!response.ok) {
    throw new MedmarMutationDefinitiveError(`Medmar ha risposto ${response.status} durante ${label}.`);
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new MedmarMutationRemoteUnknownError(`Risposta ${label} non interpretabile dopo POST mutativo.`);
  }
  return parseEnvelope<T>(json, label);
}

function normalizeLockedTicket(row: Record<string, unknown>) {
  return {
    id_corsa: row.id_corsa as number | string,
    quantita: Number(row.quantita ?? 0),
    id_log: row.id_log as number | string,
    descrizione: String(row.descrizione ?? ""),
    id_biglietto: (row.id_biglietto as number | string | null | undefined) ?? null,
    id_biglietto_congelato: row.id_biglietto_congelato as number | string,
  };
}

export function createMedmarMutationClient(): MedmarMutationClient {
  return {
    async openTurn(input) {
      const output = await postMutative<Record<string, unknown>>(TURN_PATH, input, "apertura turno");
      const parsed = typeof output.id_turno === "number" ? output.id_turno : typeof output.id_turno === "string" ? Number(output.id_turno) : NaN;
      if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new MedmarMutationRemoteUnknownError("Response apertura turno senza id_turno: verificare manualmente Medmar.");
      }
      return { id_turno: parsed };
    },

    async lockAvailability(input: { biglietti: MedmarMutationTicketLine[]; utente: number }) {
      const output = await postMutative<{ nonDisponibili?: unknown[]; congelati?: Record<string, unknown>[] }>(
        LOCK_PATH,
        input,
        "lock disponibilita"
      );
      return {
        nonDisponibili: Array.isArray(output.nonDisponibili) ? output.nonDisponibili : [],
        congelati: Array.isArray(output.congelati) ? output.congelati.map(normalizeLockedTicket) : [],
      };
    },

    async createBooking(payload: MedmarBookingPayload) {
      const output = await postMutative<Record<string, unknown>>(BOOKING_PATH, payload, "creazione prenotazione");
      if (output.id_prenotazione == null || output.prezzo_totale == null || output.id_cliente == null) {
        throw new MedmarMutationRemoteUnknownError("Response prenotazione senza dati essenziali: verificare manualmente Medmar.");
      }
      return {
        id_prenotazione: output.id_prenotazione as number | string,
        prezzo_totale: output.prezzo_totale as string | number,
        id_cliente: output.id_cliente as string | number,
      };
    },

    async payManual(payload: { id_prenotazione: number | string; prezzo: number; id_cliente: string; id_modalita: 5 }) {
      const output = await postMutative<Record<string, unknown>>(MANUAL_PAYMENT_PATH, payload, "pagamento manuale");
      if (output.id_prenotazione == null || output.prezzo == null || output.id_cliente == null || output.id_modalita == null || typeof output.numero !== "string" || !output.numero.trim()) {
        throw new MedmarMutationRemoteUnknownError("Response pagamento senza codice Medmar: verificare manualmente.");
      }
      return {
        id_prenotazione: output.id_prenotazione as string | number,
        prezzo: output.prezzo as string | number,
        id_cliente: output.id_cliente as string | number,
        id_modalita: output.id_modalita as string | number,
        numero: output.numero,
      };
    },

    async unlockAvailability(input: { biglietti: MedmarMutationTicketLine[]; utente: number }) {
      await postMutative<unknown[]>(UNLOCK_PATH, input, "scongela disponibilita");
    },
  };
}

export const MEDMAR_MUTATION_PATHS = {
  turn: TURN_PATH,
  lock: LOCK_PATH,
  booking: BOOKING_PATH,
  manualPayment: MANUAL_PAYMENT_PATH,
  unlock: UNLOCK_PATH,
} as const;
