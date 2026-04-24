/**
 * GET  /api/vehicle/[token]         — dati pubblici del veicolo (no auth)
 * POST /api/vehicle/[token]         — azioni driver: segnala danno, km log, rifornimento
 *   body.action = "report"          → segnalazione danno
 *   body.action = "km_start"        → inizio turno (inserisce log)
 *   body.action = "km_end"          → fine turno (aggiorna log con km finale)
 *   body.action = "fuel"            → rifornimento rapido
 */
import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";

import { checkRateLimit } from "@/lib/server/rate-limit";

export const runtime = "nodejs";

const MAX_PUBLIC_ACTIONS_PER_15_MIN = { maxAttempts: 12, windowMs: 15 * 60 * 1000 };
const MAX_PHOTO_COUNT = 4;
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);

type PhotoInput = {
  name?: string;
  type?: string;
  dataUrl?: string;
};

function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/^["']|["']$/g, "")!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim().replace(/^["']|["']$/g, "")!;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function getClientIp(request: NextRequest) {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    return forwardedFor.split(",")[0]?.trim() || "unknown";
  }
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

function buildRateLimitKey(request: NextRequest, token: string, action: string) {
  return `${token}:${action}:${getClientIp(request)}`;
}

function fail(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function decodeDataUrl(dataUrl: string) {
  const match = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl);
  if (!match) return null;
  const mimeType = match[1]?.trim().toLowerCase();
  const base64 = match[2]?.trim();
  if (!mimeType || !base64) return null;
  try {
    const buffer = Buffer.from(base64, "base64");
    return { mimeType, buffer };
  } catch {
    return null;
  }
}

function extensionFromMimeType(mimeType: string) {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/heic") return "heic";
  if (mimeType === "image/heif") return "heif";
  return "jpg";
}

async function uploadReportPhotos(
  admin: ReturnType<typeof adminClient>,
  vehicleId: string,
  photos: PhotoInput[] | undefined
) {
  if (!photos || photos.length === 0) return [];
  if (photos.length > MAX_PHOTO_COUNT) {
    throw new Error(`Puoi caricare al massimo ${MAX_PHOTO_COUNT} foto.`);
  }

  const uploadedUrls: string[] = [];
  for (let index = 0; index < photos.length; index += 1) {
    const photo = photos[index];
    if (!photo?.dataUrl) {
      throw new Error("Formato foto non valido.");
    }
    const decoded = decodeDataUrl(photo.dataUrl);
    if (!decoded) {
      throw new Error("Impossibile leggere una delle foto selezionate.");
    }
    if (!ALLOWED_IMAGE_TYPES.has(decoded.mimeType)) {
      throw new Error("Tipo file non supportato. Usa JPG, PNG, WEBP o HEIC.");
    }
    if (decoded.buffer.byteLength === 0 || decoded.buffer.byteLength > MAX_PHOTO_BYTES) {
      throw new Error("Ogni foto deve essere inferiore a 5 MB.");
    }

    const ext = extensionFromMimeType(decoded.mimeType);
    const objectPath = `${vehicleId}/${Date.now()}-${index}-${crypto.randomUUID()}.${ext}`;
    const upload = await admin.storage
      .from("vehicle-damage-photos")
      .upload(objectPath, decoded.buffer, {
        contentType: decoded.mimeType,
        upsert: false
      });

    if (upload.error) {
      throw new Error(`Upload foto fallito: ${upload.error.message}`);
    }

    const { data: publicUrlData } = admin.storage.from("vehicle-damage-photos").getPublicUrl(objectPath);
    uploadedUrls.push(publicUrlData.publicUrl);
  }

  return uploadedUrls;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  const admin = adminClient();

  const { data: vehicle, error } = await admin
    .from("vehicles")
    .select("id, label, plate, capacity, vehicle_size, notes, insurance_expiry, road_tax_expiry, inspection_expiry, km, telaio")
    .eq("qr_token", token)
    .maybeSingle();

  if (error || !vehicle) {
    return NextResponse.json({ error: "Veicolo non trovato." }, { status: 404 });
  }

  // Anomalie attive
  const { data: anomalies } = await admin
    .from("vehicle_anomalies")
    .select("id, severity, title, description, reported_at")
    .eq("vehicle_id", vehicle.id)
    .eq("active", true)
    .order("reported_at", { ascending: false });

  // Turno aperto (km_end null) — per mostrare "fine turno"
  const { data: openLog } = await admin
    .from("vehicle_km_logs")
    .select("id, driver_name, start_km, start_at")
    .eq("vehicle_id", vehicle.id)
    .is("end_km", null)
    .order("start_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // Ultimi 10 turni chiusi
  const { data: kmLogs } = await admin
    .from("vehicle_km_logs")
    .select("id, driver_name, start_km, end_km, start_at, end_at, notes")
    .eq("vehicle_id", vehicle.id)
    .not("end_km", "is", null)
    .order("start_at", { ascending: false })
    .limit(10);

  // Ultimi 10 rifornimenti
  const { data: fuel } = await admin
    .from("vehicle_fuel")
    .select("id, fuel_date, liters, cost, km_at_fuel, fuel_type, station")
    .eq("vehicle_id", vehicle.id)
    .order("fuel_date", { ascending: false })
    .limit(10);

  // Autisti attivi del tenant
  const { data: vehicleWithTenant } = await admin
    .from("vehicles")
    .select("tenant_id")
    .eq("id", vehicle.id)
    .maybeSingle();

  const { data: drivers } = vehicleWithTenant
    ? await admin
        .from("driver_profiles")
        .select("id, full_name")
        .eq("tenant_id", vehicleWithTenant.tenant_id)
        .eq("active", true)
        .order("full_name")
    : { data: [] };

  return NextResponse.json({
    vehicle,
    anomalies:  anomalies  ?? [],
    openLog:    openLog    ?? null,
    kmLogs:     kmLogs     ?? [],
    fuel:       fuel       ?? [],
    drivers:    drivers    ?? [],
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  const admin = adminClient();

  const { data: vehicle, error } = await admin
    .from("vehicles")
    .select("id")
    .eq("qr_token", token)
    .maybeSingle();

  if (error || !vehicle) {
    return NextResponse.json({ error: "Veicolo non trovato." }, { status: 404 });
  }

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return fail("Body non valido.");

  const action = body.action as string;
  if (!["report", "km_start", "km_end", "fuel"].includes(action)) {
    return fail("Azione non riconosciuta.");
  }

  const rateLimit = checkRateLimit("vehicle-qr", buildRateLimitKey(request, token, action), MAX_PUBLIC_ACTIONS_PER_15_MIN);
  if (!rateLimit.allowed) {
    return fail("Troppi tentativi ravvicinati. Riprova tra qualche minuto.", 429);
  }

  /* ── Segnalazione danno ─────────────────────────────────────────────────── */
  if (action === "report") {
    const description = (body.description as string)?.trim();
    if (!description) return fail("Descrizione obbligatoria.");
    if (description.length > 2000) return fail("Descrizione troppo lunga.");
    const validSeverities = ["low", "medium", "high", "blocking"];
    const severity = validSeverities.includes(body.severity as string) ? body.severity as string : "low";
    const reporterName = (body.reporter_name as string)?.trim() || null;
    if (!reporterName) return fail("Nome autista obbligatorio.");
    if (reporterName.length > 120) return fail("Nome troppo lungo.");

    // Le foto sono già caricate dal browser — riceviamo solo gli URL
    const photoUrls: string[] = Array.isArray(body.photo_urls)
      ? (body.photo_urls as string[]).filter((u) => typeof u === "string" && u.startsWith("http")).slice(0, 4)
      : [];

    await admin.from("vehicle_qr_reports").insert({
      vehicle_id:    vehicle.id,
      reporter_name: reporterName,
      description,
      severity,
      photo_urls:    photoUrls.length > 0 ? photoUrls : null,
    });

    await admin.from("vehicle_anomalies").insert({
      vehicle_id:  vehicle.id,
      severity,
      title:       reporterName ? `Segnalazione da ${reporterName}` : "Segnalazione QR",
      description,
      active:      true,
    });

    return NextResponse.json({ ok: true });
  }

  /* ── Inizio turno ───────────────────────────────────────────────────────── */
  if (action === "km_start") {
    const driverName = (body.driver_name as string)?.trim();
    const startKm    = Number(body.start_km);
    if (!driverName) return fail("Nome autista obbligatorio.");
    if (driverName.length > 120) return fail("Nome autista troppo lungo.");
    if (!Number.isInteger(startKm) || startKm < 0) return fail("Km iniziali non validi.");

    const { data: existingOpenLog } = await admin
      .from("vehicle_km_logs")
      .select("id")
      .eq("vehicle_id", vehicle.id)
      .is("end_km", null)
      .limit(1)
      .maybeSingle();

    if (existingOpenLog?.id) {
      return fail("Esiste gia un turno aperto per questo veicolo.", 409);
    }

    const { data: inserted, error: err } = await admin
      .from("vehicle_km_logs")
      .insert({ vehicle_id: vehicle.id, driver_name: driverName, start_km: startKm })
      .select("id")
      .single();

    if (err) return NextResponse.json({ error: err.message }, { status: 500 });

    // Aggiorna km veicolo
    await admin.from("vehicles").update({ km: startKm }).eq("id", vehicle.id);

    return NextResponse.json({ ok: true, log_id: inserted.id });
  }

  /* ── Fine turno ─────────────────────────────────────────────────────────── */
  if (action === "km_end") {
    const logId = body.log_id as string;
    const endKm = Number(body.end_km);
    if (!logId) return fail("log_id obbligatorio.");
    if (!Number.isInteger(endKm) || endKm < 0) return fail("Km finali non validi.");

    const { data: logRow, error: logError } = await admin
      .from("vehicle_km_logs")
      .select("id, start_km, end_km, vehicle_id")
      .eq("id", logId)
      .eq("vehicle_id", vehicle.id)
      .maybeSingle();

    if (logError || !logRow) return fail("Turno non trovato.", 404);
    if (logRow.end_km !== null) return fail("Questo turno risulta gia chiuso.", 409);
    if (endKm < logRow.start_km) return fail("I km finali non possono essere inferiori ai km iniziali.");

    const notes = typeof body.notes === "string" ? body.notes.trim() : "";
    if (notes.length > 1000) return fail("Note troppo lunghe.");

    const { error: err } = await admin
      .from("vehicle_km_logs")
      .update({ end_km: endKm, end_at: new Date().toISOString(), notes: notes || null })
      .eq("id", logId);

    if (err) return NextResponse.json({ error: err.message }, { status: 500 });

    // Aggiorna km veicolo con il valore finale
    await admin.from("vehicles").update({ km: endKm }).eq("id", vehicle.id);

    return NextResponse.json({ ok: true });
  }

  /* ── Rifornimento rapido ────────────────────────────────────────────────── */
  if (action === "fuel") {
    const liters   = body.liters   ? Number(body.liters)   : null;
    const cost     = body.cost     ? Number(body.cost)     : null;
    const kmAtFuel = body.km_at_fuel ? Number(body.km_at_fuel) : null;
    const fuelType = typeof body.fuel_type === "string" ? body.fuel_type : "diesel";
    const station  = (body.station as string)?.trim() || null;
    const validFuelTypes = new Set(["diesel", "benzina", "gas", "elettrico"]);

    if (!validFuelTypes.has(fuelType)) return fail("Tipo carburante non valido.");
    if (liters !== null && (!Number.isFinite(liters) || liters <= 0 || liters > 300)) return fail("Litri non validi.");
    if (cost !== null && (!Number.isFinite(cost) || cost < 0 || cost > 5000)) return fail("Costo non valido.");
    if (kmAtFuel !== null && (!Number.isInteger(kmAtFuel) || kmAtFuel < 0)) return fail("Km al rifornimento non validi.");
    if (station && station.length > 160) return fail("Nome distributore troppo lungo.");

    // tenant_id richiesto — lo ricaviamo dal veicolo
    const { data: veh } = await admin.from("vehicles").select("tenant_id").eq("id", vehicle.id).single();

    const { error: err } = await admin.from("vehicle_fuel").insert({
      vehicle_id: vehicle.id,
      tenant_id:  veh?.tenant_id,
      fuel_date:  new Date().toISOString().slice(0, 10),
      liters,
      cost,
      km_at_fuel: kmAtFuel,
      fuel_type:  fuelType,
      station,
      approval_status: "pending",
      submitted_via_qr: true,
    });

    if (err) return NextResponse.json({ error: err.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  return fail("Azione non riconosciuta.");
}
