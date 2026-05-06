import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import {
  appendSplitImportNote,
  formatImportValidationMessage,
  isPlaceholderHotelValue,
  sanitizeImportCustomerName,
  sanitizeImportPhone,
  splitPassengerChunks
} from "@/lib/server/bus-excel-import";
import { resolveHotelMatch } from "@/lib/server/hotel-matching";
import { canonicalizeKnownHotelName, normalizeHotelAliasValue } from "@/lib/server/hotel-aliases";
import { serviceCreateSchema } from "@/lib/validation";
import { applyPickupCalc } from "@/lib/server/apply-pickup-calc";
import { autoLinkImportedServices } from "@/lib/server/transfer-ischia-blocks";

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
  service_category: z.enum(["arrival", "departure", "transfer", "excursion", "round_trip"]).nullable().optional(),
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

type PreparedLegacyRow = { mode: "legacy"; rowIndex: number; payload: z.infer<typeof serviceCreateSchema> };
type PreparedDirectRow = {
  mode: "direct";
  rowIndex: number;
  payload: Record<string, unknown>;
  linkedReturnPayload?: Record<string, unknown> | null;
  status: "new" | "needs_review" | "cancelled";
};

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

function inferTransferMeta(reference: string, pickup: string, externalDestination: string, category: "arrival" | "departure" | "transfer" | "excursion") {
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

async function resolveOrCreateHotel(
  admin: SupabaseClient,
  tenantId: string,
  hotels: HotelRow[],
  aliasesByHotel: Map<string, string[]>,
  rawHotelName: string | null | undefined
) {
  const rawName = String(rawHotelName ?? "").trim();
  if (!rawName || isOperationalLocality(rawName)) return null;

  const existing = resolveHotelMatch(hotels, rawName, undefined);
  if (existing) return existing;

  const name = canonicalizeKnownHotelName(rawName) ?? rawName;
  const normalizedAlias = normalizeHotelAliasValue(rawName);
  const createResult = await admin
    .from("hotels")
    .insert({
      tenant_id: tenantId,
      name,
      normalized_name: normalizeLooseText(name),
      address: "Ischia",
      city: "Ischia",
      zone: "Ischia Porto",
      lat: 40.7405,
      lng: 13.9438,
      source: "excel_import",
      is_active: true
    })
    .select("id")
    .single();
  const createdId = createResult.data?.id ?? null;
  if (!createdId) return null;

  hotels.push({ id: createdId, name, normalized_name: normalizeLooseText(name), aliases: [] });
  if (normalizedAlias && normalizeHotelAliasValue(name) !== normalizedAlias) {
    await admin.from("hotel_aliases").insert({
      tenant_id: tenantId,
      hotel_id: createdId,
      alias: rawName,
      alias_normalized: normalizedAlias,
      source: "excel_import_auto_create"
    });
    aliasesByHotel.set(createdId, [rawName]);
  }

  return createdId;
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
    .select("id, name, normalized_name")
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
  const preset = presetConfig[parsed.data.preset_key];
  const validRows: Array<PreparedLegacyRow | PreparedDirectRow> = [];
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

    if (row.service_category) {
      const hotelLabel = row.hotel_name || row.destination;
      let resolvedHotelId = resolveFirstHotelMatch(
        hotelRows,
        row.service_category === "excursion"
          ? [row.hotel_name, row.destination, row.external_destination, row.pickup]
          : [hotelLabel, row.destination, row.pickup],
        parsed.data.default_hotel_id
      );
      if (!resolvedHotelId) {
        const createCandidates = row.service_category === "excursion"
          ? [row.hotel_name, row.external_destination, row.destination, row.pickup]
          : [hotelLabel, row.destination, row.pickup];
        for (const candidate of createCandidates) {
          resolvedHotelId = await resolveOrCreateHotel(
            auth.admin,
            auth.membership.tenant_id,
            hotelRows,
            aliasesByHotel,
            candidate
          );
          if (resolvedHotelId) break;
        }
      }
      if (!resolvedHotelId) {
        errors.push({ row_index: row.row_index, message: `Hotel non riconosciuto: ${hotelLabel || "vuoto"}` });
        continue;
      }

      const paxChunks = splitPassengerChunks(row.pax);
      const customerName = sanitizeImportCustomerName(row.customer_name, row.row_index);
      const phone = sanitizeImportPhone(row.phone);
      const importedStatus = mapImportedStatus(row.notes);
      const directDirection = row.service_category === "departure" ? "departure" : "arrival";
      const externalDestination = row.external_destination || row.pickup || row.destination;
      const meta = inferTransferMeta(row.transport_code, row.pickup, externalDestination, row.service_category);

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
          arrival_date: row.date,
          arrival_time: row.time,
          departure_date: row.departure_date || null,
          departure_time: row.departure_time || null,
          transport_code: row.transport_code || null,
          bus_city_origin: null,
          status: importedStatus,
          tour_name: row.service_category === "excursion" ? row.service_name || row.transport_code || "Escursione" : null,
          excursion_details: row.service_category === "excursion"
            ? {
                title: row.service_name || row.transport_code || "Escursione",
                external_destination: row.external_destination || null,
                embark_time: row.embark_time || null,
                driver_time: row.driver_time || null,
                import_source: "excel_template"
              }
            : null
        } satisfies Record<string, unknown>;

        const payloadAny = insertPayload as Record<string, unknown>;
        const pickupFields = meta.service_type === "transfer"
          ? applyPickupCalc({
              direction: String(payloadAny.direction ?? ""),
              place_type: null,
              time: String(payloadAny.time ?? ""),
              billing_party_name: typeof insertPayload.billing_party_name === "string" ? insertPayload.billing_party_name : null,
              vessel: typeof payloadAny.vessel === "string" ? payloadAny.vessel : null,
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

      validRows.push({ mode: "legacy", rowIndex: row.row_index, payload: validated.data });
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
        invalid_rows: errors.length
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
          invalid_rows: errors.length
        },
        errors
      },
      { status: 400 }
    );
  }

  const insertedIds: string[] = [];
  for (const item of validRows) {
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
          const pickupFields = applyPickupCalc({
            direction: (baseAny.direction as string) ?? "",
            place_type: (baseAny.place_type as string | null) ?? null,
            time: (baseAny.time as string) ?? "",
            billing_party_name: base.billing_party_name,
            vessel: (baseAny.vessel as string | null) ?? null,
          });
          return { ...base, ...pickupFields };
        })()
      : item.payload;

    const insertResult = await auth.admin.from("services").insert(payload).select("id").single();
    if (insertResult.error || !insertResult.data?.id) {
      return NextResponse.json({ error: insertResult.error?.message ?? `Errore import riga ${item.rowIndex}.` }, { status: 500 });
    }

    insertedIds.push(insertResult.data.id);
    const eventStatus = item.mode === "legacy" ? "new" : item.status;
    await auth.admin.from("status_events").insert({
      tenant_id: auth.membership.tenant_id,
      service_id: insertResult.data.id,
      status: eventStatus,
      by_user_id: auth.user.id
    });
  }

  if (insertedIds.length > 0) {
    // Collega automaticamente i servizi Formula Medmar/SNAV al blocco traghetto
    await autoLinkImportedServices(auth.admin, auth.membership.tenant_id, insertedIds);
  }

  return NextResponse.json({
    ok: true,
    dry_run: false,
    summary: {
      total_rows: parsed.data.rows.length,
      skipped_rows: skippedRows,
      valid_rows: validRows.length,
      invalid_rows: errors.length,
      imported_rows: insertedIds.length
    },
    imported_service_ids: insertedIds,
    errors
  });
}
