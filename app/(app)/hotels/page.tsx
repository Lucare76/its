"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { HOTEL_ZONES, inferZoneFromText, isMissingCoordinates, zoneCentroids } from "@/lib/hotel-geocoding";
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
};

const PAGE_SIZE = 20;

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
    is_active: hotel.is_active
  };
}

function formatCoord(value: number | null) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(5) : "N/D";
}

function isAddressIncomplete(address: string) {
  const trimmed = address.trim().toLowerCase();
  return trimmed.length < 6 || trimmed === "ischia";
}

function normalizeMergeName(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/['".,]/g, " ")
    .replace(/\b(?:hotel|albergo|terme|resort|spa|club|grand|parco|villa|exclusive|boutique|relax)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreMergeCandidate(leftName: string, rightName: string) {
  const left = normalizeMergeName(leftName);
  const right = normalizeMergeName(rightName);
  if (!left || !right) return 0;
  if (left === right) return 100;
  if (left.includes(right) || right.includes(left)) return 94;
  const leftTokens = left.split(" ").filter(Boolean);
  const rightTokens = new Set(right.split(" ").filter(Boolean));
  const shared = leftTokens.filter((token) => rightTokens.has(token));
  if (shared.length === 0) return 0;
  return Math.round((shared.length / Math.max(leftTokens.length, 1)) * 88);
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
  const [showAdminTools, setShowAdminTools] = useState(false);
  const [aliasHotelId, setAliasHotelId] = useState("");
  const [aliasValue, setAliasValue] = useState("");
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [createDraft, setCreateDraft] = useState<HotelEditDraft>({
    name: "", address: "", city: "Ischia", zone: "Ischia Porto", lat: "", lng: "", small_vehicle_only: false, small_vehicle_max_pax: "", is_active: true
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
        .select("id,name,zone,address,city,lat,lng,small_vehicle_only,small_vehicle_max_pax,source,source_osm_type,source_osm_id,is_active", { count: "exact" })
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
        .select("id,name,zone,address,city,lat,lng,small_vehicle_only,small_vehicle_max_pax,source,source_osm_type,source_osm_id,is_active")
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

  const hasMore = items.length < totalCount;
  const canManageHotels = role === "admin" || role === "operator";
  const groupedItems = useMemo(() => {
    const groups = new Map<string, HotelListItem[]>();
    for (const hotel of items) {
      const key = hotel.zone || "N/D";
      const bucket = groups.get(key) ?? [];
      bucket.push(hotel);
      groups.set(key, bucket);
    }
    return Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [items]);

  const missingCoordsCount = items.filter((hotel) => isMissingCoordinates(hotel.lat, hotel.lng)).length;
  const incompleteAddressCount = items.filter((hotel) => isAddressIncomplete(hotel.address)).length;
  const smallVehicleOnlyCount = items.filter((hotel) => hotel.small_vehicle_only).length;
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
      .filter((hotel) => isMissingCoordinates(hotel.lat, hotel.lng) || !hotel.zone)
      .map((hotel) => {
        const inferredZone = inferZoneFromText(`${hotel.name} ${hotel.address}`);
        const nextZone = (hotel.zone || inferredZone || "Ischia Porto") as keyof typeof zoneCentroids;
        const fallback = zoneCentroids[nextZone] ?? zoneCentroids["Ischia Porto"];
        return {
          id: hotel.id,
          zone: nextZone,
          lat: isMissingCoordinates(hotel.lat, hotel.lng) ? fallback.lat : hotel.lat,
          lng: isMissingCoordinates(hotel.lat, hotel.lng) ? fallback.lng : hotel.lng
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
        .update({ zone: row.zone, lat: row.lat, lng: row.lng, updated_at: new Date().toISOString() })
        .eq("id", row.id)
        .eq("tenant_id", tenantId);
      if (!updateError) updated += 1;
    }

    await Promise.all([loadHotels(tenantId, search, 0, false), loadMergeContext(tenantId)]);
    setImporting(false);
    setMessage(`Aggiornati ${updated} hotel (compilazione automatica coordinate/zona).`);
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
      const centroid = zoneCentroids[(nextZone as keyof typeof zoneCentroids) || "Ischia Porto"] ?? zoneCentroids["Ischia Porto"];

      const payload = {
        zone: nextZone,
        address: row.address || target.address,
        lat: Number.isFinite(parsedLat) ? Number(parsedLat) : isMissingCoordinates(target.lat, target.lng) ? centroid.lat : target.lat,
        lng: Number.isFinite(parsedLng) ? Number(parsedLng) : isMissingCoordinates(target.lat, target.lng) ? centroid.lng : target.lng,
        updated_at: new Date().toISOString()
      };

      const { error: updateError } = await supabase
        .from("hotels")
        .update(payload)
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

      setDismissedMergeKeys((current) => current.filter((key) => key !== candidate.key));
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

  const saveEdit = async (hotelId: string) => {
    if (!tenantId || !supabase || !editDraft) return;
    setSaving(true);
    setError("");

    const parsedLat = Number(editDraft.lat);
    const parsedLng = Number(editDraft.lng);
    const parsedSmallVehicleMaxPax = editDraft.small_vehicle_max_pax ? Number(editDraft.small_vehicle_max_pax) : null;
    if (!Number.isFinite(parsedLat) || !Number.isFinite(parsedLng)) {
      setSaving(false);
      setError("Coordinate non valide.");
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
    const parsedLat = createDraft.lat ? Number(createDraft.lat) : null;
    const parsedLng = createDraft.lng ? Number(createDraft.lng) : null;
    const parsedSmallVehicleMaxPax = createDraft.small_vehicle_max_pax ? Number(createDraft.small_vehicle_max_pax) : null;
    const zone = createDraft.zone || "Ischia Porto";
    const centroid = zoneCentroids[(zone as keyof typeof zoneCentroids)] ?? zoneCentroids["Ischia Porto"];
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
      lat: parsedLat && Number.isFinite(parsedLat) ? parsedLat : centroid.lat,
      lng: parsedLng && Number.isFinite(parsedLng) ? parsedLng : centroid.lng,
      small_vehicle_only: createDraft.small_vehicle_only,
      small_vehicle_max_pax: createDraft.small_vehicle_only ? parsedSmallVehicleMaxPax : null,
      is_active: createDraft.is_active,
      source: "manual"
    });
    setSaving(false);
    if (insertError) { setError(insertError.message); return; }
    setShowCreateForm(false);
    setCreateDraft({ name: "", address: "", city: "Ischia", zone: "Ischia Porto", lat: "", lng: "", small_vehicle_only: false, small_vehicle_max_pax: "", is_active: true });
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
                if (tenantId) void loadHotels(tenantId, nextSearch, 0, false);
              }}
              placeholder="Nome, zona, indirizzo"
              className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2.5"
            />
          </label>
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Hotel registrati</p>
            <p className="mt-2 text-3xl font-semibold text-slate-900">{totalCount}</p>
            <p className="mt-1 text-sm text-slate-500">Master list unica del tenant.</p>
          </div>
          <div className="rounded-2xl border border-amber-200 bg-amber-50/70 px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-amber-700">Dati da completare</p>
            <p className="mt-2 text-3xl font-semibold text-amber-900">{missingCoordsCount + incompleteAddressCount}</p>
            <p className="mt-1 text-sm text-amber-800">{missingCoordsCount} con coordinate da verificare, {incompleteAddressCount} con indirizzo da completare.</p>
          </div>
          <div className="rounded-2xl border border-indigo-200 bg-indigo-50/70 px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-indigo-700">Accesso solo bus piccolo</p>
            <p className="mt-2 text-3xl font-semibold text-indigo-900">{smallVehicleOnlyCount}</p>
            <p className="mt-1 text-sm text-indigo-800">Vincolo pronto per l’assegnazione Ischia quando configureremo la flotta.</p>
          </div>
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
                      {importing ? "Aggiornamento..." : "Compila lat/lng mancanti"}
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
                      <input value={createDraft.lat} onChange={(e) => setCreateDraft({ ...createDraft, lat: e.target.value })} placeholder="Auto dalla zona" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                    </label>
                    <label className="space-y-1">
                      <span className="text-xs font-medium text-slate-600">Lng (opzionale)</span>
                      <input value={createDraft.lng} onChange={(e) => setCreateDraft({ ...createDraft, lng: e.target.value })} placeholder="Auto dalla zona" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
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
                  </div>
                  <button type="button" onClick={() => void createHotel()} disabled={saving} className="mt-3 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
                    {saving ? "Creazione..." : "Crea hotel"}
                  </button>
                </div>
              ) : null}
                  <p className="text-xs text-slate-500">
                    Zone supportate: {HOTEL_ZONES.join(", ")}. Se lat/lng mancano, viene usato il centroide zona. Quando il cliente completerà gli indirizzi, il motore potrà ottimizzare meglio i servizi geograficamente.
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
                            onClick={() => setDismissedMergeKeys((current) => [...current, candidate.key])}
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

          {items.length === 0 ? <div className="card p-4 text-sm text-slate-500">Nessun hotel trovato.</div> : null}

          {groupedItems.map(([zone, hotels]) => (
            <article key={zone} className="card overflow-x-auto">
              <div className="border-b border-slate-100 px-3 py-2 text-sm font-semibold text-slate-700">
                {zone} ({hotels.length})
              </div>
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-left text-slate-600">
                  <tr>
                    <th className="px-3 py-2 font-medium">Hotel</th>
                    <th className="px-3 py-2 font-medium">Localizzazione</th>
                    <th className="px-3 py-2 font-medium">Assegnazione Ischia</th>
                    <th className="px-3 py-2 font-medium">Alias</th>
                    <th className="px-3 py-2 font-medium">Stato</th>
                    <th className="px-3 py-2 font-medium">Azioni</th>
                  </tr>
                </thead>
                <tbody>
                  {hotels.map((hotel) => {
                    const isEditing = editingId === hotel.id && editDraft !== null;
                    const hasMissingCoords = isMissingCoordinates(hotel.lat, hotel.lng);
                    const hasWeakAddress = isAddressIncomplete(hotel.address);
                    return (
                      <tr key={hotel.id} className="border-t border-slate-100 align-top">
                        <td className="max-w-72 px-3 py-2">
                          {isEditing ? (
                            <input
                              value={editDraft.name}
                              onChange={(event) => setEditDraft({ ...editDraft, name: event.target.value })}
                              className="w-56 rounded-md border border-slate-300 px-2 py-1"
                            />
                          ) : (
                            <div className="space-y-1">
                              <span className="line-clamp-2 break-words font-semibold uppercase text-slate-900">{hotel.name}</span>
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
                          )}
                        </td>
                        <td className="max-w-[28rem] px-3 py-2">
                          {isEditing ? (
                            <div className="grid gap-2 md:grid-cols-2">
                              <input
                                value={editDraft.address}
                                onChange={(event) => setEditDraft({ ...editDraft, address: event.target.value })}
                                className="rounded-md border border-slate-300 px-2 py-1 md:col-span-2"
                                placeholder="Indirizzo hotel"
                              />
                              <input
                                value={editDraft.city}
                                onChange={(event) => setEditDraft({ ...editDraft, city: event.target.value })}
                                className="rounded-md border border-slate-300 px-2 py-1"
                                placeholder="Città"
                              />
                              <select
                                value={editDraft.zone}
                                onChange={(event) => setEditDraft({ ...editDraft, zone: event.target.value })}
                                className="rounded-md border border-slate-300 px-2 py-1 text-sm"
                              >
                                {HOTEL_ZONES.map((z) => <option key={z} value={z}>{z}</option>)}
                              </select>
                              <input
                                value={editDraft.lat}
                                onChange={(event) => setEditDraft({ ...editDraft, lat: event.target.value })}
                                className="rounded-md border border-slate-300 px-2 py-1"
                                placeholder="Lat"
                              />
                              <input
                                value={editDraft.lng}
                                onChange={(event) => setEditDraft({ ...editDraft, lng: event.target.value })}
                                className="rounded-md border border-slate-300 px-2 py-1"
                                placeholder="Lng"
                              />
                            </div>
                          ) : (
                            <div className="space-y-1">
                              <p className="line-clamp-2 break-words text-slate-700">{hotel.address}</p>
                              <div className="flex flex-wrap gap-2 text-xs text-slate-500">
                                <span>Lat {formatCoord(hotel.lat)}</span>
                                <span>•</span>
                                <span>Lng {formatCoord(hotel.lng)}</span>
                                {hotel.source_osm_type && hotel.source_osm_id ? (
                                  <>
                                    <span>•</span>
                                    <span>{hotel.source_osm_type}:{hotel.source_osm_id}</span>
                                  </>
                                ) : null}
                              </div>
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {isEditing ? (
                            <div className="space-y-2">
                              <button
                                type="button"
                                onClick={() => setEditDraft({ ...editDraft, small_vehicle_only: !editDraft.small_vehicle_only, small_vehicle_max_pax: editDraft.small_vehicle_only ? "" : editDraft.small_vehicle_max_pax })}
                                className={`rounded-full border px-3 py-1.5 text-xs font-semibold ${editDraft.small_vehicle_only ? "border-indigo-300 bg-indigo-600 text-white" : "border-slate-200 bg-slate-50 text-slate-600"}`}
                              >
                                {editDraft.small_vehicle_only ? "Solo bus piccolo" : "Nessun vincolo"}
                              </button>
                              <input
                                value={editDraft.small_vehicle_max_pax}
                                onChange={(event) => setEditDraft({ ...editDraft, small_vehicle_max_pax: event.target.value })}
                                disabled={!editDraft.small_vehicle_only}
                                placeholder="Max posti"
                                className="w-28 rounded-md border border-slate-300 px-2 py-1 disabled:bg-slate-100"
                              />
                            </div>
                          ) : hotel.small_vehicle_only ? (
                            <div className="space-y-1">
                              <span className="inline-flex rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-xs font-semibold text-indigo-700">
                                Solo bus piccolo
                              </span>
                              <p className="text-xs text-slate-500">
                                {hotel.small_vehicle_max_pax ? `Fino a ${hotel.small_vehicle_max_pax} posti.` : "Capienza da definire."}
                              </p>
                            </div>
                          ) : (
                            <span className="text-sm text-slate-500">Accesso standard</span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap gap-1">
                            {(aliasByHotel.get(hotel.id) ?? []).map((alias) => (
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
                        </td>
                        <td className="px-3 py-2">
                          {isEditing ? (
                            <select
                              value={editDraft.is_active ? "true" : "false"}
                              onChange={(event) => setEditDraft({ ...editDraft, is_active: event.target.value === "true" })}
                              className="w-24 rounded-md border border-slate-300 px-2 py-1"
                            >
                              <option value="true">Attivo</option>
                              <option value="false">Disattivo</option>
                            </select>
                          ) : hotel.is_active ? (
                            <span className="text-emerald-700">Attivo</span>
                          ) : (
                            <span className="text-slate-500">Disattivo</span>
                          )}
                          {hasMissingCoords ? <div className="text-xs text-amber-700">Coordinate da verificare</div> : null}
                          {hasWeakAddress ? <div className="text-xs text-amber-700">Indirizzo incompleto</div> : null}
                        </td>
                        <td className="px-3 py-2">
                          {canManageHotels ? (
                            isEditing ? (
                              <div className="flex flex-wrap gap-2">
                                <button
                                  type="button"
                                  disabled={saving}
                                  onClick={() => void saveEdit(hotel.id)}
                                  className="rounded-md border border-slate-300 px-2 py-1 text-xs font-medium"
                                >
                                  {saving ? "Salvataggio..." : "Salva"}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditingId(null);
                                    setEditDraft(null);
                                  }}
                                  className="rounded-md border border-slate-300 px-2 py-1 text-xs"
                                >
                                  Annulla
                                </button>
                              </div>
                            ) : (
                              <div className="flex flex-wrap gap-1">
                                <button
                                  type="button"
                                  onClick={() => startEdit(hotel)}
                                  className="rounded-md border border-slate-300 px-2 py-1 text-xs"
                                >
                                  Modifica
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void deleteHotel(hotel.id, hotel.name)}
                                  disabled={saving}
                                  className="rounded-md border border-rose-200 px-2 py-1 text-xs text-rose-700 hover:bg-rose-50 disabled:opacity-50"
                                >
                                  Elimina
                                </button>
                              </div>
                            )
                          ) : (
                            <span className="text-xs text-slate-400">Solo admin/operator</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
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
    </section>
  );
}
