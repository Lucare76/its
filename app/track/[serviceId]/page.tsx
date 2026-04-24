"use client";

import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import { supabase } from "@/lib/supabase/client";

type DriverPosition = { lat: number; lng: number; ts: number };

export default function TrackPage({ params }: { params: { serviceId: string } }) {
  const { serviceId } = params;
  const mapRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<DriverPosition | null>(null);
  const [connected, setConnected] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);

  /* ---- map init */
  useEffect(() => {
    if (!mapRef.current || mapInstanceRef.current) return;
    const map = L.map(mapRef.current, {
      center: [40.7448, 13.9470],
      zoom: 13,
      zoomControl: true,
    });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap contributors",
      maxZoom: 19,
    }).addTo(map);
    const icon = L.divIcon({
      html: `<div style="background:#4f46e5;width:22px;height:22px;border-radius:50%;border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.35);"></div>`,
      className: "",
      iconSize: [22, 22],
      iconAnchor: [11, 11],
    });
    markerRef.current = L.marker([40.7448, 13.9470], { icon, opacity: 0 }).addTo(map);
    mapInstanceRef.current = map;
  }, []);

  /* ---- move marker on position update */
  useEffect(() => {
    if (!position || !mapInstanceRef.current || !markerRef.current) return;
    const ll: L.LatLngTuple = [position.lat, position.lng];
    markerRef.current.setLatLng(ll).setOpacity(1);
    mapInstanceRef.current.setView(ll, mapInstanceRef.current.getZoom());
  }, [position]);

  /* ---- Realtime presence subscription */
  useEffect(() => {
    if (!supabase) return;
    const ch = supabase.channel(`driver-track-${serviceId}`, {
      config: { presence: { key: "tracking" } },
    });
    ch.on("presence", { event: "sync" }, () => {
      const state = ch.presenceState<DriverPosition>();
      const all = Object.values(state).flat() as DriverPosition[];
      if (!all.length) return;
      const latest = all.reduce((best, cur) => (cur.ts > best.ts ? cur : best));
      setPosition({ lat: latest.lat, lng: latest.lng, ts: latest.ts });
      setLastUpdate(new Date());
    });
    ch.subscribe((status) => setConnected(status === "SUBSCRIBED"));
    return () => { void supabase?.removeChannel(ch); };
  }, [serviceId]);

  const minutesAgo = lastUpdate ? Math.floor((Date.now() - lastUpdate.getTime()) / 60000) : null;

  return (
    <div className="flex min-h-screen flex-col bg-slate-950 text-white">
      <div className="px-5 py-4 bg-slate-900 border-b border-slate-800">
        <div className="mx-auto max-w-lg flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-slate-400">Ischia Transfer Service</p>
            <p className="text-lg font-bold mt-0.5">Posizione autista in tempo reale</p>
          </div>
          <span className={`rounded-full px-3 py-1 text-xs font-bold ${connected ? "bg-emerald-500" : "bg-slate-600"}`}>
            {connected ? "● Live" : "● Attesa"}
          </span>
        </div>
      </div>

      <div className="flex-1 relative" style={{ minHeight: "65vh" }}>
        <div ref={mapRef} className="absolute inset-0" />
        {!position && (
          <div className="absolute inset-0 flex items-center justify-center bg-slate-900/80 z-[1000]">
            <div className="text-center px-6">
              <div className="text-5xl mb-3">📍</div>
              <p className="text-sm text-slate-300 font-medium">
                {connected ? "In attesa della posizione dell'autista..." : "Connessione in corso..."}
              </p>
            </div>
          </div>
        )}
      </div>

      <div className="px-5 py-4 bg-slate-900 border-t border-slate-800">
        <div className="mx-auto max-w-lg text-center">
          {lastUpdate ? (
            <p className="text-sm text-slate-300">
              Aggiornato {minutesAgo === 0 ? "adesso" : `${minutesAgo} min fa`}
            </p>
          ) : (
            <p className="text-sm text-slate-500">Posizione non ancora disponibile</p>
          )}
          <p className="text-xs text-slate-600 mt-1">
            La posizione si aggiorna automaticamente ogni pochi secondi.
          </p>
        </div>
      </div>
    </div>
  );
}
