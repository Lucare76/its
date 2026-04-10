"use client";

import { useEffect, useRef } from "react";
import L from "leaflet";
import type { Hotel, Service, ServiceStatus } from "@/lib/types";

interface LeafletMapProps {
  hotels: Hotel[];
  services: Service[];
  selectedServiceId?: string | null;
  onSelectService?: (serviceId: string) => void;
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

function serviceStatusColor(status: ServiceStatus) {
  if (status === "new") return { stroke: "#b45309", fill: "#f59e0b" };
  if (status === "assigned") return { stroke: "#1d4ed8", fill: "#3b82f6" };
  if (status === "partito") return { stroke: "#0f766e", fill: "#14b8a6" };
  if (status === "arrivato") return { stroke: "#4f46e5", fill: "#6366f1" };
  if (status === "completato") return { stroke: "#166534", fill: "#22c55e" };
  return { stroke: "#b91c1c", fill: "#ef4444" };
}

export function LeafletMap({ hotels, services, selectedServiceId, onSelectService }: LeafletMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const overlaysRef = useRef<L.LayerGroup | null>(null);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = L.map(containerRef.current, { zoomControl: true }).setView(DEFAULT_CENTER, 12);
    L.tileLayer(TILE_URL, {
      attribution: "&copy; OpenStreetMap contributors"
    }).addTo(map);

    mapRef.current = map;
    overlaysRef.current = L.layerGroup().addTo(map);

    return () => {
      overlaysRef.current?.clearLayers();
      overlaysRef.current = null;
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const overlays = overlaysRef.current;
    if (!map || !overlays) return;

    overlays.clearLayers();
    const bounds = L.latLngBounds([]);

    hotels.forEach((hotel) => {
      const marker = L.circleMarker([hotel.lat, hotel.lng], {
        radius: 7,
        color: "#0f172a",
        weight: 2,
        fillColor: "#ffffff",
        fillOpacity: 1
      });
      marker.bindPopup(`<strong>${escapeHtml(hotel.name)}</strong><br/>${escapeHtml(hotel.zone)}`);
      marker.addTo(overlays);
      bounds.extend(marker.getLatLng());
    });

    services.forEach((service) => {
      const hotel = hotels.find((item) => item.id === service.hotel_id);
      if (!hotel) return;

      const colors = serviceStatusColor(service.status);
      const isSelected = selectedServiceId === service.id;
      const marker = L.circleMarker([hotel.lat, hotel.lng], {
        radius: isSelected ? 10 : 8,
        color: colors.stroke,
        weight: 2,
        fillColor: colors.fill,
        fillOpacity: isSelected ? 0.9 : 0.65
      });
      marker.bindPopup(
        `<strong>${escapeHtml(service.customer_name)}</strong><br/>${escapeHtml(service.vessel)}<br/>${escapeHtml(service.status)}`
      );
      marker.on("click", () => {
        onSelectService?.(service.id);
      });
      marker.addTo(overlays);
      bounds.extend(marker.getLatLng());
    });

    if (bounds.isValid()) {
      map.fitBounds(bounds.pad(0.25), { maxZoom: 14 });
      return;
    }

    map.setView(DEFAULT_CENTER, 12);
  }, [hotels, onSelectService, selectedServiceId, services]);

  return (
    <div className="card h-[560px] overflow-hidden">
      <div ref={containerRef} style={{ height: "100%", width: "100%" }} />
    </div>
  );
}
