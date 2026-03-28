"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PageHeader } from "@/components/ui";
import { supabase } from "@/lib/supabase/client";

// ─── TYPES ────────────────────────────────────────────────────────────────────

type PlanningCell = {
  id: string;
  planning_type: string;
  cell_date: string;
  row_key: string;
  col_index: number;
  content: string | null;
  bg_color: string | null;
  service_id: string | null;
};

type BusUnit = {
  id: string;
  label: string;
  capacity: number;
  sort_order: number | null;
  driver_name: string | null;
};

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const MONTHS_IT = [
  "Gennaio", "Febbraio", "Marzo", "Aprile", "Maggio", "Giugno",
  "Luglio", "Agosto", "Settembre", "Ottobre", "Novembre", "Dicembre"
];
const SHORT_MONTHS_IT = [
  "gen", "feb", "mar", "apr", "mag", "giu",
  "lug", "ago", "set", "ott", "nov", "dic"
];

const COLOR_OPTIONS = [
  { key: "yellow", label: "Giallo",  tw: "bg-yellow-300 text-yellow-900" },
  { key: "red",    label: "Rosso",   tw: "bg-red-500 text-white" },
  { key: "green",  label: "Verde",   tw: "bg-green-500 text-white" },
  { key: "blue",   label: "Blu",     tw: "bg-blue-500 text-white" },
  { key: "orange", label: "Arancio", tw: "bg-orange-400 text-white" },
];

function cellColorTw(color: string | null): string {
  return COLOR_OPTIONS.find((c) => c.key === color)?.tw ?? "bg-yellow-300 text-yellow-900";
}

// ─── UTILS ────────────────────────────────────────────────────────────────────

function numDaysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function isSunday(year: number, month: number, day: number): boolean {
  return new Date(year, month - 1, day).getDay() === 0;
}

function toDateStr(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function formatDateRow(isoDate: string): string {
  const [, m, d] = isoDate.split("-");
  return `${parseInt(d)}-${SHORT_MONTHS_IT[parseInt(m) - 1]}`;
}

// ─── MONTH NAVIGATOR ──────────────────────────────────────────────────────────

function MonthNav({
  year, month, minYear, maxYear,
  setYear, setMonth,
}: {
  year: number; month: number; minYear: number; maxYear: number;
  setYear: (y: number) => void; setMonth: (m: number) => void;
}) {
  const prev = () => {
    if (month === 1) { if (year > minYear) { setYear(year - 1); setMonth(12); } }
    else setMonth(month - 1);
  };
  const next = () => {
    if (month === 12) { if (year < maxYear) { setYear(year + 1); setMonth(1); } }
    else setMonth(month + 1);
  };
  const atMin = year === minYear && month === 1;
  const atMax = year === maxYear && month === 12;

  return (
    <div className="flex items-center gap-3 flex-wrap">
      <button
        onClick={prev}
        disabled={atMin}
        className="btn-secondary px-4 py-2 text-base disabled:opacity-40"
      >
        ‹
      </button>
      <span className="font-semibold text-text text-base min-w-[200px] text-center">
        {MONTHS_IT[month - 1]} {year}
      </span>
      <button
        onClick={next}
        disabled={atMax}
        className="btn-secondary px-4 py-2 text-base disabled:opacity-40"
      >
        ›
      </button>
    </div>
  );
}

// ─── PLANNING BUS ─────────────────────────────────────────────────────────────

function BusPlanningGrid({ token }: { token: string }) {
  const today = new Date();
  const currentYear = today.getFullYear();
  const [year, setYear] = useState(currentYear);
  const [month, setMonth] = useState(today.getMonth() + 1);
  const [busUnits, setBusUnits] = useState<BusUnit[]>([]);
  const [cells, setCells] = useState<PlanningCell[]>([]);
  const [editKey, setEditKey] = useState<string | null>(null); // "unitId|day"
  const [editVal, setEditVal] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const loadData = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/planning/cells?type=bus&year=${year}&month=${month}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Errore caricamento");
      const data = (await res.json()) as { bus_units: BusUnit[]; cells: PlanningCell[] };
      setBusUnits(data.bus_units ?? []);
      setCells(data.cells ?? []);
    } catch {
      setError("Errore nel caricamento del planning bus.");
    }
  }, [token, year, month]);

  useEffect(() => { void loadData(); }, [loadData]);
  useEffect(() => {
    if (editKey) setTimeout(() => inputRef.current?.focus(), 30);
  }, [editKey]);

  const numDays = numDaysInMonth(year, month);
  const days = Array.from({ length: numDays }, (_, i) => i + 1);

  const getCell = (unitId: string, day: number) => {
    const date = toDateStr(year, month, day);
    return cells.find((c) => c.row_key === unitId && c.cell_date === date) ?? null;
  };

  const openEdit = (unitId: string, day: number) => {
    const cell = getCell(unitId, day);
    setEditKey(`${unitId}|${day}`);
    setEditVal(cell?.content ?? "");
  };

  const saveCell = async (unitId: string, day: number) => {
    if (saving) return;
    setSaving(true);
    const date = toDateStr(year, month, day);
    try {
      const existing = getCell(unitId, day);
      if (!editVal.trim()) {
        if (existing) {
          await fetch("/api/planning/cells", {
            method: "DELETE",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ id: existing.id }),
          });
        }
      } else {
        await fetch("/api/planning/cells", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            type: "bus",
            cell_date: date,
            row_key: unitId,
            col_index: 0,
            content: editVal.trim(),
            bg_color: "yellow",
          }),
        });
      }
      await loadData();
    } finally {
      setSaving(false);
      setEditKey(null);
    }
  };

  return (
    <div className="space-y-4">
      <MonthNav
        year={year} month={month}
        minYear={currentYear - 2} maxYear={currentYear + 2}
        setYear={setYear} setMonth={setMonth}
      />

      {error && <p className="text-sm text-red-500">{error}</p>}

      {busUnits.length === 0 ? (
        <div className="card p-8 text-center space-y-2">
          <p className="text-text font-medium">Nessun mezzo trovato</p>
          <p className="text-muted text-sm">
            Aggiungi i mezzi dalla sezione{" "}
            <a href="/bus-network" className="text-blue-600 underline">Rete Bus</a>{" "}
            (tab Mezzi), poi ricarica questa pagina.
          </p>
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl border border-border shadow-sm">
            <table className="border-collapse text-xs" style={{ minWidth: `${130 + numDays * 42}px` }}>
              <thead>
                <tr>
                  <th className="sticky left-0 z-20 bg-gray-900 text-white px-3 py-2.5 text-left min-w-[130px] border-r border-gray-600 font-bold tracking-wider uppercase text-[11px]">
                    AUTOBUS
                  </th>
                  {days.map((day) => {
                    const sun = isSunday(year, month, day);
                    return (
                      <th
                        key={day}
                        className={`px-1 py-2.5 text-center w-[42px] min-w-[42px] border-l border-gray-600 font-bold text-[11px] ${sun ? "bg-red-600 text-white" : "bg-gray-900 text-white"}`}
                      >
                        {day}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {busUnits.map((unit, rowIdx) => (
                  <tr key={unit.id} className={rowIdx % 2 === 0 ? "bg-white" : "bg-gray-50/70"}>
                    <td className="sticky left-0 z-10 bg-inherit border-r border-gray-200 px-2 py-1.5 min-w-[130px]">
                      <div className="font-semibold text-text text-[11px] leading-tight">{unit.label}</div>
                      <div className="text-muted text-[10px]">POSTI {unit.capacity}</div>
                      {unit.driver_name && (
                        <div className="text-muted text-[9px] opacity-70 truncate">{unit.driver_name}</div>
                      )}
                    </td>
                    {days.map((day) => {
                      const cell = getCell(unit.id, day);
                      const cellKey = `${unit.id}|${day}`;
                      const isEditing = editKey === cellKey;
                      const sun = isSunday(year, month, day);

                      return (
                        <td
                          key={day}
                          className={[
                            "border-l border-gray-200 p-0 cursor-pointer align-middle text-center",
                            "w-[42px] min-w-[42px] h-[44px] relative group",
                            sun ? "bg-red-50" : "",
                            cell && !isEditing ? "bg-yellow-200" : "",
                            !isEditing ? "hover:ring-2 hover:ring-inset hover:ring-blue-400" : "",
                          ].filter(Boolean).join(" ")}
                          onClick={() => !isEditing && openEdit(unit.id, day)}
                          title={cell?.content ?? "Clicca per aggiungere"}
                        >
                          {isEditing ? (
                            <input
                              ref={inputRef}
                              value={editVal}
                              onChange={(e) => setEditVal(e.target.value)}
                              onBlur={() => void saveCell(unit.id, day)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") { e.preventDefault(); void saveCell(unit.id, day); }
                                if (e.key === "Escape") setEditKey(null);
                              }}
                              className="absolute inset-0 w-full h-full px-1 py-0.5 text-[10px] border-2 border-blue-500 outline-none bg-yellow-50 text-center z-30"
                              disabled={saving}
                            />
                          ) : cell ? (
                            <div
                              className="px-0.5 py-0.5 text-[9px] font-semibold leading-tight text-yellow-900 overflow-hidden"
                              style={{
                                display: "-webkit-box",
                                WebkitLineClamp: 3,
                                WebkitBoxOrient: "vertical",
                                wordBreak: "break-word",
                              } as React.CSSProperties}
                            >
                              {cell.content}
                            </div>
                          ) : (
                            <div className="opacity-0 group-hover:opacity-20 text-blue-400 text-[16px] leading-none select-none">+</div>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted">
            Clicca su una cella per aggiungere o modificare. Lascia vuoto e premi Invio per cancellare.
            Le domeniche sono evidenziate in rosso.
          </p>
        </>
      )}
    </div>
  );
}

// ─── PLANNING TRATTA ──────────────────────────────────────────────────────────

type RouteEditState = {
  date: string;
  colIndex: number;
  cellId: string | null;
};

function RoutePlanningGrid({ token }: { token: string }) {
  const today = new Date();
  const currentYear = today.getFullYear();
  const [year, setYear] = useState(currentYear);
  const [month, setMonth] = useState(today.getMonth() + 1);
  const [cells, setCells] = useState<PlanningCell[]>([]);
  const [editState, setEditState] = useState<RouteEditState | null>(null);
  const [editVal, setEditVal] = useState("");
  const [editColor, setEditColor] = useState("yellow");
  const [saving, setSaving] = useState(false);
  const [newDate, setNewDate] = useState("");
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/planning/cells?type=route&year=${year}&month=${month}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Errore caricamento");
      const data = (await res.json()) as { cells: PlanningCell[] };
      setCells(data.cells ?? []);
    } catch {
      setError("Errore nel caricamento del planning tratta.");
    }
  }, [token, year, month]);

  useEffect(() => { void loadData(); }, [loadData]);

  const activeDates = [...new Set(cells.map((c) => c.cell_date))].sort();

  const cellsForDate = (date: string) =>
    cells.filter((c) => c.cell_date === date).sort((a, b) => a.col_index - b.col_index);

  const maxColForDate = (date: string) => {
    const dc = cellsForDate(date);
    return dc.length === 0 ? -1 : Math.max(...dc.map((c) => c.col_index));
  };

  const openEdit = (date: string, colIndex: number, cell: PlanningCell | null) => {
    setEditState({ date, colIndex, cellId: cell?.id ?? null });
    setEditVal(cell?.content ?? "");
    setEditColor(cell?.bg_color ?? "yellow");
  };

  const saveRouteCell = async () => {
    if (!editState || saving) return;
    setSaving(true);
    try {
      if (!editVal.trim() && editState.cellId) {
        await fetch("/api/planning/cells", {
          method: "DELETE",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ id: editState.cellId }),
        });
      } else if (editVal.trim()) {
        await fetch("/api/planning/cells", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            type: "route",
            cell_date: editState.date,
            row_key: editState.date,
            col_index: editState.colIndex,
            content: editVal.trim().toUpperCase(),
            bg_color: editColor,
          }),
        });
      }
      await loadData();
    } finally {
      setSaving(false);
      setEditState(null);
    }
  };

  const deleteCell = async () => {
    if (!editState?.cellId || saving) return;
    setSaving(true);
    try {
      await fetch("/api/planning/cells", {
        method: "DELETE",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ id: editState.cellId }),
      });
      await loadData();
    } finally {
      setSaving(false);
      setEditState(null);
    }
  };

  const handleAddDate = () => {
    if (!newDate) return;
    const [y, m] = newDate.split("-").map(Number);
    if (y !== year || m !== month) {
      alert(`Seleziona una data in ${MONTHS_IT[month - 1]} ${year}`);
      return;
    }
    openEdit(newDate, maxColForDate(newDate) + 1, null);
    setNewDate("");
  };

  return (
    <div className="space-y-4">
      <MonthNav
        year={year} month={month}
        minYear={currentYear - 2} maxYear={currentYear + 2}
        setYear={setYear} setMonth={setMonth}
      />

      {error && <p className="text-sm text-red-500">{error}</p>}

      {/* Grid */}
      <div className="overflow-x-auto rounded-xl border border-border shadow-sm">
        <table className="border-collapse w-full min-w-[500px]">
          <thead>
            <tr className="bg-gray-900 text-white">
              <th className="sticky left-0 z-20 bg-gray-900 px-3 py-2.5 text-left min-w-[90px] border-r border-gray-600 font-bold uppercase text-[11px] tracking-wider">
                DATA
              </th>
              <th className="px-3 py-2.5 text-left text-[11px] font-bold tracking-wider text-gray-400">
                Prenotazioni tratta (clicca per modificare)
              </th>
            </tr>
          </thead>
          <tbody>
            {activeDates.length === 0 ? (
              <tr>
                <td colSpan={2} className="px-4 py-8 text-center text-muted text-sm">
                  Nessuna data inserita per questo mese. Usa il campo sottostante per aggiungere una data.
                </td>
              </tr>
            ) : (
              activeDates.map((date, rowIdx) => {
                const dc = cellsForDate(date);
                const maxCol = maxColForDate(date);
                return (
                  <tr key={date} className={rowIdx % 2 === 0 ? "bg-white" : "bg-gray-50/70"}>
                    <td className="sticky left-0 z-10 bg-yellow-300 text-yellow-900 border-r border-yellow-400 px-2 py-2 min-w-[90px] align-middle">
                      <div className="font-bold text-[13px] leading-tight">{formatDateRow(date)}</div>
                      <div className="text-[10px] opacity-60">{date.slice(0, 4)}</div>
                    </td>
                    <td className="px-2 py-2 align-middle">
                      <div className="flex flex-wrap gap-1.5 items-center">
                        {dc.map((cell) => (
                          <button
                            key={cell.id}
                            onClick={() => openEdit(date, cell.col_index, cell)}
                            className={`rounded px-2.5 py-1.5 text-[11px] font-bold cursor-pointer min-w-[90px] text-center uppercase leading-tight transition-opacity hover:opacity-80 ${cellColorTw(cell.bg_color)}`}
                          >
                            {cell.content}
                          </button>
                        ))}
                        <button
                          onClick={() => openEdit(date, maxCol + 1, null)}
                          className="rounded px-2.5 py-1.5 text-xs border border-dashed border-gray-300 text-muted hover:bg-gray-100 min-w-[32px] transition-colors"
                          title="Aggiungi prenotazione"
                        >
                          +
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Add date */}
      <div className="flex gap-2 items-center flex-wrap">
        <input
          type="date"
          value={newDate}
          onChange={(e) => setNewDate(e.target.value)}
          className="input-saas text-sm"
          min={`${currentYear - 2}-01-01`}
          max={`${currentYear + 2}-12-31`}
        />
        <button
          onClick={handleAddDate}
          className="btn-secondary text-sm"
          disabled={!newDate}
        >
          + Aggiungi data
        </button>
      </div>

      {/* Edit modal — bottom sheet on mobile, centered on desktop */}
      {editState && (
        <div
          className="fixed inset-0 bg-black/50 z-50 flex items-end md:items-center justify-center p-0 md:p-4"
          onClick={() => setEditState(null)}
        >
          <div
            className="bg-white rounded-t-2xl md:rounded-2xl p-5 w-full max-w-md shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-text text-sm">
                {editState.cellId ? "Modifica" : "Aggiungi"} — {formatDateRow(editState.date)} {editState.date.slice(0, 4)}
              </h3>
              <button onClick={() => setEditState(null)} className="text-muted text-lg leading-none">✕</button>
            </div>

            <textarea
              value={editVal}
              onChange={(e) => setEditVal(e.target.value)}
              rows={3}
              className="input-saas w-full text-sm"
              placeholder="Es. BORTONE DISCESA MILANO"
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && e.ctrlKey) void saveRouteCell();
              }}
            />

            {/* Color picker */}
            <div className="flex gap-2 mt-3 flex-wrap">
              {COLOR_OPTIONS.map((c) => (
                <button
                  key={c.key}
                  onClick={() => setEditColor(c.key)}
                  className={[
                    "px-3 py-1.5 rounded-lg text-xs font-semibold transition-all",
                    c.tw,
                    editColor === c.key ? "ring-2 ring-offset-2 ring-gray-700 scale-105" : "opacity-60 hover:opacity-90",
                  ].join(" ")}
                >
                  {c.label}
                </button>
              ))}
            </div>

            {/* Preview */}
            {editVal.trim() && (
              <div className={`mt-3 rounded px-3 py-2 text-xs font-bold text-center uppercase ${cellColorTw(editColor)}`}>
                {editVal.trim().toUpperCase()}
              </div>
            )}

            <div className="flex gap-2 mt-4 flex-wrap">
              <button
                className="btn-primary flex-1 text-sm"
                onClick={() => void saveRouteCell()}
                disabled={saving || !editVal.trim()}
              >
                {saving ? "Salvataggio…" : "Salva"}
              </button>
              {editState.cellId && (
                <button
                  className="btn-secondary text-sm border-red-200 text-red-600 hover:bg-red-50"
                  onClick={() => void deleteCell()}
                  disabled={saving}
                >
                  Elimina
                </button>
              )}
              <button className="btn-secondary text-sm" onClick={() => setEditState(null)}>
                Annulla
              </button>
            </div>
            <p className="text-[10px] text-muted mt-2 text-center">Ctrl+Invio per salvare rapidamente</p>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── MAIN PAGE ────────────────────────────────────────────────────────────────

type PlanningTab = "bus" | "route";

export default function MarioPlanningPage() {
  const [tab, setTab] = useState<PlanningTab>("bus");
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data: { session } }) => {
      setToken(session?.access_token ?? null);
    });
  }, []);

  if (!token) {
    return (
      <section className="page-section">
        <div className="card p-4 text-sm text-muted">Caricamento…</div>
      </section>
    );
  }

  return (
    <section className="page-section">
      <PageHeader
        title="Mario Planning"
        subtitle="Planning mensile veicoli e tratte — celle editabili, domeniche in rosso"
        breadcrumbs={[
          { label: "Operazioni", href: "/dashboard" },
          { label: "Mario Planning" },
        ]}
      />

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-border pb-0 overflow-x-auto">
        {(["bus", "route"] as PlanningTab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={[
              "px-5 py-2.5 text-sm font-medium rounded-t-lg whitespace-nowrap transition-colors",
              tab === t
                ? "bg-primary text-white"
                : "text-muted hover:text-text hover:bg-surface",
            ].join(" ")}
          >
            {t === "bus" ? "Planning Bus" : "Planning Tratta"}
          </button>
        ))}
      </div>

      {tab === "bus" ? (
        <BusPlanningGrid token={token} />
      ) : (
        <RoutePlanningGrid token={token} />
      )}
    </section>
  );
}
