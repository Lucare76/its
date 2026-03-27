"use client";

import { useEffect, useRef } from "react";
import L from "leaflet";
import type { GpsLiveEntry } from "@/lib/types";

interface LiveBusMapProps {
  entries: GpsLiveEntry[];
  selectedId: string | null;
  onSelect: (radiusVehicleId: string) => void;
}

const DEFAULT_CENTER: [number, number] = [40.74, 13.92];
const TILE_URL = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function busColors(entry: GpsLiveEntry, selected: boolean) {
  if (selected) return { bg: "#1d4ed8", border: "#1e3a8a", text: "#ffffff" };
  if (!entry.online) return { bg: "#94a3b8", border: "#64748b", text: "#ffffff" };
  if (entry.pms_vehicle_id) return { bg: "#0d9488", border: "#0f766e", text: "#ffffff" };
  return { bg: "#f59e0b", border: "#b45309", text: "#1c1917" };
}

function busIcon(entry: GpsLiveEntry, selected: boolean): L.DivIcon {
  const { bg, border, text } = busColors(entry, selected);
  const size = selected ? 46 : 38;
  const label = escapeHtml((entry.pms_label ?? entry.label).slice(0, 14));

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 40 40">
      <rect x="2" y="2" width="36" height="36" rx="8" ry="8"
        fill="${bg}" stroke="${border}" stroke-width="2.5"/>
      <rect x="7" y="8" width="26" height="16" rx="3"
        fill="none" stroke="${text}" stroke-width="1.8" opacity="0.9"/>
      <rect x="9" y="10" width="9" height="7" rx="1.5" fill="${text}" opacity="0.85"/>
      <rect x="22" y="10" width="9" height="7" rx="1.5" fill="${text}" opacity="0.85"/>
      <rect x="7" y="26" width="26" height="4" rx="2" fill="${text}" opacity="0.5"/>
      <circle cx="12" cy="33" r="3" fill="${border}" stroke="${text}" stroke-width="1.2"/>
      <circle cx="28" cy="33" r="3" fill="${border}" stroke="${text}" stroke-width="1.2"/>
    </svg>`;

  return L.divIcon({
    html: `
      <div style="display:flex;flex-direction:column;align-items:center;gap:2px;">
        ${svg}
        <div style="
          background:${bg};
          border:1.5px solid ${border};
          color:${text};
          font-size:10px;
          font-weight:600;
          font-family:system-ui,sans-serif;
          padding:1px 5px;
          border-radius:4px;
          white-space:nowrap;
          max-width:90px;
          overflow:hidden;
          text-overflow:ellipsis;
          box-shadow:0 1px 3px rgba(0,0,0,.25);
        ">${label}</div>
      </div>`,
    className: "",
    iconSize: [size, size + 20],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -(size / 2)]
  });
}

function formatTimestamp(ts: string): string {
  try {
    return new Date(ts).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return ts;
  }
}

export function LiveBusMap({ entries, selectedId, onSelect }: LiveBusMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersRef = useRef<L.LayerGroup | null>(null);
  const fittedRef = useRef(false); // fitBounds solo al primo caricamento

  // Init mappa una volta sola
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, { zoomControl: true }).setView(DEFAULT_CENTER, 12);
    L.tileLayer(TILE_URL, { attribution: "&copy; OpenStreetMap contributors" }).addTo(map);
    mapRef.current = map;
    markersRef.current = L.layerGroup().addTo(map);

    return () => {
      markersRef.current?.clearLayers();
      markersRef.current = null;
      map.remove();
      mapRef.current = null;
      fittedRef.current = false;
    };
  }, []);

  // Ridisegna marker quando cambiano entries o selezione
  useEffect(() => {
    const map = mapRef.current;
    const markers = markersRef.current;
    if (!map || !markers) return;

    markers.clearLayers();
    const bounds = L.latLngBounds([]);

    entries.forEach((entry) => {
      if (!entry.lat || !entry.lng) return;

      const isSelected = selectedId === entry.radius_vehicle_id;
      const icon = busIcon(entry, isSelected);
      const marker = L.marker([entry.lat, entry.lng], { icon });

      const label = escapeHtml(entry.pms_label ?? entry.label);
      const line = entry.line_name ? `<br/>Linea: ${escapeHtml(entry.line_name)}` : "";
      const speed = entry.speed_kmh !== null ? `<br/>${entry.speed_kmh} km/h` : "";
      const updated = `<br/><span style="color:#64748b;font-size:11px">Agg. ${formatTimestamp(entry.timestamp)}</span>`;
      const offline = !entry.online ? `<br/><span style="color:#ef4444;font-size:11px">OFFLINE</span>` : "";

      marker.bindPopup(`<strong>${label}</strong>${line}${speed}${offline}${updated}`, { maxWidth: 200 });
      marker.on("click", () => onSelect(entry.radius_vehicle_id));
      marker.addTo(markers);
      bounds.extend([entry.lat, entry.lng]);
    });

    // fitBounds solo al primo caricamento dati, non ad ogni refresh
    if (!fittedRef.current && bounds.isValid()) {
      map.fitBounds(bounds.pad(0.2), { maxZoom: 13, animate: false });
      fittedRef.current = true;
    }
  }, [entries, selectedId, onSelect]);

  // Pan sul veicolo selezionato senza toccare lo zoom
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !selectedId) return;
    const entry = entries.find((e) => e.radius_vehicle_id === selectedId);
    if (entry?.lat && entry?.lng) {
      map.panTo([entry.lat, entry.lng], { animate: true, duration: 0.4 });
    }
  }, [selectedId, entries]);

  return (
    <div className="card overflow-hidden" style={{ height: "560px" }}>
      <div ref={containerRef} style={{ height: "100%", width: "100%" }} />
    </div>
  );
}
