"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import L from "leaflet";
import { HotelGeoBadge } from "@/components/hotel-geo-badge";
import { evaluateHotelGeo, HOTEL_ZONES, hotelGeoQuality, inferZoneFromText, isIncompleteHotelAddress, isMissingCoordinates, zoneCentroids } from "@/lib/hotel-geocoding";
import type { HotelGeoAccuracy, HotelGeoSource, HotelGeoStatus } from "@/lib/types";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";

interface HotelListItem {
  id: string;
  name: string;
  zone: string;
  address: string;
  city: string | null;
  lat: number | null;
  lng: number | null;
  small_vehicle_only: boolean;
  small_vehicle_max_pax: number | null;
  source: string | null;
  source_osm_type: "node" | "way" | "relation" | null;
  source_osm_id: number | null;
  is_active: boolean;
  email: string | null;
  phone: string | null;
  contact_name: string | null;
  geo_status: HotelGeoStatus;
  geo_source: HotelGeoSource;
  geo_accuracy: HotelGeoAccuracy;
  geo_verified_at: string | null;
  geo_verified_by: string | null;
  geo_notes: string | null;
  place_id: string | null;
  formatted_address: string | null;
}

interface HotelAlias {
  id: string;
  hotel_id: string;
  alias: string;
}

type HotelMergeCandidate = {
  key: string;
  primaryId: string;
  primaryName: string;
  primaryZone: string;
  primaryCity: string | null;
  primaryUsage: number;
  secondaryId: string;
  secondaryName: string;
  secondaryZone: string;
  secondaryCity: string | null;
  secondaryUsage: number;
  score: number;
  reason: string;
};

type HotelEditDraft = {
  name: string;
  address: string;
  city: string;
  zone: string;
  lat: string;
  lng: string;
  small_vehicle_only: boolean;
  small_vehicle_max_pax: string;
  is_active: boolean;
  email: string;
  phone: string;
  contact_name: string;
};

type HotelListFilter = "all" | "corrections" | "verified" | "missing" | "inactive";

type GeoCorrectionDraft = {
  hotel: HotelListItem;
  query: string;
  lat: string;
  lng: string;
  formatted_address: string;
  notes: string;
  startedFromGenericCoords: boolean;
  autoLookupDone: boolean;
  suggestionLabel: string | null;
};

const PAGE_SIZE = 20;
const HOTEL_SELECT_FIELDS =
  "id,name,zone,address,city,lat,lng,small_vehicle_only,small_vehicle_max_pax,source,source_osm_type,source_osm_id,is_active,email,phone,contact_name,geo_status,geo_source,geo_accuracy,geo_verified_at,geo_verified_by,geo_notes,place_id,formatted_address";

function toEditDraft(hotel: HotelListItem): HotelEditDraft {
  return {
    name: hotel.name,
    address: hotel.address,
    city: hotel.city ?? "Ischia",
    zone: hotel.zone ?? "Ischia Porto",
    lat: hotel.lat == null ? "" : String(hotel.lat),
    lng: hotel.lng == null ? "" : String(hotel.lng),
    small_vehicle_only: hotel.small_vehicle_only ?? false,
    small_vehicle_max_pax: hotel.small_vehicle_max_pax == null ? "" : String(hotel.small_vehicle_max_pax),
    is_active: hotel.is_active,
    email: hotel.email ?? "",
    phone: hotel.phone ?? "",
    contact_name: hotel.contact_name ?? "",
  };
}

function formatCoord(value: number | null) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(5) : "N/D";
}

function parseOptionalCoord(value: string) {
  const trimmed = value.trim().replace(",", ".");
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : "invalid";
}

function matchesHotelSearch(hotel: HotelListItem, term: string) {
  const q = term.trim().toLowerCase();
  if (!q) return true;
  return [hotel.name, hotel.address, hotel.city, hotel.zone]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(q));
}

function normalizeMergeName(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/['".,]/g, " ")
    .replace(/\b(?:hotel|albergo|terme|resort|spa|club|grand|parco|exclusive|boutique|relax)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreMergeCandidate(leftName: string, rightName: string) {
  const left = normalizeMergeName(leftName);
  const right = normalizeMergeName(rightName);
  if (!left || !right) return 0;
  if (left === right) return 100;
  if (left.length >= 5 && right.length >= 5 && (left.includes(right) || right.includes(left))) return 94;
  const leftTokens = left.split(" ").filter(Boolean);
  const rightTokens = new Set(right.split(" ").filter(Boolean));
  const shared = leftTokens.filter((token) => rightTokens.has(token));
  if (shared.length === 0) return 0;
  return Math.round((shared.length / Math.max(leftTokens.length, 1)) * 88);
}

function GeoCorrectionMap({
  lat,
  lng,
  onChange
}: {
  lat: number;
  lng: number;
  onChange: (coords: { lat: number; lng: number }) => void;
}) {
  const mapId = "hotel-geo-correction-map";

  useEffect(() => {
    const element = document.getElementById(mapId);
    if (!element) return;

    const correctionPin = L.divIcon({
      className: "",
      html: `
        <div style="
          width:34px;
          height:34px;
          transform:translate(-17px,-34px);
          filter:drop-shadow(0 10px 12px rgba(15,23,42,0.28));
          position:relative;
        ">
          <div style="
            width:34px;
            height:34px;
            border-radius:18px 18px 18px 4px;
            transform:rotate(-45deg);
            background:#0f172a;
            border:3px solid #ffffff;
            box-shadow:0 0 0 2px rgba(14,165,233,0.55);
          "></div>
          <div style="
            position:absolute;
            left:9px;
            top:9px;
            width:16px;
            height:16px;
            border-radius:999px;
            background:#38bdf8;
            border:3px solid #ffffff;
          "></div>
        </div>
      `,
      iconSize: [34, 34],
      iconAnchor: [0, 0]
    });

    const map = L.map(element, { zoomControl: true }).setView([lat, lng], 17);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors",
      maxZoom: 19
    }).addTo(map);

    const marker = L.marker([lat, lng], { draggable: true, icon: correctionPin, zIndexOffset: 1000 }).addTo(map);
    marker.on("dragend", () => {
      const position = marker.getLatLng();
      onChange({ lat: position.lat, lng: position.lng });
    });

    setTimeout(() => map.invalidateSize(), 120);

    return () => {
      map.off();
      map.remove();
    };
  }, [lat, lng, onChange]);

  return <div id={mapId} className="h-[320px] w-full rounded-xl border border-slate-200 bg-slate-100" />;
}

export default function HotelsPage() {
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<HotelListItem[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [initializing, setInitializing] = useState(true);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [importing, setImporting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<HotelEditDraft | null>(null);
  const [aliases, setAliases] = useState<HotelAlias[]>([]);
  const [allHotelsForMerge, setAllHotelsForMerge] = useState<HotelListItem[]>([]);
  const [serviceUsageByHotelId, setServiceUsageByHotelId] = useState<Record<string, number>>({});
  const [dismissedMergeKeys, setDismissedMergeKeys] = useState<string[]>([]);
  const mergeStorageKey = tenantId ? `hotel_dismissed_merges_${tenantId}` : null;
  const [showAdminTools, setShowAdminTools] = useState(false);
  const [geocoding, setGeocoding] = useState(false);
  const [aliasHotelId, setAliasHotelId] = useState("");
  const [aliasValue, setAliasValue] = useState("");
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [listFilter, setListFilter] = useState<HotelListFilter>("corrections");
  const [geoCorrection, setGeoCorrection] = useState<GeoCorrectionDraft | null>(null);
  const [geoSearching, setGeoSearching] = useState(false);
  const [createDraft, setCreateDraft] = useState<HotelEditDraft>({
    name: "", address: "", city: "Ischia", zone: "Ischia Porto", lat: "", lng: "", small_vehicle_only: false, small_vehicle_max_pax: "", is_active: true, email: "", phone: "", contact_name: ""
  });

  const loadHotels = useCallback(
    async (currentTenantId: string, termInput: string, offset: number, append: boolean) => {
      if (!supabase) return;
      const nextLimit = offset + PAGE_SIZE - 1;
      const term = termInput.trim().replaceAll(",", " ");

      append ? setLoadingMore(true) : setLoading(true);
      setError("");

      let query = supabase
        .from("hotels")
        .select(HOTEL_SELECT_FIELDS, { count: "exact" })
        .eq("tenant_id", currentTenantId)
        .order("name", { ascending: true })
        .range(offset, nextLimit);

      if (term) {
        const words = term.split(/\s+/).filter(Boolean);
        for (const word of words) {
          query = query.or(`name.ilike.%${word}%,zone.ilike.%${word}%,address.ilike.%${word}%,city.ilike.%${word}%`);
        }
      }

      const { data, count, error: queryError } = await query;
      if (queryError) {
        setError(queryError.message);
        append ? setLoadingMore(false) : setLoading(false);
        return;
      }

      const nextItems = (data ?? []) as HotelListItem[];
      setItems((prev) => (append ? [...prev, ...nextItems] : nextItems));
      setTotalCount(count ?? 0);
      append ? setLoadingMore(false) : setLoading(false);
    },
    []
  );

  const loadAliases = useCallback(async (currentTenantId: string) => {
    if (!supabase) return;
    const { data, error: aliasError } = await supabase
      .from("hotel_aliases")
      .select("id,hotel_id,alias")
      .eq("tenant_id", currentTenantId)
      .order("alias", { ascending: true })
      .limit(3000);
    if (aliasError) return;
    setAliases((data ?? []) as HotelAlias[]);
  }, []);

  const loadMergeContext = useCallback(async (currentTenantId: string) => {
    if (!supabase) return;
    const [{ data: allHotels, error: hotelsError }, { data: services, error: servicesError }] = await Promise.all([
      supabase
        .from("hotels")
        .select(HOTEL_SELECT_FIELDS)
        .eq("tenant_id", currentTenantId)
        .order("name", { ascending: true }),
      supabase
        .from("services")
        .select("hotel_id")
        .eq("tenant_id", currentTenantId)
    ]);

    if (!hotelsError) {
      setAllHotelsForMerge((allHotels ?? []) as HotelListItem[]);
    }
    if (!servicesError) {
      const usage = ((services ?? []) as Array<{ hotel_id: string | null }>).reduce<Record<string, number>>((acc, row) => {
        if (!row.hotel_id) return acc;
        acc[row.hotel_id] = (acc[row.hotel_id] ?? 0) + 1;
        return acc;
      }, {});
      setServiceUsageByHotelId(usage);
    }
  }, []);

  useEffect(() => {
    let isActive = true;

    const loadTenant = async () => {
      if (!hasSupabaseEnv || !supabase) {
        if (isActive) {
          setError("Supabase non configurato.");
          setInitializing(false);
        }
        return;
      }

      const { data: userData, error: userError } = await supabase.auth.getUser();
      if (userError || !userData.user) {
        if (isActive) {
          setError("Utente non autenticato.");
          setInitializing(false);
        }
        return;
      }

      const { data: membership, error: membershipError } = await supabase
        .from("memberships")
        .select("tenant_id, role")
        .eq("user_id", userData.user.id)
        .maybeSingle();

      if (membershipError || !membership?.tenant_id) {
        if (isActive) {
          setError("Tenant non trovato per l'utente corrente.");
          setInitializing(false);
        }
        return;
      }

      if (!isActive) return;
      setTenantId(membership.tenant_id);
      setRole(membership.role);
      setInitializing(false);
      await Promise.all([loadHotels(membership.tenant_id, "", 0, false), loadAliases(membership.tenant_id), loadMergeContext(membership.tenant_id)]);
    };

    void loadTenant();
    return () => {
      isActive = false;
    };
  }, [loadAliases, loadHotels, loadMergeContext]);

  useEffect(() => {
    if (!mergeStorageKey) return;
    try {
      const stored = localStorage.getItem(mergeStorageKey);
      if (stored) setDismissedMergeKeys(JSON.parse(stored) as string[]);
    } catch { /* ignore */ }
  }, [mergeStorageKey]);

  const hasMore = listFilter === "all" && items.length < totalCount;
  const canManageHotels = role === "admin" || role === "operator" || role === "supervisor";
  const filteredItems = useMemo(() => {
    const base = listFilter === "all" ? items : allHotelsForMerge;
    return base.filter((hotel) => {
      if (!matchesHotelSearch(hotel, search)) return false;
      const geo = evaluateHotelGeo(hotel);
      if (listFilter === "corrections") return geo.status === "generic" || geo.status === "approximate" || geo.status === "missing";
      if (listFilter === "verified") return geo.status === "verified";
      if (listFilter === "missing") return geo.status === "missing";
      if (listFilter === "inactive") return !hotel.is_active;
      return true;
    });
  }, [allHotelsForMerge, items, listFilter, search]);
  const groupedItems = useMemo(() => {
    const groups = new Map<string, HotelListItem[]>();
    for (const hotel of filteredItems) {
      const key = hotel.zone || "N/D";
      const bucket = groups.get(key) ?? [];
      bucket.push(hotel);
      groups.set(key, bucket);
    }
    return Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [filteredItems]);

  const metricsHotels = allHotelsForMerge.length > 0 ? allHotelsForMerge : items;
  const missingCoordsCount = metricsHotels.filter((hotel) => isMissingCoordinates(hotel.lat, hotel.lng)).length;
  const incompleteAddressCount = metricsHotels.filter((hotel) => isIncompleteHotelAddress(hotel.address)).length;
  const smallVehicleOnlyCount = metricsHotels.filter((hotel) => hotel.small_vehicle_only).length;
  const geoQualityByHotelId = useMemo(() => {
    const map = new Map<string, ReturnType<typeof hotelGeoQuality>>();
    for (const hotel of allHotelsForMerge) {
      map.set(hotel.id, hotelGeoQuality(hotel));
    }
    return map;
  }, [allHotelsForMerge]);
  const geoEvaluationByHotelId = useMemo(() => {
    const map = new Map<string, ReturnType<typeof evaluateHotelGeo>>();
    for (const hotel of allHotelsForMerge) {
      map.set(hotel.id, evaluateHotelGeo(hotel));
    }
    return map;
  }, [allHotelsForMerge]);
  const geoMissingCount = metricsHotels.filter((hotel) => (geoEvaluationByHotelId.get(hotel.id) ?? evaluateHotelGeo(hotel)).status === "missing").length;
  const geoVerifiedCount = metricsHotels.filter((hotel) => (geoEvaluationByHotelId.get(hotel.id) ?? evaluateHotelGeo(hotel)).status === "verified").length;
  const geoToFixCount = metricsHotels.filter((hotel) => {
    const status = (geoEvaluationByHotelId.get(hotel.id) ?? evaluateHotelGeo(hotel)).status;
    return status === "missing" || status === "generic" || status === "approximate";
  }).length;
  const geoWarningCount = metricsHotels.filter((hotel) => (geoEvaluationByHotelId.get(hotel.id) ?? evaluateHotelGeo(hotel)).status === "approximate").length;
  const geoIssueLabels: Record<string, string> = {
    missing_coordinates: "coordinate mancanti",
    outside_ischia: "fuori isola",
    default_centroid: "coordinate generiche",
    zone_coordinate_mismatch: "zona non coerente",
    incomplete_address: "indirizzo incompleto"
  };
  const aliasByHotel = useMemo(() => {
    const map = new Map<string, HotelAlias[]>();
    for (const row of aliases) {
      const bucket = map.get(row.hotel_id) ?? [];
      bucket.push(row);
      map.set(row.hotel_id, bucket);
    }
    return map;
  }, [aliases]);

  const mergeCandidates = useMemo(() => {
    const activeHotels = allHotelsForMerge.filter((hotel) => hotel.is_active);
    const candidates: HotelMergeCandidate[] = [];

    for (let index = 0; index < activeHotels.length; index += 1) {
      const left = activeHotels[index];
      for (let inner = index + 1; inner < activeHotels.length; inner += 1) {
        const right = activeHotels[inner];
        const sameZone = (left.zone || "").trim().toLowerCase() === (right.zone || "").trim().toLowerCase();
        const sameCity = (left.city || "").trim().toLowerCase() === (right.city || "").trim().toLowerCase();
        if (!sameZone && !sameCity) continue;

        const score = scoreMergeCandidate(left.name, right.name);
        if (score < 88) continue;

        const leftUsage = serviceUsageByHotelId[left.id] ?? 0;
        const rightUsage = serviceUsageByHotelId[right.id] ?? 0;
        const keepLeft =
          leftUsage > rightUsage ||
          (leftUsage === rightUsage && left.address.length >= right.address.length);
        const primary = keepLeft ? left : right;
        const secondary = keepLeft ? right : left;
        const key = [primary.id, secondary.id].sort().join(":");
        if (dismissedMergeKeys.includes(key)) continue;

        candidates.push({
          key,
          primaryId: primary.id,
          primaryName: primary.name,
          primaryZone: primary.zone,
          primaryCity: primary.city,
          primaryUsage: serviceUsageByHotelId[primary.id] ?? 0,
          secondaryId: secondary.id,
          secondaryName: secondary.name,
          secondaryZone: secondary.zone,
          secondaryCity: secondary.city,
          secondaryUsage: serviceUsageByHotelId[secondary.id] ?? 0,
          score,
          reason: score >= 98 ? "Nome praticamente identico" : "Nome molto simile nella stessa zona"
        });
      }
    }

    return candidates
      .sort((left, right) => right.score - left.score || right.primaryUsage + right.secondaryUsage - (left.primaryUsage + left.secondaryUsage))
      .slice(0, 12);
  }, [allHotelsForMerge, dismissedMergeKeys, serviceUsageByHotelId]);

  const applyAutoFillMissingCoords = async () => {
    if (!tenantId || !supabase) return;
    setImporting(true);
    setMessage("");
    setError("");

    const { data, error: fetchError } = await supabase
      .from("hotels")
      .select("id,name,address,zone,lat,lng")
      .eq("tenant_id", tenantId);

    if (fetchError) {
      setImporting(false);
      setError(fetchError.message);
      return;
    }

    const rows = (data ?? []) as Array<{
      id: string;
      name: string;
      address: string;
      zone: string | null;
      lat: number | null;
      lng: number | null;
    }>;

    const updates = rows
      .filter((hotel) => !hotel.zone || isMissingCoordinates(hotel.lat, hotel.lng))
      .map((hotel) => {
        const inferredZone = inferZoneFromText(`${hotel.name} ${hotel.address}`);
        const nextZone = (hotel.zone || inferredZone || "Ischia Porto") as keyof typeof zoneCentroids;
        return {
          id: hotel.id,
          zone: nextZone,
          lat: isMissingCoordinates(hotel.lat, hotel.lng) ? null : hotel.lat,
          lng: isMissingCoordinates(hotel.lat, hotel.lng) ? null : hotel.lng
        };
      });

    if (updates.length === 0) {
      setImporting(false);
      setMessage("Nessun hotel da aggiornare.");
      return;
    }

    let updated = 0;
    for (const row of updates) {
      const { error: updateError } = await supabase
        .from("hotels")
        .update({
          zone: row.zone,
          lat: row.lat,
          lng: row.lng,
          geo_status: row.lat == null || row.lng == null ? "missing" : "approximate",
          geo_source: "unknown",
          geo_accuracy: row.lat == null || row.lng == null ? "unknown" : "street",
          updated_at: new Date().toISOString()
        })
        .eq("id", row.id)
        .eq("tenant_id", tenantId);
      if (!updateError) updated += 1;
    }

    await Promise.all([loadHotels(tenantId, search, 0, false), loadMergeContext(tenantId)]);
    setImporting(false);
    setMessage(`Aggiornati ${updated} hotel. Coordinate mancanti lasciate da geocodificare, senza punti finti.`);
  };

  const geocodeHotels = async (force: boolean) => {
    if (!tenantId || !supabase) return;
    setGeocoding(true);
    setMessage("");
    setError("");
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) { setError("Sessione non valida. Rifai login."); setGeocoding(false); return; }

      const response = await fetch("/api/admin/geocode-hotels", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ force })
      });

      const payload = await response.json().catch(() => null) as { ok?: boolean; error?: string; report?: { total: number; updated: number; failed: number; skipped: number } } | null;
      if (!response.ok || !payload?.ok) {
        setError(payload?.error ?? "Geocoding non riuscito.");
        setGeocoding(false);
        return;
      }
      const r = payload.report!;
      setMessage(`Geocoding completato. Processati: ${r.total}, aggiornati: ${r.updated}, falliti: ${r.failed}, saltati (indirizzo incompleto): ${r.skipped}.`);
      await Promise.all([loadHotels(tenantId, search, 0, false), loadMergeContext(tenantId)]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Errore geocoding.");
    } finally {
      setGeocoding(false);
    }
  };

  const triggerOverpassImport = async () => {
    if (!supabase || !tenantId) return;
    setImporting(true);
    setMessage("");
    setError("");
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) {
        setError("Sessione non valida. Rifai login.");
        setImporting(false);
        return;
      }

      const response = await fetch("/api/admin/import-hotels-ischia", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`
        },
        body: JSON.stringify({})
      });

      const payload = (await response.json().catch(() => null)) as
        | {
            ok?: boolean;
            error?: string;
            report?: { created: number; updated: number; skipped: number; invalid: number; fetched: number };
          }
        | null;
      if (!response.ok || !payload?.ok || !payload.report) {
        setError(payload?.error ?? "Import OSM non riuscito.");
        setImporting(false);
        return;
      }

      const report = payload.report;
      setMessage(
        `Import OSM completato. Trovati: ${report.fetched}, creati: ${report.created}, aggiornati: ${report.updated}, saltati: ${report.skipped}, invalidi: ${report.invalid}.`
      );
      await Promise.all([loadHotels(tenantId, search, 0, false), loadAliases(tenantId), loadMergeContext(tenantId)]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Errore import OSM.");
    } finally {
      setImporting(false);
    }
  };

  const parseCsv = (raw: string) => {
    const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
    if (lines.length < 2) return [];
    const headers = lines[0].split(",").map((item) => item.trim().toLowerCase());
    return lines.slice(1).map((line) => {
      const cols = line.split(",").map((item) => item.trim());
      const get = (name: string) => {
        const index = headers.indexOf(name);
        return index >= 0 ? cols[index] ?? "" : "";
      };
      return {
        id: get("id"),
        name: get("name"),
        address: get("address"),
        zone: get("zone"),
        lat: get("lat"),
        lng: get("lng")
      };
    });
  };

  const handleCsvUpload = async (file: File) => {
    if (!tenantId || !supabase) return;
    setImporting(true);
    setMessage("");
    setError("");

    const csvText = await file.text();
    const rows = parseCsv(csvText);
    if (rows.length === 0) {
      setImporting(false);
      setError("CSV vuoto o formato non valido.");
      return;
    }

    const { data: allHotelsData, error: allHotelsError } = await supabase
      .from("hotels")
      .select("id,name,address,zone,lat,lng")
      .eq("tenant_id", tenantId);

    if (allHotelsError) {
      setImporting(false);
      setError(allHotelsError.message);
      return;
    }

    const allHotels = (allHotelsData ?? []) as Array<{
      id: string;
      name: string;
      address: string;
      zone: string;
      lat: number | null;
      lng: number | null;
    }>;

    const indexedById = new Map(allHotels.map((hotel) => [hotel.id, hotel]));
    const indexedByName = new Map(allHotels.map((hotel) => [hotel.name.toLowerCase(), hotel]));

    let updated = 0;
    let skipped = 0;

    for (const row of rows) {
      const target = (row.id && indexedById.get(row.id)) || indexedByName.get(row.name.toLowerCase());
      if (!target) {
        skipped += 1;
        continue;
      }

      const parsedLat = row.lat ? Number(row.lat) : null;
      const parsedLng = row.lng ? Number(row.lng) : null;
      const inferredZone = inferZoneFromText(`${row.zone} ${row.address} ${row.name}`);
      const nextZone = row.zone || inferredZone || target.zone || "Ischia Porto";
      const payload = {
        zone: nextZone,
        address: row.address || target.address,
        lat: Number.isFinite(parsedLat) ? Number(parsedLat) : isMissingCoordinates(target.lat, target.lng) ? null : target.lat,
        lng: Number.isFinite(parsedLng) ? Number(parsedLng) : isMissingCoordinates(target.lat, target.lng) ? null : target.lng,
        geo_source: "import" as const,
        geo_accuracy: Number.isFinite(parsedLat) && Number.isFinite(parsedLng) ? "street" as const : "unknown" as const,
        updated_at: new Date().toISOString()
      };
      const evaluation = evaluateHotelGeo({
        address: payload.address,
        zone: payload.zone,
        lat: payload.lat,
        lng: payload.lng,
        geo_source: payload.geo_source,
        geo_accuracy: payload.geo_accuracy
      });
      const updatePayload = { ...payload, geo_status: evaluation.status };

      const { error: updateError } = await supabase
        .from("hotels")
        .update(updatePayload)
        .eq("id", target.id)
        .eq("tenant_id", tenantId);

      if (updateError) {
        skipped += 1;
      } else {
        updated += 1;
      }
    }

      await Promise.all([loadHotels(tenantId, search, 0, false), loadAliases(tenantId), loadMergeContext(tenantId)]);
    setImporting(false);
    setMessage(`Import CSV completato. Aggiornati: ${updated}. Saltati: ${skipped}.`);
  };

  const addAlias = async () => {
    if (!tenantId || !supabase || !aliasHotelId || !aliasValue.trim()) return;
    const alias = aliasValue.trim();
    const aliasNormalized = alias
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .replace(/[^\p{Letter}\p{Number}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!aliasNormalized) {
      setError("Alias non valido.");
      return;
    }
    const { error: insertError } = await supabase.from("hotel_aliases").insert({
      tenant_id: tenantId,
      hotel_id: aliasHotelId,
      alias,
      alias_normalized: aliasNormalized,
      source: "manual"
    });
    if (insertError) {
      setError(insertError.message);
      return;
    }
    setAliasValue("");
    setMessage("Alias salvato.");
    await Promise.all([loadAliases(tenantId), loadMergeContext(tenantId)]);
  };

  const removeAlias = async (id: string) => {
    if (!tenantId || !supabase) return;
    const { error: deleteError } = await supabase.from("hotel_aliases").delete().eq("id", id).eq("tenant_id", tenantId);
    if (deleteError) {
      setError(deleteError.message);
      return;
    }
    await Promise.all([loadAliases(tenantId), loadMergeContext(tenantId)]);
  };

  const mergeHotels = async (candidate: HotelMergeCandidate) => {
    if (!tenantId || !supabase) return;
    const keepLabel = `${candidate.primaryName}`;
    const mergeLabel = `${candidate.secondaryName}`;
    if (!window.confirm(`Unificare "${mergeLabel}" dentro "${keepLabel}"?\n\nI servizi collegati verranno spostati sull'hotel mantenuto e il nome rimosso sarà salvato come alias.`)) {
      return;
    }

    setSaving(true);
    setError("");
    setMessage("");
    try {
      const existingAliases = aliases
        .filter((row) => row.hotel_id === candidate.primaryId)
        .map((row) => normalizeMergeName(row.alias));
      const secondaryAliases = aliases.filter((row) => row.hotel_id === candidate.secondaryId);
      const aliasPool = new Set(existingAliases);
      aliasPool.add(normalizeMergeName(candidate.primaryName));

      const aliasesToInsert = [
        candidate.secondaryName,
        ...secondaryAliases.map((row) => row.alias)
      ].filter((alias) => {
        const normalized = normalizeMergeName(alias);
        if (!normalized || aliasPool.has(normalized)) return false;
        aliasPool.add(normalized);
        return true;
      });

      if (aliasesToInsert.length > 0) {
        await supabase.from("hotel_aliases").insert(
          aliasesToInsert.map((alias) => ({
            tenant_id: tenantId,
            hotel_id: candidate.primaryId,
            alias,
            alias_normalized: normalizeMergeName(alias),
            source: "merge"
          }))
        );
      }

      await supabase.from("hotel_aliases").update({ hotel_id: candidate.primaryId }).eq("tenant_id", tenantId).eq("hotel_id", candidate.secondaryId);
      await supabase.from("services").update({ hotel_id: candidate.primaryId }).eq("tenant_id", tenantId).eq("hotel_id", candidate.secondaryId);

      const { error: deleteError } = await supabase.from("hotels").delete().eq("tenant_id", tenantId).eq("id", candidate.secondaryId);
      if (deleteError) {
        throw new Error(deleteError.message);
      }

      setDismissedMergeKeys((current) => {
        const next = current.filter((key) => key !== candidate.key);
        if (mergeStorageKey) {
          try { localStorage.setItem(mergeStorageKey, JSON.stringify(next)); } catch { /* ignore */ }
        }
        return next;
      });
      setMessage(`Merge completato: "${candidate.secondaryName}" unificato dentro "${candidate.primaryName}".`);
      await Promise.all([loadHotels(tenantId, search, 0, false), loadAliases(tenantId), loadMergeContext(tenantId)]);
    } catch (mergeError) {
      setError(mergeError instanceof Error ? mergeError.message : "Merge hotel non riuscito.");
    } finally {
      setSaving(false);
    }
  };

  const deleteHotel = async (hotelId: string, hotelName: string) => {
    if (!tenantId || !supabase) return;
    if (!window.confirm(`Eliminare "${hotelName}"? L'operazione non può essere annullata.`)) return;
    setSaving(true);
    setError("");
    const { error: deleteError } = await supabase.from("hotels").delete().eq("id", hotelId).eq("tenant_id", tenantId);
    setSaving(false);
    if (deleteError) {
      setError(deleteError.message);
      return;
    }
    setMessage(`Hotel "${hotelName}" eliminato.`);
    await Promise.all([loadHotels(tenantId, search, 0, false), loadMergeContext(tenantId)]);
  };

  const startEdit = (hotel: HotelListItem) => {
    setEditingId(hotel.id);
    setEditDraft(toEditDraft(hotel));
    setMessage("");
    setError("");
  };

  const openGeoCorrection = (hotel: HotelListItem) => {
    const geoEvaluation = evaluateHotelGeo(hotel);
    const fallbackZone = inferZoneFromText(`${hotel.zone ?? ""} ${hotel.city ?? ""} ${hotel.address ?? ""}`) ?? "Ischia Porto";
    const fallback = zoneCentroids[fallbackZone as keyof typeof zoneCentroids];
    const useFallback = geoEvaluation.status === "missing" || geoEvaluation.status === "generic";
    setGeoCorrection({
      hotel,
      query: [hotel.name, hotel.address, hotel.city || hotel.zone].filter(Boolean).join(", "),
      lat: String(useFallback ? fallback.lat : hotel.lat ?? fallback.lat),
      lng: String(useFallback ? fallback.lng : hotel.lng ?? fallback.lng),
      formatted_address: hotel.formatted_address ?? hotel.address,
      notes: hotel.geo_notes ?? "",
      startedFromGenericCoords: useFallback,
      autoLookupDone: !useFallback,
      suggestionLabel: null
    });
    setMessage("");
    setError("");
  };

  const searchGeoCorrectionAddress = useCallback(async (options?: { automatic?: boolean }) => {
    if (!geoCorrection) return;
    setGeoSearching(true);
    setError("");
    try {
      const { data: sessionData } = await supabase!.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) throw new Error("Sessione non valida. Rifai login.");

      const params = new URLSearchParams({
        q: geoCorrection.query,
        hotel_id: geoCorrection.hotel.id
      });
      const response = await fetch(`/api/admin/hotels/geo-lookup?${params.toString()}`, {
        headers: { authorization: `Bearer ${token}` }
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
        results?: Array<{ lat: number; lng: number; label: string }>;
      } | null;
      if (!response.ok || !payload?.ok) throw new Error(payload?.error ?? "Ricerca indirizzo non riuscita.");

      const first = payload.results?.[0];
      const lat = Number(first?.lat);
      const lng = Number(first?.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        setGeoCorrection((current) => current ? { ...current, autoLookupDone: true, suggestionLabel: null } : current);
        if (!options?.automatic) setError("Nessun risultato trovato sulla mappa. Puoi spostare il pin manualmente e salvare.");
        return;
      }
      setGeoCorrection((current) => current ? {
        ...current,
        lat: String(lat),
        lng: String(lng),
        formatted_address: first?.label ?? current.formatted_address,
        startedFromGenericCoords: false,
        autoLookupDone: true,
        suggestionLabel: first?.label ?? "Posizione suggerita dalla mappa"
      } : current);
    } catch (searchError) {
      setGeoCorrection((current) => current ? { ...current, autoLookupDone: true, suggestionLabel: null } : current);
      if (!options?.automatic) setError(searchError instanceof Error ? searchError.message : "Ricerca indirizzo non riuscita.");
    } finally {
      setGeoSearching(false);
    }
  }, [geoCorrection]);

  useEffect(() => {
    if (!geoCorrection || geoCorrection.autoLookupDone || !geoCorrection.startedFromGenericCoords || geoSearching) return;
    void searchGeoCorrectionAddress({ automatic: true });
  }, [geoCorrection, geoSearching, searchGeoCorrectionAddress]);

  const saveGeoCorrection = async () => {
    if (!tenantId || !supabase || !geoCorrection) return;
    const lat = Number(geoCorrection.lat.replace(",", "."));
    const lng = Number(geoCorrection.lng.replace(",", "."));
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      setError("Coordinate non valide.");
      return;
    }

    setSaving(true);
    setError("");
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) throw new Error("Sessione non valida. Rifai login.");

      const response = await fetch(`/api/admin/hotels/${geoCorrection.hotel.id}/verify-geo`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({
          lat,
          lng,
          formatted_address: geoCorrection.formatted_address,
          geo_notes: geoCorrection.notes
        })
      });
      const payload = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!response.ok || !payload?.ok) throw new Error(payload?.error ?? "Salvataggio geo non riuscito.");
      setGeoCorrection(null);
      setMessage("Posizione hotel verificata.");
      await Promise.all([loadHotels(tenantId, search, 0, false), loadMergeContext(tenantId)]);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Salvataggio geo non riuscito.");
    } finally {
      setSaving(false);
    }
  };

  const updateGeoCorrectionPin = useCallback((coords: { lat: number; lng: number }) => {
    setGeoCorrection((current) => current ? { ...current, lat: coords.lat.toFixed(7), lng: coords.lng.toFixed(7) } : current);
  }, []);

  const saveEdit = async (hotelId: string) => {
    if (!tenantId || !supabase || !editDraft) return;
    setSaving(true);
    setError("");

    const parsedLat = parseOptionalCoord(editDraft.lat);
    const parsedLng = parseOptionalCoord(editDraft.lng);
    const parsedSmallVehicleMaxPax = editDraft.small_vehicle_max_pax ? Number(editDraft.small_vehicle_max_pax) : null;
    if (parsedLat === "invalid" || parsedLng === "invalid") {
      setSaving(false);
      setError("Coordinate non valide. Puoi anche lasciarle vuote e salvare solo l'indirizzo.");
      return;
    }
    if (parsedSmallVehicleMaxPax !== null && (!Number.isFinite(parsedSmallVehicleMaxPax) || parsedSmallVehicleMaxPax < 1 || parsedSmallVehicleMaxPax > 60)) {
      setSaving(false);
      setError("Il limite posti del bus piccolo deve essere compreso tra 1 e 60.");
      return;
    }

    const payload = {
      name: editDraft.name.trim(),
      normalized_name: editDraft.name.trim().toLowerCase().replace(/\s+/g, " "),
      address: editDraft.address.trim(),
      city: editDraft.city.trim() || "Ischia",
      zone: editDraft.zone.trim() || "Ischia Porto",
      lat: parsedLat,
      lng: parsedLng,
      small_vehicle_only: editDraft.small_vehicle_only,
      small_vehicle_max_pax: editDraft.small_vehicle_only ? parsedSmallVehicleMaxPax : null,
      is_active: editDraft.is_active,
      email: editDraft.email.trim() || null,
      phone: editDraft.phone.trim() || null,
      contact_name: editDraft.contact_name.trim() || null,
      ...(() => {
        const nextGeoAccuracy: HotelGeoAccuracy = parsedLat == null || parsedLng == null ? "unknown" : "street";
        const evaluation = evaluateHotelGeo({
          address: editDraft.address.trim(),
          zone: editDraft.zone.trim() || "Ischia Porto",
          lat: parsedLat,
          lng: parsedLng,
          geo_status: "approximate",
          geo_source: "manual",
          geo_accuracy: nextGeoAccuracy
        });
        return {
          geo_status: evaluation.status,
          geo_source: "manual" as const,
          geo_accuracy: nextGeoAccuracy,
          geo_verified_at: null,
          geo_verified_by: null
        };
      })(),
      updated_at: new Date().toISOString()
    };

    if (!payload.name || !payload.address) {
      setSaving(false);
      setError("Nome e indirizzo sono obbligatori.");
      return;
    }

    const { error: updateError } = await supabase
      .from("hotels")
      .update(payload)
      .eq("id", hotelId)
      .eq("tenant_id", tenantId);

    setSaving(false);
    if (updateError) {
      setError(updateError.message);
      return;
    }

    setEditingId(null);
    setEditDraft(null);
    setMessage("Hotel aggiornato.");
    await Promise.all([loadHotels(tenantId, search, 0, false), loadMergeContext(tenantId)]);
  };

  const createHotel = async () => {
    if (!tenantId || !supabase) return;
    if (!createDraft.name.trim()) { setError("Il nome è obbligatorio."); return; }
    setSaving(true);
    setError("");
    const parsedLat = parseOptionalCoord(createDraft.lat);
    const parsedLng = parseOptionalCoord(createDraft.lng);
    const parsedSmallVehicleMaxPax = createDraft.small_vehicle_max_pax ? Number(createDraft.small_vehicle_max_pax) : null;
    const zone = createDraft.zone || "Ischia Porto";
    if (parsedLat === "invalid" || parsedLng === "invalid") {
      setSaving(false);
      setError("Coordinate non valide. Puoi lasciarle vuote e farle calcolare dal geocoding.");
      return;
    }
    if (parsedSmallVehicleMaxPax !== null && (!Number.isFinite(parsedSmallVehicleMaxPax) || parsedSmallVehicleMaxPax < 1 || parsedSmallVehicleMaxPax > 60)) {
      setSaving(false);
      setError("Il limite posti del bus piccolo deve essere compreso tra 1 e 60.");
      return;
    }
    const { error: insertError } = await supabase.from("hotels").insert({
      tenant_id: tenantId,
      name: createDraft.name.trim(),
      normalized_name: createDraft.name.trim().toLowerCase().replace(/\s+/g, " "),
      address: createDraft.address.trim() || "Ischia",
      city: createDraft.city.trim() || "Ischia",
      zone,
      lat: parsedLat,
      lng: parsedLng,
      small_vehicle_only: createDraft.small_vehicle_only,
      small_vehicle_max_pax: createDraft.small_vehicle_only ? parsedSmallVehicleMaxPax : null,
      is_active: createDraft.is_active,
      email: createDraft.email.trim() || null,
      phone: createDraft.phone.trim() || null,
      contact_name: createDraft.contact_name.trim() || null,
      source: "manual",
      ...(() => {
        const nextGeoAccuracy: HotelGeoAccuracy = parsedLat == null || parsedLng == null ? "unknown" : "street";
        const evaluation = evaluateHotelGeo({
          address: createDraft.address.trim() || "Ischia",
          zone,
          lat: parsedLat,
          lng: parsedLng,
          geo_source: "manual",
          geo_accuracy: nextGeoAccuracy
        });
        return {
          geo_status: evaluation.status,
          geo_source: "manual" as const,
          geo_accuracy: nextGeoAccuracy,
          formatted_address: createDraft.address.trim() || null
        };
      })()
    });
    setSaving(false);
    if (insertError) { setError(insertError.message); return; }
    setShowCreateForm(false);
    setCreateDraft({ name: "", address: "", city: "Ischia", zone: "Ischia Porto", lat: "", lng: "", small_vehicle_only: false, small_vehicle_max_pax: "", is_active: true, email: "", phone: "", contact_name: "" });
    setMessage(`Hotel "${createDraft.name.trim()}" creato.`);
    await Promise.all([loadHotels(tenantId, search, 0, false), loadMergeContext(tenantId)]);
  };

  return (
    <section className="space-y-4">
      <article className="card space-y-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold">Hotel</h1>
            <p className="max-w-3xl text-sm text-slate-600">
              Anagrafica hotel pulita e progressiva: se un nome non esiste durante import email, PDF o Excel il sistema lo crea, poi qui lo ripulisci, lo unifichi e gli insegni i riconoscimenti futuri tramite alias e merge.
            </p>
          </div>
          <label className="min-w-[240px] flex-1 text-sm md:max-w-sm">
            Cerca
            <input
              value={search}
              onChange={(event) => {
                const nextSearch = event.target.value;
                setSearch(nextSearch);
                if (tenantId && listFilter === "all") void loadHotels(tenantId, nextSearch, 0, false);
              }}
              placeholder="Nome, zona, indirizzo"
              className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2.5"
            />
          </label>
        </div>

        <div className="grid gap-3 md:grid-cols-4">
          <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Hotel registrati</p>
            <p className="mt-2 text-3xl font-semibold text-slate-900">{totalCount}</p>
            <p className="mt-1 text-sm text-slate-500">Master list unica del tenant.</p>
          </div>
          <div className="rounded-2xl border border-amber-200 bg-amber-50/70 px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-amber-700">Dati da completare</p>
            <p className="mt-2 text-3xl font-semibold text-amber-900">{missingCoordsCount + incompleteAddressCount}</p>
            <p className="mt-1 text-sm text-amber-800">{geoMissingCount} senza coordinate, {incompleteAddressCount} con indirizzo da completare.</p>
          </div>
          <div className="rounded-2xl border border-rose-200 bg-rose-50/70 px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-rose-700">Geo da correggere</p>
            <p className="mt-2 text-3xl font-semibold text-rose-900">{geoToFixCount}</p>
            <p className="mt-1 text-sm text-rose-800">{geoWarningCount} approssimativi, {geoVerifiedCount} già verificati.</p>
          </div>
          <div className="rounded-2xl border border-indigo-200 bg-indigo-50/70 px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-indigo-700">Accesso solo bus piccolo</p>
            <p className="mt-2 text-3xl font-semibold text-indigo-900">{smallVehicleOnlyCount}</p>
            <p className="mt-1 text-sm text-indigo-800">Vincolo pronto per l’assegnazione Ischia quando configureremo la flotta.</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 p-2">
          {([
            { key: "corrections", label: `Da correggere (${geoToFixCount})` },
            { key: "verified", label: `Verificati (${geoVerifiedCount})` },
            { key: "missing", label: `Mancanti (${geoMissingCount})` },
            { key: "all", label: "Tutti" },
            { key: "inactive", label: "Disattivi" },
          ] as Array<{ key: HotelListFilter; label: string }>).map((filter) => (
            <button
              key={filter.key}
              type="button"
              onClick={() => {
                setListFilter(filter.key);
                if (filter.key === "all" && tenantId) void loadHotels(tenantId, search, 0, false);
              }}
              className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition ${
                listFilter === filter.key
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-slate-200 bg-white text-slate-600 hover:bg-slate-100"
              }`}
            >
              {filter.label}
            </button>
          ))}
          <span className="ml-auto text-xs text-slate-500">
            Vista attuale: {filteredItems.length} hotel
          </span>
        </div>
      </article>

      {initializing || loading ? <div className="card p-4 text-sm text-slate-500">Caricamento hotel...</div> : null}
      {!initializing && !loading && error ? <div className="card p-4 text-sm text-red-600">{error}</div> : null}
      {!initializing && !loading && message ? <div className="card p-4 text-sm text-emerald-700">{message}</div> : null}

      {!initializing && !loading && !error ? (
        <>
          {canManageHotels ? (
            <article className="card space-y-3 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold uppercase tracking-[0.1em] text-slate-600">Gestione hotel</h2>
                  <p className="mt-1 text-sm text-slate-500">Import massivi, geodati, alias e creazione manuale. Il sistema continua a migliorare il riconoscimento tramite alias e merge.</p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowAdminTools((value) => !value)}
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  {showAdminTools ? "Riduci strumenti" : "Apri strumenti"}
                </button>
              </div>
              {showAdminTools ? (
                <>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void triggerOverpassImport()}
                      disabled={importing}
                      className="input-saas font-medium disabled:opacity-50"
                    >
                      {importing ? "Import in corso..." : "Importa hotel da OpenStreetMap"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void applyAutoFillMissingCoords()}
                      disabled={importing}
                      className="input-saas font-medium disabled:opacity-50"
                    >
                      {importing ? "Aggiornamento..." : "Normalizza zone mancanti"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void geocodeHotels(false)}
                      disabled={geocoding || importing}
                      className="input-saas font-medium disabled:opacity-50"
                      title="Chiama OpenStreetMap per ricavare le coordinate reali dagli indirizzi (solo hotel con coordinate di default)"
                    >
                      {geocoding ? "Geocoding in corso..." : "Geocodifica indirizzi"}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (window.confirm("Forza geocoding su TUTTI gli hotel, anche quelli già geocodificati?")) {
                          void geocodeHotels(true);
                        }
                      }}
                      disabled={geocoding || importing}
                      className="input-saas font-medium disabled:opacity-50"
                      title="Forza geocoding su tutti gli hotel, inclusi quelli già con coordinate precise"
                    >
                      Forza geocoding tutti
                    </button>
                    <label className="input-saas font-medium hover:bg-slate-50">
                      Carica CSV (id,name,address,zone,lat,lng)
                      <input
                        type="file"
                        accept=".csv,text/csv"
                        className="hidden"
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          if (!file) return;
                          void handleCsvUpload(file);
                        }}
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => { setShowCreateForm((v) => !v); setError(""); setMessage(""); }}
                      className="input-saas font-medium"
                    >
                      {showCreateForm ? "Annulla nuovo hotel" : "+ Nuovo hotel"}
                    </button>
                  </div>
                  {showCreateForm ? (
                <div className="rounded-lg border border-indigo-200 bg-indigo-50/50 p-4">
                  <p className="mb-3 text-sm font-semibold text-slate-800">Crea nuovo hotel</p>
                  <div className="grid gap-3 md:grid-cols-2">
                    <label className="space-y-1 md:col-span-2">
                      <span className="text-xs font-medium text-slate-600">Nome *</span>
                      <input value={createDraft.name} onChange={(e) => setCreateDraft({ ...createDraft, name: e.target.value })} placeholder="Es. Hotel Terme President" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                    </label>
                    <label className="space-y-1 md:col-span-2">
                      <span className="text-xs font-medium text-slate-600">Indirizzo</span>
                      <input value={createDraft.address} onChange={(e) => setCreateDraft({ ...createDraft, address: e.target.value })} placeholder="Es. Via Roma 1, Ischia Porto" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                    </label>
                    <label className="space-y-1">
                      <span className="text-xs font-medium text-slate-600">Città</span>
                      <input value={createDraft.city} onChange={(e) => setCreateDraft({ ...createDraft, city: e.target.value })} placeholder="Ischia" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                    </label>
                    <label className="space-y-1">
                      <span className="text-xs font-medium text-slate-600">Zona</span>
                      <select value={createDraft.zone} onChange={(e) => setCreateDraft({ ...createDraft, zone: e.target.value })} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm">
                        {HOTEL_ZONES.map((z) => <option key={z} value={z}>{z}</option>)}
                      </select>
                    </label>
                    <label className="space-y-1">
                      <span className="text-xs font-medium text-slate-600">Lat (opzionale)</span>
                      <input value={createDraft.lat} onChange={(e) => setCreateDraft({ ...createDraft, lat: e.target.value })} placeholder="Lascia vuoto" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                    </label>
                    <label className="space-y-1">
                      <span className="text-xs font-medium text-slate-600">Lng (opzionale)</span>
                      <input value={createDraft.lng} onChange={(e) => setCreateDraft({ ...createDraft, lng: e.target.value })} placeholder="Lascia vuoto" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                    </label>
                    <label className="space-y-1 rounded-xl border border-slate-200 bg-white px-3 py-3 md:col-span-2">
                      <span className="text-xs font-medium uppercase tracking-[0.12em] text-slate-500">Vincolo assegnazione Ischia</span>
                      <div className="mt-2 flex flex-wrap items-center gap-3">
                        <button
                          type="button"
                          onClick={() => setCreateDraft({ ...createDraft, small_vehicle_only: !createDraft.small_vehicle_only, small_vehicle_max_pax: createDraft.small_vehicle_only ? "" : createDraft.small_vehicle_max_pax })}
                          className={`rounded-full border px-3 py-1.5 text-xs font-semibold ${createDraft.small_vehicle_only ? "border-indigo-300 bg-indigo-600 text-white" : "border-slate-200 bg-slate-50 text-slate-600"}`}
                        >
                          {createDraft.small_vehicle_only ? "Solo bus piccolo attivo" : "Consenti anche mezzi normali"}
                        </button>
                        <input
                          value={createDraft.small_vehicle_max_pax}
                          onChange={(e) => setCreateDraft({ ...createDraft, small_vehicle_max_pax: e.target.value })}
                          placeholder="Max posti"
                          disabled={!createDraft.small_vehicle_only}
                          className="w-28 rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-100"
                        />
                      </div>
                      <p className="mt-2 text-xs text-slate-500">Per gli hotel dove, in assegnazione Ischia, può entrare solo un mezzo piccolo. Il veicolo specifico verrà scelto più avanti nella flotta.</p>
                    </label>
                  <label className="space-y-1 rounded-xl border border-slate-200 bg-white px-3 py-3 md:col-span-2">
                    <span className="text-xs font-medium uppercase tracking-[0.12em] text-slate-500">Contatti ricettivo</span>
                    <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-3">
                      <input value={createDraft.email} onChange={(e) => setCreateDraft({ ...createDraft, email: e.target.value })} placeholder="Email ricettivo" type="email" className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                      <input value={createDraft.phone} onChange={(e) => setCreateDraft({ ...createDraft, phone: e.target.value })} placeholder="Telefono / WhatsApp" className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                      <input value={createDraft.contact_name} onChange={(e) => setCreateDraft({ ...createDraft, contact_name: e.target.value })} placeholder="Referente (es. Ricevimento)" className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                    </div>
                  </label>
                  </div>
                  <button type="button" onClick={() => void createHotel()} disabled={saving} className="mt-3 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
                    {saving ? "Creazione..." : "Crea hotel"}
                  </button>
                </div>
              ) : null}
                  <p className="text-xs text-slate-500">
                    Zone supportate: {HOTEL_ZONES.join(", ")}. Inserisci indirizzo e zona; lascia vuote le coordinate. Dopo il caricamento indirizzi usa geocoding per calcolare lat/lng reali.
                  </p>
                  <div className="grid gap-2 md:grid-cols-[1fr_2fr_auto]">
                    <select
                      value={aliasHotelId}
                      onChange={(event) => setAliasHotelId(event.target.value)}
                      className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    >
                      <option value="">Seleziona hotel per alias</option>
                      {items.map((hotel) => (
                        <option key={hotel.id} value={hotel.id}>
                          {hotel.name}
                        </option>
                      ))}
                    </select>
                    <input
                      value={aliasValue}
                      onChange={(event) => setAliasValue(event.target.value)}
                      placeholder="Alias manuale (nome alternativo)"
                      className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    />
                    <button type="button" onClick={() => void addAlias()} className="input-saas text-sm font-medium">
                      Salva alias
                    </button>
                  </div>
                </>
              ) : (
                <p className="text-sm text-slate-500">Apri gli strumenti solo quando devi importare, creare o aggiungere alias. La lista hotel sotto resta pulita come master anagrafica.</p>
              )}
            </article>
          ) : null}

          {canManageHotels ? (
            <article className="card space-y-3 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold uppercase tracking-[0.1em] text-slate-600">Match &amp; merge hotel</h2>
                  <p className="text-sm text-slate-500">Suggerimenti automatici per unificare hotel con nomi molto simili. Il merge sposta i servizi sul record principale e salva alias per migliorare i riconoscimenti futuri.</p>
                </div>
                <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-600">
                  {mergeCandidates.length} suggerimenti
                </span>
              </div>
              {mergeCandidates.length === 0 ? (
                <p className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-4 text-sm text-slate-500">
                  Nessun possibile duplicato forte rilevato al momento.
                </p>
              ) : (
                <div className="space-y-3">
                  {mergeCandidates.map((candidate) => (
                    <div key={candidate.key} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="space-y-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-[11px] font-semibold text-emerald-700">
                              Mantieni
                            </span>
                            <span className="text-sm font-semibold text-slate-900">{candidate.primaryName}</span>
                            <span className="text-xs text-slate-500">{candidate.primaryZone}{candidate.primaryUsage > 0 ? ` · ${candidate.primaryUsage} servizi` : ""}</span>
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="rounded-full bg-amber-100 px-2.5 py-1 text-[11px] font-semibold text-amber-700">
                              Unifica
                            </span>
                            <span className="text-sm font-semibold text-slate-900">{candidate.secondaryName}</span>
                            <span className="text-xs text-slate-500">{candidate.secondaryZone}{candidate.secondaryUsage > 0 ? ` · ${candidate.secondaryUsage} servizi` : ""}</span>
                          </div>
                          <p className="text-xs text-slate-500">{candidate.reason} · score {candidate.score}/100</p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              setDismissedMergeKeys((current) => {
                                const next = [...current, candidate.key];
                                if (mergeStorageKey) {
                                  try { localStorage.setItem(mergeStorageKey, JSON.stringify(next)); } catch { /* ignore */ }
                                }
                                return next;
                              });
                            }}
                            className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50"
                          >
                            Ignora
                          </button>
                          <button
                            type="button"
                            onClick={() => void mergeHotels(candidate)}
                            disabled={saving}
                            className="rounded-xl border border-indigo-200 bg-indigo-600 px-3 py-2 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                          >
                            {saving ? "Merge..." : "Unifica ora"}
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </article>
          ) : null}

          {filteredItems.length === 0 ? <div className="card p-4 text-sm text-slate-500">Nessun hotel trovato con questi filtri.</div> : null}

          {groupedItems.map(([zone, hotels]) => (
            <article key={zone} className="overflow-hidden rounded-2xl border border-slate-200 bg-slate-50/80 shadow-sm">
              <div className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3">
                <h2 className="text-sm font-extrabold uppercase tracking-[0.14em] text-slate-700">{zone}</h2>
                <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-500">{hotels.length} hotel</span>
              </div>
              <div className="space-y-3 p-3">
                  {hotels.map((hotel) => {
                    const isEditing = editingId === hotel.id && editDraft !== null;
                    const hasMissingCoords = isMissingCoordinates(hotel.lat, hotel.lng);
                    const hasWeakAddress = isIncompleteHotelAddress(hotel.address);
                    const geoQuality = geoQualityByHotelId.get(hotel.id) ?? hotelGeoQuality(hotel);
                    const geoEvaluation = geoEvaluationByHotelId.get(hotel.id) ?? evaluateHotelGeo(hotel);
                    const geoIssues = geoQuality.issues.map((issue) => geoIssueLabels[issue] ?? issue);
                    if (isEditing) {
                      return (
                        <article key={hotel.id} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                                <div className="flex flex-wrap items-start justify-between gap-3">
                                  <div>
                                    <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Scheda hotel</p>
                                    <h3 className="mt-1 text-base font-bold text-slate-900">Aggiorna indirizzo e zona</h3>
                                    <p className="mt-1 text-sm text-slate-500">Per geolocalizzare bene basta un indirizzo completo. Le coordinate puoi lasciarle vuote.</p>
                                  </div>
                                  {geoIssues.length > 0 ? (
                                    <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                                      <b>Geo da correggere:</b> {geoIssues.join(", ")}
                                    </div>
                                  ) : null}
                                </div>

                                <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
                                  <div className="space-y-3">
                                    <label className="block text-xs font-semibold text-slate-600">
                                      Nome hotel
                                      <input
                                        value={editDraft.name}
                                        onChange={(event) => setEditDraft({ ...editDraft, name: event.target.value })}
                                        className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                                      />
                                    </label>
                                    <label className="block text-xs font-semibold text-slate-600">
                                      Indirizzo completo
                                      <input
                                        value={editDraft.address}
                                        onChange={(event) => setEditDraft({ ...editDraft, address: event.target.value })}
                                        className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                                        placeholder="Es. Via Provinciale Panza 209, Forio"
                                      />
                                    </label>
                                    <div className="grid gap-3 sm:grid-cols-2">
                                      <label className="block text-xs font-semibold text-slate-600">
                                        Città / Comune
                                        <input
                                          value={editDraft.city}
                                          onChange={(event) => setEditDraft({ ...editDraft, city: event.target.value })}
                                          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                                          placeholder="Ischia, Forio, Casamicciola..."
                                        />
                                      </label>
                                      <label className="block text-xs font-semibold text-slate-600">
                                        Zona operativa
                                        <select
                                          value={editDraft.zone}
                                          onChange={(event) => setEditDraft({ ...editDraft, zone: event.target.value })}
                                          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                                        >
                                          {HOTEL_ZONES.map((z) => <option key={z} value={z}>{z}</option>)}
                                        </select>
                                      </label>
                                    </div>
                                    <div className="grid gap-3 sm:grid-cols-2">
                                      <label className="block text-xs font-semibold text-slate-600">
                                        Lat opzionale
                                        <input
                                          value={editDraft.lat}
                                          onChange={(event) => setEditDraft({ ...editDraft, lat: event.target.value })}
                                          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                                          placeholder="Lascia vuoto"
                                        />
                                      </label>
                                      <label className="block text-xs font-semibold text-slate-600">
                                        Lng opzionale
                                        <input
                                          value={editDraft.lng}
                                          onChange={(event) => setEditDraft({ ...editDraft, lng: event.target.value })}
                                          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                                          placeholder="Lascia vuoto"
                                        />
                                      </label>
                                    </div>
                                  </div>

                                  <div className="space-y-3">
                                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                                      <span className="text-xs font-bold uppercase tracking-wide text-slate-500">Assegnazione Ischia</span>
                                      <div className="mt-2 flex flex-wrap items-center gap-3">
                                        <button
                                          type="button"
                                          onClick={() => setEditDraft({ ...editDraft, small_vehicle_only: !editDraft.small_vehicle_only, small_vehicle_max_pax: editDraft.small_vehicle_only ? "" : editDraft.small_vehicle_max_pax })}
                                          className={`rounded-full border px-3 py-1.5 text-xs font-semibold ${editDraft.small_vehicle_only ? "border-indigo-300 bg-indigo-600 text-white" : "border-slate-200 bg-white text-slate-600"}`}
                                        >
                                          {editDraft.small_vehicle_only ? "Solo bus piccolo" : "Accesso standard"}
                                        </button>
                                        <input
                                          value={editDraft.small_vehicle_max_pax}
                                          onChange={(event) => setEditDraft({ ...editDraft, small_vehicle_max_pax: event.target.value })}
                                          disabled={!editDraft.small_vehicle_only}
                                          placeholder="Max posti"
                                          className="w-28 rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-100"
                                        />
                                      </div>
                                    </div>
                                    <div className="grid gap-2">
                                      <input
                                        value={editDraft.email}
                                        onChange={(event) => setEditDraft({ ...editDraft, email: event.target.value })}
                                        placeholder="Email ricettivo"
                                        type="email"
                                        className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
                                      />
                                      <input
                                        value={editDraft.phone}
                                        onChange={(event) => setEditDraft({ ...editDraft, phone: event.target.value })}
                                        placeholder="Telefono / WhatsApp"
                                        className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
                                      />
                                      <input
                                        value={editDraft.contact_name}
                                        onChange={(event) => setEditDraft({ ...editDraft, contact_name: event.target.value })}
                                        placeholder="Referente, es. Ricevimento"
                                        className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
                                      />
                                    </div>
                                    <label className="block text-xs font-semibold text-slate-600">
                                      Stato
                                      <select
                                        value={editDraft.is_active ? "true" : "false"}
                                        onChange={(event) => setEditDraft({ ...editDraft, is_active: event.target.value === "true" })}
                                        className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                                      >
                                        <option value="true">Attivo</option>
                                        <option value="false">Disattivo</option>
                                      </select>
                                    </label>
                                  </div>
                                </div>

                                <div className="mt-4 flex flex-wrap justify-end gap-2 border-t border-slate-100 pt-3">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setEditingId(null);
                                      setEditDraft(null);
                                    }}
                                    className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50"
                                  >
                                    Annulla
                                  </button>
                                  <button
                                    type="button"
                                    disabled={saving}
                                    onClick={() => void saveEdit(hotel.id)}
                                    className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                                  >
                                    {saving ? "Salvataggio..." : "Salva hotel"}
                                  </button>
                                </div>
                        </article>
                      );
                    }
                    return (
                      <article key={hotel.id} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                        <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(190px,1.45fr)_minmax(0,1.35fr)_minmax(160px,0.7fr)_minmax(0,0.85fr)_minmax(180px,0.7fr)_minmax(128px,0.45fr)]">
                          <div className="min-w-0 space-y-1">
                            <p className="break-words text-sm font-extrabold uppercase leading-5 tracking-[0.02em] text-slate-900">{hotel.name}</p>
                            <div className="flex flex-wrap gap-2 text-xs text-slate-500">
                              <span>{hotel.city ?? "Ischia"}</span>
                              <span>•</span>
                              <span>{hotel.zone || "N/D"}</span>
                              {hotel.source ? (
                                <>
                                  <span>•</span>
                                  <span className="uppercase tracking-wide">{hotel.source}</span>
                                </>
                              ) : null}
                            </div>
                          </div>

                          <div className="min-w-0 space-y-1">
                            <p className="line-clamp-2 break-words text-sm font-medium text-slate-700">{hotel.address}</p>
                            <div className="flex flex-wrap gap-2 text-xs text-slate-500">
                              <span>Lat {formatCoord(hotel.lat)}</span>
                              <span>•</span>
                              <span>Lng {formatCoord(hotel.lng)}</span>
                            </div>
                          </div>

                          <div className="space-y-2">
                            {hotel.small_vehicle_only ? (
                              <div className="space-y-1">
                                <span className="inline-flex rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-xs font-semibold text-indigo-700">
                                  Solo bus piccolo
                                </span>
                                <p className="text-xs text-slate-500">
                                  {hotel.small_vehicle_max_pax ? `Fino a ${hotel.small_vehicle_max_pax} posti.` : "Capienza da definire."}
                                </p>
                              </div>
                            ) : (
                              <span className="inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">Accesso standard</span>
                            )}
                            <div className="flex flex-wrap gap-1">
                              {(aliasByHotel.get(hotel.id) ?? []).slice(0, 3).map((alias) => (
                                <button
                                  key={alias.id}
                                  type="button"
                                  onClick={() => (canManageHotels ? void removeAlias(alias.id) : undefined)}
                                  className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-600"
                                  title={canManageHotels ? "Clicca per rimuovere alias" : "Alias"}
                                >
                                  {alias.alias}
                                </button>
                              ))}
                            </div>
                          </div>

                          <div className="min-w-0 space-y-1 text-xs text-slate-600">
                            {hotel.email && <div className="truncate" title={hotel.email}>Email: {hotel.email}</div>}
                            {hotel.phone && <div title={hotel.phone}>Tel: {hotel.phone}</div>}
                            {hotel.contact_name && <div className="truncate text-slate-400" title={hotel.contact_name}>{hotel.contact_name}</div>}
                            {!hotel.email && !hotel.phone && <span className="text-slate-300 italic">Nessun contatto</span>}
                          </div>

                          <div className="space-y-2">
                            <div className="flex flex-wrap items-center gap-2">
                              {hotel.is_active ? (
                                <span className="inline-flex rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-bold text-emerald-700">Attivo</span>
                              ) : (
                                <span className="inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-xs font-bold text-slate-500">Disattivo</span>
                              )}
                              <HotelGeoBadge evaluation={geoEvaluation} />
                            </div>
                            {geoIssues.length > 0 ? (
                              <div className="text-xs text-slate-500">{geoIssues.join(", ")}</div>
                            ) : null}
                            {hasMissingCoords && geoIssues.length === 0 ? <div className="text-xs text-amber-700">Coordinate da verificare</div> : null}
                            {hasWeakAddress && geoIssues.length === 0 ? <div className="text-xs text-amber-700">Indirizzo incompleto</div> : null}
                          </div>

                          <div>
                            {canManageHotels ? (
                              <div className="flex flex-wrap gap-1.5 xl:flex-col">
                                  <button
                                    type="button"
                                    onClick={() => startEdit(hotel)}
                                    className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                                  >
                                    Modifica
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => openGeoCorrection(hotel)}
                                    className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-1.5 text-xs font-semibold text-sky-700 hover:bg-sky-100"
                                  >
                                    Correggi geo
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => void deleteHotel(hotel.id, hotel.name)}
                                    disabled={saving}
                                    className="rounded-lg border border-rose-200 px-3 py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-50"
                                  >
                                    Elimina
                                  </button>
                              </div>
                            ) : (
                              <span className="text-xs text-slate-400">Solo admin/operator</span>
                            )}
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
            </article>
          ))}

          {hasMore ? (
            <button
              type="button"
              onClick={() => {
                if (!tenantId) return;
                void loadHotels(tenantId, search, items.length, true);
              }}
              disabled={loadingMore}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium disabled:opacity-50"
            >
              {loadingMore ? "Caricamento..." : "Carica altri"}
            </button>
          ) : null}
        </>
      ) : null}

      {geoCorrection ? (
        <div className="fixed inset-0 z-[900] bg-slate-950/35 p-3 backdrop-blur-sm">
          <div className="ml-auto flex h-full w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
            <div className="border-b border-slate-200 px-5 py-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.16em] text-slate-500">Correzione geolocalizzazione</p>
                  <h2 className="mt-1 text-xl font-semibold text-slate-950">{geoCorrection.hotel.name}</h2>
                  <p className="mt-1 text-sm text-slate-500">{geoCorrection.hotel.address}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setGeoCorrection(null)}
                  className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50"
                >
                  Chiudi
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-5">
              <div className="grid gap-4 lg:grid-cols-[1fr_1.1fr]">
                <div className="space-y-3">
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
                    <p><b>Coordinate attuali:</b> {formatCoord(geoCorrection.hotel.lat)} / {formatCoord(geoCorrection.hotel.lng)}</p>
                    <p className="mt-1"><b>Stato:</b> {evaluateHotelGeo(geoCorrection.hotel).label}</p>
                    {geoCorrection.startedFromGenericCoords ? (
                      <p className="mt-2 rounded-lg border border-orange-200 bg-orange-50 px-3 py-2 text-xs font-semibold text-orange-700">
                        Coordinate salvate generiche: sto cercando automaticamente l&apos;hotel sulla mappa. Conferma solo se il pin cade sul punto giusto.
                      </p>
                    ) : null}
                    {geoSearching ? (
                      <p className="mt-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs font-semibold text-sky-700">
                        Ricerca automatica posizione in corso...
                      </p>
                    ) : null}
                    {geoCorrection.suggestionLabel ? (
                      <p className="mt-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700">
                        Suggerimento trovato: controlla il pin e premi Salva e verifica se la posizione e corretta.
                      </p>
                    ) : null}
                  </div>
                  <label className="block text-xs font-semibold text-slate-600">
                    Cerca indirizzo / hotel
                    <div className="mt-1 flex gap-2">
                      <input
                        value={geoCorrection.query}
                        onChange={(event) => setGeoCorrection({ ...geoCorrection, query: event.target.value })}
                        className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
                        placeholder="Nome hotel, via, comune"
                      />
                      <button
                        type="button"
                        onClick={() => void searchGeoCorrectionAddress()}
                        disabled={geoSearching}
                        className="rounded-lg border border-slate-900 bg-slate-900 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
                      >
                        {geoSearching ? "Cerco..." : "Cerca"}
                      </button>
                    </div>
                  </label>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="block text-xs font-semibold text-slate-600">
                      Latitudine
                      <input
                        value={geoCorrection.lat}
                        onChange={(event) => setGeoCorrection({ ...geoCorrection, lat: event.target.value })}
                        className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                      />
                    </label>
                    <label className="block text-xs font-semibold text-slate-600">
                      Longitudine
                      <input
                        value={geoCorrection.lng}
                        onChange={(event) => setGeoCorrection({ ...geoCorrection, lng: event.target.value })}
                        className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                      />
                    </label>
                  </div>
                  <label className="block text-xs font-semibold text-slate-600">
                    Indirizzo verificato
                    <input
                      value={geoCorrection.formatted_address}
                      onChange={(event) => setGeoCorrection({ ...geoCorrection, formatted_address: event.target.value })}
                      className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    />
                  </label>
                  {geoCorrection.suggestionLabel ? (
                    <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600">
                      <span className="font-semibold text-slate-700">Risultato mappa:</span> {geoCorrection.suggestionLabel}
                    </div>
                  ) : null}
                  <label className="block text-xs font-semibold text-slate-600">
                    Note geo
                    <textarea
                      value={geoCorrection.notes}
                      onChange={(event) => setGeoCorrection({ ...geoCorrection, notes: event.target.value })}
                      className="mt-1 min-h-20 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                      placeholder="Es. pin confermato da Google Maps / reception"
                    />
                  </label>
                </div>

                <div className="space-y-3">
                  <GeoCorrectionMap
                    lat={Number(geoCorrection.lat.replace(",", ".")) || zoneCentroids["Ischia Porto"].lat}
                    lng={Number(geoCorrection.lng.replace(",", ".")) || zoneCentroids["Ischia Porto"].lng}
                    onChange={updateGeoCorrectionPin}
                  />
                  <p className="text-xs text-slate-500">Trascina il pin sul punto reale di arrivo mezzo. Il salvataggio manuale imposta la geo come verificata.</p>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-4">
              <button
                type="button"
                onClick={() => setGeoCorrection(null)}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-white"
              >
                Annulla
              </button>
              <button
                type="button"
                onClick={() => void saveGeoCorrection()}
                disabled={saving}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {saving ? "Salvataggio..." : "Salva e verifica"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
