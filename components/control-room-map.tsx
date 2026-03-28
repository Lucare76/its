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
const TILE_URL = "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png";

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
  const palette = statusPalette(entry.status_key, selected);
  const label = escapeHtml((entry.pms_label ?? entry.label).slice(0, selected ? 16 : 11));
  const line = escapeHtml((entry.line_name ?? "").slice(0, selected ? 14 : 10));
  const size = selected ? 52 : 40;
  const speed = entry.speed_kmh !== null ? Math.round(entry.speed_kmh) : null;

  return L.divIcon({
    className: "",
    html: `
      <div style="display:flex;flex-direction:column;align-items:center;gap:4px;">
        <div style="
          width:${size}px;
          height:${size}px;
          display:flex;
          align-items:center;
          justify-content:center;
          border-radius:16px;
          border:2px solid ${palette.border};
          background:${palette.bg};
          color:${palette.text};
          box-shadow:${palette.glow}, 0 10px 24px rgba(15,23,42,0.18);
        ">
          <svg xmlns="http://www.w3.org/2000/svg" width="${size - 16}" height="${size - 16}" viewBox="0 0 32 32" fill="none">
            <rect x="5" y="6" width="22" height="13" rx="3.2" stroke="${palette.text}" stroke-width="2"/>
            <path d="M8 22h16" stroke="${palette.text}" stroke-width="2" stroke-linecap="round"/>
            <circle cx="10.5" cy="24.5" r="2.5" fill="${palette.text}" opacity="0.95"/>
            <circle cx="21.5" cy="24.5" r="2.5" fill="${palette.text}" opacity="0.95"/>
            <rect x="8" y="9" width="6.5" height="4.5" rx="1.2" fill="${palette.text}" opacity="0.9"/>
            <rect x="17.5" y="9" width="6.5" height="4.5" rx="1.2" fill="${palette.text}" opacity="0.9"/>
          </svg>
        </div>
        <div style="
          min-width:${selected ? 86 : 64}px;
          max-width:${selected ? 120 : 86}px;
          border-radius:${selected ? 10 : 8}px;
          border:1px solid ${palette.border};
          background:${selected ? "rgba(255,255,255,0.97)" : "rgba(255,255,255,0.92)"};
          box-shadow:${selected ? "0 10px 24px rgba(15,23,42,0.14)" : "0 8px 18px rgba(15,23,42,0.10)"};
          padding:${selected ? "5px 8px" : "4px 6px"};
          text-align:center;
          font-family:ui-sans-serif,system-ui,sans-serif;
        ">
          <div style="font-size:${selected ? 11 : 10}px;font-weight:700;color:#0f172a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${label}</div>
          <div style="font-size:${selected ? 10 : 9}px;color:#475569;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${line || "Bus live"}</div>
          ${selected ? `<div style="font-size:10px;font-weight:700;color:${palette.border};">${speed !== null ? `${speed} km/h` : "-- km/h"}</div>` : ""}
        </div>
      </div>
    `,
    iconSize: [size + 18, size + (selected ? 42 : 28)],
    iconAnchor: [size / 2 + 12, size / 2 + 8],
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
 * Dispone a spirale i veicoli con la stessa posizione GPS
 * per evitare sovrapposizione delle icone.
 */
function spreadOverlapping(items: GpsControlRoomEntry[]): Array<GpsControlRoomEntry & { _lat: number; _lng: number }> {
  const OFFSET = 0.00028; // ~31m in gradi — sufficiente a separare le icone a zoom 13

  const groups = new Map<string, GpsControlRoomEntry[]>();
  for (const item of items) {
    const key = `${item.lat.toFixed(5)},${item.lng.toFixed(5)}`;
    const g = groups.get(key);
    if (g) g.push(item);
    else groups.set(key, [item]);
  }

  const result: Array<GpsControlRoomEntry & { _lat: number; _lng: number }> = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      result.push({ ...group[0], _lat: group[0].lat, _lng: group[0].lng });
      continue;
    }
    group.forEach((item, i) => {
      if (i === 0) {
        result.push({ ...item, _lat: item.lat, _lng: item.lng });
      } else {
        const angle = (2 * Math.PI * (i - 1)) / (group.length - 1);
        const radius = OFFSET * (1 + Math.floor((i - 1) / 8) * 0.6);
        result.push({
          ...item,
          _lat: item.lat + radius * Math.cos(angle),
          _lng: item.lng + radius * Math.sin(angle)
        });
      }
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
    const map = L.map(containerRef.current, { zoomControl: true, preferCanvas: true }).setView(DEFAULT_CENTER, 12);
    L.tileLayer(TILE_URL, {
      attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
      subdomains: "abcd",
      maxZoom: 19
    }).addTo(map);
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

  useEffect(() => {
    const map = mapRef.current;
    const markers = markersRef.current;
    if (!map || !markers) return;

    markers.clearLayers();
    const bounds = L.latLngBounds([]);

    const spread = spreadOverlapping(entries.filter((e) => e.lat && e.lng));

    spread.forEach((entry) => {
      const selected = selectedId === entry.radius_vehicle_id;
      const marker = L.marker([entry._lat, entry._lng], { icon: busIcon(entry, selected), zIndexOffset: selected ? 1200 : 0 });

      // Linea tratteggiata verso la posizione reale se spostato
      if (entry._lat !== entry.lat || entry._lng !== entry.lng) {
        L.polyline(
          [[entry.lat, entry.lng], [entry._lat, entry._lng]],
          { color: "#94a3b8", weight: 1.2, dashArray: "4 5", opacity: 0.6 }
        ).addTo(markers);
      }

      const popup = `
        <div style="font-family:ui-sans-serif,system-ui,sans-serif;min-width:220px;color:#0f172a;">
          <div style="font-size:14px;font-weight:700;">${escapeHtml(entry.pms_label ?? entry.label)}</div>
          <div style="margin-top:6px;font-size:12px;color:#475569;">Linea: ${escapeHtml(entry.line_name ?? "N/D")}</div>
          <div style="font-size:12px;color:#475569;">Autista: ${escapeHtml(entry.driver_name ?? "N/D")}</div>
          <div style="font-size:12px;color:#475569;">Velocita: ${entry.speed_kmh !== null ? `${Math.round(entry.speed_kmh)} km/h` : "N/D"}</div>
          <div style="font-size:12px;color:#475569;">Indirizzo: ${escapeHtml(entry.current_address ?? "N/D")}${entry.current_city ? ` • ${escapeHtml(entry.current_city)}` : ""}</div>
          <div style="font-size:12px;color:#475569;">Ultima posizione: ${entry.lat.toFixed(5)}, ${entry.lng.toFixed(5)}</div>
          <div style="font-size:12px;color:#475569;">Ultimo aggiornamento: ${formatTimestamp(entry.timestamp)}</div>
          <div style="margin-top:8px;display:inline-flex;border-radius:999px;padding:3px 9px;background:#f8fafc;border:1px solid #cbd5e1;font-size:11px;font-weight:700;">
            ${escapeHtml(entry.status_label)}
          </div>
        </div>
      `;

      marker.bindPopup(popup, { maxWidth: 260 });
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
          <div className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600">Leaflet • CARTO Voyager</div>
        </div>
      </div>
      <div className="relative">
        <div
          ref={containerRef}
          style={{ height: "calc(100vh - 280px)", minHeight: "560px", width: "100%" }}
          className="bg-[#dfe8ef] [&_.leaflet-control-container]:z-[450] [&_.leaflet-control-zoom]:!border-0 [&_.leaflet-control-zoom]:!shadow-[0_10px_24px_rgba(15,23,42,0.14)] [&_.leaflet-control-zoom_a]:!text-slate-700 [&_.leaflet-control-zoom_a]:!h-10 [&_.leaflet-control-zoom_a]:!w-10 [&_.leaflet-control-zoom_a]:!leading-[38px] [&_.leaflet-control-zoom_a]:!border-slate-200 [&_.leaflet-control-zoom_a]:!bg-white/95 [&_.leaflet-control-zoom_a]:hover:!bg-slate-50 [&_.leaflet-pane.leaflet-tile-pane]:[filter:saturate(1.06)_contrast(1.02)_brightness(1.01)] [&_.leaflet-popup-content-wrapper]:!rounded-2xl [&_.leaflet-popup-content-wrapper]:!shadow-[0_18px_45px_rgba(15,23,42,0.18)] [&_.leaflet-popup-tip]:!shadow-none"
        />

        <div className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-[linear-gradient(180deg,rgba(255,255,255,0.84)_0%,rgba(255,255,255,0)_100%)]" />
        <div className="pointer-events-none absolute inset-y-0 right-0 w-20 bg-[linear-gradient(270deg,rgba(248,250,252,0.65)_0%,rgba(248,250,252,0)_100%)]" />

        <div className="absolute left-4 top-4 z-[500] flex flex-wrap gap-2">
          <div className="rounded-2xl border border-white/70 bg-white/92 px-3 py-2 shadow-[0_12px_30px_rgba(15,23,42,0.12)] backdrop-blur">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">Live</p>
            <p className="mt-1 text-lg font-semibold text-slate-950">{summary.total}</p>
            <p className="text-xs text-slate-500">mezzi in mappa</p>
          </div>
          <div className="rounded-2xl border border-white/70 bg-white/92 px-3 py-2 shadow-[0_12px_30px_rgba(15,23,42,0.12)] backdrop-blur">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">Stati</p>
            <div className="mt-1 flex items-center gap-3 text-xs font-medium text-slate-700">
              <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />{summary.moving}</span>
              <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full bg-amber-500" />{summary.warning}</span>
              <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full bg-rose-500" />{summary.stopped}</span>
              <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full bg-slate-500" />{summary.offline}</span>
            </div>
          </div>
        </div>

        <div className="absolute bottom-4 left-4 z-[500] max-w-[300px] rounded-2xl border border-white/70 bg-white/92 px-4 py-3 shadow-[0_16px_36px_rgba(15,23,42,0.14)] backdrop-blur">
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">Legenda</p>
          <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-xs text-slate-700">
            <span className="inline-flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />In movimento</span>
            <span className="inline-flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-amber-500" />Lento / warning</span>
            <span className="inline-flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-rose-500" />Fermo</span>
            <span className="inline-flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-slate-500" />Offline</span>
          </div>
        </div>

      </div>
    </div>
  );
}
