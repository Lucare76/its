import type { MedmarPreflightResult } from "./types";

export type MedmarIssueStatus =
  | "preflight_started"
  | "preflight_ok"
  | "lock_started"
  | "locked"
  | "booking_started"
  | "booked"
  | "payment_started"
  | "paid"
  | "unlock_started"
  | "completed"
  | "preflight_failed"
  | "lock_failed"
  | "booking_failed_definitive"
  | "payment_failed_definitive"
  | "remote_state_unknown"
  | "manual_review";

export type MedmarIssueAttempt = {
  id: string;
  tenant_id: string;
  idempotency_key: string;
  service_ids: string[];
  status: MedmarIssueStatus;
  preflight_snapshot: unknown | null;
  lock_snapshot: unknown | null;
  booking_payload_hash: string | null;
  medmar_id_prenotazione: string | null;
  medmar_numero: string | null;
  expected_total_cents: number | null;
  final_total_cents: number | null;
  last_error_code: string | null;
  last_error_message: string | null;
  remote_state_unknown: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export type MedmarIssueEventInput = {
  tenantId: string;
  attemptId: string;
  serviceId?: string | null;
  previousStatus?: MedmarIssueStatus | null;
  newStatus: MedmarIssueStatus;
  eventType: string;
  medmarIdPrenotazione?: string | null;
  medmarNumero?: string | null;
  errorCode?: string | null;
  details?: Record<string, unknown>;
  createdBy?: string | null;
};

export type MedmarIssueResult =
  | {
      ok: true;
      status: "completed";
      idempotency_key: string;
      attempt_id: string;
      medmar_id_prenotazione: string;
      medmar_numero: string;
      final_total_cents: number;
      existing: boolean;
    }
  | {
      ok: false;
      status:
        | "feature_disabled"
        | "already_in_progress"
        | "remote_state_unknown"
        | "manual_review"
        | "preflight_failed"
        | "lock_failed"
        | "booking_failed_definitive"
        | "payment_failed_definitive"
        | "not_ready";
      idempotency_key?: string;
      attempt_id?: string;
      error: string;
      retry_allowed: boolean;
    };

export type MedmarIssueCustomer = {
  nome: string;
  cognome: string;
  telefono_1: string;
  email: string;
};

export type MedmarIssueServiceRow = {
  id: string;
  tenant_id: string;
  customer_name: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  pax: number | null;
};

export type MedmarIssueConfig = {
  enabled: boolean;
  causaleId: number;
  modalitaId: number;
  vettoreAndataId: number;
  vettoreRitornoId: number;
};

export type MedmarIssueSessionContext = {
  bearerToken: string;
  userId: number;
  clienteId: string;
  postazioneId: string;
  turnoId: number;
};

export type IssueOrchestratorInput = {
  tenantId: string;
  userId: string;
  serviceIds: string[];
};

export type IssueRepository = {
  findAttempt(tenantId: string, idempotencyKey: string): Promise<MedmarIssueAttempt | null>;
  acquireAttempt(input: {
    tenantId: string;
    idempotencyKey: string;
    serviceIds: string[];
    createdBy: string;
  }): Promise<{ kind: "created"; attempt: MedmarIssueAttempt } | { kind: "existing"; attempt: MedmarIssueAttempt }>;
  updateAttempt(id: string, patch: Partial<MedmarIssueAttempt>): Promise<MedmarIssueAttempt>;
  addEvent(input: MedmarIssueEventInput): Promise<void>;
  loadServices(tenantId: string, serviceIds: string[]): Promise<MedmarIssueServiceRow[]>;
};

export type MedmarMutationTicketLine = {
  id_corsa: number | string;
  quantita: number;
  id_log: number | string;
  descrizione: string;
};

export type MedmarLockedTicket = MedmarMutationTicketLine & {
  id_biglietto: number | string | null;
  id_biglietto_congelato: number | string;
};

export type MedmarBookingDetailLine = {
  biglietto: string;
  checkin?: boolean;
  flag_ar: "A" | "R";
  flag_collegabile: 0;
  flag_targa: 0;
  id_biglietto_congelato?: number | string;
  id_child_riga?: number;
  id_corsa: number | string;
  id_gruppo: number;
  id_iva: number | string | null;
  id_log: number | string;
  id_riga: number;
  id_tariffa: number | string | null;
  id_tipologia_passeggero: number | null;
  prezzo: number;
  prezzo_prevendita: number;
  quantita: number;
  re?: false;
};

export type MedmarBookingPayload = {
  cliente_sito: MedmarIssueCustomer;
  dettaglio: MedmarBookingDetailLine[];
  dettaglioMezzo: [];
  id_causale: number;
  id_cliente: string;
  id_modalita: number;
  id_prenotazione: null;
  id_turno: number;
  id_vettore_andata: number;
  id_vettore_ritorno: number;
  targa: { dettagli: [] };
  urlPagamento: null;
};

export type MedmarMutationClient = {
  openTurn(input: {
    id_utente: number;
    id_postazione: string;
    flag_stato: "A";
    data: string;
    ora_apertura: string;
    ora_chiusura: "23:59:59";
  }): Promise<{ id_turno: number }>;
  lockAvailability(input: { biglietti: MedmarMutationTicketLine[]; utente: number }): Promise<{
    nonDisponibili: unknown[];
    congelati: MedmarLockedTicket[];
  }>;
  createBooking(payload: MedmarBookingPayload): Promise<{
    id_prenotazione: number | string;
    prezzo_totale: string | number;
    id_cliente: string | number;
  }>;
  payManual(payload: { id_prenotazione: number | string; prezzo: number; id_cliente: string; id_modalita: 5 }): Promise<{
    id_prenotazione: string | number;
    prezzo: string | number;
    id_cliente: string | number;
    id_modalita: string | number;
    numero: string;
  }>;
  unlockAvailability(input: { biglietti: MedmarMutationTicketLine[]; utente: number }): Promise<void>;
};

export type RunPreflightFn = (tenantId: string, serviceIds: string[]) => Promise<MedmarPreflightResult>;
