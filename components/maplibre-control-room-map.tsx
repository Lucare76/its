"use client";

import { useEffect, useMemo, useRef } from "react";
import maplibregl, { type Map as MapLibreMap, type Marker } from "maplibre-gl";
import type { GpsControlRoomEntry } from "@/lib/types";

const STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
const DEFAULT_CENTER: [number, number] = [13.9124, 40.7395];

// Perimetro operativo semplificato di Ischia con un piccolo margine costiero.
// Evita che coordinate GPS anomale nel mare vengano mostrate come posizioni valide.
const ISCHIA_OPERATING_POLYGON: Array<[number, number]> = [
  [13.770, 40.733],
  [13.783, 40.705],
  [13.818, 40.685],
  [13.866, 40.676],
  [13.919, 40.690],
  [13.965, 40.711],
  [13.977, 40.742],
  [13.964, 40.771],
  [13.925, 40.797],
  [13.872, 40.801],
  [13.818, 40.787],
  [13.783, 40.762],
];

function isInsideIschiaOperatingArea(entry: GpsControlRoomEntry) {
  let inside = false;
  for (let current = 0, previous = ISCHIA_OPERATING_POLYGON.length - 1; current < ISCHIA_OPERATING_POLYGON.length; previous = current++) {
    const [currentLng, currentLat] = ISCHIA_OPERATING_POLYGON[current];
    const [previousLng, previousLat] = ISCHIA_OPERATING_POLYGON[previous];
    const crossesLatitude = currentLat > entry.lat !== previousLat > entry.lat;
    const edgeLng = ((previousLng - currentLng) * (entry.lat - currentLat)) / (previousLat - currentLat) + currentLng;
    if (crossesLatitude && entry.lng < edgeLng) inside = !inside;
  }
  return inside;
}

function markerTone(entry: GpsControlRoomEntry, selected: boolean) {
  if (selected) return "#4f46e5";
  if (entry.status_key === "moving") return "#16a34a";
  if (entry.status_key === "warning") return "#f59e0b";
  if (entry.status_key === "stopped") return "#ef4444";
  return "#64748b";
}

function vehicleKind(entry: GpsControlRoomEntry) {
  const value = `${entry.pms_label ?? ""} ${entry.label} ${entry.line_name ?? ""}`.toLowerCase();
  if (value.includes("bus")) return "BUS";
  if (value.includes("van") || value.includes("vito") || value.includes("ducato")) return "VAN";
  return "AUTO";
}

function markerElement(entry: GpsControlRoomEntry, selected: boolean) {
  const root = document.createElement("button");
  root.type = "button";
  root.className = "group relative flex items-center justify-center rounded-full border-2 border-white text-white shadow-[0_8px_22px_rgba(15,23,42,.28)] transition-transform hover:scale-110";
  root.style.width = selected ? "46px" : "36px";
  root.style.height = selected ? "46px" : "36px";
  root.style.background = markerTone(entry, selected);
  root.style.boxShadow = selected ? "0 0 0 7px rgba(79,70,229,.20),0 10px 28px rgba(15,23,42,.30)" : "0 8px 22px rgba(15,23,42,.28)";
  root.innerHTML = `<span style="font:800 ${selected ? 10 : 8}px ui-sans-serif,system-ui">${vehicleKind(entry)}</span>`;
  root.setAttribute("aria-label", entry.pms_label ?? entry.label);
  return root;
}

export function MapLibreControlRoomMap({ entries, selectedId, onSelect, onFailure }: {
  entries: GpsControlRoomEntry[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onFailure: () => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markersRef = useRef<Marker[]>([]);
  const loadedRef = useRef(false);
  const mapEntries = useMemo(() => entries.filter((entry) => Number.isFinite(entry.lat) && Number.isFinite(entry.lng) && isInsideIschiaOperatingArea(entry)), [entries]);
  const excludedCount = entries.length - mapEntries.length;

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: STYLE_URL,
      center: DEFAULT_CENTER,
      zoom: 11.7,
      pitch: 18,
      bearing: 0,
      attributionControl: {},
    });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
    map.addControl(new maplibregl.FullscreenControl(), "top-right");
    map.on("load", () => { loadedRef.current = true; });
    map.on("error", () => { if (!loadedRef.current) onFailure(); });
    const timeout = window.setTimeout(() => { if (!loadedRef.current) onFailure(); }, 12000);
    mapRef.current = map;
    return () => {
      window.clearTimeout(timeout);
      markersRef.current.forEach((marker) => marker.remove());
      markersRef.current = [];
      mapRef.current = null;
      map.remove();
    };
  }, [onFailure]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    markersRef.current.forEach((marker) => marker.remove());
    markersRef.current = mapEntries.map((entry) => {
      const selected = entry.radius_vehicle_id === selectedId;
      const element = markerElement(entry, selected);
      element.onclick = () => onSelect(entry.radius_vehicle_id);
      const popup = new maplibregl.Popup({ offset: 24, closeButton: false, maxWidth: "290px" }).setHTML(
        `<div style="font:13px ui-sans-serif,system-ui;color:#0f172a"><strong style="font-size:14px">${entry.pms_label ?? entry.label}</strong><div style="margin-top:6px;color:#475569">${entry.driver_name ?? "Autista non assegnato"}</div><div style="margin-top:3px;color:#64748b">${entry.current_address ?? entry.current_city ?? "Posizione non disponibile"}</div></div>`
      );
      return new maplibregl.Marker({ element, anchor: "center" }).setLngLat([entry.lng, entry.lat]).setPopup(popup).addTo(map);
    });
    if (mapEntries.length > 0 && !selectedId) {
      const bounds = new maplibregl.LngLatBounds();
      mapEntries.forEach((entry) => bounds.extend([entry.lng, entry.lat]));
      if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 70, maxZoom: 13 });
    }
  }, [mapEntries, onSelect, selectedId]);

  useEffect(() => {
    const map = mapRef.current;
    const selected = entries.find((entry) => entry.radius_vehicle_id === selectedId);
    if (map && selected && isInsideIschiaOperatingArea(selected)) map.flyTo({ center: [selected.lng, selected.lat], zoom: Math.max(map.getZoom(), 13.5), duration: 650 });
  }, [entries, selectedId]);

  return <div className="relative"><div ref={containerRef} className="h-[clamp(520px,64vh,700px)] w-full bg-sky-50" />{excludedCount > 0 ? <div className="absolute bottom-9 left-3 z-10 rounded-lg border border-amber-200 bg-white/95 px-3 py-2 text-[11px] font-semibold text-amber-800 shadow-lg">{excludedCount} {excludedCount === 1 ? "posizione GPS fuori area non mostrata" : "posizioni GPS fuori area non mostrate"}</div> : null}</div>;
}
