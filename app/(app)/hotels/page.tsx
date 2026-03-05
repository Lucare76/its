"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { HOTEL_ZONES, inferZoneFromText, isMissingCoordinates, zoneCentroids } from "@/lib/hotel-geocoding";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";

interface HotelListItem {
  id: string;
  name: string;
  zone: string;
  address: string;
  lat: number;
  lng: number;
}

const PAGE_SIZE = 20;

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
  const [csvMessage, setCsvMessage] = useState("");
  const [error, setError] = useState("");

  const loadHotels = useCallback(
    async (currentTenantId: string, termInput: string, offset: number, append: boolean) => {
      if (!supabase) return;
      const nextLimit = offset + PAGE_SIZE - 1;
      const term = termInput.trim().replaceAll(",", " ");

      append ? setLoadingMore(true) : setLoading(true);
      setError("");

      let query = supabase
        .from("hotels")
        .select("id,name,zone,address,lat,lng", { count: "exact" })
        .eq("tenant_id", currentTenantId)
        .order("name", { ascending: true })
        .range(offset, nextLimit);

      if (term) {
        query = query.or(`name.ilike.%${term}%,zone.ilike.%${term}%,address.ilike.%${term}%`);
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
      await loadHotels(membership.tenant_id, "", 0, false);
    };

    void loadTenant();
    return () => {
      isActive = false;
    };
  }, [loadHotels]);

  const hasMore = items.length < totalCount;
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

  const applyAutoFillMissingCoords = async () => {
    if (!tenantId || !supabase) return;
    setImporting(true);
    setCsvMessage("");

    const { data, error: fetchError } = await supabase
      .from("hotels")
      .select("id,name,address,zone,lat,lng")
      .eq("tenant_id", tenantId);

    if (fetchError) {
      setImporting(false);
      setCsvMessage(fetchError.message);
      return;
    }

    const rows = (data ?? []) as HotelListItem[];
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
      setCsvMessage("Nessun hotel da aggiornare.");
      return;
    }

    let updated = 0;
    for (const row of updates) {
      const { error: updateError } = await supabase
        .from("hotels")
        .update({ zone: row.zone, lat: row.lat, lng: row.lng })
        .eq("id", row.id)
        .eq("tenant_id", tenantId);
      if (!updateError) updated += 1;
    }

    await loadHotels(tenantId, search, 0, false);
    setImporting(false);
    setCsvMessage(`Aggiornati ${updated} hotel (auto-fill coordinate/zone).`);
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
    setCsvMessage("");

    const csvText = await file.text();
    const rows = parseCsv(csvText);
    if (rows.length === 0) {
      setImporting(false);
      setCsvMessage("CSV vuoto o formato non valido.");
      return;
    }

    const { data: allHotelsData, error: allHotelsError } = await supabase
      .from("hotels")
      .select("id,name,address,zone,lat,lng")
      .eq("tenant_id", tenantId);

    if (allHotelsError) {
      setImporting(false);
      setCsvMessage(allHotelsError.message);
      return;
    }

    const allHotels = (allHotelsData ?? []) as HotelListItem[];
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
        lng: Number.isFinite(parsedLng) ? Number(parsedLng) : isMissingCoordinates(target.lat, target.lng) ? centroid.lng : target.lng
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

    await loadHotels(tenantId, search, 0, false);
    setImporting(false);
    setCsvMessage(`CSV import completato. Aggiornati: ${updated}. Skippati: ${skipped}.`);
  };

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Hotels</h1>
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
              if (tenantId) {
                void loadHotels(tenantId, nextSearch, 0, false);
              }
            }}
            placeholder="Nome, zona, indirizzo"
            className="ml-2 w-72 rounded-lg border border-slate-300 px-3 py-2"
          />
        </label>
      </div>

      {initializing || loading ? (
        <div className="card p-4 text-sm text-slate-500">Caricamento hotel...</div>
      ) : error ? (
        <div className="card p-4 text-sm text-red-600">{error}</div>
      ) : (
        <>
          {role === "admin" ? (
            <article className="card space-y-3 p-4">
              <h2 className="text-sm font-semibold uppercase tracking-[0.1em] text-slate-600">Admin geocoding tool</h2>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void applyAutoFillMissingCoords()}
                  disabled={importing}
                  className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium disabled:opacity-50"
                >
                  {importing ? "Aggiornamento..." : "Auto-fill missing lat/lng"}
                </button>
                <label className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium hover:bg-slate-50">
                  CSV upload (id,name,address,zone,lat,lng)
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
              </div>
              <p className="text-xs text-slate-500">
                Zone supportate: {HOTEL_ZONES.join(", ")}. Se lat/lng mancano, viene usato il centroide zona.
              </p>
              {csvMessage ? <p className="text-sm text-slate-700">{csvMessage}</p> : null}
            </article>
          ) : null}

          {items.length === 0 ? (
            <div className="card p-4 text-sm text-slate-500">Nessun hotel trovato.</div>
          ) : (
            groupedItems.map(([zone, hotels]) => (
              <article key={zone} className="card overflow-x-auto">
                <div className="border-b border-slate-100 px-3 py-2 text-sm font-semibold text-slate-700">
                  {zone} ({hotels.length})
                </div>
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-50 text-left text-slate-600">
                    <tr>
                      <th className="px-3 py-2 font-medium">Name</th>
                      <th className="px-3 py-2 font-medium">Address</th>
                      <th className="px-3 py-2 font-medium">Lat</th>
                      <th className="px-3 py-2 font-medium">Lng</th>
                    </tr>
                  </thead>
                  <tbody>
                    {hotels.map((hotel) => (
                      <tr key={hotel.id} className="border-t border-slate-100">
                        <td className="px-3 py-2">{hotel.name}</td>
                        <td className="px-3 py-2">{hotel.address}</td>
                        <td className="px-3 py-2">{hotel.lat.toFixed(5)}</td>
                        <td className="px-3 py-2">{hotel.lng.toFixed(5)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </article>
            ))
          )}

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
      )}
    </section>
  );
}
