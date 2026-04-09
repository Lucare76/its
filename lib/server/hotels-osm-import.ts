import { inferZoneFromText, zoneCentroids } from "@/lib/hotel-geocoding";

type SupabaseAdminClient = any;

type OverpassElement = {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat?: number; lon?: number };
  tags?: Record<string, string>;
};

export type ImportHotelsOptions = {
  limit?: number;
  dryRun?: boolean;
  forceRefresh?: boolean;
  cacheTtlMinutes?: number;
  requestedByUserId?: string | null;
};

export type ImportHotelsResult = {
  source: "osm_overpass";
  usedCache: boolean;
  fetched: number;
  created: number;
  updated: number;
  skipped: number;
  invalid: number;
  runId: string | null;
};

type NormalizedOsmHotel = {
  osmType: "node" | "way" | "relation";
  osmId: number;
  name: string;
  normalizedName: string;
  address: string;
  city: string;
  zone: string;
  lat: number;
  lng: number;
  source: string;
  isActive: boolean;
};

const OVERPASS_ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
const DEFAULT_CACHE_TTL_MINUTES = 12 * 60;
const IMPORT_SOURCE = "osm_overpass";

function normalizeText(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\p{Letter}\p{Number}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function roundCoord(value: number) {
  return Math.round(value * 100000) / 100000;
}

function buildAddress(tags: Record<string, string>) {
  const street = [tags["addr:street"], tags["addr:housenumber"]].filter(Boolean).join(" ");
  const locality = tags["addr:city"] || tags["addr:town"] || tags["addr:village"] || tags["addr:place"];
  const postcode = tags["addr:postcode"];
  const full = tags["addr:full"];
  const parts = [street, locality, postcode].filter(Boolean);
  if (parts.length > 0) return parts.join(", ");
  if (full) return full;
  return "Ischia";
}

function inferZoneFromCoords(lat: number, lng: number) {
  let bestZone = "Ischia Porto";
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const [zone, centroid] of Object.entries(zoneCentroids)) {
    const dLat = lat - centroid.lat;
    const dLng = lng - centroid.lng;
    const distance = dLat * dLat + dLng * dLng;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestZone = zone;
    }
  }
  return bestZone;
}

function normalizeElement(element: OverpassElement): NormalizedOsmHotel | null {
  const tags = element.tags ?? {};
  const name = String(tags.name ?? "").trim();
  const latCandidate = element.lat ?? element.center?.lat;
  const lngCandidate = element.lon ?? element.center?.lon;
  if (!name) {
    return null;
  }

  const address = buildAddress(tags);
  const city = tags["addr:city"] || tags["addr:town"] || tags["addr:village"] || "Ischia";
  let lat = latCandidate;
  let lng = lngCandidate;
  const zoneByText = inferZoneFromText(`${name} ${address} ${city}`);

  if (typeof lat !== "number" || typeof lng !== "number" || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    const fallbackZone = zoneByText ?? "Ischia Porto";
    const centroid = zoneCentroids[fallbackZone];
    lat = centroid.lat;
    lng = centroid.lng;
  }

  const zone = zoneByText ?? inferZoneFromCoords(lat, lng);

  return {
    osmType: element.type,
    osmId: element.id,
    name,
    normalizedName: normalizeText(name),
    address,
    city,
    zone,
    lat,
    lng,
    source: IMPORT_SOURCE,
    isActive: true
  };
}

function buildOverpassQuery(mode: "area" | "bbox") {
  const tourismFilter = '["tourism"~"hotel|hostel|guest_house|apartment|motel|resort|chalet|bed_and_breakfast"]';
  const amenityFilter = '["amenity"~"hotel|guest_house|hostel"]';
  const buildingFilter = '["building"~"hotel|guest_house"]';
  if (mode === "bbox") {
    // Bounding box approximating Ischia island.
    const bbox = "(40.67,13.82,40.79,13.99)";
    return [
      "[out:json][timeout:60];",
      "(",
      `node${tourismFilter}${bbox};`,
      `way${tourismFilter}${bbox};`,
      `relation${tourismFilter}${bbox};`,
      `node${amenityFilter}${bbox};`,
      `way${amenityFilter}${bbox};`,
      `relation${amenityFilter}${bbox};`,
      `node${buildingFilter}${bbox};`,
      `way${buildingFilter}${bbox};`,
      `relation${buildingFilter}${bbox};`,
      ");",
      "out center tags;"
    ].join("\n");
  }
  return [
    "[out:json][timeout:60];",
    'area["name"="Ischia"]["place"="island"]->.searchArea;',
    "(",
    `node${tourismFilter}(area.searchArea);`,
    `way${tourismFilter}(area.searchArea);`,
    `relation${tourismFilter}(area.searchArea);`,
    `node${amenityFilter}(area.searchArea);`,
    `way${amenityFilter}(area.searchArea);`,
    `relation${amenityFilter}(area.searchArea);`,
    `node${buildingFilter}(area.searchArea);`,
    `way${buildingFilter}(area.searchArea);`,
    `relation${buildingFilter}(area.searchArea);`,
    ");",
    "out center tags;"
  ].join("\n");
}

async function fetchOverpassHotels(limit?: number) {
  let lastError: string | null = null;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    for (const mode of ["area", "bbox"] as const) {
      const query = buildOverpassQuery(mode);
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: query
        });
        if (!response.ok) {
          lastError = `Overpass API error (${response.status}) on ${endpoint}`;
          continue;
        }
        const data = (await response.json()) as { elements?: OverpassElement[] };
        const all = Array.isArray(data.elements) ? data.elements : [];
        if (all.length === 0 && mode === "area") {
          // Some Overpass instances fail to resolve this specific area alias.
          continue;
        }
        return typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? all.slice(0, limit) : all;
      } catch (error) {
        lastError = error instanceof Error ? error.message : "Overpass fetch failed";
      }
    }
  }

  throw new Error(lastError ?? "Overpass fetch failed");
}

async function startImportRun(
  admin: SupabaseAdminClient,
  tenantId: string,
  options: ImportHotelsOptions
) {
  const payload = {
    tenant_id: tenantId,
    source: IMPORT_SOURCE,
    dry_run: options.dryRun ?? false,
    limit_applied: options.limit ?? null,
    force_refresh: options.forceRefresh ?? false,
    requested_by_user_id: options.requestedByUserId ?? null,
    status: "running",
    started_at: new Date().toISOString()
  };
  const { data, error } = await admin.from("hotel_import_runs").insert(payload).select("id").maybeSingle();
  if (error || !data?.id) return null;
  return String(data.id);
}

async function completeImportRun(
  admin: SupabaseAdminClient,
  runId: string | null,
  input: {
    status: "success" | "error";
    usedCache?: boolean;
    fetched?: number;
    created?: number;
    updated?: number;
    skipped?: number;
    invalid?: number;
    errorMessage?: string | null;
    payloadElements?: OverpassElement[] | null;
  }
) {
  if (!runId) return;
  const payload = {
    status: input.status,
    used_cache: input.usedCache ?? false,
    fetched_count: input.fetched ?? 0,
    created_count: input.created ?? 0,
    updated_count: input.updated ?? 0,
    skipped_count: input.skipped ?? 0,
    invalid_count: input.invalid ?? 0,
    error_message: input.errorMessage ?? null,
    payload_json: input.payloadElements ? { elements: input.payloadElements } : null,
    completed_at: new Date().toISOString()
  };
  await admin.from("hotel_import_runs").update(payload).eq("id", runId);
}

async function readCachedElements(
  admin: SupabaseAdminClient,
  tenantId: string,
  cacheTtlMinutes: number
): Promise<OverpassElement[] | null> {
  const { data, error } = await admin
    .from("hotel_import_runs")
    .select("completed_at,payload_json")
    .eq("tenant_id", tenantId)
    .eq("source", IMPORT_SOURCE)
    .eq("status", "success")
    .eq("dry_run", false)
    .not("payload_json", "is", null)
    .order("completed_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data?.completed_at || !data?.payload_json) return null;

  const completedAt = new Date(data.completed_at).getTime();
  if (!Number.isFinite(completedAt)) return null;
  const ageMs = Date.now() - completedAt;
  if (ageMs > cacheTtlMinutes * 60 * 1000) return null;

  const payload = data.payload_json as { elements?: OverpassElement[] };
  return Array.isArray(payload.elements) ? payload.elements : null;
}

export async function importHotelsFromOsmForTenant(
  admin: SupabaseAdminClient,
  tenantId: string,
  options: ImportHotelsOptions = {}
): Promise<ImportHotelsResult> {
  const cacheTtlMinutes =
    typeof options.cacheTtlMinutes === "number" && Number.isFinite(options.cacheTtlMinutes) && options.cacheTtlMinutes > 0
      ? options.cacheTtlMinutes
      : DEFAULT_CACHE_TTL_MINUTES;
  let runId: string | null = null;
  try {
    runId = await startImportRun(admin, tenantId, options);
  } catch {
    runId = null;
  }

  try {
    let usedCache = false;
    let fetchedElements: OverpassElement[] = [];

    if (!options.forceRefresh) {
      const cached = await readCachedElements(admin, tenantId, cacheTtlMinutes).catch(() => null);
      if (cached) {
        fetchedElements = cached;
        usedCache = true;
      }
    }

    if (fetchedElements.length === 0) {
      fetchedElements = await fetchOverpassHotels(options.limit);
    }

    const normalizedRows = fetchedElements.map(normalizeElement);
    const validRows = normalizedRows.filter((item): item is NormalizedOsmHotel => Boolean(item));
    const invalid = normalizedRows.length - validRows.length;

    const { data: existing, error: existingError } = await admin
      .from("hotels")
      .select("id,name,normalized_name,address,city,zone,lat,lng,source,source_osm_type,source_osm_id,is_active")
      .eq("tenant_id", tenantId);
    if (existingError) {
      throw new Error(existingError.message);
    }

    const existingBySource = new Map<string, { id: string }>();
    const existingByNameCoords = new Map<string, { id: string }>();
    const existingById = new Map<
      string,
      {
        name: string;
        normalized_name: string | null;
        address: string | null;
        city: string | null;
        zone: string | null;
        lat: number | null;
        lng: number | null;
        source: string | null;
        source_osm_type: string | null;
        source_osm_id: number | null;
        is_active: boolean | null;
      }
    >();
    for (const row of (existing ?? []) as Array<{
      id: string;
      name: string;
      normalized_name: string | null;
      address: string | null;
      city: string | null;
      zone: string | null;
      lat: number | null;
      lng: number | null;
      source: string | null;
      source_osm_type: string | null;
      source_osm_id: number | null;
      is_active: boolean | null;
    }>) {
      existingById.set(row.id, row);
      if (row.source_osm_id != null && row.source_osm_type) {
        existingBySource.set(`${row.source_osm_type}:${row.source_osm_id}`, { id: row.id });
      }
      if (row.normalized_name && typeof row.lat === "number" && typeof row.lng === "number") {
        const key = `${row.normalized_name}|${roundCoord(row.lat)}|${roundCoord(row.lng)}`;
        existingByNameCoords.set(key, { id: row.id });
      }
    }

    const seenSource = new Set<string>();
    const dedupedRows: NormalizedOsmHotel[] = [];
    for (const row of validRows) {
      const key = `${row.osmType}:${row.osmId}`;
      if (seenSource.has(key)) continue;
      seenSource.add(key);
      dedupedRows.push(row);
    }

    let created = 0;
    let updated = 0;
    let skipped = validRows.length - dedupedRows.length;

    for (const row of dedupedRows) {
      const sourceKey = `${row.osmType}:${row.osmId}`;
      const nameCoordKey = `${row.normalizedName}|${roundCoord(row.lat)}|${roundCoord(row.lng)}`;
      const matched = existingBySource.get(sourceKey) ?? existingByNameCoords.get(nameCoordKey);
      const payload = {
        tenant_id: tenantId,
        name: row.name,
        normalized_name: row.normalizedName,
        address: row.address,
        city: row.city,
        zone: row.zone,
        lat: row.lat,
        lng: row.lng,
        source: row.source,
        source_osm_type: row.osmType,
        source_osm_id: row.osmId,
        is_active: row.isActive,
        updated_at: new Date().toISOString()
      };

      if (!matched) {
        if (!options.dryRun) {
          const { data: inserted, error } = await admin.from("hotels").insert(payload).select("id").maybeSingle();
          if (error) {
            skipped += 1;
            continue;
          }
          if (inserted?.id) {
            existingBySource.set(sourceKey, { id: inserted.id });
            existingByNameCoords.set(nameCoordKey, { id: inserted.id });
          }
        }
        created += 1;
        continue;
      }

      const current = existingById.get(matched.id);
      if (
        current &&
        current.name === payload.name &&
        current.normalized_name === payload.normalized_name &&
        current.address === payload.address &&
        current.city === payload.city &&
        current.zone === payload.zone &&
        current.lat === payload.lat &&
        current.lng === payload.lng &&
        current.source === payload.source &&
        current.source_osm_type === payload.source_osm_type &&
        current.source_osm_id === payload.source_osm_id &&
        current.is_active === payload.is_active
      ) {
        skipped += 1;
        continue;
      }

      if (!options.dryRun) {
        const { error } = await admin
          .from("hotels")
          .update(payload)
          .eq("id", matched.id)
          .eq("tenant_id", tenantId);
        if (error) {
          skipped += 1;
          continue;
        }
      }
      updated += 1;
    }

    const result: ImportHotelsResult = {
      source: "osm_overpass",
      usedCache,
      fetched: fetchedElements.length,
      created,
      updated,
      skipped,
      invalid,
      runId
    };

    await completeImportRun(admin, runId, {
      status: "success",
      usedCache,
      fetched: result.fetched,
      created: result.created,
      updated: result.updated,
      skipped: result.skipped,
      invalid: result.invalid,
      payloadElements: usedCache ? null : fetchedElements
    }).catch(() => undefined);

    return result;
  } catch (error) {
    await completeImportRun(admin, runId, {
      status: "error",
      errorMessage: error instanceof Error ? error.message : "Unknown error"
    }).catch(() => undefined);
    throw error;
  }
}
