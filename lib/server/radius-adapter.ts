/**
 * Adapter per Radius Velocity / Kinesis GPS API
 * Documentazione: https://api-docs.velocityfleet.com/
 *
 * Autenticazione OAuth2 in due step:
 *   1. POST /vapi/v1/accounts/users/oauth2/refresh/  →  access_token (valido 30 giorni)
 *   2. Ogni richiesta API usa:  Authorization: Bearer <access_token>
 *
 * Endpoint GPS posizioni:
 *   POST /api/mobile/kinesis/device-live-positions/?customer=<customer_id>
 *
 * Env richieste:
 *   RADIUS_REFRESH_TOKEN   — token dal Radius Velocity Portal (Telematica)
 *   RADIUS_CUSTOMER_ID     — ID cliente (opzionale: se non impostato viene auto-rilevato)
 *
 * Env opzionale:
 *   RADIUS_API_BASE_URL    — override base URL (default: https://www.velocityfleet.com)
 */

import type { GpsVehiclePosition } from "@/lib/types";

const VELOCITY_BASE = "https://www.velocityfleet.com";

function velocityBase(): string {
  const override = process.env.RADIUS_API_BASE_URL;
  if (override) return override.replace(/\/vapi\/v1\/?$/, "").replace(/\/$/, "");
  return VELOCITY_BASE;
}

// ─── Cache ─────────────────────────────────────────────────────────────────
let cachedAccessToken: string | null = null;
let cacheExpiresAt = 0;
let cachedCustomerId: string | null = null;

// ─── OAuth2: Refresh Token → Access Token ──────────────────────────────────
async function getAccessToken(): Promise<string> {
  if (cachedAccessToken && Date.now() < cacheExpiresAt) return cachedAccessToken;

  const refreshToken = process.env.RADIUS_REFRESH_TOKEN;
  if (!refreshToken) throw new Error("RADIUS_REFRESH_TOKEN non configurato.");

  const base = velocityBase();
  const body = new FormData();
  body.append("token", refreshToken);

  const res = await fetch(`${base}/vapi/v1/accounts/users/oauth2/refresh/`, {
    method: "POST",
    body,
    signal: AbortSignal.timeout(10_000)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Radius OAuth2 errore ${res.status}: ${text}`);
  }

  const json = await res.json() as Record<string, unknown>;
  const token = String(json.access_token ?? json.token ?? "");
  if (!token) throw new Error("Radius OAuth2: access_token non trovato nella risposta.");

  cachedAccessToken = token;
  cacheExpiresAt = Date.now() + 29 * 24 * 60 * 60 * 1000;
  return token;
}

async function authHeader(): Promise<Record<string, string>> {
  const token = await getAccessToken();
  return { "Authorization": `Bearer ${token}` };
}

// ─── Customer ID auto-rilevamento ─────────────────────────────────────────
async function getCustomerId(): Promise<string> {
  if (process.env.RADIUS_CUSTOMER_ID) return process.env.RADIUS_CUSTOMER_ID;
  if (cachedCustomerId) return cachedCustomerId;

  const base = velocityBase();
  const headers = await authHeader();
  const res = await fetch(`${base}/vapi/v1/accounts/users/customers`, {
    headers,
    signal: AbortSignal.timeout(8_000)
  });

  if (!res.ok) throw new Error(`Radius customers errore ${res.status}`);

  const json = await res.json() as unknown;
  const list = Array.isArray(json)
    ? json
    : Array.isArray((json as Record<string, unknown>).results)
      ? (json as Record<string, unknown[]>).results
      : Array.isArray((json as Record<string, unknown>).customers)
        ? (json as Record<string, unknown[]>).customers
        : [];

  const first = list[0] as Record<string, unknown> | undefined;
  const id = String(first?.id ?? first?.customer_id ?? first?.customerId ?? "");
  if (!id) throw new Error("Radius: impossibile determinare customer_id automaticamente. Imposta RADIUS_CUSTOMER_ID nel .env");

  cachedCustomerId = id;
  return id;
}

// ─── Normalizzatore posizione ──────────────────────────────────────────────
interface RadiusRawPosition {
  id?: string | number;
  device_id?: string | number;
  deviceId?: string | number;
  vehicle_id?: string | number;
  vehicleId?: string | number;
  name?: string;
  label?: string;
  vehicle_name?: string;
  registration?: string;
  plate?: string;
  lat?: number;
  latitude?: number;
  lng?: number;
  lon?: number;
  longitude?: number;
  speed?: number;
  speedKmh?: number;
  speed_kmh?: number;
  heading?: number;
  bearing?: number;
  direction?: number;
  timestamp?: string;
  updatedAt?: string;
  updated_at?: string;
  last_seen?: string;
  datetime?: string;
  driverName?: string;
  driver_name?: string;
  driver?: string;
  lineName?: string;
  line_name?: string;
  online?: boolean;
  ignition?: boolean;
  status?: string;
}

function parseTimestamp(raw: RadiusRawPosition): string {
  const raw_ts = raw.timestamp ?? raw.datetime ?? raw.updatedAt ?? raw.updated_at ?? raw.last_seen;
  if (!raw_ts) return new Date().toISOString();
  const s = String(raw_ts);
  // Unix timestamp in secondi (10 cifre) o millisecondi (13 cifre)
  if (/^\d{9,13}$/.test(s)) {
    const n = Number(s);
    const ms = n < 1e12 ? n * 1000 : n;
    return new Date(ms).toISOString();
  }
  return s;
}

function normalizePosition(raw: RadiusRawPosition): GpsVehiclePosition {
  const lat = raw.lat ?? raw.latitude ?? 0;
  const lng = raw.lng ?? raw.lon ?? raw.longitude ?? 0;
  const speed = raw.speedKmh ?? raw.speed_kmh ?? raw.speed ?? null;
  const heading = raw.heading ?? raw.bearing ?? raw.direction ?? null;
  const timestamp = parseTimestamp(raw);

  const vehicleId = String(
    raw.device_id ?? raw.deviceId ?? raw.vehicle_id ?? raw.vehicleId ?? raw.id ?? ""
  );

  // In Kinesis, driver_name contiene il nome del veicolo (non del guidatore)
  const vehicleName = raw.vehicle_name ?? raw.name ?? raw.driver_name ?? raw.driverName ?? raw.registration ?? raw.plate ?? vehicleId;

  // Online: vero se ignition attivo oppure se aggiornamento recente (< 2 ore)
  let online: boolean;
  if (raw.online !== undefined) {
    online = raw.online;
  } else if (raw.ignition !== undefined) {
    online = raw.ignition;
  } else if (["online", "active", "moving"].includes(String(raw.status ?? ""))) {
    online = true;
  } else {
    // Fallback: considera online se aggiornato nelle ultime 2 ore
    const ageMs = Date.now() - new Date(timestamp).getTime();
    online = ageMs < 2 * 60 * 60 * 1000;
  }

  return {
    radius_vehicle_id: vehicleId,
    label: vehicleName,
    lat,
    lng,
    speed_kmh: speed !== null ? Number(speed) : null,
    heading: heading !== null ? Number(heading) : null,
    timestamp,
    driver_name: null, // Kinesis non espone il guidatore su questo endpoint
    line_name: raw.lineName ?? raw.line_name ?? null,
    online
  };
}

function extractArray(json: unknown, ...keys: string[]): unknown[] {
  if (Array.isArray(json)) return json;
  if (json && typeof json === "object") {
    for (const key of keys) {
      const val = (json as Record<string, unknown>)[key];
      if (Array.isArray(val)) return val;
    }
  }
  return [];
}

// ─── API pubblica ──────────────────────────────────────────────────────────

/**
 * Posizioni live di tutti i dispositivi GPS del fleet.
 * Endpoint: POST /api/mobile/kinesis/device-live-positions/?customer=<id>
 */
export async function fetchRadiusAllPositions(): Promise<GpsVehiclePosition[]> {
  const { normalized } = await fetchRadiusAllPositionsWithRaw();
  return normalized;
}

/**
 * Come fetchRadiusAllPositions ma restituisce anche il JSON grezzo (per debug).
 */
export async function fetchRadiusAllPositionsWithRaw(): Promise<{
  normalized: GpsVehiclePosition[];
  raw_json: unknown;
}> {
  const base = velocityBase();
  const headers = await authHeader();
  const customerId = await getCustomerId();

  const res = await fetch(
    `${base}/api/mobile/kinesis/device-live-positions/?customer=${encodeURIComponent(customerId)}`,
    { method: "POST", headers, signal: AbortSignal.timeout(12_000) }
  );

  if (!res.ok) {
    throw new Error(`Radius device-live-positions errore ${res.status}: ${await res.text()}`);
  }

  const raw_json = await res.json() as unknown;
  const raw = extractArray(raw_json, "positions", "devices", "vehicles", "results", "data");
  return { normalized: (raw as RadiusRawPosition[]).map(normalizePosition), raw_json };
}

/**
 * Lista veicoli/dispositivi del fleet (senza posizione).
 * Tenta endpoint telematica; fallback sulla lista dalle posizioni live.
 */
export async function fetchRadiusVehicles(): Promise<GpsVehiclePosition[]> {
  return fetchRadiusAllPositions();
}

/**
 * Posizione live di un singolo dispositivo.
 */
export async function fetchRadiusVehiclePosition(vehicleId: string): Promise<GpsVehiclePosition | null> {
  const all = await fetchRadiusAllPositions();
  return all.find((v) => v.radius_vehicle_id === vehicleId) ?? null;
}
