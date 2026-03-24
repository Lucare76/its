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

type HotelEditDraft = {
  name: string;
  address: string;
  city: string;
  zone: string;
  lat: string;
  lng: string;
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
  const [aliasHotelId, setAliasHotelId] = useState("");
  const [aliasValue, setAliasValue] = useState("");
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [createDraft, setCreateDraft] = useState<HotelEditDraft>({
    name: "", address: "", city: "Ischia", zone: "Ischia Porto", lat: "", lng: "", is_active: true
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
        .select("id,name,zone,address,city,lat,lng,source,source_osm_type,source_osm_id,is_active", { count: "exact" })
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
      await Promise.all([loadHotels(membership.tenant_id, "", 0, false), loadAliases(membership.tenant_id)]);
    };

    void loadTenant();
    return () => {
      isActive = false;
    };
  }, [loadAliases, loadHotels]);

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
  const aliasByHotel = useMemo(() => {
    const map = new Map<string, HotelAlias[]>();
    for (const row of aliases) {
      const bucket = map.get(row.hotel_id) ?? [];
      bucket.push(row);
      map.set(row.hotel_id, bucket);
    }
    return map;
  }, [aliases]);

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

    await loadHotels(tenantId, search, 0, false);
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
      await loadHotels(tenantId, search, 0, false);
      await loadAliases(tenantId);
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

      await Promise.all([loadHotels(tenantId, search, 0, false), loadAliases(tenantId)]);
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
    await loadAliases(tenantId);
  };

  const removeAlias = async (id: string) => {
    if (!tenantId || !supabase) return;
    const { error: deleteError } = await supabase.from("hotel_aliases").delete().eq("id", id).eq("tenant_id", tenantId);
    if (deleteError) {
      setError(deleteError.message);
      return;
    }
    await loadAliases(tenantId);
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
    await loadHotels(tenantId, search, 0, false);
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
    if (!Number.isFinite(parsedLat) || !Number.isFinite(parsedLng)) {
      setSaving(false);
      setError("Coordinate non valide.");
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
    await loadHotels(tenantId, search, 0, false);
  };

  const createHotel = async () => {
    if (!tenantId || !supabase) return;
    if (!createDraft.name.trim()) { setError("Il nome è obbligatorio."); return; }
    setSaving(true);
    setError("");
    const parsedLat = createDraft.lat ? Number(createDraft.lat) : null;
    const parsedLng = createDraft.lng ? Number(createDraft.lng) : null;
    const zone = createDraft.zone || "Ischia Porto";
    const centroid = zoneCentroids[(zone as keyof typeof zoneCentroids)] ?? zoneCentroids["Ischia Porto"];
    const { error: insertError } = await supabase.from("hotels").insert({
      tenant_id: tenantId,
      name: createDraft.name.trim(),
      normalized_name: createDraft.name.trim().toLowerCase().replace(/\s+/g, " "),
      address: createDraft.address.trim() || "Ischia",
      city: createDraft.city.trim() || "Ischia",
      zone,
      lat: parsedLat && Number.isFinite(parsedLat) ? parsedLat : centroid.lat,
      lng: parsedLng && Number.isFinite(parsedLng) ? parsedLng : centroid.lng,
      is_active: createDraft.is_active,
      source: "manual"
    });
    setSaving(false);
    if (insertError) { setError(insertError.message); return; }
    setShowCreateForm(false);
    setCreateDraft({ name: "", address: "", city: "Ischia", zone: "Ischia Porto", lat: "", lng: "", is_active: true });
    setMessage(`Hotel "${createDraft.name.trim()}" creato.`);
    await loadHotels(tenantId, search, 0, false);
  };

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Hotel</h1>
          <p className="text-sm text-slate-600">
            Totale: {totalCount} | Coordinate mancanti (pagina corrente): {missingCoordsCount}
          </p>
        </div>
        <label className="text-sm">
          Cerca
          <input
            value={search}
            onChange={(event) => {
              const nextSearch = event.target.value;
              setSearch(nextSearch);
              if (tenantId) void loadHotels(tenantId, nextSearch, 0, false);
            }}
            placeholder="Nome, zona, indirizzo"
            className="ml-2 w-72 max-w-full rounded-lg border border-slate-300 px-3 py-2"
          />
        </label>
      </div>

      {initializing || loading ? <div className="card p-4 text-sm text-slate-500">Caricamento hotel...</div> : null}
      {!initializing && !loading && error ? <div className="card p-4 text-sm text-red-600">{error}</div> : null}
      {!initializing && !loading && message ? <div className="card p-4 text-sm text-emerald-700">{message}</div> : null}

      {!initializing && !loading && !error ? (
        <>
          {canManageHotels ? (
            <article className="card space-y-3 p-4">
              <h2 className="text-sm font-semibold uppercase tracking-[0.1em] text-slate-600">Strumenti admin hotel</h2>
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
                  </div>
                  <button type="button" onClick={() => void createHotel()} disabled={saving} className="mt-3 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
                    {saving ? "Creazione..." : "Crea hotel"}
                  </button>
                </div>
              ) : null}
              <p className="text-xs text-slate-500">
                Zone supportate: {HOTEL_ZONES.join(", ")}. Se lat/lng mancano, viene usato il centroide zona.
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
                    <th className="px-3 py-2 font-medium">Nome</th>
                    <th className="px-3 py-2 font-medium">Indirizzo</th>
                    <th className="px-3 py-2 font-medium">Città</th>
                    <th className="px-3 py-2 font-medium">Zona</th>
                    <th className="px-3 py-2 font-medium">Lat</th>
                    <th className="px-3 py-2 font-medium">Lng</th>
                    <th className="px-3 py-2 font-medium">Fonte</th>
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
                            <span className="line-clamp-2 break-words uppercase">{hotel.name}</span>
                          )}
                        </td>
                        <td className="max-w-80 px-3 py-2">
                          {isEditing ? (
                            <input
                              value={editDraft.address}
                              onChange={(event) => setEditDraft({ ...editDraft, address: event.target.value })}
                              className="w-64 rounded-md border border-slate-300 px-2 py-1"
                            />
                          ) : (
                            <span className="line-clamp-2 break-words">{hotel.address}</span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {isEditing ? (
                            <input
                              value={editDraft.city}
                              onChange={(event) => setEditDraft({ ...editDraft, city: event.target.value })}
                              className="w-32 rounded-md border border-slate-300 px-2 py-1"
                            />
                          ) : (
                            hotel.city ?? "Ischia"
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {isEditing ? (
                            <select
                              value={editDraft.zone}
                              onChange={(event) => setEditDraft({ ...editDraft, zone: event.target.value })}
                              className="w-40 rounded-md border border-slate-300 px-2 py-1 text-sm"
                            >
                              {HOTEL_ZONES.map((z) => <option key={z} value={z}>{z}</option>)}
                            </select>
                          ) : (
                            <span className="text-sm text-slate-700">{hotel.zone || "N/D"}</span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {isEditing ? (
                            <input
                              value={editDraft.lat}
                              onChange={(event) => setEditDraft({ ...editDraft, lat: event.target.value })}
                              className="w-24 rounded-md border border-slate-300 px-2 py-1"
                            />
                          ) : (
                            formatCoord(hotel.lat)
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {isEditing ? (
                            <input
                              value={editDraft.lng}
                              onChange={(event) => setEditDraft({ ...editDraft, lng: event.target.value })}
                              className="w-24 rounded-md border border-slate-300 px-2 py-1"
                            />
                          ) : (
                            formatCoord(hotel.lng)
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <span className="rounded-md bg-slate-100 px-2 py-1 text-xs uppercase tracking-wide text-slate-600">
                            {hotel.source ?? "manual"}
                          </span>
                          {hotel.source_osm_type && hotel.source_osm_id ? (
                            <div className="mt-1 text-xs text-slate-500">
                              {hotel.source_osm_type}:{hotel.source_osm_id}
                            </div>
                          ) : null}
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
