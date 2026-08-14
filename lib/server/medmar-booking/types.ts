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
  /**
   * Fase 2B.5: gruppo con bambino/infant classificati correttamente e
   * prezzo/tariffa determinabili, ma emissione volutamente NON abilitata
   * ancora (payload di emissione minori non verificato contro Medmar
   * reale). can_issue resta SEMPRE false su questo stato — vedi
   * passengers/ticket_breakdown per i dati comunque disponibili.
   */
  | "passenger_payload_pending_verification"
  | "medmar_unavailable"
  | "medmar_auth_expired"
  /** MEDMAR_EMAIL/MEDMAR_PASSWORD (o, in compatibilità, MEDMAR_SESSION_TOKEN) assenti o a metà configurati: mai un crash, sempre can_issue=false. */
  | "medmar_auth_not_configured"
  | "error";

/**
 * Riga corsa reale di GET .../api/corse/{id_tratta} (Fase 1.5B — schema
 * confermato da risposte JSON reali; envelope di trasporto corretto in Fase
 * 2A.2, vedi MedmarApiEnvelope sotto — l'array righe vive sotto
 * output.data, non alla radice). Solo i campi usati dal matching sono
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

/**
 * Envelope esterno comune a tutte le risposte reali osservate dell'API
 * Medmar (Fase 2A.2 — confermato su /authenticate, GET corse, GET
 * biglietti/vendibili tramite smoke test reale): { return: true, output: T }.
 * "return" deve essere confrontato in modo stretto (=== true), stesso
 * criterio già usato per /authenticate (vedi medmar-auth-provider.ts).
 */
export type MedmarApiEnvelope<T> = {
  return: unknown;
  output: T;
};

/** Payload di paginazione reale (stile Laravel) osservato sotto output di GET .../api/corse/{id_tratta}. */
export type MedmarPaginatedEnvelope<T> = {
  data: T[];
  current_page: number | null;
  last_page: number | null;
  total: number | null;
};

/**
 * Riga di GET /api/biglietti/vendibili/{id_corsa} — schema riallineato in
 * Fase 2A.2 sullo schema REALE osservato tramite smoke test reale (Fase
 * 2A.1), che ha superseduto lo schema Fase 1.6 (mai stato reale: verificato
 * contro un envelope sbagliato). Solo i nomi di campo realmente osservati:
 * nessun alias inventato, nessun parsing multi-chiave permissivo. Campi
 * reali osservati ma deliberatamente NON modellati qui perché di struttura
 * ignota e non usati dalla logica attuale: gruppo, cumulativo, orePrevendita,
 * biglietti_bonus, passeggeri_tipologia, collegati, collegabili, dipendenti.
 *
 * RIMOSSI rispetto allo schema Fase 1.6 (mai osservati realmente):
 * "biglietto" (sostituito da nome/descrizione), "flag_ar" (sostituito da
 * flag_ar_obbligatorio, booleano), "quantita" (sostituito da
 * quantita_min_per_esclusivo/quantita_max_per_esclusivo), "checkin",
 * "id_gruppo", "flag_collegabile", "re".
 *
 * "prezzo_ar" e "prezzo_prevendita": chiavi reali confermate, ma semantica
 * NON confermata (la riga tariffa AR realmente osservata aveva prezzo=11.5,
 * prezzo_ar/prezzo_prevendita non verificati come "il" prezzo AR). Catturati
 * per diagnostica, MAI usati al posto di "prezzo" per il calcolo di
 * can_issue finché non verificati con evidenza reale.
 *
 * "quantita_min_per_esclusivo" / "quantita_max_per_esclusivo": stessa
 * cautela già documentata per "quantita" in Fase 1.7 — il nome ("per
 * esclusivo") suggerisce un vincolo di vendita esclusiva, non posti
 * residui. NON usati come guard di disponibilità. Per verificarli davvero
 * servirebbe osservare la stessa corsa/tariffa PRIMA e DOPO un'emissione
 * reale (fuori scope: nessuna emissione viene fatta da questo modulo).
 */
export type BigliettoVendibileRaw = {
  id_corsa: number | string | null;
  id_biglietto: number | string | null;
  id_tipologia_passeggero: number | null;
  id_tariffa: number | string | null;
  id_iva: number | string | null;
  id_log: number | string | null;
  /** Etichetta breve — fonte SECONDARIA di label (vedi resolveBigliettoLabel in live-parser.ts). */
  nome: string | null;
  /** Etichetta estesa — fonte PRIMARIA di label e di identificazione AR/tassa di sbarco. */
  descrizione: string | null;
  /** UNICO prezzo usato per can_issue (vedi commento sopra su prezzo_ar/prezzo_prevendita). */
  prezzo: number | null;
  prezzo_ar: number | null;
  prezzo_prevendita: number | null;
  /** Segnale SECONDARIO/informativo, mai discriminante da solo per identificare l'AR (vedi live-parser.ts). */
  flag_ar_obbligatorio: boolean | number | null;
  flag_targa: boolean | number | null;
  quantita_min_per_esclusivo: number | null;
  quantita_max_per_esclusivo: number | null;
  /**
   * Fase 2B.5: array grezzo di biglietti collegati (es. tassa di sbarco
   * legata a un titolo passeggero), osservato realmente ma di struttura
   * interna NON verificata su JSON grezzo — MAI parsato in campi tipizzati
   * qui, solo attraversato difensivamente da deriveTaxLinkage in
   * live-parser.ts (cerca un id_biglietto corrispondente). null se assente.
   */
  collegati: unknown;
};

export type MedmarPreflightWarning = { code: string; message: string };

export type MedmarPreflightLeg = {
  direction: "outward" | "return";
  route_code: MedmarTicketRouteCode | null;
  route: { from: string; to: string } | null;
  date: string;
  requested_time: string | null;
  matched_departure_time: string | null;
  candidate_count: number | null;
  match_source: "booked_ferry_time" | null;
  vessel: string | null;
  service_ids: string[];
  /** Presente solo se determinata da chiamata live a Medmar. */
  id_corsa: number | string | null;
  /** "live" se determinata da Medmar in tempo reale, "local_fallback" se solo diagnostica, null se non determinata. */
  source: "live" | "local_fallback" | null;
  /**
   * Fase 2B.7 — dettaglio tariffa/tasse per QUESTA gamba soltanto, ricavato
   * dalla risposta biglietti/vendibili della SUA id_corsa (mai riusato tra
   * andata e ritorno). Opzionale/undefined quando la gamba non è stata
   * ancora prezzata (route non risolta, corsa non trovata, ecc.) — usare
   * `?? null` in lettura, mai assumere un default diverso da "non prezzato".
   */
  ticket_breakdown?: MedmarPreflightTicketBreakdown | null;
  /**
   * Fase 2B.7 — totale (tariffa + tasse) × pax per QUESTA gamba soltanto.
   * MAI il totale A/R: il totale A/R è la somma di outward.total_cents +
   * return.total_cents (vedi MedmarPreflightResult.expected_total_cents).
   * null/undefined se non determinabile con certezza sui dati live.
   */
  total_cents?: number | null;
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

/** Fase 2B.5 — categorie passeggero riconosciute per la classificazione biglietti (tax esclusa: non è un passeggero). */
export type MedmarPassengerCategory = "adult" | "child" | "infant";

/**
 * Conteggio passeggeri per categoria di un gruppo di servizi. Fonte
 * preferita: services.ferry_details.medmar_adult_count/medmar_child_count/
 * medmar_infant_count (strutturato, catturato in fase di prenotazione — vedi
 * lib/booking-ancillaries.ts). Se questi campi non sono mai stati
 * valorizzati (prenotazioni precedenti alla Fase 2B.5, tutti a zero), si
 * ricade su adults=pax/children=0/infants=0 (comportamento storico
 * invariato) — MAI un'età dedotta da testo libero.
 */
export type MedmarPreflightPassengerCounts = {
  adults: number;
  children: number;
  infants: number;
  source: "medmar_counts" | "pax_fallback";
};

export type MedmarPreflightPassengerTicket = {
  count: number;
  id_biglietto: number | string | null;
  id_log: number | string | null;
  label: string | null;
  unit_price_cents: number | null;
  total_cents: number | null;
};

export type MedmarPreflightTaxBreakdown = {
  count: number;
  label: string | null;
  unit_amount_cents: number | null;
  total_amount_cents: number | null;
};

export type MedmarPreflightTicketBreakdown = {
  adult: MedmarPreflightPassengerTicket | null;
  child: MedmarPreflightPassengerTicket | null;
  infant: MedmarPreflightPassengerTicket | null;
  taxes: MedmarPreflightTaxBreakdown | null;
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
  /** Fase 2B.5 — null solo per gli status "early" (error/not_medmar/db_error) dove i servizi non sono nemmeno stati letti. */
  passengers: MedmarPreflightPassengerCounts | null;
  /** Fase 2B.5 — dettaglio per categoria, popolato solo quando la tariffa adulto live è stata determinata (stesso momento in cui tariff/taxes sopra vengono popolati). */
  ticket_breakdown: MedmarPreflightTicketBreakdown | null;
};

export type MedmarPreflightServiceRow = {
  id: string;
  tenant_id: string;
  date: string;
  time: string | null;
  outbound_time?: string | null;
  return_time?: string | null;
  customer_name: string | null;
  pax: number | null;
  vessel: string | null;
  notes: string | null;
  booking_service_kind: string | null;
  direction: string | null;
  status: string | null;
  /**
   * Stesso campo/stessa regola già usati da
   * lib/service-display.ts:getDepartureIschiaPort per distinguere Ischia da
   * Casamicciola lato Pozzuoli. Usato da port-resolution.ts per risolvere il
   * porto isolano della gamba (Fase 1.7).
   */
  meeting_point: string | null;
  orario_barca?: string | null;
  /**
   * Fase 2B.5 — jsonb popolato da lib/booking-ancillaries.ts alla creazione
   * del servizio (app/api/ops/new-booking/route.ts). Contiene
   * medmar_adult_count/medmar_child_count/medmar_infant_count quando la
   * prenotazione li ha catturati; opzionale perché prenotazioni precedenti
   * non hanno mai valorizzato questi campi. Parsato SOLO da
   * passenger-composition.ts, mai letto altrove come testo libero.
   */
  ferry_details?: unknown;
  /**
   * Fase 2B.6 — "modello single-row": alcuni canali di prenotazione (es.
   * app/api/agency/bookings/route.ts, o app/api/ops/new-booking/route.ts con
   * trip_leg="outbound_only" ma date di ritorno comunque compilate) salvano
   * andata E ritorno sulla STESSA riga services (direction resta "arrival"),
   * senza creare una seconda riga collegata da linked_service_id. Letti SOLO
   * per ricostruire in memoria la gamba di ritorno quando non esiste alcuna
   * riga reale con direction="departure" — vedi resolveEmbeddedReturnLeg in
   * preflight.ts. Mai scritti, mai propagati a service_ids.
   */
  departure_date?: string | null;
  departure_time?: string | null;
};
