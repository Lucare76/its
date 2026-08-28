import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest, type PricingAuthContext } from "@/lib/server/pricing-auth";
import {
  appendSplitImportNote,
  formatImportValidationMessage,
  isPlaceholderHotelValue,
  sanitizeImportCustomerName,
  sanitizeImportPhone,
  splitPassengerChunks
} from "@/lib/server/bus-excel-import";
import { resolveHotelMatch } from "@/lib/server/hotel-matching";
import { serviceCreateSchema } from "@/lib/validation";
import { applyPickupCalc } from "@/lib/server/apply-pickup-calc";
import { autoLinkImportedServices } from "@/lib/server/transfer-ischia-blocks";
import {
  loadTenantPlaces,
  parseImportPlaceType,
  resolvePlaceMatch,
  type ImportPlaceType
} from "@/lib/server/place-matching";
import {
  loadBusResolverContext,
  registerBusResolverAllocation,
  resolveBusImportRow,
  type BusAllocationPlan,
  type BusResolverContext
} from "@/lib/server/bus-service-resolver";
import { ensureWhatsAppContact } from "@/lib/server/whatsapp/contacts";

export const runtime = "nodejs";

const presetSchema = z.enum(["generic_transfer", "formula_snav", "formula_medmar_napoli", "formula_medmar_pozzuoli", "transfer_airport", "transfer_station", "linea_bus"]);

const rowSchema = z.object({
  row_index: z.number().int().min(1),
  customer_name: z.string().trim().optional().default(""),
  date: z.string().trim().optional().default(""),
  time: z.string().trim().optional().default(""),
  pickup: z.string().trim().optional().default(""),
  destination: z.string().trim().optional().default(""),
  pax: z.number().int().min(0).optional().default(0),
  transport_code: z.string().trim().optional().default(""),
  phone: z.string().trim().optional().default(""),
  notes: z.string().trim().optional().default(""),
  departure_date: z.string().trim().optional().default(""),
  departure_time: z.string().trim().optional().default(""),
  direction: z.enum(["arrival", "departure"]).nullable().optional(),
  billing_party_name: z.string().trim().optional().default(""),
  bus_city_origin: z.string().trim().optional().default(""),
  service_category: z.enum(["arrival", "departure", "transfer", "excursion", "territorial", "round_trip", "bus_line"]).nullable().optional(),
  route_kind: z.enum([
    "porto_hotel",
    "hotel_porto",
    "aeroporto_hotel",
    "hotel_aeroporto",
    "stazione_hotel",
    "hotel_stazione",
    "hotel_luogo",
    "luogo_hotel",
    "luogo_luogo",
    "hotel_attrazione",
    "attrazione_hotel",
    "escursione",
    "territoriale",
    "linea_bus_arrivo_ritorno",
    "linea_bus_solo_arrivo",
    "linea_bus_solo_ritorno"
  ]).nullable().optional(),
  origin_place_type: z.string().trim().optional().default(""),
  destination_place_type: z.string().trim().optional().default(""),
  company_name: z.string().trim().optional().default(""),
  pickup_time: z.string().trim().optional().default(""),
  practice_reference: z.string().trim().optional().default(""),
  service_name: z.string().trim().optional().default(""),
  hotel_name: z.string().trim().optional().default(""),
  external_destination: z.string().trim().optional().default(""),
  embark_time: z.string().trim().optional().default(""),
  driver_time: z.string().trim().optional().default("")
});

const payloadSchema = z.object({
  dry_run: z.boolean().default(true),
  preset_key: presetSchema,
  default_direction: z.enum(["arrival", "departure"]).default("arrival"),
  default_billing_party_name: z.string().trim().max(160).optional().default(""),
  default_hotel_id: z.string().uuid().optional().nullable(),
  rows: z.array(rowSchema).min(1).max(1000)
});

type HotelRow = {
  id: string;
  name: string;
  normalized_name?: string | null;
  aliases?: string[];
  zone?: string | null;
};

const presetConfig = {
  generic_transfer: {
    vessel: "Transfer Ischia",
    meetingPoint: "",
    bookingKind: null,
    serviceTypeCode: null
  },
  formula_snav: {
    vessel: "SNAV",
    meetingPoint: "Porto Napoli",
    bookingKind: "transfer_port_hotel",
    serviceTypeCode: "transfer_port_hotel"
  },
  formula_medmar_napoli: {
    vessel: "MEDMAR Napoli",
    meetingPoint: "Porto Napoli",
    bookingKind: "formula_medmar_napoli",
    serviceTypeCode: "transfer_port_hotel"
  },
  formula_medmar_pozzuoli: {
    vessel: "MEDMAR Pozzuoli",
    meetingPoint: "Porto Pozzuoli",
    bookingKind: "formula_medmar_pozzuoli",
    serviceTypeCode: "transfer_port_hotel"
  },
  transfer_airport: {
    vessel: "Aeroporto Napoli",
    meetingPoint: "Aeroporto",
    bookingKind: "transfer_airport_hotel",
    serviceTypeCode: "transfer_airport_hotel"
  },
  transfer_station: {
    vessel: "Stazione Napoli",
    meetingPoint: "Stazione",
    bookingKind: "transfer_train_hotel",
    serviceTypeCode: "transfer_station_hotel"
  },
  linea_bus: {
    vessel: "Linea bus",
    meetingPoint: "Meeting point linea bus",
    bookingKind: "bus_city_hotel",
    serviceTypeCode: "bus_line"
  }
} as const;

type PreparedLegacyRow = {
  mode: "legacy";
  rowIndex: number;
  payload: z.infer<typeof serviceCreateSchema>;
  busAllocation?: BusAllocationPlan | null;
};
type PreparedDirectRow = {
  mode: "direct";
  rowIndex: number;
  payload: Record<string, unknown>;
  linkedReturnPayload?: Record<string, unknown> | null;
  status: "new" | "needs_review" | "cancelled";
  busAllocation?: BusAllocationPlan | null;
};
type PreparedBusPendingRow = {
  mode: "bus_pending";
  rowIndex: number;
  pendingPayload: Record<string, unknown>;
};

type ImportCategory = "arrival" | "departure" | "transfer" | "excursion" | "territorial";
type BusRouteKind = "linea_bus_arrivo_ritorno" | "linea_bus_solo_arrivo" | "linea_bus_solo_ritorno";

function normalizeLooseText(value: string | null | undefined) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function mapImportedStatus(notes: string) {
  const normalized = normalizeLooseText(notes);
  if (normalized.includes("annullato")) return "cancelled" as const;
  if (normalized.includes("verificare")) return "needs_review" as const;
  return "new" as const;
}

function inferTransferMeta(reference: string, pickup: string, externalDestination: string, category: ImportCategory) {
  if (category === "excursion") {
    return {
      service_type: "bus_tour" as const,
      vessel: "Escursione",
      booking_service_kind: "excursion",
      service_type_code: "excursion"
    };
  }

  const source = normalizeLooseText([reference, pickup, externalDestination].filter(Boolean).join(" "));
  if (/\bvolo\b|\bapt\b|\baeroporto\b|\bairport\b|\bfr\b|\blx\b|\baz\b|\bsn\b/.test(source)) {
    return {
      service_type: "transfer" as const,
      vessel: reference ? `Volo ${reference.trim()}` : "Aeroporto Napoli",
      booking_service_kind: "transfer_airport_hotel",
      service_type_code: "transfer_airport_hotel"
    };
  }
  if (/\bstz\b|\bstazione\b|\btreno\b|\bfs\b|\bitalo\b|\bfrecc/i.test(source)) {
    return {
      service_type: "transfer" as const,
      vessel: reference.trim() || "Stazione Napoli",
      booking_service_kind: "transfer_train_hotel",
      service_type_code: "transfer_station_hotel"
    };
  }
  if (/\bmedmar\b|\bsnav\b|\bcaremar\b|\balilauro\b|\btraghetto\b|\bporto\b|\bbeverello\b|\bpozzuoli\b|\bmetropark\b|\bflixbus\b/.test(source)) {
    return {
      service_type: "transfer" as const,
      vessel: reference.trim() || "Transfer porto",
      booking_service_kind: "transfer_port_hotel",
      service_type_code: "transfer_port_hotel"
    };
  }

  return {
    service_type: "transfer" as const,
    vessel: "Transfer Ischia",
    booking_service_kind: null,
    service_type_code: null
  };
}

function isBusImportCandidate(row: z.infer<typeof rowSchema>, presetKey: z.infer<typeof presetSchema>) {
  if (presetKey === "linea_bus") return true;
  if (row.service_category === "bus_line") return true;
  if (row.route_kind?.startsWith("linea_bus_")) return true;
  const source = normalizeLooseText([
    row.service_category,
    row.route_kind,
    row.transport_code,
    row.service_name,
    row.notes
  ].filter(Boolean).join(" "));
  return /\b(bus|linea bus|lineabus|transfer bus)\b/.test(source);
}

function isTemplateBusRow(row: z.infer<typeof rowSchema>) {
  return row.service_category === "bus_line" || Boolean(row.route_kind?.startsWith("linea_bus_"));
}

function busTemplateDirection(routeKind: string | null | undefined, fallback: "arrival" | "departure" | null | undefined) {
  if (routeKind === "linea_bus_solo_ritorno") return "departure" as const;
  return fallback ?? "arrival" as const;
}

function makeBusLegacyPayload(
  row: z.infer<typeof rowSchema>,
  rowDate: string,
  rowTime: string,
  direction: "arrival" | "departure",
  hotelId: string,
  pax: number,
  customerName: string,
  phone: string,
  billingPartyName: string,
  busCityOrigin: string,
  transportCode: string,
  notes: string
) {
  return {
    date: rowDate,
    time: rowTime,
    service_type: "transfer" as const,
    direction,
    vessel: "Linea bus",
    pax,
    hotel_id: hotelId,
    customer_name: customerName,
    phone,
    notes,
    meeting_point: busCityOrigin,
    stops: [],
    bus_plate: "",
    billing_party_name: billingPartyName,
    customer_email: "",
    booking_service_kind: "bus_city_hotel" as const,
    service_type_code: "bus_line" as const,
    arrival_date: direction === "arrival" ? rowDate : "",
    arrival_time: direction === "arrival" ? rowTime : "",
    departure_date: direction === "departure" ? rowDate : "",
    departure_time: direction === "departure" ? rowTime : "",
    transport_code: transportCode,
    bus_city_origin: busCityOrigin,
    tour_name: transportCode || busCityOrigin || "Linea bus",
    capacity: 54,
    low_seat_threshold: 5,
    minimum_passengers: null,
    waitlist_enabled: false,
    waitlist_count: 0,
    status: "new" as const
  };
}

async function insertServiceWithSchemaFallback(
  admin: PricingAuthContext["admin"],
  payload: Record<string, unknown>
) {
  let insertPayload = { ...payload };
  const droppedColumns: string[] = [];
  let insertResult = await admin.from("services").insert(insertPayload).select("id").single();

  while (insertResult.error) {
    const missingColumnMatch = insertResult.error.message.match(/Could not find the '([^']+)' column/i);
    const missingColumn = missingColumnMatch?.[1] ?? "";
    if (!missingColumn || droppedColumns.includes(missingColumn)) break;
    droppedColumns.push(missingColumn);
    const nextPayload = { ...insertPayload };
    delete nextPayload[missingColumn];
    insertPayload = nextPayload;
    insertResult = await admin.from("services").insert(insertPayload).select("id").single();
  }

  return { ...insertResult, droppedColumns };
}

function makeBusPendingRow(rowIndex: number, pendingPayload: Record<string, unknown>): PreparedBusPendingRow {
  return { mode: "bus_pending", rowIndex, pendingPayload };
}

function addBusPendingOrError(
  validRows: Array<PreparedLegacyRow | PreparedDirectRow | PreparedBusPendingRow>,
  errors: Array<{ row_index: number; message: string }>,
  rowIndex: number,
  pendingPayload: Record<string, unknown> | undefined,
  reasons: string[]
) {
  if (pendingPayload?.bus_line_id) {
    validRows.push(makeBusPendingRow(rowIndex, pendingPayload));
    return;
  }
  errors.push({
    row_index: rowIndex,
    message: reasons.join(" ") || "Riga bus non importabile: dati insufficienti."
  });
}

function formatImportStorageError(rowIndex: number, action: string, message: string) {
  return {
    row_index: rowIndex,
    message: `${action}: ${message}`
  };
}

function resolveFirstHotelMatch(hotels: HotelRow[], candidates: Array<string | null | undefined>, defaultHotelId?: string | null) {
  for (const candidate of candidates) {
    const match = resolveHotelMatch(hotels, String(candidate ?? ""), undefined);
    if (match) return match;
  }
  return defaultHotelId ?? null;
}

const OPERATIONAL_LOCALITIES = new Set([
  "aeroporto",
  "aeroporto di napoli",
  "mortella",
  "porto casamicciola",
  "porto di casamicciola",
  "sant angelo",
  "citara",
  "procida",
  "napoli",
  "positano",
  "amalfi"
]);

function isOperationalLocality(value: string | null | undefined) {
  return OPERATIONAL_LOCALITIES.has(normalizeLooseText(value));
}

function isPlaceBasedRow(row: z.infer<typeof rowSchema>) {
  return Boolean(row.route_kind || row.origin_place_type || row.destination_place_type);
}

function directionForTemplateRow(
  category: ImportCategory,
  routeKind: string | null | undefined,
  originPlaceType?: string | null,
  destinationPlaceType?: string | null
) {
  if (category === "arrival") return "arrival" as const;
  if (category === "departure") return "departure" as const;
  if (routeKind?.startsWith("hotel_")) return "departure" as const;
  if (routeKind?.endsWith("_hotel")) return "arrival" as const;
  if (originPlaceType === "hotel" && destinationPlaceType !== "hotel") return "departure" as const;
  if (destinationPlaceType === "hotel" && originPlaceType !== "hotel") return "arrival" as const;
  return "departure" as const;
}

function templatePassengerChunks(pax: number) {
  if (!Number.isFinite(pax) || pax <= 0) return [];
  return [Math.floor(pax)];
}

function placeErrorLabel(kind: "origine" | "destinazione", status: string, raw: string) {
  if (status === "ambiguous") return `${kind} ambigua: ${raw}`;
  return `${kind} non trovata: ${raw || "vuota"}`;
}

function normalizeExpectedPlaceType(rawType: string, label: string): ImportPlaceType | null {
  const parsed = parseImportPlaceType(rawType);
  if (parsed) return parsed;
  if (isOperationalLocality(label)) return "locality";
  return null;
}

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator"]);
  if (auth instanceof NextResponse) return auth;

  const parsed = payloadSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Payload non valido." }, { status: 400 });
  }

  const { data: hotels, error: hotelsError } = await auth.admin
    .from("hotels")
    .select("id, name, normalized_name, zone")
    .eq("tenant_id", auth.membership.tenant_id)
    .order("name", { ascending: true });

  if (hotelsError) {
    return NextResponse.json({ error: "Errore caricamento hotel per import Excel." }, { status: 500 });
  }

  const { data: aliasRows } = await auth.admin
    .from("hotel_aliases")
    .select("hotel_id, alias")
    .eq("tenant_id", auth.membership.tenant_id)
    .limit(5000);

  // Regole canoniche + orari nave per il dominio A (treno/aeroporto) di
  // apply-pickup-calc.ts: caricati UNA volta per l'intero batch, MAI per
  // riga — passati come context a ogni chiamata applyPickupCalc sotto.
  const { data: operationalRulesData } = await auth.admin.from("ferry_pickup_rules").select("*");
  const { data: ferryScheduleData } = await auth.admin
    .from("ferry_schedules")
    .select("company, departure_port, arrival_port, departure_time, arrival_time, direction, days_of_week, valid_from, valid_to");
  const operationalRulesRows = operationalRulesData ?? [];
  const scheduleRows = ferryScheduleData ?? [];

  const aliasesByHotel = new Map<string, string[]>();
  for (const row of (aliasRows ?? []) as Array<{ hotel_id: string; alias: string }>) {
    const bucket = aliasesByHotel.get(row.hotel_id) ?? [];
    bucket.push(row.alias);
    aliasesByHotel.set(row.hotel_id, bucket);
  }

  const hotelRows = ((hotels ?? []) as HotelRow[]).map((hotel) => ({
    ...hotel,
    aliases: aliasesByHotel.get(hotel.id) ?? []
  }));
  // Zona hotel per il calcolo pickup (dominio B, Formula/porto-porto in
  // apply-pickup-calc.ts) — mappa costruita UNA volta dal batch gia' caricato
  // sopra, nessuna query aggiuntiva per riga.
  const hotelZoneById = new Map(hotelRows.map((hotel) => [hotel.id, hotel.zone ?? null]));
  const hotelNameById = new Map(hotelRows.map((hotel) => [hotel.id, hotel.name]));
  const places = await loadTenantPlaces(auth.admin, auth.membership.tenant_id);
  const preset = presetConfig[parsed.data.preset_key];
  const needsBusResolver = parsed.data.rows.some((row) => isBusImportCandidate(row, parsed.data.preset_key));
  let busResolverContext: BusResolverContext | null = null;
  if (needsBusResolver) {
    try {
      busResolverContext = await loadBusResolverContext(auth.admin, auth.membership.tenant_id);
    } catch (error) {
      return NextResponse.json({
        error: `Errore caricamento rete bus per import Excel: ${error instanceof Error ? error.message : "errore sconosciuto"}`
      }, { status: 500 });
    }
  }
  const validRows: Array<PreparedLegacyRow | PreparedDirectRow | PreparedBusPendingRow> = [];
  const errors: Array<{ row_index: number; message: string }> = [];
  let skippedRows = 0;

  for (const row of parsed.data.rows) {
    if (row.pax <= 0) {
      skippedRows += 1;
      continue;
    }
    if (parsed.data.preset_key === "linea_bus" && isPlaceholderHotelValue(row.destination)) {
      skippedRows += 1;
      continue;
    }

    if (row.service_category === "round_trip") {
      errors.push({ row_index: row.row_index, message: "Categoria A-R non ancora supportata in import automatico." });
      continue;
    }

    if (isTemplateBusRow(row)) {
      if (!busResolverContext) {
        errors.push({ row_index: row.row_index, message: "Resolver bus non disponibile per riga Linea Bus." });
        continue;
      }

      const routeKind = row.route_kind as BusRouteKind | null | undefined;
      if (!routeKind || !routeKind.startsWith("linea_bus_")) {
        errors.push({ row_index: row.row_index, message: "Tipo tratta Linea Bus non valido: usare linea_bus_solo_arrivo, linea_bus_solo_ritorno o linea_bus_arrivo_ritorno." });
        continue;
      }

      const busDirection = busTemplateDirection(routeKind, row.direction);
      const busCityOrigin = row.bus_city_origin || row.pickup;
      const lineName = row.transport_code;
      const customerName = sanitizeImportCustomerName(row.customer_name, row.row_index);
      const phone = sanitizeImportPhone(row.phone);
      const billingPartyName = row.billing_party_name || parsed.data.default_billing_party_name;

      const missing: string[] = [];
      if (!row.date) missing.push(busDirection === "departure" ? "Data ritorno bus" : "Data arrivo bus");
      if (!lineName) missing.push("Linea bus");
      if (!busCityOrigin) missing.push("Fermata / città partenza");
      if (!row.destination) missing.push("Hotel destinazione bus");
      if (!row.customer_name) missing.push("Nome cliente");
      if (row.pax <= 0) missing.push("Pax");
      if (missing.length > 0) {
        errors.push({ row_index: row.row_index, message: `Linea Bus incompleta: ${missing.join(", ")}.` });
        continue;
      }

      const resolvedHotelId = resolveHotelMatch(hotelRows, row.destination, null);
      const busResolution = resolveBusImportRow(busResolverContext, {
        tenantId: auth.membership.tenant_id,
        date: row.date,
        direction: busDirection,
        bookingServiceKind: "bus_city_hotel",
        serviceTypeCode: "bus_line",
        importCategory: "linea bus",
        busCityOrigin,
        stopName: busCityOrigin,
        transportCode: lineName,
        lineName,
        hotelName: row.destination,
        hotelId: resolvedHotelId,
        pax: row.pax,
        customerName,
        phone,
        agencyName: billingPartyName,
        notes: row.notes,
        time: row.time
      });

      if (busResolution.status === "needs_review") {
        addBusPendingOrError(validRows, errors, row.row_index, busResolution.pendingPayload, busResolution.reasons);
        continue;
      }
      if (busResolution.status !== "ready" || !busResolution.allocationPlan || !resolvedHotelId) {
        errors.push({ row_index: row.row_index, message: busResolution.reasons.join(" ") || "Riga bus bloccata dal resolver." });
        continue;
      }

      registerBusResolverAllocation(busResolverContext, {
        busUnitId: busResolution.allocationPlan.unitId,
        date: row.date,
        direction: busResolution.allocationPlan.direction,
        pax: row.pax
      });

      const payload = makeBusLegacyPayload(
        row,
        row.date,
        row.time || "00:00",
        busDirection,
        resolvedHotelId,
        row.pax,
        customerName,
        phone,
        billingPartyName,
        busCityOrigin,
        lineName,
        row.notes
      );
      const validated = serviceCreateSchema.safeParse(payload);
      if (!validated.success) {
        errors.push({ row_index: row.row_index, message: formatImportValidationMessage(validated.error.issues[0]) });
        continue;
      }

      validRows.push({ mode: "legacy", rowIndex: row.row_index, payload: validated.data, busAllocation: busResolution.allocationPlan });
      continue;
    }

    if (row.service_category && isPlaceBasedRow(row)) {
      const category = row.service_category as ImportCategory;
      const originType = normalizeExpectedPlaceType(row.origin_place_type, row.pickup);
      const destinationType = normalizeExpectedPlaceType(row.destination_place_type, row.destination);
      const originMatch = resolvePlaceMatch(places, row.pickup, originType);
      const destinationMatch = resolvePlaceMatch(places, row.destination, destinationType);

      if (originMatch.status !== "matched") {
        errors.push({ row_index: row.row_index, message: placeErrorLabel("origine", originMatch.status, row.pickup) });
        continue;
      }
      if (destinationMatch.status !== "matched") {
        errors.push({ row_index: row.row_index, message: placeErrorLabel("destinazione", destinationMatch.status, row.destination) });
        continue;
      }

      const hotelCandidate =
        row.hotel_name ||
        (originMatch.place.place_type === "hotel"
          ? row.pickup
          : destinationMatch.place.place_type === "hotel"
            ? row.destination
            : "");
      const resolvedHotelId = hotelCandidate ? resolveHotelMatch(hotelRows, hotelCandidate, null) : null;
      if (hotelCandidate && !resolvedHotelId) {
        errors.push({ row_index: row.row_index, message: `Hotel non collegato al catalogo hotel: ${hotelCandidate}` });
        continue;
      }

      const paxChunks = templatePassengerChunks(row.pax);
      const customerName = sanitizeImportCustomerName(row.customer_name, row.row_index);
      const phone = sanitizeImportPhone(row.phone);
      const importedStatus = mapImportedStatus(row.notes);
      const meta = inferTransferMeta(row.transport_code || row.company_name, row.pickup, row.destination, category);
      const confidence = Math.min(originMatch.confidence, destinationMatch.confidence);
      const rowDirection = directionForTemplateRow(category, row.route_kind, originType, destinationType);

      for (const [chunkIndex, paxChunk] of paxChunks.entries()) {
        const baseNotes = appendSplitImportNote(row.notes, row.pax, chunkIndex + 1, paxChunks.length);
        const placeNote = `Origine: ${originMatch.place.name} | Destinazione: ${destinationMatch.place.name}`;
        const insertPayload = {
          tenant_id: auth.membership.tenant_id,
          created_by_user_id: auth.user.id,
          is_draft: false,
          date: row.date,
          time: row.time,
          service_type: meta.service_type,
          direction: rowDirection,
          vessel: row.company_name || meta.vessel,
          pax: paxChunk,
          hotel_id: resolvedHotelId,
          customer_name: customerName,
          phone,
          notes: [baseNotes, row.practice_reference ? `Pratica: ${row.practice_reference}` : "", placeNote].filter(Boolean).join(" | "),
          meeting_point: row.pickup || null,
          billing_party_name: row.billing_party_name || parsed.data.default_billing_party_name || null,
          customer_email: null,
          booking_service_kind: row.route_kind === "escursione" ? "excursion" : meta.booking_service_kind,
          service_type_code: row.route_kind === "escursione" ? "excursion" : meta.service_type_code,
          service_category: category,
          route_kind: row.route_kind ?? null,
          origin_place_id: originMatch.place.id,
          destination_place_id: destinationMatch.place.id,
          origin_label_raw: row.pickup,
          destination_label_raw: row.destination,
          origin_place_type: originType,
          destination_place_type: destinationType,
          geo_status: "matched",
          geo_confidence: confidence,
          arrival_date: rowDirection === "arrival" ? row.date : null,
          arrival_time: rowDirection === "arrival" ? row.time : null,
          departure_date: rowDirection === "departure" ? row.date : row.departure_date || null,
          departure_time: rowDirection === "departure" ? row.departure_time || row.time : row.departure_time || null,
          pickup_time: row.pickup_time || null,
          transport_code: row.transport_code || null,
          bus_city_origin: null,
          status: importedStatus,
          tour_name: category === "excursion" ? row.service_name || row.destination || "Escursione" : null,
          excursion_details: category === "excursion"
            ? {
                title: row.service_name || row.destination || "Escursione",
                origin_place_id: originMatch.place.id,
                destination_place_id: destinationMatch.place.id,
                embark_time: row.embark_time || null,
                driver_time: row.driver_time || null,
                import_source: "excel_place_template"
              }
            : {}
        } satisfies Record<string, unknown>;

        const pickupFields = meta.service_type === "transfer"
          ? applyPickupCalc({
              direction: String(insertPayload.direction),
              booking_service_kind: typeof insertPayload.booking_service_kind === "string" ? insertPayload.booking_service_kind : null,
              time: String(insertPayload.time),
              billing_party_name: typeof insertPayload.billing_party_name === "string" ? insertPayload.billing_party_name : null,
              vessel: typeof insertPayload.vessel === "string" ? insertPayload.vessel : null,
              hotel_zone: resolvedHotelId ? hotelZoneById.get(resolvedHotelId) ?? null : null,
              hotel_name: resolvedHotelId ? hotelNameById.get(resolvedHotelId) ?? null : null,
              context: {
                operationalRules: operationalRulesRows as never,
                ferrySchedules: scheduleRows as never,
                date: String(insertPayload.date),
                hotelId: resolvedHotelId,
              },
            })
          : {};

        validRows.push({
          mode: "direct",
          rowIndex: row.row_index,
          payload: { ...insertPayload, ...pickupFields },
          status: importedStatus
        });
      }
      continue;
    }

    if (row.service_category) {
      const category = row.service_category as ImportCategory;
      const hotelLabel = row.hotel_name || row.destination;
      let resolvedHotelId = resolveFirstHotelMatch(
        hotelRows,
        category === "excursion"
          ? [row.hotel_name, row.destination, row.external_destination, row.pickup]
          : [hotelLabel, row.destination, row.pickup],
        parsed.data.default_hotel_id
      );
      if (!resolvedHotelId) {
        errors.push({ row_index: row.row_index, message: `Hotel non riconosciuto: ${hotelLabel || "vuoto"}. Import bloccato: non creo hotel automatici da Excel.` });
        continue;
      }

      const paxChunks = templatePassengerChunks(row.pax);
      const customerName = sanitizeImportCustomerName(row.customer_name, row.row_index);
      const phone = sanitizeImportPhone(row.phone);
      const importedStatus = mapImportedStatus(row.notes);
      const directDirection = directionForTemplateRow(category, row.route_kind, row.origin_place_type, row.destination_place_type);
      const externalDestination = row.external_destination || row.pickup || row.destination;
      const meta = inferTransferMeta(row.transport_code, row.pickup, externalDestination, category);

      for (const [chunkIndex, paxChunk] of paxChunks.entries()) {
        const baseNotes = appendSplitImportNote(row.notes, row.pax, chunkIndex + 1, paxChunks.length);
        const insertPayload = {
          tenant_id: auth.membership.tenant_id,
          created_by_user_id: auth.user.id,
          is_draft: false,
          date: row.date,
          time: row.time,
          service_type: meta.service_type,
          direction: directDirection,
          vessel: meta.vessel,
          pax: paxChunk,
          hotel_id: resolvedHotelId,
          customer_name: customerName,
          phone,
          notes: baseNotes || "",
          meeting_point: row.pickup || null,
          billing_party_name: row.billing_party_name || parsed.data.default_billing_party_name || null,
          customer_email: null,
          booking_service_kind: meta.booking_service_kind,
          service_type_code: meta.service_type_code,
          arrival_date: directDirection === "arrival" ? row.date : null,
          arrival_time: directDirection === "arrival" ? row.time : null,
          departure_date: directDirection === "departure" ? row.date : row.departure_date || null,
          departure_time: directDirection === "departure" ? row.departure_time || row.time : row.departure_time || null,
          transport_code: row.transport_code || null,
          bus_city_origin: null,
          status: importedStatus,
          tour_name: category === "excursion" ? row.service_name || row.transport_code || "Escursione" : null,
          excursion_details: category === "excursion"
            ? {
                title: row.service_name || row.transport_code || "Escursione",
                external_destination: row.external_destination || null,
                embark_time: row.embark_time || null,
                driver_time: row.driver_time || null,
                import_source: "excel_template"
              }
            : {}
        } satisfies Record<string, unknown>;

        const payloadAny = insertPayload as Record<string, unknown>;
        const pickupFields = meta.service_type === "transfer"
          ? applyPickupCalc({
              direction: String(payloadAny.direction ?? ""),
              booking_service_kind: typeof payloadAny.booking_service_kind === "string" ? payloadAny.booking_service_kind : null,
              time: String(payloadAny.time ?? ""),
              billing_party_name: typeof insertPayload.billing_party_name === "string" ? insertPayload.billing_party_name : null,
              vessel: typeof payloadAny.vessel === "string" ? payloadAny.vessel : null,
              hotel_zone: resolvedHotelId ? hotelZoneById.get(resolvedHotelId) ?? null : null,
              hotel_name: resolvedHotelId ? hotelNameById.get(resolvedHotelId) ?? null : null,
              context: {
                operationalRules: operationalRulesRows as never,
                ferrySchedules: scheduleRows as never,
                date: String(payloadAny.date ?? ""),
                hotelId: resolvedHotelId,
              },
            })
          : {};

        validRows.push({
          mode: "direct",
          rowIndex: row.row_index,
          payload: { ...insertPayload, ...pickupFields },
          status: importedStatus
        });
      }
      continue;
    }

    const resolvedHotelId = resolveHotelMatch(hotelRows, row.destination, parsed.data.default_hotel_id);
    if (!resolvedHotelId) {
      if (parsed.data.preset_key === "linea_bus" && busResolverContext) {
        const busResolution = resolveBusImportRow(busResolverContext, {
          tenantId: auth.membership.tenant_id,
          date: row.date,
          direction: row.direction ?? parsed.data.default_direction,
          bookingServiceKind: preset.bookingKind,
          serviceTypeCode: preset.serviceTypeCode,
          importCategory: "linea bus",
          busCityOrigin: row.bus_city_origin || row.pickup,
          stopName: row.bus_city_origin || row.pickup,
          transportCode: row.transport_code,
          lineName: row.transport_code,
          hotelName: row.destination,
          hotelId: null,
          pax: row.pax,
          customerName: sanitizeImportCustomerName(row.customer_name, row.row_index),
          phone: sanitizeImportPhone(row.phone),
          agencyName: row.billing_party_name || parsed.data.default_billing_party_name,
          notes: row.notes,
          time: row.time
        });
        addBusPendingOrError(validRows, errors, row.row_index, busResolution.pendingPayload, busResolution.reasons);
        continue;
      }
      errors.push({ row_index: row.row_index, message: `Hotel non riconosciuto: ${row.destination || "vuoto"}` });
      continue;
    }

    const paxChunks = splitPassengerChunks(row.pax);
    const customerName = sanitizeImportCustomerName(row.customer_name, row.row_index);
    const phone = sanitizeImportPhone(row.phone);

    for (const [chunkIndex, paxChunk] of paxChunks.entries()) {
      const payload = {
        date: row.date,
        time: row.time,
        service_type: "transfer" as const,
        direction: row.direction ?? parsed.data.default_direction,
        vessel: preset.vessel,
        pax: paxChunk,
        hotel_id: resolvedHotelId,
        customer_name: customerName,
        phone,
        notes: appendSplitImportNote(row.notes, row.pax, chunkIndex + 1, paxChunks.length),
        meeting_point: row.pickup || preset.meetingPoint,
        stops: [],
        bus_plate: "",
        billing_party_name: row.billing_party_name || parsed.data.default_billing_party_name,
        customer_email: "",
        booking_service_kind: preset.bookingKind ?? undefined,
        service_type_code: preset.serviceTypeCode ?? undefined,
        arrival_date: row.date,
        arrival_time: row.time,
        departure_date: row.departure_date,
        departure_time: row.departure_time,
        transport_code: row.transport_code,
        bus_city_origin: row.bus_city_origin || (parsed.data.preset_key === "linea_bus" ? row.pickup : ""),
        tour_name: parsed.data.preset_key === "linea_bus" ? (row.transport_code || row.bus_city_origin || row.pickup || "Linea bus") : "",
        capacity: parsed.data.preset_key === "linea_bus" ? 54 : undefined,
        low_seat_threshold: parsed.data.preset_key === "linea_bus" ? 5 : undefined,
        minimum_passengers: parsed.data.preset_key === "linea_bus" ? null : undefined,
        waitlist_enabled: parsed.data.preset_key === "linea_bus" ? false : undefined,
        waitlist_count: parsed.data.preset_key === "linea_bus" ? 0 : undefined,
        status: "new" as const
      };

      const validated = serviceCreateSchema.safeParse(payload);
      if (!validated.success) {
        errors.push({
          row_index: row.row_index,
          message: formatImportValidationMessage(validated.error.issues[0])
        });
        continue;
      }

      let busAllocation: BusAllocationPlan | null = null;
      if (parsed.data.preset_key === "linea_bus" && busResolverContext) {
        const busResolution = resolveBusImportRow(busResolverContext, {
          tenantId: auth.membership.tenant_id,
          date: row.date,
          direction: validated.data.direction,
          bookingServiceKind: preset.bookingKind,
          serviceTypeCode: preset.serviceTypeCode,
          importCategory: "linea bus",
          busCityOrigin: validated.data.bus_city_origin || row.pickup,
          stopName: validated.data.bus_city_origin || row.pickup,
          transportCode: validated.data.transport_code || row.transport_code,
          lineName: validated.data.transport_code || row.transport_code,
          hotelName: row.destination,
          hotelId: resolvedHotelId,
          pax: paxChunk,
          customerName,
          phone,
          agencyName: row.billing_party_name || parsed.data.default_billing_party_name,
          notes: row.notes,
          time: row.time
        });

        if (busResolution.status === "ready" && busResolution.allocationPlan) {
          busAllocation = busResolution.allocationPlan;
          registerBusResolverAllocation(busResolverContext, {
            busUnitId: busResolution.allocationPlan.unitId,
            date: row.date,
            direction: busResolution.allocationPlan.direction,
            pax: paxChunk
          });
        } else if (busResolution.status === "needs_review") {
          addBusPendingOrError(validRows, errors, row.row_index, busResolution.pendingPayload, busResolution.reasons);
          continue;
        } else {
          errors.push({ row_index: row.row_index, message: busResolution.reasons.join(" ") || "Riga bus bloccata dal resolver." });
          continue;
        }
      }

      const finalPayload = parsed.data.preset_key === "linea_bus" && busAllocation
        ? {
            ...validated.data,
            bus_city_origin: validated.data.bus_city_origin || busAllocation.stopName
          }
        : validated.data;

      validRows.push({ mode: "legacy", rowIndex: row.row_index, payload: finalPayload, busAllocation });
    }
  }

  if (parsed.data.dry_run) {
    return NextResponse.json({
      ok: true,
      dry_run: true,
      summary: {
        total_rows: parsed.data.rows.length,
        skipped_rows: skippedRows,
        valid_rows: validRows.length,
        invalid_rows: errors.length,
        pending_rows: validRows.filter((row) => row.mode === "bus_pending").length
      },
      errors
    });
  }

  if (validRows.length === 0) {
    return NextResponse.json(
      {
        ok: false,
        error: "Nessuna riga valida da importare.",
        summary: {
          total_rows: parsed.data.rows.length,
          skipped_rows: skippedRows,
          valid_rows: 0,
          invalid_rows: errors.length,
          pending_rows: 0
        },
        errors
      },
      { status: 400 }
    );
  }

  const insertedIds: string[] = [];
  let pendingRows = 0;
  let allocatedBusRows = 0;
  for (const item of validRows) {
    if (item.mode === "bus_pending") {
      const pendingInsert = await auth.admin.from("bus_import_pending").insert({
        tenant_id: auth.membership.tenant_id,
        ...item.pendingPayload
      });
      if (pendingInsert.error) {
        errors.push(formatImportStorageError(item.rowIndex, "Pending bus non salvato", pendingInsert.error.message));
        continue;
      }
      pendingRows += 1;
      continue;
    }

    const payload = item.mode === "legacy"
      ? (() => {
          const base = {
            ...item.payload,
            tenant_id: auth.membership.tenant_id,
            created_by_user_id: auth.user.id,
            is_draft: false,
            billing_party_name: item.payload.billing_party_name || null,
            customer_email: item.payload.customer_email || null,
            booking_service_kind: item.payload.booking_service_kind || null,
            service_type_code: item.payload.service_type_code || null,
            arrival_date: item.payload.arrival_date || item.payload.date,
            arrival_time: item.payload.arrival_time || item.payload.time,
            departure_date: item.payload.departure_date || null,
            departure_time: item.payload.departure_time || null,
            transport_code: item.payload.transport_code || null,
            bus_city_origin: item.payload.bus_city_origin || null
          };
          const baseAny = base as Record<string, unknown>;
          const rowHotelId = (baseAny.hotel_id as string | null) ?? null;
          const pickupFields = applyPickupCalc({
            direction: (baseAny.direction as string) ?? "",
            booking_service_kind: (baseAny.booking_service_kind as string | null) ?? null,
            time: (baseAny.time as string) ?? "",
            billing_party_name: base.billing_party_name,
            vessel: (baseAny.vessel as string | null) ?? null,
            hotel_zone: rowHotelId ? hotelZoneById.get(rowHotelId) ?? null : null,
            hotel_name: rowHotelId ? hotelNameById.get(rowHotelId) ?? null : null,
            context: {
              operationalRules: operationalRulesRows as never,
              ferrySchedules: scheduleRows as never,
              date: String(baseAny.date ?? baseAny.arrival_date ?? ""),
              hotelId: rowHotelId,
            },
          });
          return { ...base, ...pickupFields };
        })()
      : item.payload;

    const insertResult = await insertServiceWithSchemaFallback(auth.admin, payload as Record<string, unknown>);
    if (insertResult.error || !insertResult.data?.id) {
      errors.push(formatImportStorageError(item.rowIndex, "Servizio non creato", insertResult.error?.message ?? "Errore sconosciuto."));
      continue;
    }

    if (item.busAllocation) {
      const { error: allocationError } = await auth.admin.rpc("allocate_bus_service", {
        p_tenant_id: auth.membership.tenant_id,
        p_service_id: insertResult.data.id,
        p_bus_line_id: item.busAllocation.lineId,
        p_bus_unit_id: item.busAllocation.unitId,
        p_stop_id: item.busAllocation.stopId,
        p_stop_name: item.busAllocation.stopName,
        p_direction: item.busAllocation.direction,
        p_pax_assigned: item.busAllocation.pax,
        p_notes: "Allocato da import generale Excel tramite resolver bus.",
        p_created_by_user_id: auth.user.id
      });

      if (allocationError) {
        await auth.admin
          .from("services")
          .delete()
          .eq("tenant_id", auth.membership.tenant_id)
          .eq("id", insertResult.data.id);

        if (item.busAllocation.pendingPayload?.bus_line_id) {
          const fallbackPendingInsert = await auth.admin.from("bus_import_pending").insert({
            tenant_id: auth.membership.tenant_id,
            ...item.busAllocation.pendingPayload,
            notes: [
              typeof item.busAllocation.pendingPayload.notes === "string" ? item.busAllocation.pendingPayload.notes : "",
              `Allocazione fallita: ${allocationError.message}`
            ].filter(Boolean).join(" | ")
          });
          if (fallbackPendingInsert.error) {
            errors.push(formatImportStorageError(
              item.rowIndex,
              "Allocazione bus fallita e pending non salvato",
              `${allocationError.message} | ${fallbackPendingInsert.error.message}`
            ));
          } else {
            pendingRows += 1;
          }
          continue;
        }

        errors.push(formatImportStorageError(item.rowIndex, "Allocazione bus fallita", allocationError.message));
        continue;
      }
      allocatedBusRows += 1;
    }

    insertedIds.push(insertResult.data.id);
    ensureWhatsAppContact(auth.admin, {
      tenantId: auth.membership.tenant_id,
      phone: typeof (payload as Record<string, unknown>).phone === "string" ? (payload as Record<string, unknown>).phone as string : null,
      profileName: typeof (payload as Record<string, unknown>).customer_name === "string" ? (payload as Record<string, unknown>).customer_name as string : null,
    }).catch((contactError) => console.error("WhatsApp contact creation failed:", contactError));

    const eventStatus = item.mode === "legacy" ? "new" : item.status;
    const statusEventResult = await auth.admin.from("status_events").insert({
      tenant_id: auth.membership.tenant_id,
      service_id: insertResult.data.id,
      status: eventStatus,
      by_user_id: auth.user.id
    });
    if (statusEventResult.error) {
      console.warn("[excel-import] status_events insert failed", {
        rowIndex: item.rowIndex,
        serviceId: insertResult.data.id,
        message: statusEventResult.error.message
      });
    }
  }

  if (insertedIds.length > 0) {
    // Collega automaticamente i servizi Formula Medmar/SNAV al blocco traghetto
    try {
      await autoLinkImportedServices(auth.admin, auth.membership.tenant_id, insertedIds);
    } catch (error) {
      console.warn("[excel-import] autoLinkImportedServices failed", {
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  if (insertedIds.length === 0 && pendingRows === 0 && errors.length > 0) {
    return NextResponse.json(
      {
        ok: false,
        dry_run: false,
        error: "Nessuna riga importata. Controlla gli errori riga.",
        summary: {
          total_rows: parsed.data.rows.length,
          skipped_rows: skippedRows,
          valid_rows: validRows.length,
          invalid_rows: errors.length,
          imported_rows: 0,
          pending_rows: 0,
          allocated_bus_rows: 0
        },
        imported_service_ids: [],
        errors
      },
      { status: 400 }
    );
  }

  return NextResponse.json({
    ok: true,
    dry_run: false,
    summary: {
      total_rows: parsed.data.rows.length,
      skipped_rows: skippedRows,
      valid_rows: validRows.length,
      invalid_rows: errors.length,
      imported_rows: insertedIds.length,
      pending_rows: pendingRows,
      allocated_bus_rows: allocatedBusRows
    },
    imported_service_ids: insertedIds,
    errors
  });
}
