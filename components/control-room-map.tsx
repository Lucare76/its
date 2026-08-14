"use client";

import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import type { GpsControlRoomEntry } from "@/lib/types";

interface ControlRoomMapProps {
  entries: GpsControlRoomEntry[];
  selectedId: string | null;
  onSelect: (radiusVehicleId: string) => void;
  compact?: boolean;
}

const DEFAULT_CENTER: [number, number] = [40.7395, 13.9124];

const TILE_URL = "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png";
const PROTOMAPS_URL =
  process.env.NEXT_PUBLIC_PROTOMAPS_PM_TILES_URL?.trim() ||
  process.env.NEXT_PUBLIC_PROTOMAPS_PMtiles_URL?.trim() ||
  "";

const OPERATING_PORTS = [
  { name: "Ischia Porto", lat: 40.7329, lng: 13.9477, tone: "#0f766e" },
  { name: "Casamicciola", lat: 40.7507, lng: 13.9013, tone: "#0369a1" },
  { name: "Forio", lat: 40.7355, lng: 13.8675, tone: "#7c3aed" },
  { name: "Lacco Ameno", lat: 40.7580, lng: 13.8887, tone: "#be123c" }
];

const OPERATING_ZONES = [
  { name: "Ischia / Barano", lat: 40.7240, lng: 13.9555, radius: 2400, tone: "#0f766e" },
  { name: "Casamicciola / Lacco", lat: 40.7520, lng: 13.8955, radius: 2300, tone: "#0369a1" },
  { name: "Forio / Panza", lat: 40.7265, lng: 13.8525, radius: 3200, tone: "#7c3aed" },
  { name: "Serrara / Barano alto", lat: 40.7072, lng: 13.9142, radius: 2800, tone: "#b45309" }
];

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function statusPalette(status: GpsControlRoomEntry["status_key"], selected: boolean) {
  if (selected) return { bg: "#2563eb", border: "#1d4ed8", text: "#eff6ff", glow: "0 0 0 7px rgba(37,99,235,0.18)" };
  if (status === "moving") return { bg: "#16a34a", border: "#15803d", text: "#f0fdf4", glow: "0 0 0 6px rgba(34,197,94,0.18)" };
  if (status === "stopped") return { bg: "#dc2626", border: "#b91c1c", text: "#fff1f2", glow: "0 0 0 6px rgba(239,68,68,0.16)" };
  if (status === "warning") return { bg: "#f59e0b", border: "#d97706", text: "#1c1917", glow: "0 0 0 6px rgba(245,158,11,0.18)" };
  return { bg: "#64748b", border: "#475569", text: "#f8fafc", glow: "0 0 0 6px rgba(100,116,139,0.16)" };
}

function busIcon(entry: GpsControlRoomEntry, selected: boolean) {
  const offlineWithActiveService = entry.status_key === "offline" && Boolean(entry.active_service);
  const palette = offlineWithActiveService && !selected
    ? { bg: "#be123c", border: "#881337", text: "#fff1f2", glow: "0 0 0 7px rgba(225,29,72,0.2)" }
    : statusPalette(entry.status_key, selected);
  const iconSurface = "#ffffff";
  const accent = palette.bg;
  const label = escapeHtml((entry.pms_label ?? entry.label).slice(0, selected ? 18 : 12));
  const line = escapeHtml((entry.line_name ?? "").slice(0, selected ? 16 : 11));
  const driver = escapeHtml((entry.driver_name ?? "").slice(0, selected ? 18 : 13));
  const critical = entry.status_key === "warning" || entry.status_key === "stopped" || offlineWithActiveService;
  const showDetails = selected || critical;
  const size = selected ? 48 : critical ? 42 : 36;
  const speed = entry.speed_kmh !== null ? Math.round(entry.speed_kmh) : null;
  const vehicleText = `${entry.pms_label ?? ""} ${entry.label} ${entry.line_name ?? ""}`.toLowerCase();
  const vehicleKind = vehicleText.includes("bus") ? "bus" : vehicleText.includes("van") || vehicleText.includes("vito") || vehicleText.includes("ducato") ? "van" : "car";
  const vehicleSvg = vehicleKind === "bus"
    ? `<rect x="8" y="8" width="24" height="23" rx="5" fill="#fff" stroke="#1f2937" stroke-width="1.8"/><path d="M12 12h16v9H12z" fill="${accent}"/><circle cx="14" cy="30" r="3" fill="#1f2937"/><circle cx="27" cy="30" r="3" fill="#1f2937"/>`
    : vehicleKind === "van"
      ? `<path d="M7 25V14c0-3 2-5 5-5h12c4 0 7 3 7 7v9H7Z" fill="#fff" stroke="#1f2937" stroke-width="1.8"/><path d="M12 13h11v7H12z" fill="${accent}"/><circle cx="13" cy="27" r="3" fill="#1f2937"/><circle cx="27" cy="27" r="3" fill="#1f2937"/>`
      : `<path d="M7 24l3-9c.7-2 2.3-3 4.5-3h11c2 0 3.5 1 4.2 2.8L33 24v5H7v-5Z" fill="#fff" stroke="#1f2937" stroke-width="1.8"/><path d="M12 16h15l2 6H10l2-6Z" fill="${accent}"/><circle cx="13" cy="29" r="3" fill="#1f2937"/><circle cx="28" cy="29" r="3" fill="#1f2937"/>`;

  return L.divIcon({
    className: "",
    html: `
      <div style="display:flex;flex-direction:column;align-items:center;gap:7px;">
        <div style="
          width:${size}px;
          height:${size}px;
          display:flex;
          align-items:center;
          justify-content:center;
          border-radius:50% 50% 50% 10px;
          border:2px solid #ffffff;
          background:${accent};
          color:${iconSurface};
          box-shadow:${palette.glow}, 0 12px 24px rgba(15,23,42,0.18);
          position:relative;
          transform:rotate(-45deg);
          overflow:hidden;
        ">
          <div style="
            position:absolute;
            inset:5px;
            border-radius:999px;
            background:${iconSurface};
            box-shadow:inset 0 -1px 0 rgba(15,23,42,0.08);
          "></div>
          <svg xmlns="http://www.w3.org/2000/svg" width="${size - 13}" height="${size - 13}" viewBox="0 0 40 40" fill="none" style="position:relative;z-index:1;transform:rotate(45deg);">
            ${vehicleSvg}
          </svg>
          ${offlineWithActiveService && !selected ? `
            <div style="
              position:absolute;
              top:-6px;
              right:-6px;
              min-width:18px;
              height:18px;
              border-radius:999px;
              border:2px solid #fff;
              background:${accent};
              color:#fff;
              display:flex;
              align-items:center;
              justify-content:center;
              font-size:10px;
              font-weight:800;
              box-shadow:0 6px 16px rgba(15,23,42,0.18);
            ">!</div>
          ` : ""}
        </div>
        ${showDetails ? `
          <div style="
            min-width:${selected ? 132 : 104}px;
            max-width:${selected ? 158 : 132}px;
            border-radius:8px;
            border:1px solid rgba(148,163,184,0.22);
            background:rgba(255,255,255,0.96);
            box-shadow:0 12px 28px rgba(15,23,42,0.14);
            padding:${selected ? "8px 11px" : "6px 9px"};
            text-align:center;
            font-family:ui-sans-serif,system-ui,sans-serif;
            backdrop-filter:blur(10px);
          ">
            <div style="font-size:11px;font-weight:700;color:#0f172a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${label}</div>
            ${selected ? `<div style="margin-top:2px;font-size:10px;color:#64748b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${line || "Bus live"}</div>` : ""}
            ${selected && driver ? `<div style="margin-top:1px;font-size:10px;color:#475569;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${driver}</div>` : ""}
            <div style="margin-top:4px;display:inline-flex;align-items:center;justify-content:center;border-radius:999px;background:${accent};padding:3px 8px;font-size:10px;font-weight:800;color:${palette.text};">${speed !== null ? `${speed} km/h` : "-- km/h"}</div>
          </div>
        ` : ""}
      </div>
    `,
    iconSize: [size + (showDetails ? 20 : 8), size + (showDetails ? 44 : 8)],
    iconAnchor: [size / 2 + (showDetails ? 10 : 4), size],
    popupAnchor: [0, -(size + 6)]
  });
}

function formatTimestamp(ts: string) {
  try {
    return new Date(ts).toLocaleString("it-IT", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return ts;
  }
}

function addOsmLayer(map: L.Map) {
  return L.tileLayer(TILE_URL, {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    detectRetina: true,
    maxZoom: 20,
    subdomains: "abcd"
  }).addTo(map);
}

async function pmtilesIsReachable(url: string) {
  try {
    const response = await fetch(url, { method: "HEAD", cache: "no-store" });
    return response.ok;
  } catch {
    return false;
  }
}

async function addBaseLayer(map: L.Map): Promise<{ label: string; layer: L.Layer; cleanup?: () => void }> {
  if (!PROTOMAPS_URL) {
    return { label: "CARTO Voyager - fallback raster", layer: addOsmLayer(map) };
  }

  const reachable = await pmtilesIsReachable(PROTOMAPS_URL);
  if (!reachable) {
    return { label: "CARTO Voyager - PMTiles non trovato", layer: addOsmLayer(map) };
  }

  const { leafletLayer } = await import("protomaps-leaflet");
  const layer = leafletLayer({
    attribution: '<a href="https://protomaps.com">Protomaps</a> - <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>',
    flavor: "light",
    lang: "it",
    maxDataZoom: 14,
    maxZoom: 19,
    url: PROTOMAPS_URL
  }) as unknown as L.Layer;

  layer.addTo(map);
  return { label: "Protomaps self-hosted", layer };
}

/**
 * Distribuisce i mezzi molto vicini su piccole corone concentriche
 * per evitare pile di marker nello stesso punto.
 */
function spreadOverlapping(items: GpsControlRoomEntry[]): Array<GpsControlRoomEntry & { _lat: number; _lng: number }> {
  const PROXIMITY = 0.00018; // ~20m
  const BASE_OFFSET = 0.00022; // ~24m
  const groups: GpsControlRoomEntry[][] = [];

  for (const item of items) {
    const group = groups.find((candidate) => {
      const anchor = candidate[0];
      return Math.abs(anchor.lat - item.lat) <= PROXIMITY && Math.abs(anchor.lng - item.lng) <= PROXIMITY;
    });
    if (group) {
      group.push(item);
    } else {
      groups.push([item]);
    }
  }

  const result: Array<GpsControlRoomEntry & { _lat: number; _lng: number }> = [];
  for (const group of groups) {
    if (group.length === 1) {
      result.push({ ...group[0], _lat: group[0].lat, _lng: group[0].lng });
      continue;
    }

    group.forEach((item, i) => {
      const ring = Math.floor(i / 6);
      const ringStart = ring * 6;
      const pointsInRing = Math.min(6, group.length - ringStart);
      const positionInRing = i - ringStart;
      const angle = (2 * Math.PI * positionInRing) / pointsInRing;
      const radius = BASE_OFFSET * (1 + ring * 0.85 + Math.min(group.length, 8) * 0.08);

      result.push({
        ...item,
        _lat: item.lat + radius * Math.cos(angle),
        _lng: item.lng + radius * Math.sin(angle)
      });
    });
  }
  return result;
}

export function ControlRoomMap({ entries, selectedId, onSelect, compact = false }: ControlRoomMapProps) {
  const [baseLayerLabel, setBaseLayerLabel] = useState(PROTOMAPS_URL ? "Protomaps in caricamento" : "CARTO in caricamento");
  const [operationalLayerEnabled, setOperationalLayerEnabled] = useState(true);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersRef = useRef<L.LayerGroup | null>(null);
  const opsLayerRef = useRef<L.LayerGroup | null>(null);
  const fittedRef = useRef(false);
  const summary = entries.reduce(
    (acc, entry) => {
      acc.total += 1;
      if (entry.status_key === "moving") acc.moving += 1;
      if (entry.status_key === "stopped") acc.stopped += 1;
      if (entry.status_key === "warning") acc.warning += 1;
      if (entry.status_key === "offline") acc.offline += 1;
      return acc;
    },
    { total: 0, moving: 0, stopped: 0, warning: 0, offline: 0 }
  );

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    let disposed = false;
    let baseLayer: L.Layer | null = null;
    let baseLayerCleanup: (() => void) | undefined;
    const map = L.map(containerRef.current, {
      zoomControl: false,
      maxBounds: [[-85, -180], [85, 180]],
      maxBoundsViscosity: 1,
      minZoom: 1
    }).setView(DEFAULT_CENTER, 12);
    L.control.zoom({ position: "topright" }).addTo(map);
    mapRef.current = map;
    markersRef.current = L.layerGroup().addTo(map);
    opsLayerRef.current = L.layerGroup().addTo(map);

    void addBaseLayer(map).then((result) => {
      if (disposed) {
        result.cleanup?.();
        result.layer.remove();
        return;
      }
      baseLayer = result.layer;
      baseLayerCleanup = result.cleanup;
      setBaseLayerLabel(result.label);
    });

    return () => {
      disposed = true;
      markersRef.current?.clearLayers();
      opsLayerRef.current?.clearLayers();
      baseLayer?.remove();
      baseLayerCleanup?.();
      markersRef.current = null;
      opsLayerRef.current = null;
      mapRef.current = null;
      fittedRef.current = false;
      map.off();
      map.remove();
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const markers = markersRef.current;
    if (!map || !markers) return;

    markers.clearLayers();
    const bounds = L.latLngBounds([]);

    const spread = spreadOverlapping(entries.filter((e) => e.lat && e.lng));

    spread.forEach((entry) => {
      const selected = selectedId === entry.radius_vehicle_id;
      const zIndexOffset = selected ? 1400 : entry.status_key === "offline" && entry.active_service ? 900 : 0;
      const marker = L.marker([entry._lat, entry._lng], { icon: busIcon(entry, selected), zIndexOffset });

      // Linea tratteggiata verso la posizione reale se spostato
      if (entry._lat !== entry.lat || entry._lng !== entry.lng) {
        L.polyline(
          [[entry.lat, entry.lng], [entry._lat, entry._lng]],
          { color: "#94a3b8", weight: 1.2, dashArray: "4 5", opacity: 0.6 }
        ).addTo(markers);
      }

      const popup = `
        <div style="font-family:ui-sans-serif,system-ui,sans-serif;min-width:240px;color:#0f172a;">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;">
            <div style="font-size:15px;font-weight:800;line-height:1.15;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:165px;">${escapeHtml(entry.pms_label ?? entry.label)}</div>
            <div style="display:inline-flex;border-radius:999px;padding:4px 9px;background:#eff6ff;border:1px solid #bfdbfe;color:#1d4ed8;font-size:11px;font-weight:800;">
              ${escapeHtml(entry.status_label)}
            </div>
          </div>
          <div style="margin-top:12px;display:grid;gap:5px;font-size:12px;color:#475569;">
            <div>Linea: ${escapeHtml(entry.line_name ?? "N/D")}</div>
            <div>Autista: ${escapeHtml(entry.driver_name ?? "N/D")}</div>
            <div>Velocita: ${entry.speed_kmh !== null ? `${Math.round(entry.speed_kmh)} km/h` : "N/D"}</div>
            <div>Update: ${formatTimestamp(entry.timestamp)}</div>
            <div style="line-height:1.35;">${escapeHtml(entry.current_address ?? "N/D")}${entry.current_city ? ` - ${escapeHtml(entry.current_city)}` : ""}</div>
          </div>
        </div>
      `;

      marker.bindPopup(popup, { className: "control-room-map-popup", maxWidth: 300, offset: [0, -12] });
      marker.on("click", () => onSelect(entry.radius_vehicle_id));
      marker.addTo(markers);
      bounds.extend([entry.lat, entry.lng]);
    });

    if (!fittedRef.current && bounds.isValid()) {
      map.fitBounds(bounds.pad(0.18), { maxZoom: 13, animate: false });
      fittedRef.current = true;
    }
  }, [entries, onSelect, selectedId]);

  useEffect(() => {
    const layer = opsLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    if (!operationalLayerEnabled) return;

    OPERATING_ZONES.forEach((zone) => {
      L.circle([zone.lat, zone.lng], {
        radius: zone.radius,
        color: zone.tone,
        weight: 1.1,
        opacity: 0.24,
        fillColor: zone.tone,
        fillOpacity: 0.025,
        dashArray: "5 10",
        interactive: false
      }).addTo(layer);

      L.marker([zone.lat, zone.lng], {
        interactive: false,
        icon: L.divIcon({
          className: "",
          html: `
            <div style="
              border:1px solid rgba(15,23,42,0.12);
              background:rgba(255,255,255,0.76);
              color:#334155;
              padding:3px 8px;
              border-radius:8px;
              font:700 10px ui-sans-serif,system-ui,sans-serif;
              box-shadow:0 6px 14px rgba(15,23,42,0.08);
              white-space:nowrap;
              backdrop-filter:blur(8px);
            ">${escapeHtml(zone.name)}</div>
          `,
          iconSize: [120, 22],
          iconAnchor: [60, 11]
        })
      }).addTo(layer);
    });

    OPERATING_PORTS.forEach((port) => {
      L.circleMarker([port.lat, port.lng], {
        radius: 6,
        color: "#ffffff",
        weight: 2,
        fillColor: port.tone,
        fillOpacity: 1
      }).addTo(layer);

      L.marker([port.lat, port.lng], {
        interactive: false,
        icon: L.divIcon({
          className: "",
          html: `
            <div style="
              transform:translate(12px,-12px);
              border:1px solid rgba(15,23,42,0.12);
              background:rgba(255,255,255,0.94);
              color:${port.tone};
              padding:3px 8px;
              border-radius:8px;
              font:800 10px ui-sans-serif,system-ui,sans-serif;
              box-shadow:0 8px 18px rgba(15,23,42,0.12);
              white-space:nowrap;
            ">${escapeHtml(port.name)}</div>
          `,
          iconSize: [120, 24],
          iconAnchor: [0, 12]
        })
      }).addTo(layer);
    });
  }, [operationalLayerEnabled]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !selectedId) return;
    const entry = entries.find((item) => item.radius_vehicle_id === selectedId);
    if (entry) {
      map.flyTo([entry.lat, entry.lng], Math.max(map.getZoom(), 13), { animate: true, duration: 0.45 });
    }
  }, [entries, selectedId]);

  const centerAll = () => {
    const map = mapRef.current;
    const validEntries = entries.filter((entry) => Number.isFinite(entry.lat) && Number.isFinite(entry.lng));
    if (!map) return;
    if (validEntries.length === 0) { map.setView(DEFAULT_CENTER, 12); return; }
    map.fitBounds(L.latLngBounds(validEntries.map((entry) => [entry.lat, entry.lng] as [number, number])).pad(0.2), { maxZoom: 13, animate: true });
  };

  return (
    <div className="relative overflow-hidden rounded-lg border border-slate-200 bg-white shadow-[0_24px_70px_rgba(15,23,42,0.12)]">
      {!compact ? <div className="border-b border-slate-200 bg-white px-5 py-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">Fleet Control</p>
            <h3 className="mt-1 text-lg font-semibold text-slate-950">Mappa live mezzi</h3>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setOperationalLayerEnabled((value) => !value)}
              className={`rounded-lg border px-3 py-1 text-xs font-semibold transition ${
                operationalLayerEnabled
                  ? "border-teal-200 bg-teal-50 text-teal-700"
                  : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
              }`}
            >
              Layer operativo {operationalLayerEnabled ? "on" : "off"}
            </button>
            <div className="rounded-lg border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600">
              {baseLayerLabel}
            </div>
          </div>
        </div>
      </div> : null}
      <div className="relative">
        <div
          ref={containerRef}
          style={{ height: compact ? "clamp(520px, 64vh, 700px)" : "clamp(500px, 70vh, 820px)", width: "100%" }}
          className="bg-[#eef3f7] [&_.leaflet-container]:!bg-[#eef3f7] [&_.leaflet-control-attribution]:!rounded-tl-lg [&_.leaflet-control-attribution]:!bg-white/85 [&_.leaflet-control-attribution]:!text-[10px] [&_.leaflet-control-container]:z-[450] [&_.leaflet-control-zoom]:!overflow-hidden [&_.leaflet-control-zoom]:!rounded-lg [&_.leaflet-control-zoom]:!border [&_.leaflet-control-zoom]:!border-slate-200 [&_.leaflet-control-zoom]:!shadow-[0_10px_24px_rgba(15,23,42,0.14)] [&_.leaflet-control-zoom_a]:!text-slate-700 [&_.leaflet-control-zoom_a]:!h-10 [&_.leaflet-control-zoom_a]:!w-10 [&_.leaflet-control-zoom_a]:!leading-[38px] [&_.leaflet-control-zoom_a]:!border-slate-200 [&_.leaflet-control-zoom_a]:!bg-white/95 [&_.leaflet-control-zoom_a]:hover:!bg-slate-50 [&_.leaflet-pane.leaflet-tile-pane]:[filter:saturate(1.04)_contrast(1.02)_brightness(1.01)] [&_.leaflet-popup-content]:!m-0 [&_.leaflet-popup-content-wrapper]:!rounded-lg [&_.leaflet-popup-content-wrapper]:!p-3 [&_.leaflet-popup-content-wrapper]:!shadow-[0_18px_45px_rgba(15,23,42,0.18)] [&_.leaflet-popup-tip]:!shadow-none"
        />

        <div className="pointer-events-none absolute inset-x-0 top-0 h-12 bg-[linear-gradient(180deg,rgba(255,255,255,0.52)_0%,rgba(255,255,255,0)_100%)]" />

        <div className={`absolute left-4 z-[500] flex max-w-[calc(100%-6rem)] flex-wrap gap-2 ${compact ? "top-16" : "top-4"}`}>
          <div className="rounded-lg border border-white/80 bg-white/94 px-3 py-2 shadow-[0_12px_28px_rgba(15,23,42,0.12)] backdrop-blur">
            <div className="flex flex-wrap items-center gap-3 text-xs font-medium text-slate-700">
              <span className="inline-flex items-center gap-1.5 text-slate-900"><span className="h-2.5 w-2.5 rounded-full bg-slate-900" />{summary.total} live</span>
              <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />{summary.moving}</span>
              <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-amber-500" />{summary.warning}</span>
              <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-rose-500" />{summary.stopped}</span>
              <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-slate-500" />{summary.offline}</span>
            </div>
          </div>
        </div>

        <button type="button" onClick={centerAll} className="absolute right-4 top-28 z-[500] rounded-lg border border-white/80 bg-white/95 px-3 py-2 text-xs font-bold text-slate-700 shadow-lg backdrop-blur hover:bg-white">Centra tutti</button>

        <div className="absolute bottom-4 left-4 z-[500] rounded-lg border border-white/80 bg-white/94 px-3 py-2 shadow-[0_12px_28px_rgba(15,23,42,0.12)] backdrop-blur">
          <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-700">
            <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />In movimento</span>
            <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-amber-500" />Warning</span>
            <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-rose-500" />Fermo</span>
            <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-slate-500" />Offline</span>
          </div>
        </div>

        <div className="absolute bottom-4 right-4 z-[500] rounded-lg border border-white/80 bg-white/94 px-3 py-2 text-[11px] font-semibold text-slate-700 shadow-[0_12px_28px_rgba(15,23,42,0.12)] backdrop-blur">GPS live · {summary.total} mezzi</div>

        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-[linear-gradient(0deg,rgba(255,255,255,0.40)_0%,rgba(255,255,255,0)_100%)]" />

      </div>
    </div>
  );
}
