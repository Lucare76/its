import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import {
  buildMemorySlotKey,
  getRouteDefinition,
  normalizeTime,
  type MedmarTicketRouteCode,
} from "@/lib/medmar-ticket-memory";

export const runtime = "nodejs";

type MemoryRow = {
  id: string;
  route_code: MedmarTicketRouteCode;
  travel_date: string;
  departure_time: string | null;
  issue_date: string | null;
  ticket_number: string | null;
  booking_code: string | null;
  voucher_label: string | null;
  tariff_label: string | null;
  price_cents: number | null;
  quantity: number;
  status: "available" | "matched" | "used" | "expired";
  matched_service_id: string | null;
  photo_path: string | null;
  photo_url: string | null;
  notes: string | null;
  created_at: string;
};

type ServiceCandidateRow = {
  id: string;
  customer_name: string | null;
  phone: string | null;
  pax: number | null;
  date: string;
  time: string | null;
  direction: "arrival" | "departure";
  vessel: string | null;
  meeting_point: string | null;
  booking_service_kind: string | null;
  departure_time: string | null;
  arrival_time: string | null;
  hotels: { name: string | null } | Array<{ name: string | null }> | null;
};

function extractHotelName(joined: ServiceCandidateRow["hotels"]) {
  if (Array.isArray(joined)) return joined[0]?.name ?? null;
  return joined?.name ?? null;
}

function containsAny(text: string, keywords: string[]) {
  return keywords.some((keyword) => text.includes(keyword));
}

function scoreCandidate(memory: MemoryRow, service: ServiceCandidateRow) {
  const def = getRouteDefinition(memory.route_code);
  const haystack = `${service.vessel ?? ""} ${service.meeting_point ?? ""} ${service.booking_service_kind ?? ""}`.toLowerCase();
  let score = 0;
  const reasons: string[] = [];

  if ((service.vessel ?? "").toLowerCase().includes("medmar")) {
    score += 4;
    reasons.push("compagnia Medmar");
  }

  if (containsAny(haystack, def.departurePortKeywords)) {
    score += 3;
    reasons.push(`porto ${def.departurePortKeywords[0]}`);
  }

  if (service.booking_service_kind && def.bookingKinds.includes(service.booking_service_kind)) {
    score += 2;
    reasons.push(`formula ${service.booking_service_kind}`);
  }

  const targetTime = normalizeTime(memory.departure_time);
  const serviceTimes = [
    normalizeTime(service.time),
    normalizeTime(service.departure_time),
    normalizeTime(service.arrival_time),
  ].filter((value): value is string => Boolean(value));

  if (targetTime && serviceTimes.includes(targetTime)) {
    score += 3;
    reasons.push(`orario ${targetTime}`);
  }

  return { score, reasons };
}

const createMemorySchema = z.object({
  route_code: z.enum([
    "pozzuoli_ischia",
    "pozzuoli_casamicciola",
    "napoli_ischia",
    "napoli_casamicciola",
    "ischia_pozzuoli",
    "casamicciola_pozzuoli",
    "ischia_napoli",
    "casamicciola_napoli",
  ]),
  travel_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  departure_time: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  issue_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  ticket_number: z.string().max(80).nullable().optional(),
  booking_code: z.string().max(120).nullable().optional(),
  voucher_label: z.string().max(120).nullable().optional(),
  tariff_label: z.string().max(200).nullable().optional(),
  price_cents: z.number().int().nonnegative().nullable().optional(),
  quantity: z.number().int().min(1).max(100),
  photo_path: z.string().max(500).nullable().optional(),
  photo_url: z.string().max(2000).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
});

export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;
  const { admin, membership } = auth;
  const tenantId = membership.tenant_id;

  const url = new URL(request.url);
  const dateFrom = url.searchParams.get("date_from") ?? new Date().toISOString().slice(0, 10);
  const dateTo = url.searchParams.get("date_to") ?? dateFrom;
  const today = new Date().toISOString().slice(0, 10);

  await admin
    .from("medmar_ticket_memory")
    .update({ status: "expired" })
    .eq("tenant_id", tenantId)
    .eq("status", "available")
    .lt("travel_date", today);

  const { data: memories, error: memoriesError } = await admin
    .from("medmar_ticket_memory")
    .select("*")
    .eq("tenant_id", tenantId)
    .gte("travel_date", dateFrom)
    .lte("travel_date", dateTo)
    .order("travel_date")
    .order("departure_time")
    .order("created_at", { ascending: false });

  if (memoriesError) {
    return NextResponse.json({ ok: false, error: memoriesError.message }, { status: 500 });
  }

  const memoryList = (memories ?? []) as MemoryRow[];
  const relevantDates = [...new Set(memoryList.map((row) => row.travel_date))];
  let servicesByDate = new Map<string, ServiceCandidateRow[]>();

  if (relevantDates.length > 0) {
    const { data: services, error: servicesError } = await admin
      .from("services")
      .select("id, customer_name, phone, pax, date, time, direction, vessel, meeting_point, booking_service_kind, departure_time, arrival_time, hotels!left(name)")
      .eq("tenant_id", tenantId)
      .in("date", relevantDates)
      .eq("is_draft", false)
      .neq("status", "cancelled")
      .ilike("vessel", "%medmar%");

    if (servicesError) {
      return NextResponse.json({ ok: false, error: servicesError.message }, { status: 500 });
    }

    for (const service of (services ?? []) as ServiceCandidateRow[]) {
      const bucket = servicesByDate.get(service.date) ?? [];
      bucket.push(service);
      servicesByDate.set(service.date, bucket);
    }
  }

  const slotMap = new Map<string, {
    key: string;
    route_code: MedmarTicketRouteCode;
    travel_date: string;
    departure_time: string | null;
    available_quantity: number;
    tickets: MemoryRow[];
    matched_services: Array<{
      service_id: string;
      customer_name: string | null;
      hotel_name: string | null;
      pax: number | null;
      date: string;
      time: string | null;
      direction: "arrival" | "departure";
      vessel: string | null;
      score: number;
      reasons: string[];
    }>;
  }>();

  for (const memory of memoryList) {
    const key = buildMemorySlotKey(memory.route_code, memory.travel_date, memory.departure_time);
    const existing = slotMap.get(key) ?? {
      key,
      route_code: memory.route_code,
      travel_date: memory.travel_date,
      departure_time: normalizeTime(memory.departure_time),
      available_quantity: 0,
      tickets: [],
      matched_services: [],
    };

    existing.tickets.push(memory);
    if (memory.status === "available") {
      existing.available_quantity += memory.quantity;
    }

    if (existing.matched_services.length === 0) {
      const def = getRouteDefinition(memory.route_code);
      const candidates = (servicesByDate.get(memory.travel_date) ?? [])
        .filter((service) => service.direction === def.serviceDirection)
        .map((service) => {
          const { score, reasons } = scoreCandidate(memory, service);
          return {
            service_id: service.id,
            customer_name: service.customer_name,
            hotel_name: extractHotelName(service.hotels),
            pax: service.pax,
            date: service.date,
            time: normalizeTime(service.time) ?? normalizeTime(service.departure_time) ?? normalizeTime(service.arrival_time),
            direction: service.direction,
            vessel: service.vessel,
            score,
            reasons,
          };
        })
        .filter((service) => service.score >= 4)
        .sort((left, right) => right.score - left.score || (left.customer_name ?? "").localeCompare(right.customer_name ?? ""));

      existing.matched_services = candidates;
    }

    slotMap.set(key, existing);
  }

  return NextResponse.json({
    ok: true,
    memories: memoryList,
    slots: [...slotMap.values()].sort((left, right) =>
      left.travel_date.localeCompare(right.travel_date) ||
      (left.departure_time ?? "").localeCompare(right.departure_time ?? "") ||
      left.route_code.localeCompare(right.route_code)
    ),
  });
}

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;
  const { admin, membership, user } = auth;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "JSON non valido." }, { status: 400 });
  }

  const parsed = createMemorySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: parsed.error.issues[0]?.message ?? "Dati non validi." }, { status: 400 });
  }

  const payload = {
    tenant_id: membership.tenant_id,
    route_code: parsed.data.route_code,
    travel_date: parsed.data.travel_date,
    departure_time: parsed.data.departure_time ?? null,
    issue_date: parsed.data.issue_date ?? null,
    ticket_number: parsed.data.ticket_number?.trim() || null,
    booking_code: parsed.data.booking_code?.trim() || null,
    voucher_label: parsed.data.voucher_label?.trim() || null,
    tariff_label: parsed.data.tariff_label?.trim() || null,
    price_cents: parsed.data.price_cents ?? null,
    quantity: parsed.data.quantity,
    photo_path: parsed.data.photo_path ?? null,
    photo_url: parsed.data.photo_url ?? null,
    notes: parsed.data.notes?.trim() || null,
    created_by: user.id,
  };

  const { data, error } = await admin
    .from("medmar_ticket_memory")
    .insert(payload)
    .select("*")
    .single();

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, memory: data });
}
