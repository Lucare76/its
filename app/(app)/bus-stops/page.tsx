"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { PageHeader, EmptyState } from "@/components/ui";
import { getClientSessionContext } from "@/lib/supabase/client-session";
import {
  classifyBusStopStatus,
  BUS_STOP_STATUS_LABELS,
  BUS_STOP_STATUS_BADGE_CLASSNAME,
  type BusStopStatus,
} from "@/lib/bus-stop-status";
import { findNearDuplicateStopNamesClient } from "@/lib/bus-stop-dedup";

type Direction = "arrival" | "departure";

type BusLineRow = { id: string; code: string; name: string; family_code: string; active: boolean };

type BusStopRow = {
  id: string;
  bus_line_id: string;
  direction: Direction;
  stop_name: string;
  city: string;
  pickup_note: string | null;
  pickup_time: string | null;
  stop_order: number;
  lat: number | null;
  lng: number | null;
  is_manual: boolean;
  active: boolean;
  service_count: number;
};

type StopDraft = {
  busLineId: string;
  direction: Direction;
  stopName: string;
  city: string;
  pickupNote: string;
  pickupTime: string;
  stopOrder: string;
  lat: string;
  lng: string;
  active: boolean;
};

const DIRECTION_LABEL: Record<Direction, string> = { arrival: "Andata", departure: "Ritorno" };

const LINE_BADGE_CLASSNAME: Record<string, string> = {
  ITALIA: "bg-blue-100 text-blue-700",
  CENTRO: "bg-emerald-100 text-emerald-700",
  ADRIATICA: "bg-amber-100 text-amber-700",
  GRUPPI_ESCLUSIVI: "bg-purple-100 text-purple-700",
};

function lineBadgeClassName(familyCode: string) {
  return LINE_BADGE_CLASSNAME[familyCode] ?? "bg-slate-100 text-slate-700";
}

function lineShortLabel(line: Pick<BusLineRow, "code" | "family_code">) {
  return line.family_code === "GRUPPI_ESCLUSIVI" ? "GRUPPI" : line.code;
}

function emptyDraft(defaultLineId: string): StopDraft {
  return {
    busLineId: defaultLineId,
    direction: "arrival",
    stopName: "",
    city: "",
    pickupNote: "",
    pickupTime: "",
    stopOrder: "",
    lat: "",
    lng: "",
    active: true,
  };
}

function draftFromStop(stop: BusStopRow): StopDraft {
  return {
    busLineId: stop.bus_line_id,
    direction: stop.direction,
    stopName: stop.stop_name,
    city: stop.city,
    pickupNote: stop.pickup_note ?? "",
    pickupTime: stop.pickup_time ? stop.pickup_time.slice(0, 5) : "",
    stopOrder: String(stop.stop_order),
    lat: stop.lat != null ? String(stop.lat) : "",
    lng: stop.lng != null ? String(stop.lng) : "",
    active: stop.active,
  };
}

async function postBusNetworkAction(action: string, data: Record<string, unknown>) {
  const ctx = await getClientSessionContext();
  if (!ctx.accessToken) return { ok: false as const, error: "Sessione non valida, ricarica la pagina." };
  let res: Response;
  try {
    res = await fetch("/api/ops/bus-network", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.accessToken}` },
      body: JSON.stringify({ action, ...data }),
    });
  } catch {
    return { ok: false as const, error: "Errore di rete." };
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !body?.ok) {
    return { ok: false as const, error: (body?.error as string | undefined) ?? "Errore operazione.", status: res.status };
  }
  return body as { ok: true } & Record<string, unknown>;
}

function toCsvValue(value: string | number | null | undefined) {
  const str = String(value ?? "");
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

export default function BusStopsPage() {
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");
  const [lines, setLines] = useState<BusLineRow[]>([]);
  const [stops, setStops] = useState<BusStopRow[]>([]);
  const [message, setMessage] = useState("");

  const [lineFilter, setLineFilter] = useState<string>("all");
  const [directionFilter, setDirectionFilter] = useState<"all" | Direction>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | BusStopStatus>("active");
  const [search, setSearch] = useState("");
  const [manualOnly, setManualOnly] = useState(false);
  const [showMoreFilters, setShowMoreFilters] = useState(false);
  const [sortBy, setSortBy] = useState<"line_order" | "name">("line_order");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const [selectedStopId, setSelectedStopId] = useState<string | null>(null);
  const [mode, setMode] = useState<"view" | "create">("view");
  const [draft, setDraft] = useState<StopDraft | null>(null);
  const [stopOrderTouched, setStopOrderTouched] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!message) return;
    const timeout = window.setTimeout(() => setMessage(""), 3000);
    return () => window.clearTimeout(timeout);
  }, [message]);

  const loadData = async () => {
    setLoading(true);
    const result = await postBusNetworkAction("list_bus_line_stops", {});
    setLoading(false);
    if (!result.ok) {
      setErrorMessage(result.error ?? "Errore caricamento fermate.");
      return;
    }
    setErrorMessage("");
    setLines((result.lines ?? []) as BusLineRow[]);
    setStops((result.stops ?? []) as BusStopRow[]);
  };

  const didInit = useRef(false);
  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;
    void loadData();
  }, []);

  const lineById = useMemo(() => new Map(lines.map((line) => [line.id, line])), [lines]);

  const stopsWithStatus = useMemo(
    () =>
      stops.map((stop) => ({
        stop,
        status: classifyBusStopStatus({
          active: stop.active,
          stopName: stop.stop_name,
          city: stop.city,
          pickupNote: stop.pickup_note,
          serviceCount: stop.service_count,
        }),
      })),
    [stops]
  );

  // KPI: sempre sul totale, indipendenti dai filtri applicati alla tabella.
  const kpi = useMemo(() => {
    const totalStops = stops.length;
    const withNote = stops.filter((s) => s.pickup_note && s.pickup_note.trim()).length;
    const activeLines = lines.filter((l) => l.active);
    const linkedServicesTotal = stops.reduce((sum, s) => sum + s.service_count, 0);
    const stopsWithUsage = stops.filter((s) => s.service_count > 0).length;
    return {
      totalStops,
      withNote,
      withNotePct: totalStops > 0 ? Math.round((withNote / totalStops) * 1000) / 10 : 0,
      activeLinesCount: activeLines.length,
      activeLinesLabel: activeLines.map((l) => lineShortLabel(l)).join(" · "),
      linkedServicesTotal,
      coveragePct: totalStops > 0 ? Math.round((stopsWithUsage / totalStops) * 1000) / 10 : 0,
    };
  }, [stops, lines]);

  const lineCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const stop of stops) map.set(stop.bus_line_id, (map.get(stop.bus_line_id) ?? 0) + 1);
    return map;
  }, [stops]);

  const filteredStops = useMemo(() => {
    const searchNorm = search.trim().toLowerCase();
    return stopsWithStatus.filter(({ stop, status }) => {
      if (lineFilter !== "all" && stop.bus_line_id !== lineFilter) return false;
      if (directionFilter !== "all" && stop.direction !== directionFilter) return false;
      if (statusFilter !== "all" && status !== statusFilter) return false;
      if (manualOnly && !stop.is_manual) return false;
      if (searchNorm) {
        const haystack = `${stop.stop_name} ${stop.city}`.toLowerCase();
        if (!haystack.includes(searchNorm)) return false;
      }
      return true;
    });
  }, [stopsWithStatus, lineFilter, directionFilter, statusFilter, manualOnly, search]);

  const sortedStops = useMemo(() => {
    const list = [...filteredStops];
    if (sortBy === "name") {
      list.sort((a, b) => a.stop.stop_name.localeCompare(b.stop.stop_name, "it"));
    } else {
      list.sort((a, b) => {
        const lineA = lineById.get(a.stop.bus_line_id)?.code ?? "";
        const lineB = lineById.get(b.stop.bus_line_id)?.code ?? "";
        if (lineA !== lineB) return lineA.localeCompare(lineB, "it");
        if (a.stop.direction !== b.stop.direction) return a.stop.direction.localeCompare(b.stop.direction);
        return a.stop.stop_order - b.stop.stop_order;
      });
    }
    return list;
  }, [filteredStops, sortBy, lineById]);

  const totalPages = Math.max(1, Math.ceil(sortedStops.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageStops = sortedStops.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  useEffect(() => {
    setPage(1);
  }, [lineFilter, directionFilter, statusFilter, manualOnly, search, pageSize, sortBy]);

  const selectedStop = selectedStopId ? stops.find((s) => s.id === selectedStopId) ?? null : null;

  const selectStop = (stop: BusStopRow) => {
    setMode("view");
    setSelectedStopId(stop.id);
    setDraft(draftFromStop(stop));
    setStopOrderTouched(true);
  };

  const startCreate = () => {
    const defaultLineId = lineFilter !== "all" ? lineFilter : lines[0]?.id ?? "";
    setMode("create");
    setSelectedStopId(null);
    setDraft(emptyDraft(defaultLineId));
    setStopOrderTouched(false);
  };

  const closePanel = () => {
    setMode("view");
    setSelectedStopId(null);
    setDraft(null);
  };

  // Fase 7 — propone automaticamente il prossimo stop_order per linea+direzione
  // in creazione, finché l'utente non lo modifica manualmente.
  useEffect(() => {
    if (mode !== "create" || !draft || stopOrderTouched) return;
    const candidates = stops.filter((s) => s.bus_line_id === draft.busLineId && s.direction === draft.direction);
    const nextOrder = candidates.length > 0 ? Math.max(...candidates.map((s) => s.stop_order)) + 1 : 1;
    setDraft((prev) => (prev ? { ...prev, stopOrder: String(nextOrder) } : prev));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- solo su cambio linea/direzione in creazione, non su ogni digitazione
  }, [mode, draft?.busLineId, draft?.direction, stopOrderTouched, stops]);

  const nearDuplicates = useMemo(() => {
    if (!draft || !draft.stopName.trim()) return [];
    const siblings = stops
      .filter((s) => s.bus_line_id === draft.busLineId && s.direction === draft.direction && s.id !== selectedStopId)
      .map((s) => ({ id: s.id, stopName: s.stop_name, city: s.city }));
    return findNearDuplicateStopNamesClient(draft.stopName, siblings);
  }, [draft, stops, selectedStopId]);

  const updateDraft = (patch: Partial<StopDraft>) => setDraft((prev) => (prev ? { ...prev, ...patch } : prev));

  const save = async () => {
    if (!draft) return;
    if (!draft.stopName.trim() || !draft.city.trim()) {
      setMessage("Nome fermata e città sono obbligatori.");
      return;
    }
    const stopOrderNum = draft.stopOrder ? Number(draft.stopOrder) : undefined;
    const latNum = draft.lat.trim() ? Number(draft.lat) : null;
    const lngNum = draft.lng.trim() ? Number(draft.lng) : null;

    setBusy(true);
    const payload = {
      bus_line_id: draft.busLineId,
      direction: draft.direction,
      stop_name: draft.stopName.trim(),
      city: draft.city.trim(),
      pickup_note: draft.pickupNote.trim() || null,
      pickup_time: draft.pickupTime || null,
      stop_order: stopOrderNum,
      lat: latNum,
      lng: lngNum,
    };
    const result =
      mode === "create"
        ? await postBusNetworkAction("create_bus_line_stop", payload)
        : await postBusNetworkAction("update_bus_line_stop", { stop_id: selectedStopId, ...payload, active: draft.active });
    setBusy(false);
    if (!result.ok) {
      setMessage(result.error ?? "Errore salvataggio fermata.");
      return;
    }
    await loadData();
    const savedStop = (result as { stop?: BusStopRow }).stop;
    if (savedStop) {
      setSelectedStopId(savedStop.id);
      setMode("view");
    }
    setMessage(mode === "create" ? "Fermata creata." : "Fermata aggiornata.");
  };

  const remove = async () => {
    if (!selectedStop) return;
    if (selectedStop.service_count > 0) {
      setMessage(`Fermata utilizzata da ${selectedStop.service_count} servizi. Non può essere eliminata.`);
      return;
    }
    if (typeof window !== "undefined" && !window.confirm(`Eliminare definitivamente la fermata "${selectedStop.stop_name}"?`)) {
      return;
    }
    setBusy(true);
    const result = await postBusNetworkAction("delete_bus_line_stop", { stop_id: selectedStop.id });
    setBusy(false);
    if (!result.ok) {
      setMessage(result.error ?? "Errore eliminazione fermata.");
      return;
    }
    closePanel();
    await loadData();
    setMessage("Fermata eliminata.");
  };

  const exportCsv = () => {
    const header = ["Linea", "Direzione", "Ordine", "Nome fermata", "Città", "Punto di carico", "Stato", "Servizi"];
    const rows = sortedStops.map(({ stop, status }) => [
      lineById.get(stop.bus_line_id)?.code ?? "",
      DIRECTION_LABEL[stop.direction],
      stop.stop_order,
      stop.stop_name,
      stop.city,
      stop.pickup_note ?? "",
      BUS_STOP_STATUS_LABELS[status],
      stop.service_count,
    ]);
    const csv = [header, ...rows].map((row) => row.map(toCsvValue).join(",")).join("\n");
    const blob = new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "fermate-bus.csv";
    link.click();
    URL.revokeObjectURL(url);
  };

  if (loading) return <div className="card p-4 text-sm text-muted">Caricamento fermate...</div>;
  if (errorMessage) return <div className="card p-4 text-sm text-muted">{errorMessage}</div>;

  return (
    <section className="page-section">
      <PageHeader
        title="Fermate bus"
        subtitle="Gestisci tutte le fermate delle linee bus. Puoi aggiungere, modificare o disattivare le fermate e definire il punto di carico."
        actions={
          <button type="button" className="btn-primary px-4 py-2 text-sm" onClick={startCreate}>
            + Nuova fermata
          </button>
        }
      />

      <div className="grid gap-3 md:grid-cols-4">
        <article className="card p-4">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-100 text-blue-600">
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 21s-7-6.2-7-11a7 7 0 1 1 14 0c0 4.8-7 11-7 11z" /><circle cx="12" cy="10" r="2.5" /></svg>
            </span>
            <div>
              <p className="text-2xl font-bold text-text">{kpi.totalStops}</p>
              <p className="text-xs text-muted">Fermate totali</p>
            </div>
          </div>
        </article>
        <article className="card p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M5 12l4 4 10-10" /></svg>
              </span>
              <div>
                <p className="text-2xl font-bold text-text">{kpi.withNote}</p>
                <p className="text-xs text-muted">Con punto di carico</p>
              </div>
            </div>
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">{kpi.withNotePct}%</span>
          </div>
        </article>
        <article className="card p-4">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-600">
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 3" /></svg>
            </span>
            <div>
              <p className="text-2xl font-bold text-text">{kpi.activeLinesCount}</p>
              <p className="text-xs text-muted">Linee attive</p>
            </div>
          </div>
          <p className="mt-2 text-[11px] text-muted">{kpi.activeLinesLabel}</p>
        </article>
        <article className="card p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-purple-100 text-purple-600">
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="9" cy="8" r="3" /><path d="M2 20a7 7 0 0 1 14 0M16 8a3 3 0 1 1 0 6M22 20a6.5 6.5 0 0 0-5-6.3" /></svg>
              </span>
              <div>
                <p className="text-2xl font-bold text-text">{kpi.linkedServicesTotal}</p>
                <p className="text-xs text-muted">Servizi collegati</p>
              </div>
            </div>
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">{kpi.coveragePct}%</span>
          </div>
        </article>
      </div>

      <div className="grid gap-4 xl:grid-cols-[260px_minmax(0,1fr)_380px]">
        {/* Colonna sinistra: filtri */}
        <div className="space-y-3">
          <div className="card space-y-3 p-4">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">Filtri</h2>
              <button
                type="button"
                className="text-xs text-accent hover:underline"
                onClick={() => {
                  setLineFilter("all");
                  setDirectionFilter("all");
                  setStatusFilter("all");
                  setSearch("");
                  setManualOnly(false);
                }}
              >
                Pulisci
              </button>
            </div>
            <label className="block text-xs text-muted">
              Linea
              <select className="input-saas mt-1 w-full" value={lineFilter} onChange={(e) => setLineFilter(e.target.value)}>
                <option value="all">Tutte le linee</option>
                {lines.map((line) => (
                  <option key={line.id} value={line.id}>{line.name}</option>
                ))}
              </select>
            </label>
            <label className="block text-xs text-muted">
              Direzione
              <select className="input-saas mt-1 w-full" value={directionFilter} onChange={(e) => setDirectionFilter(e.target.value as "all" | Direction)}>
                <option value="all">Tutte</option>
                <option value="arrival">Andata</option>
                <option value="departure">Ritorno</option>
              </select>
            </label>
            <label className="block text-xs text-muted">
              Stato
              <select className="input-saas mt-1 w-full" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as "all" | BusStopStatus)}>
                <option value="all">Tutte</option>
                <option value="active">Solo attive</option>
                <option value="incomplete">Da completare</option>
                <option value="unused">Mai utilizzate</option>
                <option value="review">Da verificare</option>
              </select>
            </label>
            <label className="block text-xs text-muted">
              Cerca
              <input className="input-saas mt-1 w-full" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Nome fermata, città..." />
            </label>
            <button type="button" className="w-full rounded-lg bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-700 hover:bg-blue-100" onClick={() => setShowMoreFilters((v) => !v)}>
              Altri filtri
            </button>
            {showMoreFilters ? (
              <label className="flex items-center gap-2 text-xs text-muted">
                <input type="checkbox" checked={manualOnly} onChange={(e) => setManualOnly(e.target.checked)} />
                Solo fermate create manualmente
              </label>
            ) : null}
          </div>

          <div className="card space-y-1 p-4">
            <h2 className="mb-2 font-semibold">Linee</h2>
            <button
              type="button"
              onClick={() => setLineFilter("all")}
              className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-sm ${lineFilter === "all" ? "bg-blue-50 font-semibold text-blue-700" : "hover:bg-slate-50"}`}
            >
              <span>Tutte le linee</span>
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">{stops.length}</span>
            </button>
            {lines.map((line) => (
              <button
                key={line.id}
                type="button"
                onClick={() => setLineFilter(line.id)}
                className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-sm ${lineFilter === line.id ? "bg-blue-50 font-semibold text-blue-700" : "hover:bg-slate-50"}`}
              >
                <span className="truncate">{line.name}</span>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">{lineCounts.get(line.id) ?? 0}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Colonna centrale: tabella */}
        <div className="card p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold">Fermate ({sortedStops.length})</h2>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1.5 text-xs text-muted">
                Ordina per
                <select className="input-saas py-1 text-xs" value={sortBy} onChange={(e) => setSortBy(e.target.value as "line_order" | "name")}>
                  <option value="line_order">Linea, Ordine</option>
                  <option value="name">Nome fermata (A-Z)</option>
                </select>
              </label>
              <button type="button" className="btn-secondary px-3 py-1.5 text-xs" onClick={exportCsv} disabled={sortedStops.length === 0}>
                Esporta
              </button>
            </div>
          </div>

          {sortedStops.length === 0 ? (
            <EmptyState title="Nessuna fermata trovata con questi filtri." compact />
          ) : (
            <>
              {/* Desktop/tablet: tabella */}
              <div className="hidden overflow-x-auto rounded-xl border border-slate-200 md:block">
                <table className="min-w-[900px] table-auto whitespace-nowrap text-sm">
                  <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-3 py-2.5">Linea</th>
                      <th className="px-3 py-2">Direzione</th>
                      <th className="px-3 py-2">Ord.</th>
                      <th className="px-3 py-2">Nome fermata</th>
                      <th className="px-3 py-2">Città</th>
                      <th className="px-3 py-2">Punto di carico</th>
                      <th className="px-3 py-2">Stato</th>
                      <th className="px-3 py-2">Servizi</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageStops.map(({ stop, status }) => {
                      const line = lineById.get(stop.bus_line_id);
                      const isSelected = selectedStopId === stop.id;
                      return (
                        <tr
                          key={stop.id}
                          onClick={() => selectStop(stop)}
                          className={`cursor-pointer border-t border-slate-100 transition ${isSelected ? "bg-blue-50/70" : "hover:bg-slate-50"}`}
                        >
                          <td className="px-3 py-2">
                            {line ? <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold uppercase ${lineBadgeClassName(line.family_code)}`}>{lineShortLabel(line)}</span> : "N/D"}
                          </td>
                          <td className="px-3 py-2 text-slate-700">{DIRECTION_LABEL[stop.direction]}</td>
                          <td className="px-3 py-2 text-slate-500">{stop.stop_order}</td>
                          <td className="px-3 py-2 font-semibold text-slate-800">{stop.stop_name.toUpperCase()}</td>
                          <td className="px-3 py-2 text-slate-600">{stop.city}</td>
                          <td className="max-w-[240px] truncate px-3 py-2 text-slate-600" title={stop.pickup_note ?? ""}>
                            {stop.pickup_note && stop.pickup_note.trim() ? (
                              stop.pickup_note
                            ) : (
                              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700">Punto di carico mancante</span>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${BUS_STOP_STATUS_BADGE_CLASSNAME[status]}`}>{BUS_STOP_STATUS_LABELS[status]}</span>
                          </td>
                          <td className="px-3 py-2 text-slate-600">{stop.service_count}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Mobile: card per fermata (Fase 19 — niente tabella illeggibile) */}
              <div className="space-y-2 md:hidden">
                {pageStops.map(({ stop, status }) => {
                  const line = lineById.get(stop.bus_line_id);
                  return (
                    <button
                      type="button"
                      key={stop.id}
                      onClick={() => selectStop(stop)}
                      className={`block w-full rounded-xl border p-3 text-left text-sm ${selectedStopId === stop.id ? "border-blue-300 bg-blue-50/60" : "border-slate-200 bg-white"}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold text-slate-800">{stop.stop_name.toUpperCase()}</span>
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${BUS_STOP_STATUS_BADGE_CLASSNAME[status]}`}>{BUS_STOP_STATUS_LABELS[status]}</span>
                      </div>
                      <div className="mt-1 flex items-center gap-2 text-xs text-muted">
                        {line ? <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold uppercase ${lineBadgeClassName(line.family_code)}`}>{lineShortLabel(line)}</span> : null}
                        <span>{DIRECTION_LABEL[stop.direction]}</span>
                        <span>· {stop.service_count} servizi</span>
                      </div>
                      <p className="mt-1 text-xs text-slate-600">{stop.pickup_note && stop.pickup_note.trim() ? stop.pickup_note : "Punto di carico mancante"}</p>
                    </button>
                  );
                })}
              </div>

              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
                <span>Risultati: {sortedStops.length} fermate</span>
                <div className="flex items-center gap-2">
                  <button type="button" className="btn-secondary px-2 py-1 text-xs" disabled={currentPage <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>‹</button>
                  <span>Pagina {currentPage} / {totalPages}</span>
                  <button type="button" className="btn-secondary px-2 py-1 text-xs" disabled={currentPage >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>›</button>
                  <select className="input-saas py-1 text-xs" value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}>
                    <option value={10}>10 per pagina</option>
                    <option value={25}>25 per pagina</option>
                    <option value={50}>50 per pagina</option>
                  </select>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Colonna destra: pannello modifica/creazione */}
        <div className="card space-y-3 p-4">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">{mode === "create" ? "Nuova fermata" : "Modifica fermata"}</h2>
            {draft ? (
              <button type="button" className="text-sm text-muted hover:text-text" onClick={closePanel} aria-label="Chiudi">✕</button>
            ) : null}
          </div>

          {!draft ? (
            <p className="text-sm text-muted">Seleziona una fermata dalla tabella, oppure crea una nuova fermata.</p>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="text-sm">Linea
                  <select className="input-saas mt-1 w-full" value={draft.busLineId} onChange={(e) => updateDraft({ busLineId: e.target.value })} disabled={mode === "view" && !!selectedStop && selectedStop.service_count > 0}>
                    {lines.map((line) => (
                      <option key={line.id} value={line.id}>{line.name}</option>
                    ))}
                  </select>
                </label>
                <label className="text-sm">Direzione
                  <select className="input-saas mt-1 w-full" value={draft.direction} onChange={(e) => updateDraft({ direction: e.target.value as Direction })} disabled={mode === "view" && !!selectedStop && selectedStop.service_count > 0}>
                    <option value="arrival">Andata</option>
                    <option value="departure">Ritorno</option>
                  </select>
                </label>
              </div>
              {mode === "view" && selectedStop && selectedStop.service_count > 0 ? (
                <p className="text-xs text-amber-700">Fermata usata da {selectedStop.service_count} servizi: linea/direzione bloccate da qui.</p>
              ) : null}

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="text-sm">Nome fermata *
                  <input className="input-saas mt-1 w-full" value={draft.stopName} onChange={(e) => updateDraft({ stopName: e.target.value })} />
                </label>
                <label className="text-sm">Città *
                  <input className="input-saas mt-1 w-full" value={draft.city} onChange={(e) => updateDraft({ city: e.target.value })} />
                </label>
              </div>

              {nearDuplicates.length > 0 ? (
                <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
                  Esiste una fermata simile: {nearDuplicates.map((d) => d.stopName).join(", ")}
                </p>
              ) : null}

              <label className="block text-sm">Punto di carico
                <textarea className="input-saas mt-1 min-h-[64px] w-full" value={draft.pickupNote} onChange={(e) => updateDraft({ pickupNote: e.target.value })} placeholder="Inserisci punto di carico" />
              </label>

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="text-sm">Orario indicativo
                  <input type="time" className="input-saas mt-1 w-full" value={draft.pickupTime} onChange={(e) => updateDraft({ pickupTime: e.target.value })} />
                </label>
                <label className="text-sm">Ordine fermata
                  <input type="number" min={1} className="input-saas mt-1 w-full" value={draft.stopOrder} onChange={(e) => { setStopOrderTouched(true); updateDraft({ stopOrder: e.target.value }); }} />
                </label>
              </div>

              {mode === "view" ? (
                <label className="flex items-center gap-3 text-sm">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={draft.active}
                    onClick={() => updateDraft({ active: !draft.active })}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition ${draft.active ? "bg-blue-600" : "bg-slate-300"}`}
                  >
                    <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition ${draft.active ? "translate-x-6" : "translate-x-1"}`} />
                  </button>
                  Attiva
                </label>
              ) : null}

              <div>
                <p className="text-xs font-medium text-muted">Coordinate (opzionale)</p>
                <div className="mt-1 grid gap-3 sm:grid-cols-2">
                  <label className="text-sm">Latitudine
                    <input className="input-saas mt-1 w-full" value={draft.lat} onChange={(e) => updateDraft({ lat: e.target.value })} />
                  </label>
                  <label className="text-sm">Longitudine
                    <input className="input-saas mt-1 w-full" value={draft.lng} onChange={(e) => updateDraft({ lng: e.target.value })} />
                  </label>
                </div>
                {draft.lat && draft.lng ? (
                  <a
                    className="mt-1 inline-block text-xs text-accent hover:underline"
                    href={`https://www.google.com/maps?q=${encodeURIComponent(draft.lat)},${encodeURIComponent(draft.lng)}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Apri in Google Maps
                  </a>
                ) : null}
              </div>

              <div className="flex flex-wrap gap-2 pt-2">
                {mode === "view" && selectedStop ? (
                  <button
                    type="button"
                    className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-700 hover:bg-rose-100 disabled:opacity-50"
                    disabled={busy || selectedStop.service_count > 0}
                    title={selectedStop.service_count > 0 ? `Fermata utilizzata da ${selectedStop.service_count} servizi. Non può essere eliminata.` : undefined}
                    onClick={() => void remove()}
                  >
                    Elimina fermata
                  </button>
                ) : null}
                <button type="button" className="btn-primary px-4 py-2 text-sm" disabled={busy} onClick={() => void save()}>
                  {busy ? "Salvataggio..." : mode === "create" ? "Crea fermata" : "Salva modifiche"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {message ? <div className="fixed bottom-4 right-4 rounded-lg bg-slate-900 px-4 py-2 text-sm text-white">{message}</div> : null}
    </section>
  );
}
