/**
 * Tipi per il preflight Medmar One Click (Fase 1 — nessuna emissione).
 * Vedi anche lib/medmar-ticket-memory.ts per i tipi del route_code esistenti.
 */

import type { MedmarTicketRouteCode } from "@/lib/medmar-ticket-memory";

export type MedmarPreflightStatus =
  | "ok"
  | "no_match"
  | "ambiguous"
  | "not_medmar"
  | "manual_review"
  | "route_mismatch"
  | "unsupported_passenger_type"
  | "medmar_unavailable"
  | "medmar_auth_expired"
  | "error";

/**
 * Riga corsa reale di GET .../api/corse/{id_tratta} (Fase 1.5B — schema
 * confermato da risposte JSON reali). Solo i campi usati dal matching sono
 * modellati (lo schema reale ne contiene molti altri: id_corsa_periodica,
 * id_listino, id_configurazione, diretta, tempo_percorrenza, stagione_*,
 * blocca_overbooking, flag_bypassa, bypassa, ruoli, tratta — non necessari
 * alla logica attuale).
 */
export type CorsaMedmarRaw = {
  id_corsa: number | string | null;
  id_tratta: number | null;
  partenza_data: string | null;
  partenza_ora: string | null;
  flag_chiuso: boolean | number | null;
  flag_sospeso: boolean | number | null;
  id_porto_partenza: number | null;
  id_porto_arrivo: number | null;
  porto_partenza: string | null;
  porto_arrivo: string | null;
  nave: string | null;
};

/** Envelope di paginazione reale (stile Laravel) osservato su GET .../api/corse/{id_tratta}. */
export type MedmarPaginatedEnvelope<T> = {
  data: T[];
  current_page: number | null;
  last_page: number | null;
  total: number | null;
};

/**
 * Riga di GET /api/biglietti/vendibili/{id_corsa} (Fase 1.6 — schema reale
 * CONFERMATO da risposte JSON reali). Solo i nomi di campo realmente
 * osservati: nessun alias inventato, nessun parsing multi-chiave permissivo.
 * "re" ha significato non ancora documentato: viene solo catturato per
 * diagnostica/Fase 2, mai usato per decidere can_issue.
 */
export type BigliettoVendibileRaw = {
  id_corsa: number | string | null;
  id_biglietto: number | string | null;
  id_tipologia_passeggero: number | null;
  id_tariffa: number | string | null;
  id_log: number | string | null;
  id_iva: number | string | null;
  id_gruppo: number | string | null;
  biglietto: string | null;
  prezzo: number | null;
  prezzo_prevendita: number | null;
  quantita: number | null;
  flag_ar: string | null;
  flag_collegabile: boolean | number | null;
  flag_targa: boolean | number | null;
  checkin: boolean | null;
  re: unknown;
};

export type MedmarPreflightWarning = { code: string; message: string };

export type MedmarPreflightLeg = {
  direction: "outward" | "return";
  route_code: MedmarTicketRouteCode | null;
  route: { from: string; to: string } | null;
  date: string;
  requested_time: string | null;
  matched_departure_time: string | null;
  vessel: string | null;
  service_ids: string[];
  /** Presente solo se determinata da chiamata live a Medmar. */
  id_corsa: number | string | null;
  /** "live" se determinata da Medmar in tempo reale, "local_fallback" se solo diagnostica, null se non determinata. */
  source: "live" | "local_fallback" | null;
};

export type MedmarPreflightTariff = {
  id_biglietto: number | string | null;
  id_tariffa: number | string | null;
  label: string | null;
  unit_price_cents: number | null;
  source: "medmar_live" | "ticket_memory" | "unknown";
};

export type MedmarPreflightTaxLine = {
  label: string;
  amount_cents: number | null;
};

export type MedmarPreflightResult = {
  ok: boolean;
  can_issue: boolean;
  status: MedmarPreflightStatus;
  group_key: string;
  customer_name: string | null;
  pratica: string | null;
  pax: number;
  outward: MedmarPreflightLeg | null;
  return: MedmarPreflightLeg | null;
  tariff: MedmarPreflightTariff | null;
  taxes: MedmarPreflightTaxLine[];
  expected_total_cents: number | null;
  is_live: boolean;
  warnings: MedmarPreflightWarning[];
  error: string | null;
};

export type MedmarPreflightServiceRow = {
  id: string;
  tenant_id: string;
  date: string;
  time: string | null;
  customer_name: string | null;
  pax: number | null;
  vessel: string | null;
  notes: string | null;
  booking_service_kind: string | null;
  direction: string | null;
  status: string | null;
};
