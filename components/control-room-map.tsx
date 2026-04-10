"use client";

import { useEffect, useRef } from "react";
import L from "leaflet";
import type { GpsControlRoomEntry } from "@/lib/types";

interface ControlRoomMapProps {
  entries: GpsControlRoomEntry[];
  selectedId: string | null;
  onSelect: (radiusVehicleId: string) => void;
}

const DEFAULT_CENTER: [number, number] = [40.7395, 13.9124];

const TILE_PROVIDER = "OpenStreetMap";
const TILE_URL = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function statusPalette(status: GpsControlRoomEntry["status_key"], selected: boolean) {
  if (selected) return { bg: "#0f172a", border: "#020617", text: "#f8fafc", glow: "0 0 0 4px rgba(15,23,42,0.22)" };
  if (status === "moving") return { bg: "#16a34a", border: "#166534", text: "#f0fdf4", glow: "0 0 0 3px rgba(34,197,94,0.22)" };
  if (status === "stopped") return { bg: "#dc2626", border: "#991b1b", text: "#fff1f2", glow: "0 0 0 3px rgba(239,68,68,0.2)" };
  if (status === "warning") return { bg: "#f59e0b", border: "#b45309", text: "#1c1917", glow: "0 0 0 3px rgba(245,158,11,0.22)" };
  return { bg: "#64748b", border: "#475569", text: "#f8fafc", glow: "0 0 0 3px rgba(100,116,139,0.2)" };
}

function busIcon(entry: GpsControlRoomEntry, selected: boolean) {
  const offlineWithActiveService = entry.status_key === "offline" && Boolean(entry.active_service);
  const palette = offlineWithActiveService && !selected
    ? { bg: "#be123c", border: "#881337", text: "#fff1f2", glow: "0 0 0 4px rgba(225,29,72,0.24)" }
    : statusPalette(entry.status_key, selected);
  const iconSurface = "#ffffff";
  const iconStroke = selected ? "#cbd5e1" : "#d7e0ea";
  const accent = palette.bg;
  const label = escapeHtml((entry.pms_label ?? entry.label).slice(0, selected ? 18 : 12));
  const line = escapeHtml((entry.line_name ?? "").slice(0, selected ? 16 : 11));
  const showDetails = selected;
  const size = selected ? 50 : 34;
  const speed = entry.speed_kmh !== null ? Math.round(entry.speed_kmh) : null;

  return L.divIcon({
    className: "",
    html: `
      <div style="display:flex;flex-direction:column;align-items:center;gap:5px;">
        <div style="
          width:${size}px;
          height:${size}px;
          display:flex;
          align-items:center;
          justify-content:center;
          border-radius:999px;
          border:1px solid ${iconStroke};
          background:${iconSurface};
          color:${accent};
          box-shadow:${palette.glow}, 0 8px 18px rgba(15,23,42,0.12);
          position:relative;
          overflow:hidden;
        ">
          <div style="
            position:absolute;
            inset:auto 0 0 0;
            height:${selected ? 5 : 4}px;
            background:${accent};
            opacity:0.95;
          "></div>
          <svg xmlns="http://www.w3.org/2000/svg" width="${size - 8}" height="${size - 8}" viewBox="0 0 40 40" fill="none" style="position:relative;z-index:1;">
            <path d="M8.5 24.8v-8.4c0-4.1 3.3-7.4 7.4-7.4h7.8c3.9 0 6 1.7 6 5.2v10.6c0 1.9-1.5 3.5-3.5 3.5H12c-1.9 0-3.5-1.6-3.5-3.5Z" fill="#ffffff" stroke="#1f2937" stroke-width="1.8"/>
            <path d="M11.2 14.9h15.4c1.2 0 1.9.5 1.9 1.5v1.4H10v-1.2c0-1.2.5-1.7 1.2-1.7Z" fill="${accent}"/>
            <rect x="11.4" y="18.8" width="5.8" height="4.2" rx="0.9" fill="#eef4ff" stroke="#1f2937" stroke-width="1.3"/>
            <rect x="17.8" y="18.8" width="5.8" height="4.2" rx="0.9" fill="#eef4ff" stroke="#1f2937" stroke-width="1.3"/>
            <rect x="24.2" y="18.8" width="4" height="5.3" rx="0.9" fill="#eef4ff" stroke="#1f2937" stroke-width="1.3"/>
            <path d="M13.8 25.8h9.2" stroke="${accent}" stroke-width="2" stroke-linecap="round"/>
            <circle cx="14.8" cy="28" r="3.6" fill="#1f2937"/>
            <circle cx="14.8" cy="28" r="2.1" fill="#ffffff"/>
            <circle cx="25.8" cy="28" r="3.6" fill="#1f2937"/>
            <circle cx="25.8" cy="28" r="2.1" fill="#ffffff"/>
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
            min-width:124px;
            max-width:148px;
            border-radius:16px;
            border:1px solid ${iconStroke};
            background:rgba(255,255,255,0.97);
            box-shadow:0 12px 26px rgba(15,23,42,0.12);
            padding:8px 11px;
            text-align:center;
            font-family:ui-sans-serif,system-ui,sans-serif;
          ">
            <div style="font-size:11px;font-weight:700;color:#0f172a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${label}</div>
            <div style="margin-top:2px;font-size:10px;color:#64748b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${line || "Bus live"}</div>
            <div style="margin-top:4px;display:inline-flex;align-items:center;justify-content:center;border-radius:999px;background:#f8fafc;padding:3px 8px;font-size:10px;font-weight:700;color:${accent};">${speed !== null ? `${speed} km/h` : "-- km/h"}</div>
          </div>
        ` : ""}
      </div>
    `,
    iconSize: [size + (showDetails ? 20 : 8), size + (showDetails ? 44 : 8)],
    iconAnchor: [size / 2 + 8, size / 2 + 8],
    popupAnchor: [0, -(size / 2 + 6)]
  });
}

function formatTimestamp(ts: string) {
  try {
    return new Date(ts).toLocaleString("it-IT", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return ts;
  }
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

export function ControlRoomMap({ entries, selectedId, onSelect }: ControlRoomMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersRef = useRef<L.LayerGroup | null>(null);
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
    const map = L.map(containerRef.current, { zoomControl: true }).setView(DEFAULT_CENTER, 12);
    L.tileLayer(TILE_URL, {
      attribution: "&copy; OpenStreetMap contributors",
      maxZoom: 19
    }).addTo(map);
    mapRef.current = map;
    markersRef.current = L.layerGroup().addTo(map);

    return () => {
      markersRef.current?.clearLayers();
      markersRef.current = null;
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
        <div style="font-family:ui-sans-serif,system-ui,sans-serif;min-width:220px;color:#0f172a;">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
            <div style="font-size:14px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(entry.pms_label ?? entry.label)}</div>
            <div style="display:inline-flex;border-radius:999px;padding:3px 9px;background:#f8fafc;border:1px solid #cbd5e1;font-size:11px;font-weight:700;">
              ${escapeHtml(entry.status_label)}
            </div>
          </div>
          <div style="margin-top:8px;display:grid;gap:4px;font-size:12px;color:#475569;">
            <div>Linea: ${escapeHtml(entry.line_name ?? "N/D")}</div>
            <div>Autista: ${escapeHtml(entry.driver_name ?? "N/D")}</div>
            <div>Velocita: ${entry.speed_kmh !== null ? `${Math.round(entry.speed_kmh)} km/h` : "N/D"}</div>
            <div>Update: ${formatTimestamp(entry.timestamp)}</div>
            <div style="line-height:1.35;">${escapeHtml(entry.current_address ?? "N/D")}${entry.current_city ? ` • ${escapeHtml(entry.current_city)}` : ""}</div>
          </div>
        </div>
      `;

      marker.bindPopup(popup, { maxWidth: 260, offset: [0, -10] });
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
    const map = mapRef.current;
    if (!map || !selectedId) return;
    const entry = entries.find((item) => item.radius_vehicle_id === selectedId);
    if (entry) {
      map.flyTo([entry.lat, entry.lng], Math.max(map.getZoom(), 13), { animate: true, duration: 0.45 });
    }
  }, [entries, selectedId]);

  return (
    <div className="relative overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-[0_24px_70px_rgba(15,23,42,0.12)]">
      <div className="border-b border-slate-200 bg-[linear-gradient(90deg,#f8fafc_0%,#ffffff_55%,#eff6ff_100%)] px-5 py-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">Fleet Control</p>
            <h3 className="mt-1 text-lg font-semibold text-slate-950">Mappa live mezzi</h3>
          </div>
          <div className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600">
            Leaflet • {TILE_PROVIDER}
          </div>
        </div>
      </div>
      <div className="relative">
        <div
          ref={containerRef}
          style={{ height: "calc(100vh - 280px)", minHeight: "560px", width: "100%" }}
          className="bg-[#eef3f7] [&_.leaflet-control-container]:z-[450] [&_.leaflet-control-zoom]:!border-0 [&_.leaflet-control-zoom]:!shadow-[0_10px_24px_rgba(15,23,42,0.14)] [&_.leaflet-control-zoom_a]:!text-slate-700 [&_.leaflet-control-zoom_a]:!h-10 [&_.leaflet-control-zoom_a]:!w-10 [&_.leaflet-control-zoom_a]:!leading-[38px] [&_.leaflet-control-zoom_a]:!border-slate-200 [&_.leaflet-control-zoom_a]:!bg-white/95 [&_.leaflet-control-zoom_a]:hover:!bg-slate-50 [&_.leaflet-pane.leaflet-tile-pane]:[filter:saturate(0.92)_contrast(1.03)_brightness(1.02)] [&_.leaflet-popup-content-wrapper]:!rounded-2xl [&_.leaflet-popup-content-wrapper]:!shadow-[0_18px_45px_rgba(15,23,42,0.18)] [&_.leaflet-popup-tip]:!shadow-none"
        />

        <div className="pointer-events-none absolute inset-x-0 top-0 h-16 bg-[linear-gradient(180deg,rgba(255,255,255,0.68)_0%,rgba(255,255,255,0)_100%)]" />

        <div className="absolute left-[4.5rem] top-4 z-[500] flex max-w-[calc(100%-5.5rem)] flex-wrap gap-2 md:left-[5rem]">
          <div className="rounded-full border border-white/80 bg-white/94 px-3 py-2 shadow-[0_12px_28px_rgba(15,23,42,0.12)] backdrop-blur">
            <div className="flex flex-wrap items-center gap-3 text-xs font-medium text-slate-700">
              <span className="inline-flex items-center gap-1.5 text-slate-900"><span className="h-2.5 w-2.5 rounded-full bg-slate-900" />{summary.total} live</span>
              <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />{summary.moving}</span>
              <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-amber-500" />{summary.warning}</span>
              <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-rose-500" />{summary.stopped}</span>
              <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-slate-500" />{summary.offline}</span>
            </div>
          </div>
        </div>

        <div className="absolute bottom-4 left-4 z-[500] rounded-full border border-white/80 bg-white/94 px-3 py-2 shadow-[0_12px_28px_rgba(15,23,42,0.12)] backdrop-blur">
          <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-700">
            <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />In movimento</span>
            <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-amber-500" />Warning</span>
            <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-rose-500" />Fermo</span>
            <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-slate-500" />Offline</span>
          </div>
        </div>

        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-[linear-gradient(0deg,rgba(255,255,255,0.54)_0%,rgba(255,255,255,0)_100%)]" />

      </div>
    </div>
  );
}
