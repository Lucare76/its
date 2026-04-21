import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { hotelGeoQuality } from "@/lib/hotel-geocoding";

export const runtime = "nodejs";

const MODEL = "claude-haiku-4-5-20251001";
const MAX_CLUSTERS = 20;
const MAX_GEO_ISSUES = 10;

const requestSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
});

const aiActionSchema = z.object({
  priority: z.enum(["alta", "media", "bassa"]),
  title: z.string().max(120),
  reason: z.string().max(280),
  operator_action: z.string().max(280)
});

const aiBatchSchema = z.object({
  direction: z.enum(["arrival", "departure"]),
  time_window: z.string().max(40),
  port: z.string().nullable(),
  zone: z.string().nullable(),
  services: z.number().int().nonnegative(),
  pax: z.number().int().nonnegative(),
  recommendation: z.string().max(320),
  risk: z.string().max(180).nullable()
});

const aiPlanSchema = z.object({
  summary: z.string().max(600),
  confidence: z.enum(["alta", "media", "bassa"]),
  priority_actions: z.array(aiActionSchema).max(8),
  suggested_batches: z.array(aiBatchSchema).max(12),
  warnings: z.array(z.string().max(220)).max(10)
});

type ServiceRow = {
  id: string;
  time: string;
  direction: "arrival" | "departure";
  vessel: string | null;
  hotel_id: string | null;
  pax: number;
  status: string;
  meeting_point: string | null;
  pickup_hotel: string | null;
  customer_name: string | null;
};

type HotelRow = {
  id: string;
  name: string;
  address: string | null;
  zone: string | null;
  lat: number | null;
  lng: number | null;
  geo_status: string | null;
  geo_source: string | null;
  geo_accuracy: string | null;
  geo_verified_at: string | null;
};

type VehicleRow = { id: string; label: string; capacity: number | null; vehicle_size: string | null; active: boolean | null };
type DriverRow = { user_id: string; full_name: string | null; role: string };
type AssignmentRow = { service_id: string; group_id: string | null; driver_user_id: string | null };
type TripGroupRow = { id: string; driver_user_id: string | null; vehicle_label: string | null; vehicle_capacity: number | null; status: string | null };

function minutesFromTime(value: string | null | undefined) {
  const [h, m] = String(value ?? "").slice(0, 5).split(":").map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

function timeFromMinutes(total: number) {
  return `${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function hourWindow(time: string | null | undefined) {
  const minutes = minutesFromTime(time) ?? 0;
  const start = Math.floor(minutes / 60) * 60;
  return `${timeFromMinutes(start)}-${timeFromMinutes(start + 60)}`;
}

function cleanPortName(value: string | null | undefined): string {
  const text = String(value ?? "").toLowerCase();
  if (text.includes("casamicciola")) return "Casamicciola";
  if (text.includes("forio")) return "Forio";
  if (text.includes("lacco")) return "Lacco Ameno";
  if (text.includes("ischia porto") || text.includes("uscita arrivi") || text.includes("ischia")) return "Ischia Porto";
  if (text.includes("pozzuoli")) return "Pozzuoli";
  if (text.includes("beverello") || text.includes("napoli")) return "Napoli Beverello";
  return String(value ?? "").trim();
}

function compactPort(value: string | null | undefined) {
  const port = cleanPortName(value);
  return port || "Porto da verificare";
}

function normalizeVessel(value: string | null | undefined) {
  const text = String(value ?? "").toLowerCase();
  if (text.includes("snav")) return "SNAV";
  if (text.includes("medmar")) return "Medmar";
  if (text.includes("alilauro")) return "Alilauro";
  if (text.includes("caremar")) return "Caremar";
  return value || "Nave non indicata";
}

function issueLabels(issues: string[]) {
  const labels: Record<string, string> = {
    missing_coordinates: "coordinate mancanti",
    outside_ischia: "coordinate fuori Ischia",
    default_centroid: "coordinate generiche",
    zone_coordinate_mismatch: "zona incoerente con coordinate",
    incomplete_address: "indirizzo incompleto"
  };
  return issues.map((issue) => labels[issue] ?? issue);
}

function safeJsonText(text: string) {
  const cleaned = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  return match?.[0] ?? cleaned;
}

async function callAnthropic(input: unknown) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY non configurata sul server.");

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      system: [
        "Sei un assistente operativo per Ischia Transfer.",
        "Aiuti un operatore a gestire giornate enormi, anche 600 arrivi e 600 partenze.",
        "Non devi applicare modifiche. Devi proporre un piano semplice, prudente e verificabile.",
        "Rispondi solo con JSON valido, senza markdown."
      ].join(" "),
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Analizza questo riassunto del Piano del Giorno e restituisci JSON con schema:
{
  "summary": "sintesi operativa in italiano",
  "confidence": "alta|media|bassa",
  "priority_actions": [{"priority":"alta|media|bassa","title":"...","reason":"...","operator_action":"..."}],
  "suggested_batches": [{"direction":"arrival|departure","time_window":"HH:MM-HH:MM","port":"... o null","zone":"... o null","services":0,"pax":0,"recommendation":"...","risk":"... o null"}],
  "warnings": ["..."]
}

Regole:
- Stesso porto: arrivi entro 20/25 minuti possono essere accorpati se non generano attese eccessive.
- Non fidarti di hotel con geo_issues: vanno corretti prima di usare percorso geografico.
- Per partenze, considera pickup hotel/zone e porto di imbarco.
- Dai massimo 8 azioni prioritarie e massimo 12 batch.
- Linguaggio semplice per operatore, non tecnico.

DATI:
${JSON.stringify(input)}`
            }
          ]
        }
      ]
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Errore Anthropic: ${body.slice(0, 500)}`);
  }
  return response.json() as Promise<{
    content?: Array<{ type?: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  }>;
}

export async function POST(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
    if (auth instanceof NextResponse) return auth;

    const parsed = requestSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: "Data non valida." }, { status: 400 });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json({ ok: false, error: "ANTHROPIC_API_KEY non configurata sul server." }, { status: 503 });
    }

    const tenantId = auth.membership.tenant_id;
    const date = parsed.data.date;

    const [servicesRes, hotelsRes, vehiclesRes, driversRes, assignmentsRes, groupsRes] = await Promise.all([
      auth.admin
        .from("services")
        .select("id,time,direction,vessel,hotel_id,pax,status,meeting_point,pickup_hotel,customer_name")
        .eq("tenant_id", tenantId)
        .eq("date", date)
        .neq("status", "cancelled")
        .neq("is_draft", true),
      auth.admin
        .from("hotels")
        .select("id,name,address,zone,lat,lng,geo_status,geo_source,geo_accuracy,geo_verified_at")
        .eq("tenant_id", tenantId),
      auth.admin
        .from("vehicles")
        .select("id,label,capacity,vehicle_size,active")
        .eq("tenant_id", tenantId)
        .eq("active", true),
      auth.admin
        .from("memberships")
        .select("user_id,full_name,role")
        .eq("tenant_id", tenantId)
        .eq("role", "driver"),
      auth.admin
        .from("assignments")
        .select("service_id,group_id,driver_user_id")
        .eq("tenant_id", tenantId),
      auth.admin
        .from("trip_groups")
        .select("id,driver_user_id,vehicle_label,vehicle_capacity,status")
        .eq("tenant_id", tenantId)
        .eq("date", date)
        .eq("status", "active")
    ]);

    if (servicesRes.error || hotelsRes.error || vehiclesRes.error || driversRes.error || assignmentsRes.error || groupsRes.error) {
      return NextResponse.json({ ok: false, error: "Errore caricamento dati piano." }, { status: 500 });
    }

    const services = (servicesRes.data ?? []) as ServiceRow[];
    const hotels = (hotelsRes.data ?? []) as HotelRow[];
    const vehicles = (vehiclesRes.data ?? []) as VehicleRow[];
    const drivers = (driversRes.data ?? []) as DriverRow[];
    const assignments = (assignmentsRes.data ?? []) as AssignmentRow[];
    const groups = (groupsRes.data ?? []) as TripGroupRow[];
    const hotelById = new Map(hotels.map((hotel) => [hotel.id, hotel]));
    const assignedServiceIds = new Set(assignments.filter((row) => row.group_id).map((row) => row.service_id));
    const unassigned = services.filter((service) => !assignedServiceIds.has(service.id));

    const clustersByKey = new Map<string, {
      direction: "arrival" | "departure";
      window: string;
      port: string;
      zone: string;
      vessel: string;
      services: number;
      pax: number;
      geoIssues: number;
      sampleHotels: Set<string>;
    }>();

    for (const service of unassigned) {
      const hotel = hotelById.get(service.hotel_id ?? "");
      const quality = hotel ? hotelGeoQuality(hotel) : null;
      const displayTime = service.direction === "departure" ? service.pickup_hotel ?? service.time : service.time;
      const window = hourWindow(displayTime);
      const port = compactPort(service.meeting_point);
      const zone = hotel?.zone || "Zona da verificare";
      const vessel = service.direction === "arrival" ? normalizeVessel(service.vessel) : "partenza";
      const key = [service.direction, window, port, zone, vessel].join("|");
      const row = clustersByKey.get(key) ?? {
        direction: service.direction,
        window,
        port,
        zone,
        vessel,
        services: 0,
        pax: 0,
        geoIssues: 0,
        sampleHotels: new Set<string>()
      };
      row.services += 1;
      row.pax += service.pax;
      if (!hotel || quality?.routeUsable === false) row.geoIssues += 1;
      if (hotel?.name && row.sampleHotels.size < 4) row.sampleHotels.add(hotel.name);
      clustersByKey.set(key, row);
    }

    const clusters = Array.from(clustersByKey.values())
      .sort((a, b) => b.services - a.services || b.pax - a.pax)
      .slice(0, MAX_CLUSTERS)
      .map((row) => ({
        direction: row.direction,
        window: row.window,
        port: row.port,
        zone: row.zone,
        vessel: row.vessel,
        services: row.services,
        pax: row.pax,
        geo_issues: row.geoIssues,
        sample_hotels: Array.from(row.sampleHotels)
      }));

    const geoIssues = hotels
      .map((hotel) => ({ hotel, quality: hotelGeoQuality(hotel) }))
      .filter((row) => row.quality.routeUsable === false)
      .slice(0, MAX_GEO_ISSUES)
      .map((row) => ({
        hotel: row.hotel.name,
        zone: row.hotel.zone,
        issues: issueLabels(row.quality.issues)
      }));

    const groupStats = {
      total: groups.length,
      without_driver: groups.filter((group) => !group.driver_user_id).length,
      without_vehicle: groups.filter((group) => !group.vehicle_label).length
    };

    const input = {
      date,
      totals: {
        services: services.length,
        arrivals: services.filter((service) => service.direction === "arrival").length,
        departures: services.filter((service) => service.direction === "departure").length,
        unassigned_services: unassigned.length,
        unassigned_pax: unassigned.reduce((sum, service) => sum + service.pax, 0),
        active_trips: groupStats.total,
        trips_without_driver: groupStats.without_driver,
        trips_without_vehicle: groupStats.without_vehicle,
        drivers: drivers.length,
        vehicles: vehicles.length,
        max_vehicle_capacity: vehicles.reduce((max, vehicle) => Math.max(max, vehicle.capacity ?? 0), 0)
      },
      vehicles: vehicles.slice(0, 20).map((vehicle) => ({
        label: vehicle.label,
        capacity: vehicle.capacity,
        size: vehicle.vehicle_size
      })),
      unassigned_clusters: clusters,
      hotel_geo_issues: geoIssues
    };

    const anth = await callAnthropic(input);
    const text = anth.content?.map((part) => part.text ?? "").join("") ?? "";
    const jsonText = safeJsonText(text);
    const parseResult = (() => { try { return { ok: true, value: JSON.parse(jsonText) }; } catch { return { ok: false }; } })();
    if (!parseResult.ok) {
      return NextResponse.json({ ok: false, error: "Risposta AI troncata. Riprova — se persiste ridurre la complessità della giornata." }, { status: 502 });
    }
    const aiParsed = aiPlanSchema.safeParse(parseResult.value);
    if (!aiParsed.success) {
      return NextResponse.json({ ok: false, error: "Risposta AI non valida. Riprova." }, { status: 502 });
    }

    return NextResponse.json({
      ok: true,
      model: MODEL,
      plan: aiParsed.data,
      usage: anth.usage ?? null
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Errore AI piano del giorno." },
      { status: 500 }
    );
  }
}
