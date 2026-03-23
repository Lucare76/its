import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { serviceCreateSchema } from "@/lib/validation";

export const runtime = "nodejs";

const presetSchema = z.enum(["generic_transfer", "formula_snav", "formula_medmar", "transfer_airport", "transfer_station", "linea_bus"]);

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
  bus_city_origin: z.string().trim().optional().default("")
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
  formula_medmar: {
    vessel: "MEDMAR",
    meetingPoint: "Porto Pozzuoli",
    bookingKind: "transfer_port_hotel",
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

function normalizeText(value: string | null | undefined) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function resolveHotelId(hotels: HotelRow[], rawHotelName: string, defaultHotelId: string | null | undefined) {
  const wanted = normalizeText(rawHotelName);
  if (!wanted) {
    return defaultHotelId ?? null;
  }

  const exact = hotels.find((hotel) => normalizeText(hotel.normalized_name || hotel.name) === wanted);
  if (exact) return exact.id;

  const include = hotels.find((hotel) => {
    const candidate = normalizeText(hotel.normalized_name || hotel.name);
    return candidate.includes(wanted) || wanted.includes(candidate);
  });
  if (include) return include.id;

  return defaultHotelId ?? null;
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

  const hotelRows = (hotels ?? []) as HotelRow[];
  const preset = presetConfig[parsed.data.preset_key];
  const validRows: Array<{ rowIndex: number; payload: z.infer<typeof serviceCreateSchema> }> = [];
  const errors: Array<{ row_index: number; message: string }> = [];

  for (const row of parsed.data.rows) {
    const resolvedHotelId = resolveHotelId(hotelRows, row.destination, parsed.data.default_hotel_id);
    if (!resolvedHotelId) {
      errors.push({ row_index: row.row_index, message: `Hotel non riconosciuto: ${row.destination || "vuoto"}` });
      continue;
    }

    const payload = {
      date: row.date,
      time: row.time,
      service_type: "transfer" as const,
      direction: row.direction ?? parsed.data.default_direction,
      vessel: preset.vessel,
      pax: row.pax,
      hotel_id: resolvedHotelId,
      customer_name: row.customer_name,
      phone: row.phone,
      notes: row.notes,
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
        message: validated.error.issues[0]?.message ?? "Riga non valida."
      });
      continue;
    }

    validRows.push({ rowIndex: row.row_index, payload: validated.data });
  }

  if (parsed.data.dry_run) {
    return NextResponse.json({
      ok: true,
      dry_run: true,
      summary: {
        total_rows: parsed.data.rows.length,
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
          valid_rows: 0,
          invalid_rows: errors.length
        },
        errors
      },
      { status: 400 }
    );
  }

  const servicesToInsert = validRows.map((item) => ({
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
  }));

  const insertResult = await auth.admin.from("services").insert(servicesToInsert).select("id");
  if (insertResult.error) {
    return NextResponse.json({ error: insertResult.error.message }, { status: 500 });
  }

  const insertedIds = (insertResult.data ?? []).map((item: { id: string }) => item.id);
  if (insertedIds.length > 0) {
    const events = insertedIds.map((serviceId: string) => ({
      tenant_id: auth.membership.tenant_id,
      service_id: serviceId,
      status: "new",
      by_user_id: auth.user.id
    }));
    await auth.admin.from("status_events").insert(events);
  }

  return NextResponse.json({
    ok: true,
    dry_run: false,
    summary: {
      total_rows: parsed.data.rows.length,
      valid_rows: validRows.length,
      invalid_rows: errors.length,
      imported_rows: insertedIds.length
    },
    imported_service_ids: insertedIds,
    errors
  });
}
