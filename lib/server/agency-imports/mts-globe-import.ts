import type { SupabaseClient } from "@supabase/supabase-js";
import { canonicalizeKnownHotelName } from "@/lib/server/hotel-aliases";
import { resolveHotelMatch, type HotelMatchRow } from "@/lib/server/hotel-matching";
import { parseMtsGlobeRows, type MtsGlobeBookingDraft, type MtsGlobeParsedLeg } from "@/lib/server/agency-imports/mts-globe-parser";
import { generateSunSeaServices, type GeneratedServiceDraft, type ResolvedHotelForLeg } from "@/lib/server/agency-imports/sunsea-service-generator";
import { applyPickupCalc, type PickupCalcCanonicalContext } from "@/lib/server/apply-pickup-calc";

const SOURCE = "mts_globe";

// Chiave di correzione hotel manuale (operatore, in preview): una entry per
// leg semplice (arrivo/partenza), due per hotel_change (":from" / ":to").
// Stessa forma sia in preview che in confirm, cosi' l'operatore puo' correggere
// in preview e il confirm rispetta esattamente la stessa risoluzione.
export type MtsGlobeHotelCorrections = Record<string, string>;

function hotelCorrectionKey(voucherNo: string, rowIndex: number, part?: "from" | "to"): string {
  return part ? `${voucherNo}#${rowIndex}#${part}` : `${voucherNo}#${rowIndex}`;
}

// Correzione manuale dell'orario transfer Intermedio (HH:MM), stessa
// filosofia delle correzioni hotel: dato indispensabile mancante nel file
// reale (Dep Time/Arr Time sempre vuoti per le righe Intermedio) -> WARNING
// bloccante finche' l'operatore non lo inserisce in preview.
export type MtsGlobeTimeCorrections = Record<string, string>;

function timeCorrectionKey(voucherNo: string, rowIndex: number): string {
  return `${voucherNo}#${rowIndex}#time`;
}

const VALID_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// Serializzazione JSON con chiavi ordinate ricorsivamente, indipendente
// dall'ordine di inserimento. Necessaria per confrontare un oggetto JS appena
// costruito con lo stesso oggetto riletto da una colonna JSONB Postgres, che
// non garantisce l'ordine delle chiavi originale (bug reale osservato: senza
// questo, ogni reimport identico risultava "update" invece di "duplicate").
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// Agenzie con una logica operativa nave verificata nel codice ITS (vedi
// lib/server/apply-pickup-calc.ts billingToAgencyKey e
// lib/travel-connection-resolver.ts resolveAgencyConnectionPolicy — stesso
// criterio di normalizzazione riusato qui, non reinventato). Qualunque altra
// agenzia (Sun&Sea inclusa) ricade sulla policy di default conservativa gia'
// documentata nel codebase (commento in travel-connection-resolver.ts riga
// ~103, che cita esplicitamente "Sun & sea" come caso reale osservato): mai
// aliscafo automatico, stesse tabelle statiche di Aleste. Qui aggiungiamo
// solo un warning di trasparenza non bloccante, mai un secondo default.
function isKnownAgency(agencyName: string | null | undefined): boolean {
  const n = (agencyName ?? "").toLowerCase();
  return n.includes("sosandra") || n.includes("dimhotel") || n.includes("aleste") || n.includes("angelino") || n.includes("zigolo");
}

export type AgencyBookingRowStatus = "ready" | "warning" | "error" | "duplicate" | "update";

export type MtsGlobePreviewBooking = {
  voucherNo: string;
  sourceBookingKey: string;
  customerName: string;
  date: string;
  pax: number;
  hotelNameRaw: string | null;
  serviceScope: MtsGlobeBookingDraft["serviceScope"];
  status: AgencyBookingRowStatus;
  reasons: string[];
  generatedServices: GeneratedServiceDraft[];
  existingAgencyBookingId: string | null;
};

export type MtsGlobePreviewResult = {
  bookings: MtsGlobePreviewBooking[];
  rowErrors: Array<{ rowIndex: number; voucherNo: string | null; message: string }>;
  summary: {
    totalRows: number;
    bookingCount: number;
    serviceCount: number;
    readyCount: number;
    warningCount: number;
    errorCount: number;
    duplicateCount: number;
    updateCount: number;
  };
};

type HotelCatalogRow = HotelMatchRow & { zone: string | null; city: string | null };

// Comuni reali dell'isola d'Ischia (le uniche zone coperte dalla logica
// pickup/nave esistente, pensata SOLO per transfer da/verso l'isola).
// Deliberatamente NON usa normalizeZonaIschia() (logica condivisa, mai
// modificata qui): quella funzione collassa qualunque zona non riconosciuta
// su "ischia" di default — corretto per varianti di nome della stessa isola,
// ma pericoloso per un hotel sul continente (es. Napoli), che verrebbe
// silenziosamente trattato come se fosse a Ischia. Questo controllo serve
// solo a decidere SE invocare applyPickupCalc, non a normalizzare la zona.
const ISCHIA_COMUNI_RE = /ischia|forio|lacco ameno|casamicciola|serrara fontana|barano/i;

function isIschiaComune(hotel: HotelCatalogRow | null): boolean {
  if (!hotel) return true; // hotel non risolto: gestito altrove (hotelUnresolved), non e' questo il gate
  const label = `${hotel.city ?? ""} ${hotel.zone ?? ""}`.trim();
  if (!label) return true; // nessun dato di zona/citta': nessuna evidenza che sia continente, non bloccare qui
  return ISCHIA_COMUNI_RE.test(label);
}

// Messaggio esatto per il caso "hotel su zona/citta' non coperta dalla
// logica pickup Ischia" — confrontato per uguaglianza esatta altrove
// (buildMtsGlobePreview) per decidere se bloccare il confirm, stesso
// pattern di "Orario transfer Intermedio mancante.".
const CONTINENTE_NOT_COVERED_WARNING = "Transfer continente non coperto dalla logica pickup automatica — verifica operatore.";

async function loadHotelCatalog(admin: SupabaseClient, tenantId: string): Promise<HotelCatalogRow[]> {
  const { data: hotels } = await admin.from("hotels").select("id, name, normalized_name, zone, city").eq("tenant_id", tenantId).limit(1000);
  const { data: aliasRows } = await admin.from("hotel_aliases").select("hotel_id, alias").eq("tenant_id", tenantId).limit(5000);
  const aliasesByHotel = new Map<string, string[]>();
  for (const row of (aliasRows ?? []) as Array<{ hotel_id: string; alias: string }>) {
    const bucket = aliasesByHotel.get(row.hotel_id) ?? [];
    bucket.push(row.alias);
    aliasesByHotel.set(row.hotel_id, bucket);
  }
  return ((hotels ?? []) as Array<HotelMatchRow & { zone: string | null; city: string | null }>).map((hotel) => ({
    ...hotel,
    aliases: aliasesByHotel.get(hotel.id) ?? []
  }));
}

async function loadOperationalContext(admin: SupabaseClient): Promise<{ operationalRules: unknown[]; ferrySchedules: unknown[] }> {
  const { data: operationalRulesData } = await admin.from("ferry_pickup_rules").select("*");
  const { data: ferryScheduleData } = await admin
    .from("ferry_schedules")
    .select("company, departure_port, arrival_port, departure_time, arrival_time, direction, days_of_week, valid_from, valid_to");
  return { operationalRules: operationalRulesData ?? [], ferrySchedules: ferryScheduleData ?? [] };
}

function matchHotel(hotels: HotelCatalogRow[], rawName: string | null): { hotelId: string | null; confidence: "matched" | "unmatched" } {
  if (!rawName) return { hotelId: null, confidence: "unmatched" };
  const canonical = canonicalizeKnownHotelName(rawName) ?? rawName;
  const hotelId = resolveHotelMatch(hotels, canonical, null);
  return { hotelId, confidence: hotelId ? "matched" : "unmatched" };
}

// Un hotelId scelto manualmente dall'operatore (correzione in preview) e'
// sempre "matched": non si applica mai un secondo controllo di confidenza
// sulla scelta esplicita dell'operatore — nessuna auto-associazione a bassa
// confidenza qui, solo lettura di una scelta gia' fatta dall'umano.
function resolveLegHotels(
  leg: MtsGlobeParsedLeg,
  hotels: HotelCatalogRow[],
  corrections: MtsGlobeHotelCorrections
): ResolvedHotelForLeg[] {
  if (leg.legType === "hotel_change") {
    const fromCorrection = corrections[hotelCorrectionKey(leg.voucherNo, leg.rowIndex, "from")];
    const toCorrection = corrections[hotelCorrectionKey(leg.voucherNo, leg.rowIndex, "to")];
    const from = fromCorrection ? { hotelId: fromCorrection, confidence: "matched" as const } : matchHotel(hotels, leg.hotelFromRaw);
    const to = toCorrection ? { hotelId: toCorrection, confidence: "matched" as const } : matchHotel(hotels, leg.hotelToRaw);
    return [
      { legRowIndex: leg.rowIndex, hotelId: from.hotelId, matchConfidence: from.confidence },
      { legRowIndex: -leg.rowIndex, hotelId: to.hotelId, matchConfidence: to.confidence }
    ];
  }
  const correction = corrections[hotelCorrectionKey(leg.voucherNo, leg.rowIndex)];
  const result = correction ? { hotelId: correction, confidence: "matched" as const } : matchHotel(hotels, leg.hotelNameRaw);
  return [{ legRowIndex: leg.rowIndex, hotelId: result.hotelId, matchConfidence: result.confidence }];
}

// Riscrive hotelNameRaw/hotelToNameRaw (e per hotel_change anche notes) col
// nome hotel CANONICO quando risolto (match automatico o correzione
// operatore), invece del testo grezzo del file. Senza questo, un hotel
// corretto manualmente restava visualizzato — sia in UI (HotelCell legge
// questi stessi campi) sia, per l'Intermedio, nel campo notes persistito
// (l'unica colonna dei services che porta il nome della destinazione: nessuna
// colonna hotel_to_id esiste nello schema services) — col nome grezzo/errato
// originale anziche' con quello effettivamente scelto.
function resolveHotelNames(services: GeneratedServiceDraft[], hotels: HotelCatalogRow[]): GeneratedServiceDraft[] {
  const hotelById = new Map(hotels.map((h) => [h.id, h.name]));
  return services.map((service) => {
    const fromName = (service.hotelId && hotelById.get(service.hotelId)) || service.hotelNameRaw;
    const toName = (service.hotelToId && hotelById.get(service.hotelToId)) || service.hotelToNameRaw;
    if (service.bookingServiceKind !== "transfer_hotel_hotel") {
      return fromName === service.hotelNameRaw ? service : { ...service, hotelNameRaw: fromName };
    }
    return {
      ...service,
      hotelNameRaw: fromName,
      hotelToNameRaw: toName,
      notes: `Transfer hotel/hotel: ${fromName} -> ${toName}`
    };
  });
}

// Applica l'orario Intermedio inserito manualmente dall'operatore (preview),
// quando il file non ne porta uno reale (vedi hotelChangeTimeMissing). Un
// valore non valido (formato diverso da HH:MM) viene ignorato silenziosamente
// come "non ancora corretto" — mai scritto un orario malformato.
function applyIntermedioTimeCorrections(
  services: GeneratedServiceDraft[],
  voucherNo: string,
  corrections: MtsGlobeTimeCorrections
): GeneratedServiceDraft[] {
  return services.map((service) => {
    if (service.bookingServiceKind !== "transfer_hotel_hotel" || service.time) return service;
    const correction = corrections[timeCorrectionKey(voucherNo, service.legRowIndex)];
    if (!correction || !VALID_TIME_RE.test(correction)) return service;
    return {
      ...service,
      time: correction,
      warnings: service.warnings.filter((w) => w !== "Orario transfer Intermedio mancante.")
    };
  });
}

// Applica il motore canonico condiviso applyPickupCalc SOLO alle partenze
// aeroporto (hotel -> aeroporto): l'unico caso, tra i leg MTS Globe reali, che
// ricade nel dominio A di apply-pickup-calc.ts (transfer_airport_hotel).
// Arrivo e hotel_change restano fuori: per l'arrivo l'orario operativo e'
// gia' l'orario del volo (stessa convenzione di agency-pdf-import.ts, che usa
// arrival_time = orario volo direttamente, senza motore); per hotel_change
// non esiste un dominio applyPickupCalc (non e' un transfer treno/aereo).
function applyDepartureOperationalTiming(
  services: GeneratedServiceDraft[],
  booking: MtsGlobeBookingDraft,
  hotels: HotelCatalogRow[],
  operationalContext: { operationalRules: unknown[]; ferrySchedules: unknown[] }
): GeneratedServiceDraft[] {
  const hotelById = new Map(hotels.map((h) => [h.id, h]));
  return services.map((service) => {
    if (service.direction !== "departure" || service.bookingServiceKind !== "transfer_airport_hotel") return service;

    const hotel = service.hotelId ? hotelById.get(service.hotelId) ?? null : null;

    // Protezione locale, non nel motore condiviso: applyPickupCalc/
    // normalizeZonaIschia coprono SOLO transfer da/verso l'isola d'Ischia.
    // Un hotel risolto ma su zona/citta' non riconosciuta come comune di
    // Ischia (es. Napoli) verrebbe altrimenti passato ad applyPickupCalc,
    // che internamente ricade su normalizeZonaIschia() e tratterebbe
    // silenziosamente "Napoli" come "ischia" — mai nave/porto/pickup
    // inventati per un caso che il motore non e' stato pensato per coprire.
    if (hotel && !isIschiaComune(hotel)) {
      return {
        ...service,
        pickupHotel: null,
        barcaCompagnia: null,
        orarioBarca: null,
        portoBruno: null,
        pickupAlert: CONTINENTE_NOT_COVERED_WARNING,
        warnings: [...service.warnings, CONTINENTE_NOT_COVERED_WARNING]
      };
    }

    const context: PickupCalcCanonicalContext = {
      operationalRules: operationalContext.operationalRules as never,
      ferrySchedules: operationalContext.ferrySchedules as never,
      date: service.date,
      hotelId: service.hotelId
    };

    const result = applyPickupCalc({
      direction: "departure",
      booking_service_kind: "transfer_airport_hotel",
      time: service.time, // orario volo di partenza, MAI reinterpretato: input al motore, non l'output
      billing_party_name: booking.agencyName,
      vessel: service.vessel,
      hotel_zone: hotel?.zone ?? null,
      hotel_name: hotel?.name ?? service.hotelNameRaw,
      context
    });

    const warnings = result.pickup_alert ? [...service.warnings, result.pickup_alert] : service.warnings;

    return {
      ...service,
      vessel: result.vessel ?? service.vessel,
      pickupHotel: result.pickup_hotel ?? null,
      barcaCompagnia: result.barca_compagnia ?? null,
      orarioBarca: result.orario_barca ?? null,
      portoBruno: result.porto_bruno ?? null,
      pickupAlert: result.pickup_alert ?? null,
      warnings
    };
  });
}

async function findExistingAgencyBooking(admin: SupabaseClient, tenantId: string, sourceBookingKey: string) {
  const { data } = await admin
    .from("agency_bookings")
    .select("id, source_payload")
    .eq("tenant_id", tenantId)
    .eq("source", SOURCE)
    .eq("source_booking_key", sourceBookingKey)
    .maybeSingle();
  return data as { id: string; source_payload: unknown } | null;
}

function bookingSourcePayload(booking: MtsGlobeBookingDraft) {
  return {
    voucher_no: booking.voucherNo,
    customer_name: booking.customerName,
    legs: booking.legs.map((leg) => ({
      row_index: leg.rowIndex,
      leg_type: leg.legType,
      date: leg.date,
      flight_code: leg.flightCode,
      // Orario volo grezzo, conservato come dato di prenotazione per audit —
      // MAI usato direttamente come orario operativo del service per le
      // partenze (vedi applyDepartureOperationalTiming). Per l'arrivo invece
      // e' gia' l'orario operativo (stessa convenzione di agency-pdf-import.ts).
      dep_time_raw: leg.depTime,
      arr_time_raw: leg.arrTime,
      hotel_name_raw: leg.hotelNameRaw,
      hotel_from_raw: leg.hotelFromRaw,
      hotel_to_raw: leg.hotelToRaw,
      pax: leg.pax
    }))
  };
}

/**
 * Costruisce la preview: parsing + hotel matching + dedup, senza scrivere
 * nulla. Ogni booking riceve uno stato READY/WARNING/ERROR/DUPLICATE/UPDATE.
 * `hotelCorrections` (opzionale) applica scelte hotel manuali dell'operatore
 * fatte in un giro di preview precedente, prima di ricalcolare gli stati.
 */
export async function buildMtsGlobePreview(
  admin: SupabaseClient,
  tenantId: string,
  rawRows: Array<Record<string, unknown>>,
  hotelCorrections: MtsGlobeHotelCorrections = {},
  timeCorrections: MtsGlobeTimeCorrections = {}
): Promise<MtsGlobePreviewResult> {
  const parsed = parseMtsGlobeRows(rawRows);
  const hotels = await loadHotelCatalog(admin, tenantId);
  const operationalContext = await loadOperationalContext(admin);

  const bookings: MtsGlobePreviewBooking[] = [];
  for (const booking of parsed.bookings) {
    const reasons: string[] = [];
    if (booking.duplicateLegsSkipped > 0) {
      reasons.push(`${booking.duplicateLegsSkipped} riga/e duplicata/e ignorata/e nello stesso voucher.`);
    }

    const resolvedHotels = booking.legs.flatMap((leg) => resolveLegHotels(leg, hotels, hotelCorrections));
    // Hotel non risolto ("indispensabile"): mai auto-associato a bassa
    // confidenza (resolveLegHotels usa solo match >=70 o correzione esplicita
    // dell'operatore) — se manca, blocca il confirm (vedi sotto). Distinto
    // dagli alert di orario operativo (timingWarnings), che non bloccano.
    const hotelUnresolved = resolvedHotels.some((r) => !r.hotelId || r.matchConfidence === "unmatched");

    const generatedServicesBeforeTiming = generateSunSeaServices(booking, resolvedHotels);
    const generatedServicesWithNames = resolveHotelNames(generatedServicesBeforeTiming, hotels);
    const generatedServicesWithIntermedioTime = applyIntermedioTimeCorrections(generatedServicesWithNames, booking.voucherNo, timeCorrections);
    const generatedServices = applyDepartureOperationalTiming(generatedServicesWithIntermedioTime, booking, hotels, operationalContext);

    // Orario Intermedio non risolto ("indispensabile", stessa filosofia
    // dell'hotel): il file reale non porta mai un orario per queste righe —
    // mai inventato (vedi hotelChangeTimeMissing in sunsea-service-generator.ts).
    // Blocca il confirm finche' l'operatore non lo inserisce (timeCorrections).
    const timeUnresolved = generatedServices.some((service) => service.bookingServiceKind === "transfer_hotel_hotel" && !service.time);

    const hotelWarnings = generatedServices.flatMap((service) => service.warnings.filter((w) => w.startsWith("Hotel ")));
    const timeWarnings = generatedServices.flatMap((service) => service.warnings.filter((w) => w === "Orario transfer Intermedio mancante."));
    const timingWarnings = generatedServices.flatMap((service) => (service.pickupAlert ? [service.pickupAlert] : []));
    reasons.push(...hotelWarnings, ...timeWarnings, ...timingWarnings);

    // Hotel su zona/citta' non coperta dalla logica pickup Ischia (es.
    // Napoli): nessun pickup/nave/porto inventato, dato indispensabile per
    // una partenza mancante — stessa filosofia bloccante di hotel/orario.
    const continenteUnresolved = generatedServices.some((service) => service.pickupAlert === CONTINENTE_NOT_COVERED_WARNING);

    // Trasparenza non bloccante: agenzia senza logica nave verificata nel
    // codice ITS (vedi isKnownAgency) — nessun secondo default inventato qui,
    // solo il segnale che il calcolo sotto usa la policy conservativa gia'
    // esistente per le agenzie non mappate (stessa per tutti i canali ITS).
    if (!isKnownAgency(booking.agencyName) && generatedServices.some((s) => s.bookingServiceKind === "transfer_airport_hotel" && s.direction === "departure")) {
      reasons.push(
        `Agenzia "${booking.agencyName}" non mappata a una logica nave verificata: pickup/nave/porto calcolati con la policy di default (stessa usata per agenzie non riconosciute) — verificare se serve una regola dedicata.`
      );
    }

    const existing = await findExistingAgencyBooking(admin, tenantId, booking.sourceBookingKey);
    let status: AgencyBookingRowStatus;
    if (existing) {
      // Confronto ordine-indipendente: Postgres JSONB non preserva l'ordine
      // di inserimento delle chiavi (verificato live — un source_payload
      // riletto dal DB ha un ordine chiavi diverso da quello appena calcolato
      // in JS anche a parita' di contenuto), quindi un semplice
      // JSON.stringify() a confronto rileva "update" anche quando i dati sono
      // identici. stableStringify normalizza l'ordine prima del confronto.
      const previousPayload = stableStringify(existing.source_payload ?? {});
      const currentPayload = stableStringify(bookingSourcePayload(booking));
      status = previousPayload === currentPayload ? "duplicate" : "update";
      if (status === "update") reasons.push("Pratica già importata in precedenza con dati diversi.");
      else reasons.push("Pratica già importata: nessuna modifica rilevata.");
    } else if (hotelUnresolved || timeUnresolved || continenteUnresolved) {
      // Dato indispensabile non risolto (hotel, orario Intermedio, o
      // transfer verso zona/citta' non coperta dalla logica pickup Ischia):
      // WARNING in preview, ma NON confermabile finche' l'operatore non
      // risolve manualmente — vedi confirmMtsGlobeImport.
      status = "warning";
    } else {
      status = "ready";
    }

    bookings.push({
      voucherNo: booking.voucherNo,
      sourceBookingKey: booking.sourceBookingKey,
      customerName: booking.customerName,
      date: booking.legs[0]?.date ?? "",
      pax: booking.pax,
      hotelNameRaw: booking.hotelNameRaw,
      serviceScope: booking.serviceScope,
      status,
      reasons,
      generatedServices,
      existingAgencyBookingId: existing?.id ?? null
    });
  }

  const summary = {
    totalRows: parsed.totalRows,
    bookingCount: bookings.length,
    serviceCount: bookings.reduce((sum, b) => sum + b.generatedServices.length, 0),
    readyCount: bookings.filter((b) => b.status === "ready").length,
    warningCount: bookings.filter((b) => b.status === "warning").length,
    errorCount: parsed.errors.length,
    duplicateCount: bookings.filter((b) => b.status === "duplicate").length,
    updateCount: bookings.filter((b) => b.status === "update").length
  };

  return { bookings, rowErrors: parsed.errors, summary };
}

export type ConfirmMtsGlobeImportResult = {
  importedBookingCount: number;
  importedServiceCount: number;
  skippedDuplicateCount: number;
  failedBookings: Array<{ voucherNo: string; message: string }>;
};

/**
 * Crea in modo atomico (per booking) agency_bookings + services SOLO per le
 * righe di preview con stato READY. DUPLICATE/UPDATE/ERROR/WARNING vengono
 * tutte saltate senza scrivere nulla: un booking con hotel indispensabile
 * non risolto resta WARNING e non e' mai confermabile finche' l'operatore
 * non passa la correzione hotel (hotelCorrections) che lo fa diventare READY.
 * Nessuna sovrascrittura silenziosa per UPDATE/DUPLICATE/ERROR.
 */
export async function confirmMtsGlobeImport(
  admin: SupabaseClient,
  tenantId: string,
  userId: string | null,
  rawRows: Array<Record<string, unknown>>,
  sourceImportId: string | null,
  hotelCorrections: MtsGlobeHotelCorrections = {},
  timeCorrections: MtsGlobeTimeCorrections = {}
): Promise<ConfirmMtsGlobeImportResult> {
  const preview = await buildMtsGlobePreview(admin, tenantId, rawRows, hotelCorrections, timeCorrections);
  const parsed = parseMtsGlobeRows(rawRows);
  const bookingByVoucher = new Map(parsed.bookings.map((b) => [b.voucherNo, b]));

  let importedBookingCount = 0;
  let importedServiceCount = 0;
  let skippedDuplicateCount = 0;
  const failedBookings: Array<{ voucherNo: string; message: string }> = [];

  for (const previewBooking of preview.bookings) {
    if (previewBooking.status === "duplicate") {
      skippedDuplicateCount += 1;
      continue;
    }
    // Blocca tutto cio' che non e' READY: WARNING (hotel non risolto o altro
    // dato indispensabile mancante), UPDATE (dati diversi da pratica gia'
    // importata, mai sovrascritta automaticamente), ERROR (riga non valida).
    if (previewBooking.status !== "ready") {
      continue;
    }

    const booking = bookingByVoucher.get(previewBooking.voucherNo);
    if (!booking) continue;

    const bookingInsert = await admin
      .from("agency_bookings")
      .insert({
        tenant_id: tenantId,
        source: SOURCE,
        source_import_id: sourceImportId,
        source_booking_key: booking.sourceBookingKey,
        source_payload: bookingSourcePayload(booking),
        agency_name: booking.agencyName,
        booking_kind: "transfer",
        service_scope: booking.serviceScope,
        customer_name: booking.customerName,
        pax: booking.pax,
        // Hotel risolto del primo leg (stesso hotel a cui si riferisce
        // hotel_name_raw sopra — "from" per Intermedio). Prima di questo fix
        // restava sempre null: mai scritto nell'insert nonostante la colonna
        // esista (migration 0266) e il match fosse gia' disponibile.
        hotel_id: previewBooking.generatedServices[0]?.hotelId ?? null,
        hotel_name_raw: booking.hotelNameRaw,
        status: previewBooking.status,
        status_reasons: previewBooking.reasons,
        created_by_user_id: userId
      })
      .select("id")
      .single();

    if (bookingInsert.error || !bookingInsert.data?.id) {
      failedBookings.push({ voucherNo: booking.voucherNo, message: bookingInsert.error?.message ?? "Booking non creato." });
      continue;
    }

    const agencyBookingId = bookingInsert.data.id;
    const servicePayloads = previewBooking.generatedServices.map((service) => ({
      tenant_id: tenantId,
      created_by_user_id: userId,
      is_draft: false,
      agency_booking_id: agencyBookingId,
      date: service.date,
      time: service.time,
      service_type: "transfer" as const,
      direction: service.direction,
      vessel: service.vessel,
      pax: service.pax,
      hotel_id: service.hotelId,
      customer_name: service.customerName,
      phone: "000000",
      notes: [service.notes, service.warnings.length > 0 ? `[needs_review] ${service.warnings.join(" ")}` : null]
        .filter(Boolean)
        .join(" | "),
      meeting_point: service.meetingPoint,
      booking_service_kind: service.bookingServiceKind,
      service_type_code: service.serviceTypeCode,
      transport_code: service.transportCode,
      arrival_date: service.direction === "arrival" ? service.date : null,
      arrival_time: service.direction === "arrival" ? service.time : null,
      departure_date: service.direction === "departure" ? service.date : null,
      departure_time: service.direction === "departure" ? service.time : null,
      // Orario operativo di pickup/nave/porto per le partenze, dal motore
      // canonico applyPickupCalc (vedi applyDepartureOperationalTiming) — mai
      // dal semplice orario volo. Sempre null per arrivo/hotel_change.
      pickup_hotel: service.pickupHotel,
      barca_compagnia: service.barcaCompagnia,
      orario_barca: service.orarioBarca,
      porto_bruno: service.portoBruno,
      pickup_alert: service.pickupAlert,
      status: service.warnings.length > 0 ? ("needs_review" as const) : ("new" as const)
    }));

    const servicesInsert = await admin.from("services").insert(servicePayloads).select("id");
    if (servicesInsert.error) {
      // Atomicita' per booking: se i servizi falliscono, rimuove il booking
      // appena creato per non lasciare pratiche vuote.
      await admin.from("agency_bookings").delete().eq("tenant_id", tenantId).eq("id", agencyBookingId);
      failedBookings.push({ voucherNo: booking.voucherNo, message: `Servizi non creati: ${servicesInsert.error.message}` });
      continue;
    }

    importedBookingCount += 1;
    importedServiceCount += servicesInsert.data?.length ?? 0;
  }

  return { importedBookingCount, importedServiceCount, skippedDuplicateCount, failedBookings };
}
