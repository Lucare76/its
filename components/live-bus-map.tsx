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

function busColor(entry: GpsLiveEntry, selected: boolean) {
  if (!entry.online) return { stroke: "#64748b", fill: "#94a3b8" };
  if (selected) return { stroke: "#1d4ed8", fill: "#3b82f6" };
  if (entry.pms_vehicle_id) return { stroke: "#0f766e", fill: "#14b8a6" };
  return { stroke: "#b45309", fill: "#fbbf24" };
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
      const { stroke, fill } = busColor(entry, isSelected);
      const radius = isSelected ? 14 : 10;

      const marker = L.circleMarker([entry.lat, entry.lng], {
        radius,
        color: stroke,
        weight: 2.5,
        fillColor: fill,
        fillOpacity: isSelected ? 0.95 : 0.8
      });

      const label = escapeHtml(entry.pms_label ?? entry.label);
      const driver = entry.driver_name ? `<br/>Autista: ${escapeHtml(entry.driver_name)}` : "";
      const line = entry.line_name ? `<br/>Linea: ${escapeHtml(entry.line_name)}` : "";
      const speed = entry.speed_kmh !== null ? `<br/>${entry.speed_kmh} km/h` : "";
      const updated = `<br/><span style="color:#64748b;font-size:11px">Agg. ${formatTimestamp(entry.timestamp)}</span>`;
      const offline = !entry.online ? `<br/><span style="color:#ef4444;font-size:11px">OFFLINE</span>` : "";

      marker.bindPopup(`<strong>${label}</strong>${line}${driver}${speed}${offline}${updated}`);
      marker.on("click", () => onSelect(entry.radius_vehicle_id));
      marker.addTo(markers);
      bounds.extend([entry.lat, entry.lng]);
    });

    if (bounds.isValid()) {
      map.fitBounds(bounds.pad(0.3), { maxZoom: 14 });
    } else {
      map.setView(DEFAULT_CENTER, 12);
    }
  }, [entries, selectedId, onSelect]);

  // Centra sul veicolo selezionato senza ridisegnare tutto
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !selectedId) return;
    const entry = entries.find((e) => e.radius_vehicle_id === selectedId);
    if (entry?.lat && entry?.lng) {
      map.panTo([entry.lat, entry.lng], { animate: true });
    }
  }, [selectedId, entries]);

  return (
    <div className="card h-[540px] overflow-hidden">
      <div ref={containerRef} style={{ height: "100%", width: "100%" }} />
    </div>
  );
}
