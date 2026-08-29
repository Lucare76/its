/**
 * applyPickupCalc — CANONICO per la scrittura: unico punto da chiamare prima
 * di ogni INSERT/UPDATE su services che possa richiedere un pickup_hotel
 * calcolato, indipendentemente dal canale di ingresso (manuale operatore,
 * agenzia, Excel, email/inbox-approve). Vedi audit di sessione: prima di
 * questa estensione i canali usavano calcolatori diversi (o nessuno) per
 * scenari operativamente equivalenti — vedi §14 del report per la mappa.
 *
 * Due domini indipendenti, entrambi gestiti qui:
 *
 *  A. Treno/aereo (transfer_train_hotel e transfer_airport_hotel, incluse le
 *     varianti _aliscafo/_exclusive). Motore decisionale CONDIVISO col
 *     read-path (lib/operational-timing-resolver.ts, usato da /departures):
 *       1. se il chiamante passa `context` (operationalRules + ferrySchedules
 *          + date, gia' caricati in batch — vedi sotto) -> resolveOperationalConnection()
 *          (lib/operational-connection-resolver.ts), la STESSA funzione che il
 *          read-path chiama. Se produce una regola canonica DB o un override
 *          manuale, quel valore viene scritto — mai duplicato qui (nessuna
 *          reimplementazione di findCanonicalRule()).
 *       2. altrimenti (nessun context, o nessuna regola canonica/override
 *          trovati per quella fascia) -> fallback storico invariato: tabelle
 *          statiche calc-pickup-time.ts (comportamento pre-esistente, MAI
 *          rimosso — vedi nota fallback).
 *     Questo chiude il mismatch scrittura/lettura possibile prima di questa
 *     modifica: senza `context`, una regola canonica modificata a DB restava
 *     invisibile al write-path, che continuava a persistere il valore statico.
 *
 *  B. Formula SNAV/MEDMAR diretta (booking_service_kind formula_snav /
 *     formula_medmar_napoli / formula_medmar_pozzuoli) oppure porto-porto
 *     puro (transfer_port_hotel con vessel che nomina SNAV/MEDMAR) → tabelle
 *     zona-based di lib/departure-pickup-rules.ts (getPickupRule), la stessa
 *     fonte gia' usata da /departures e (prima di questa centralizzazione)
 *     duplicata localmente in app/api/email/inbox-approve/route.ts — ora
 *     quella duplicazione viene rimossa in favore di questa unica funzione.
 *     Richiede `hotel_zone` (il chiamante lo recupera dalla riga hotel gia'
 *     caricata): se assente, nessun pickup viene inventato — pickup_alert
 *     esplicito, stesso comportamento fail-safe gia' in uso. NON tocca
 *     resolveOperationalConnection (fuori dal suo dominio: treno/volo solo).
 *
 * Qualunque altro kind (navette, escursioni, hotel-hotel, bus, transfer_port_hotel
 * senza compagnia riconoscibile) → {} (non applicabile, nessun calcolo).
 *
 * NB: `place_type` descrive l'origine del pickup (quasi sempre "hotel" per le
 * partenze), non la destinazione — non e' un indicatore affidabile del mezzo.
 * Il trigger usa `booking_service_kind`, che codifica il mezzo esplicitamente.
 *
 * Popola: pickup_hotel, barca_compagnia, orario_barca, porto_bruno, pickup_alert, vessel
 * (dominio A) oppure solo pickup_hotel/pickup_alert (dominio B — barca_compagnia/
 * orario_barca/porto_bruno per Formula sono gia' valorizzati dal chiamante con
 * i propri campi raw, es. ferry_dep_time/porto_partenza in new-booking).
 *
 * Performance: questa funzione resta PURA/context-driven — nessuna query al
 * suo interno. Il chiamante carica operationalRules/ferrySchedules UNA volta
 * per l'intero batch (import Excel, approvazione email, ecc.) e li passa in
 * `context` a ogni chiamata per singolo servizio — mai una query per riga.
 */
import { calcPickupTime } from "@/lib/server/calc-pickup-time";
import { getPickupRule, normalizeZonaIschia, derivePortCarrier } from "@/lib/departure-pickup-rules";
import { resolveOperationalConnection, type OperationalPickupRule, type OperationalConnectionInput } from "@/lib/operational-connection-resolver";
import type { FerryScheduleRow } from "@/lib/travel-connection-resolver";

/**
 * Contesto opzionale per abilitare il Livello 1 (regola canonica DB / override
 * manuale) del dominio A. Stesso shape di lib/operational-timing-resolver.ts
 * (OperationalTimingContext) + `date`, richiesta qui per la validita'
 * temporale della regola (valid_from/valid_to/days_of_week) e assente in
 * quel tipo. Se omesso, il dominio A usa solo il fallback statico invariato.
 */
export type PickupCalcCanonicalContext = {
  operationalRules: OperationalPickupRule[];
  ferrySchedules: FerryScheduleRow[];
  date: string; // YYYY-MM-DD
  hotelId?: string | null;
  currentOverride?: OperationalConnectionInput["currentOverride"];
};

const RECOGNIZED_ZONES = /forio|lacco|casamicciola|barano|ischia/;

const TRAIN_KINDS = new Set(["transfer_train_hotel", "transfer_train_hotel_exclusive", "transfer_train_hotel_aliscafo"]);
const AIRPORT_KINDS = new Set(["transfer_airport_hotel", "transfer_airport_hotel_exclusive", "transfer_airport_hotel_aliscafo"]);
const ALISCAFO_KINDS = new Set(["transfer_train_hotel_aliscafo", "transfer_airport_hotel_aliscafo"]);

/** Formula SNAV/MEDMAR diretta → compagnia implicita nel kind stesso (non nel testo vessel). */
const FORMULA_CARRIER: Record<string, "snav" | "medmar"> = {
  formula_snav: "snav",
  formula_medmar_napoli: "medmar",
  formula_medmar_pozzuoli: "medmar",
};

function directCarrierFromKind(kind: string | null | undefined, vessel: string | null | undefined): "snav" | "medmar" | null {
  if (kind && FORMULA_CARRIER[kind]) return FORMULA_CARRIER[kind];
  if (kind === "transfer_port_hotel") return derivePortCarrier(vessel);
  return null;
}

/**
 * Esportate (non solo per uso interno) perche' il fallback statico
 * (calcPickupTime) e' condiviso anche dal read-path (resolveOperationalTiming,
 * lib/operational-timing-resolver.ts) — stessa mappatura kind/agenzia/vessel
 * -> input di calcPickupTime, mai duplicata. Import a senso unico (il
 * read-path importa queste funzioni pure; questo file non importa mai nulla
 * dal read-path) — nessuna dipendenza circolare, nessuna chiamata di
 * resolveOperationalTiming/applyPickupCalc l'una verso l'altra.
 */
export function mezzoFromKind(kind: string | null | undefined): "treno" | "aereo" | null {
  if (!kind) return null;
  if (TRAIN_KINDS.has(kind)) return "treno";
  if (AIRPORT_KINDS.has(kind)) return "aereo";
  return null;
}

/**
 * Mappa billing_party_name → agency_key per le regole di calcPickupTime.
 * Sosandra/Dimhotels hanno regole diverse (aliscafo alternato, nessun pickup_hotel).
 * Tutte le altre agenzie usano le stesse regole di Aleste (Medmar traghetto).
 */
export function billingToAgencyKey(name: string | null | undefined): string {
  const n = (name ?? "").toLowerCase();
  if (n.includes("sosandra") || n.includes("dimhotel")) return "sosandra";
  if (n.includes("aleste")) return "aleste";
  if (n.includes("angelino")) return "angelino";
  if (n.includes("zigolo")) return "zigolo";
  return "aleste"; // default: stesse regole Aleste (Medmar traghetto)
}

/**
 * Deriva tipo_barca. Priorita': variante "_aliscafo" nel booking_service_kind
 * (esplicita), poi fallback sul nome vessel gia' noto (Alilauro/Snav = aliscafo).
 */
export function tipoBarcaFor(kind: string | null | undefined, vessel: string | null | undefined): "traghetto" | "aliscafo" {
  if (kind && ALISCAFO_KINDS.has(kind)) return "aliscafo";
  const v = (vessel ?? "").toLowerCase();
  if (v.includes("alilauro") || v.includes("snav")) return "aliscafo";
  return "traghetto";
}

export type PickupCalcFields = {
  pickup_hotel: string | null;
  barca_compagnia: string | null;
  orario_barca: string | null;
  porto_bruno: string | null;
  pickup_alert: string | null;
  vessel: string;
};

/**
 * Ritorna i campi calcolati da aggiungere all'INSERT/UPDATE, oppure {} se
 * il servizio non è una partenza in treno o aereo (booking_service_kind).
 */
export function applyPickupCalc(opts: {
  direction: string;
  booking_service_kind?: string | null;
  time: string;                       // orario treno/volo HH:MM (dominio A) oppure orario nave (dominio B: Formula/porto-porto)
  billing_party_name?: string | null; // nome agenzia per determinare le regole
  vessel?: string | null;             // vessel già noto (per tipo_barca, fallback, e per riconoscere SNAV/MEDMAR in transfer_port_hotel)
  hotel_zone?: string | null;         // zona hotel (dominio B: obbligatoria per calcolare; dominio A: opzionale, abilita il match di zona nella regola canonica)
  hotel_name?: string | null;         // solo per arricchire il messaggio di pickup_alert quando manca la zona
  context?: PickupCalcCanonicalContext; // dominio A: se presente, tenta prima la regola canonica DB / override — vedi docstring del file
}): Partial<PickupCalcFields> {
  if (opts.direction !== "departure") return {};
  if (!opts.time) return {};

  const mezzo = mezzoFromKind(opts.booking_service_kind);
  if (mezzo) {
    // Livello 1 (condiviso col read-path): regola canonica DB o override
    // manuale, via la STESSA resolveOperationalConnection() gia' usata da
    // /departures — mai una findCanonicalRule() reimplementata qui.
    if (opts.context && opts.booking_service_kind) {
      const zoneRaw = opts.hotel_zone ?? null;
      const zoneRecognized = zoneRaw ? RECOGNIZED_ZONES.test(zoneRaw.toLowerCase()) : false;
      const connection = resolveOperationalConnection({
        direction: "from_ischia",
        bookingServiceKind: opts.booking_service_kind,
        transportTime: opts.time,
        date: opts.context.date,
        hotelId: opts.context.hotelId ?? null,
        zone: zoneRaw ? normalizeZonaIschia(zoneRaw) : null,
        zoneRecognized,
        agencyName: opts.billing_party_name ?? null,
        operationalRules: opts.context.operationalRules,
        ferrySchedules: opts.context.ferrySchedules,
        currentOverride: opts.context.currentOverride ?? null,
      });
      if (connection.source === "canonical_rule" || connection.source === "manual_override") {
        return {
          pickup_hotel:    connection.pickupTime,
          barca_compagnia: connection.company,
          orario_barca:    connection.ferryDepartureTime,
          porto_bruno:     connection.embarkPort,
          pickup_alert:    connection.warnings.join(" ") || null,
          vessel: connection.company ?? opts.vessel ?? "",
        };
      }
      // Nessuna regola canonica ne' override per questa fascia: prosegue sul
      // fallback statico sotto — MAI resolveOperationalConnection's proprio
      // fallback legacy (resolveTravelConnection), che non produce pickup_hotel.
    }

    // Livello 2: fallback storico invariato (tabelle statiche calc-pickup-time.ts).
    const agency_key = billingToAgencyKey(opts.billing_party_name);
    const tipo_barca = tipoBarcaFor(opts.booking_service_kind, opts.vessel);

    const result = calcPickupTime({ agency_key, mezzo, tipo_barca, orario: opts.time });

    return {
      pickup_hotel:    result.pickup_hotel,
      barca_compagnia: result.barca_compagnia,
      orario_barca:    result.orario_barca,
      porto_bruno:     result.porto_bruno,
      pickup_alert:    result.alert,
      // Aggiorna vessel con la compagnia calcolata (se non già impostato)
      vessel: result.barca_compagnia ?? opts.vessel ?? "",
    };
  }

  // Dominio B: Formula SNAV/MEDMAR diretta, o transfer_port_hotel (porto-porto
  // puro). Qualunque altro kind (navette, escursioni, hotel-hotel, bus) resta
  // {} — genuinamente fuori scope, nessun alert. transfer_port_hotel invece
  // e' SEMPRE nel dominio: se la compagnia non e' riconoscibile dal testo
  // vessel, e' un dato mancante da segnalare (non un kind fuori scope) — stesso
  // alert in qualunque canale, non solo per l'email import che lo generava prima.
  const isFormulaKind = Boolean(opts.booking_service_kind && FORMULA_CARRIER[opts.booking_service_kind]);
  const isPortHotelKind = opts.booking_service_kind === "transfer_port_hotel";
  if (!isFormulaKind && !isPortHotelKind) return {};

  const carrier = directCarrierFromKind(opts.booking_service_kind, opts.vessel);
  if (!carrier) {
    return { pickup_alert: `Pickup hotel non calcolato: compagnia traghetto/aliscafo non riconosciuta — verificare manualmente.` };
  }

  if (!opts.hotel_zone) {
    const hotelLabel = opts.hotel_name ? `"${opts.hotel_name}"` : "";
    return { pickup_alert: `Pickup hotel non calcolato: zona non impostata per l'hotel ${hotelLabel} — impostare la zona e ricalcolare.`.replace(/  /g, " ") };
  }
  const zona = normalizeZonaIschia(opts.hotel_zone);

  // Livello 1 (stesso pattern del Dominio A sopra): se il chiamante passa
  // `context`, tenta prima la regola canonica DB (transport_type='direct',
  // vedi lib/operational-connection-resolver.ts) via resolveOperationalConnection
  // — la STESSA funzione, nessuna reimplementazione. Oggi ferry_pickup_rules
  // non ha ancora righe direction='from_ischia' popolate (vedi migration
  // 0262_ferry_pickup_rules_departure_seed.sql, non ancora applicata), quindi
  // questo ramo non cambia alcun output reale finché il seed non viene
  // eseguito — è preparazione per la fonte-unica-DB, non un comportamento
  // nuovo oggi. getPickupRule() (statico) resta il fallback, MAI rimosso qui.
  if (opts.context && opts.booking_service_kind) {
    const connection = resolveOperationalConnection({
      direction: "from_ischia",
      bookingServiceKind: opts.booking_service_kind,
      vessel: opts.vessel ?? null,
      transportTime: opts.time,
      date: opts.context.date,
      hotelId: opts.context.hotelId ?? null,
      zone: zona,
      zoneRecognized: true, // normalizeZonaIschia() ha sempre un default valido ("ischia"), mai un valore non riconosciuto qui
      agencyName: opts.billing_party_name ?? null,
      operationalRules: opts.context.operationalRules,
      ferrySchedules: opts.context.ferrySchedules,
    });
    if (connection.source === "canonical_rule" && connection.pickupTime) {
      return { pickup_hotel: connection.pickupTime, pickup_alert: connection.warnings.join(" ") || null };
    }
    // eslint-disable-next-line no-console -- log deliberato: traccia l'uso del
    // fallback legacy (departure-pickup-rules.ts) per capire quando il seed
    // DB è stato applicato e la regola non è (ancora) migrata/configurata.
    console.warn(
      `[applyPickupCalc] Dominio B (${carrier}): nessuna regola canonica DB per kind='${opts.booking_service_kind}' ` +
        `orario='${opts.time}' zona='${zona}' — uso fallback legacy lib/departure-pickup-rules.ts.`
    );
  }

  const rule = getPickupRule(opts.billing_party_name ?? "", carrier, opts.time, zona);
  if (!rule) {
    return { pickup_alert: `Pickup hotel non calcolato: nessuna regola ${carrier.toUpperCase()} per zona "${zona}" orario ${opts.time} — verificare manualmente.` };
  }
  return { pickup_hotel: rule.pickup, pickup_alert: null };
}
