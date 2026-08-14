"use client";

import { useCallback, useState } from "react";
import type { GpsControlRoomEntry } from "@/lib/types";
import { ControlRoomMap } from "@/components/control-room-map";
import { MapLibreControlRoomMap } from "@/components/maplibre-control-room-map";

export function ControlRoomMapShell({ entries, selectedId, onSelect }: {
  entries: GpsControlRoomEntry[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [fallback, setFallback] = useState(false);
  const activateFallback = useCallback(() => setFallback(true), []);
  if (fallback) return <ControlRoomMap compact entries={entries} selectedId={selectedId} onSelect={onSelect} />;
  return <MapLibreControlRoomMap entries={entries} selectedId={selectedId} onSelect={onSelect} onFailure={activateFallback} />;
}
