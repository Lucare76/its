"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PageHeader } from "@/components/ui";
import { supabase } from "@/lib/supabase/client";

// ─── TYPES ────────────────────────────────────────────────────────────────────

type PlanningCell = {
  id: string;
  planning_type: string;
  cell_date: string;
  end_date: string | null;
  row_key: string;
  col_index: number;
  content: string | null;
  bg_color: string | null;
};

type BusUnit = {
  id: string;
  label: string;
  capacity: number;
  sort_order: number | null;
  driver_name: string | null;
};

type PlanningTab = "bus" | "gruppi" | "route";

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const MONTHS_IT = [
  "Gennaio","Febbraio","Marzo","Aprile","Maggio","Giugno",
  "Luglio","Agosto","Settembre","Ottobre","Novembre","Dicembre",
];
const SHORT_MONTHS_IT = ["gen","feb","mar","apr","mag","giu","lug","ago","set","ott","nov","dic"];

const COLOR_OPTIONS = [
  { key: "yellow", label: "Giallo",  tw: "bg-yellow-300 text-yellow-900" },
  { key: "red",    label: "Rosso",   tw: "bg-red-500 text-white" },
  { key: "green",  label: "Verde",   tw: "bg-green-500 text-white" },
  { key: "blue",   label: "Blu",     tw: "bg-blue-500 text-white" },
  { key: "orange", label: "Arancio", tw: "bg-orange-400 text-white" },
];

function colorTw(color: string | null): string {
  return COLOR_OPTIONS.find((c) => c.key === color)?.tw ?? "bg-yellow-300 text-yellow-900";
}

// ─── UTILS ────────────────────────────────────────────────────────────────────

function daysInMonth(year: number, month: number) {
  return new Date(year, month, 0).getDate();
}

function isSunday(year: number, month: number, day: number) {
  return new Date(year, month - 1, day).getDay() === 0;
}

function toDateStr(year: number, month: number, day: number) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function shortDate(iso: string) {
  const [, m, d] = iso.split("-");
  return `${parseInt(d, 10)}-${SHORT_MONTHS_IT[parseInt(m, 10) - 1]}`;
}

// pure: build day→block map for a unit (from cells array)
function buildDayMap(cells: PlanningCell[], unitId: string): Map<number, PlanningCell> {
  const map = new Map<number, PlanningCell>();
  for (const c of cells) {
    if (c.row_key !== unitId) continue;
    const s = parseInt(c.cell_date.slice(8), 10);
    const e = c.end_date ? parseInt(c.end_date.slice(8), 10) : s;
    for (let d = s; d <= e; d++) map.set(d, c);
  }
  return map;
}

// pure: check if [start,end] overlaps existing blocks
function hasConflict(cells: PlanningCell[], unitId: string, start: number, end: number): boolean {
  for (const c of cells) {
    if (c.row_key !== unitId) continue;
    const s = parseInt(c.cell_date.slice(8), 10);
    const e = c.end_date ? parseInt(c.end_date.slice(8), 10) : s;
    if (!(end < s || start > e)) return true;
  }
  return false;
}

// ─── SHARED: MONTH NAVIGATOR ──────────────────────────────────────────────────

function MonthNav({
  year, month, minYear, maxYear, setYear, setMonth,
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
  return (
    <div className="flex items-center gap-3 flex-wrap">
      <button onClick={prev} disabled={year === minYear && month === 1} className="btn-secondary px-4 py-2 text-base disabled:opacity-40">‹</button>
      <span className="font-semibold text-text text-base min-w-[200px] text-center">{MONTHS_IT[month - 1]} {year}</span>
      <button onClick={next} disabled={year === maxYear && month === 12} className="btn-secondary px-4 py-2 text-base disabled:opacity-40">›</button>
    </div>
  );
}

// ─── SHARED: COLOR PICKER ─────────────────────────────────────────────────────

function ColorPicker({ value, onChange }: { value: string; onChange: (k: string) => void }) {
  return (
    <div className="flex gap-2 flex-wrap">
      {COLOR_OPTIONS.map((c) => (
        <button
          key={c.key}
          onClick={() => onChange(c.key)}
          className={[
            "px-3 py-1.5 rounded-lg text-xs font-semibold transition-all",
            c.tw,
            value === c.key ? "ring-2 ring-offset-1 ring-gray-700 scale-105" : "opacity-60 hover:opacity-90",
          ].join(" ")}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}

// ─── SHARED: BOTTOM MODAL ─────────────────────────────────────────────────────

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-end md:items-center justify-center p-0 md:p-4" onClick={onClose}>
      <div className="bg-white rounded-t-2xl md:rounded-2xl p-5 w-full max-w-md shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-text text-sm">{title}</h3>
          <button onClick={onClose} className="text-muted text-lg leading-none">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. PLANNING BUS GENERALI — hotel Gantt style
// ═══════════════════════════════════════════════════════════════════════════════

type NewBlock = { unitId: string; startDay: number; endDay: number };
type EditBlock = { cell: PlanningCell };

function BusGeneralPlanning({ token }: { token: string }) {
  const today = new Date();
  const cy = today.getFullYear();
  const [year, setYear] = useState(cy);
  const [month, setMonth] = useState(today.getMonth() + 1);
  const [busUnits, setBusUnits] = useState<BusUnit[]>([]);
  const [cells, setCells] = useState<PlanningCell[]>([]);
  const [error, setError] = useState<string | null>(null);

  // drag state (refs to avoid stale closures in document event)
  const dragStartRef = useRef<{ unitId: string; day: number } | null>(null);
  const isDraggingRef = useRef(false);
  const cellsRef = useRef<PlanningCell[]>([]);
  useEffect(() => { cellsRef.current = cells; }, [cells]);

  const [dragPreview, setDragPreview] = useState<{ unitId: string; d1: number; d2: number } | null>(null);

  // new block modal
  const [newBlock, setNewBlock] = useState<NewBlock | null>(null);
  const [newLabel, setNewLabel] = useState("");
  const [newColor, setNewColor] = useState("yellow");
  const newInputRef = useRef<HTMLInputElement>(null);

  // edit block modal
  const [editBlock, setEditBlock] = useState<EditBlock | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [editColor, setEditColor] = useState("yellow");
  const editInputRef = useRef<HTMLInputElement>(null);

  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch(`/api/planning/cells?type=bus&year=${year}&month=${month}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error();
      const d = (await r.json()) as { bus_units: BusUnit[]; cells: PlanningCell[] };
      setBusUnits(d.bus_units ?? []);
      setCells(d.cells ?? []);
    } catch { setError("Errore caricamento."); }
  }, [token, year, month]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (newBlock) setTimeout(() => newInputRef.current?.focus(), 30); }, [newBlock]);
  useEffect(() => { if (editBlock) setTimeout(() => editInputRef.current?.focus(), 30); }, [editBlock]);

  // document-level mouseup to finalize drag
  useEffect(() => {
    const onUp = () => {
      if (!isDraggingRef.current || !dragStartRef.current) {
        isDraggingRef.current = false;
        setDragPreview(null);
        return;
      }
      const { unitId } = dragStartRef.current;
      const cur = dragStartRef.current;
      const snap = dragPreviewRef.current;
      const d1 = snap ? Math.min(cur.day, snap.d2) : cur.day;
      const d2 = snap ? Math.max(cur.day, snap.d2) : cur.day;
      isDraggingRef.current = false;
      dragStartRef.current = null;
      setDragPreview(null);
      if (hasConflict(cellsRef.current, unitId, d1, d2)) {
        setError("Intervallo sovrapposto a un blocco esistente.");
        setTimeout(() => setError(null), 3000);
        return;
      }
      setNewBlock({ unitId, startDay: d1, endDay: d2 });
      setNewLabel("");
      setNewColor("yellow");
    };
    document.addEventListener("mouseup", onUp);
    document.addEventListener("touchend", onUp);
    return () => {
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("touchend", onUp);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ref mirror of dragPreview for use inside document mouseup
  const dragPreviewRef = useRef<{ unitId: string; d1: number; d2: number } | null>(null);
  useEffect(() => { dragPreviewRef.current = dragPreview; }, [dragPreview]);

  // Escape to cancel
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { isDraggingRef.current = false; dragStartRef.current = null; setDragPreview(null); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const numDays = daysInMonth(year, month);
  const days = Array.from({ length: numDays }, (_, i) => i + 1);

  function onCellDown(unitId: string, day: number, e: React.MouseEvent | React.TouchEvent) {
    if ("button" in e && e.button !== 0) return;
    e.preventDefault();
    dragStartRef.current = { unitId, day };
    isDraggingRef.current = true;
    setDragPreview({ unitId, d1: day, d2: day });
  }

  function onCellEnter(unitId: string, day: number) {
    if (!isDraggingRef.current || !dragStartRef.current) return;
    if (dragStartRef.current.unitId !== unitId) return;
    const d1 = dragStartRef.current.day;
    setDragPreview({ unitId, d1, d2: day });
  }

  const saveNew = async () => {
    if (!newBlock || !newLabel.trim() || saving) return;
    setSaving(true);
    try {
      await fetch("/api/planning/cells", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          type: "bus",
          cell_date: toDateStr(year, month, newBlock.startDay),
          end_date: toDateStr(year, month, newBlock.endDay),
          row_key: newBlock.unitId,
          col_index: 0,
          content: newLabel.trim().toUpperCase(),
          bg_color: newColor,
        }),
      });
      await load();
      setNewBlock(null);
    } finally { setSaving(false); }
  };

  const saveEdit = async () => {
    if (!editBlock || !editLabel.trim() || saving) return;
    setSaving(true);
    try {
      await fetch("/api/planning/cells", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          type: "bus",
          cell_date: editBlock.cell.cell_date,
          end_date: editBlock.cell.end_date,
          row_key: editBlock.cell.row_key,
          col_index: 0,
          content: editLabel.trim().toUpperCase(),
          bg_color: editColor,
        }),
      });
      await load();
      setEditBlock(null);
    } finally { setSaving(false); }
  };

  const deleteBlock = async () => {
    if (!editBlock || saving) return;
    setSaving(true);
    try {
      await fetch("/api/planning/cells", {
        method: "DELETE",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ id: editBlock.cell.id }),
      });
      await load();
      setEditBlock(null);
    } finally { setSaving(false); }
  };

  const openEdit = (cell: PlanningCell) => {
    setEditBlock({ cell });
    setEditLabel(cell.content ?? "");
    setEditColor(cell.bg_color ?? "yellow");
  };

  return (
    <div className="space-y-4">
      <MonthNav year={year} month={month} minYear={cy - 2} maxYear={cy + 2} setYear={setYear} setMonth={setMonth} />
      {error && <p className="text-sm text-red-500">{error}</p>}

      {dragPreview && (
        <p className="text-sm text-blue-600 font-medium">
          Trascina per selezionare il periodo — rilascia per creare il blocco.{" "}
          <button onClick={() => { isDraggingRef.current = false; dragStartRef.current = null; setDragPreview(null); }} className="underline">Annulla</button>
        </p>
      )}

      {busUnits.length === 0 ? (
        <div className="card p-8 text-center space-y-2">
          <p className="text-text font-medium">Nessun mezzo trovato</p>
          <p className="text-muted text-sm">Aggiungi i mezzi da <a href="/bus-network" className="text-blue-600 underline">Rete Bus</a>.</p>
        </div>
      ) : (
        <>
          <div
            className="overflow-x-auto rounded-xl border border-border shadow-sm select-none"
            style={{ cursor: isDraggingRef.current ? "col-resize" : "default" }}
          >
            <table className="border-collapse" style={{ minWidth: `${140 + numDays * 44}px` }}>
              <thead>
                <tr>
                  <th className="sticky left-0 z-20 bg-gray-900 text-white px-3 py-2.5 text-left min-w-[140px] border-r border-gray-700 font-bold uppercase text-[11px] tracking-wider">
                    AUTOBUS
                  </th>
                  {days.map((d) => (
                    <th
                      key={d}
                      className={`w-[44px] min-w-[44px] py-2.5 text-center border-l border-gray-600 font-bold text-[11px] ${isSunday(year, month, d) ? "bg-red-600 text-white" : "bg-gray-900 text-white"}`}
                    >
                      {d}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {busUnits.map((unit, ri) => {
                  const dayMap = buildDayMap(cells, unit.id);
                  const tds: React.ReactNode[] = [];
                  let d = 1;
                  while (d <= numDays) {
                    const block = dayMap.get(d);
                    if (block) {
                      const s = parseInt(block.cell_date.slice(8), 10);
                      const e = block.end_date ? parseInt(block.end_date.slice(8), 10) : s;
                      if (d === s) {
                        tds.push(
                          <td
                            key={d}
                            colSpan={e - s + 1}
                            className={`border-l border-gray-300 px-2 py-1 cursor-pointer text-center font-bold text-[11px] uppercase leading-tight hover:opacity-80 transition-opacity ${colorTw(block.bg_color)}`}
                            onClick={() => openEdit(block)}
                            title="Clicca per modificare"
                          >
                            {block.content}
                          </td>
                        );
                        d = e + 1;
                      } else {
                        d++;
                      }
                    } else {
                      const sun = isSunday(year, month, d);
                      const inPrev = dragPreview?.unitId === unit.id;
                      const dp1 = inPrev ? Math.min(dragPreview!.d1, dragPreview!.d2) : 0;
                      const dp2 = inPrev ? Math.max(dragPreview!.d1, dragPreview!.d2) : 0;
                      const highlighted = inPrev && d >= dp1 && d <= dp2;
                      const rowBg = ri % 2 === 0 ? "bg-white" : "bg-gray-50/60";
                      tds.push(
                        <td
                          key={d}
                          className={[
                            "border-l border-gray-200 h-[46px] w-[44px] min-w-[44px] transition-colors",
                            sun ? "bg-red-50" : highlighted ? "bg-blue-200" : rowBg,
                            !highlighted ? "hover:bg-blue-50" : "",
                          ].filter(Boolean).join(" ")}
                          onMouseDown={(e) => onCellDown(unit.id, d, e)}
                          onMouseEnter={() => onCellEnter(unit.id, d)}
                          onTouchStart={(e) => onCellDown(unit.id, d, e)}
                          style={{ cursor: "cell" }}
                        />
                      );
                      d++;
                    }
                  }
                  return (
                    <tr key={unit.id}>
                      <td
                        className="sticky left-0 z-10 border-r border-gray-200 px-2 py-1.5 min-w-[140px]"
                        style={{ background: ri % 2 === 0 ? "white" : "#f9fafb" }}
                      >
                        <div className="font-semibold text-text text-[11px] leading-tight">{unit.label}</div>
                        <div className="text-muted text-[10px]">POSTI {unit.capacity}</div>
                        {unit.driver_name && <div className="text-[9px] text-muted opacity-60 truncate">{unit.driver_name}</div>}
                      </td>
                      {tds}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted">
            Tieni premuto e trascina su più giorni per creare un blocco. Domeniche in rosso.
            Clicca su un blocco per modificarlo o eliminarlo.
          </p>
        </>
      )}

      {/* New block modal */}
      {newBlock && (
        <Modal
          title={`Nuovo blocco — ${busUnits.find((u) => u.id === newBlock.unitId)?.label ?? ""}`}
          onClose={() => setNewBlock(null)}
        >
          <p className="text-xs text-muted mb-3">
            {newBlock.startDay === newBlock.endDay
              ? `Giorno ${newBlock.startDay} ${MONTHS_IT[month - 1]}`
              : `Dal ${newBlock.startDay} al ${newBlock.endDay} ${MONTHS_IT[month - 1]}`}
          </p>
          <input
            ref={newInputRef}
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void saveNew()}
            className="input-saas w-full text-sm uppercase mb-3"
            placeholder="Es. TOUR CALABRIA OTA"
          />
          <ColorPicker value={newColor} onChange={setNewColor} />
          {newLabel.trim() && (
            <div className={`mt-3 rounded px-3 py-2 text-xs font-bold text-center uppercase ${colorTw(newColor)}`}>
              {newLabel.trim().toUpperCase()}
            </div>
          )}
          <div className="flex gap-2 mt-4">
            <button className="btn-primary flex-1 text-sm" onClick={() => void saveNew()} disabled={saving || !newLabel.trim()}>
              {saving ? "…" : "Salva"}
            </button>
            <button className="btn-secondary text-sm" onClick={() => setNewBlock(null)}>Annulla</button>
          </div>
        </Modal>
      )}

      {/* Edit block modal */}
      {editBlock && (
        <Modal
          title={`Modifica — ${busUnits.find((u) => u.id === editBlock.cell.row_key)?.label ?? ""}`}
          onClose={() => setEditBlock(null)}
        >
          <p className="text-xs text-muted mb-3">
            {(() => {
              const s = parseInt(editBlock.cell.cell_date.slice(8), 10);
              const e = editBlock.cell.end_date ? parseInt(editBlock.cell.end_date.slice(8), 10) : s;
              return s === e ? `Giorno ${s}` : `Dal ${s} al ${e} ${MONTHS_IT[month - 1]}`;
            })()}
          </p>
          <input
            ref={editInputRef}
            value={editLabel}
            onChange={(e) => setEditLabel(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void saveEdit()}
            className="input-saas w-full text-sm uppercase mb-3"
          />
          <ColorPicker value={editColor} onChange={setEditColor} />
          <div className="flex gap-2 mt-4 flex-wrap">
            <button className="btn-primary flex-1 text-sm" onClick={() => void saveEdit()} disabled={saving || !editLabel.trim()}>
              {saving ? "…" : "Salva"}
            </button>
            <button className="btn-secondary text-sm border-red-200 text-red-600 hover:bg-red-50" onClick={() => void deleteBlock()} disabled={saving}>
              Elimina
            </button>
            <button className="btn-secondary text-sm" onClick={() => setEditBlock(null)}>Annulla</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2. PLANNING GRUPPI — due righe per data (giallo A + rosso B)
// ═══════════════════════════════════════════════════════════════════════════════

type GruppiEdit = { date: string; row: "A" | "B"; colIndex: number; cellId: string | null };

function GruppiPlanning({ token }: { token: string }) {
  const today = new Date();
  const cy = today.getFullYear();
  const [year, setYear] = useState(cy);
  const [month, setMonth] = useState(today.getMonth() + 1);
  const [cells, setCells] = useState<PlanningCell[]>([]);
  const [editState, setEditState] = useState<GruppiEdit | null>(null);
  const [editVal, setEditVal] = useState("");
  const [editColor, setEditColor] = useState("green");
  const [saving, setSaving] = useState(false);
  const [newDate, setNewDate] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch(`/api/planning/cells?type=gruppi&year=${year}&month=${month}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error();
      const d = (await r.json()) as { cells: PlanningCell[] };
      setCells(d.cells ?? []);
    } catch { setError("Errore caricamento."); }
  }, [token, year, month]);

  useEffect(() => { void load(); }, [load]);

  const activeDates = [...new Set(cells.map((c) => c.cell_date))].sort();

  const forRow = (date: string, row: "A" | "B") =>
    cells.filter((c) => c.cell_date === date && c.row_key === row).sort((a, b) => a.col_index - b.col_index);

  const maxCol = (date: string, row: "A" | "B") => {
    const dc = forRow(date, row);
    return dc.length === 0 ? -1 : Math.max(...dc.map((c) => c.col_index));
  };

  const openEdit = (date: string, row: "A" | "B", colIndex: number, cell: PlanningCell | null) => {
    setEditState({ date, row, colIndex, cellId: cell?.id ?? null });
    setEditVal(cell?.content ?? "");
    setEditColor(cell?.bg_color ?? "green");
  };

  const saveCell = async () => {
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
            type: "gruppi",
            cell_date: editState.date,
            row_key: editState.row,
            col_index: editState.colIndex,
            content: editVal.trim().toUpperCase(),
            bg_color: editColor,
          }),
        });
      }
      await load();
    } finally { setSaving(false); setEditState(null); }
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
      await load();
    } finally { setSaving(false); setEditState(null); }
  };

  const handleAddDate = () => {
    if (!newDate) return;
    const [y, m] = newDate.split("-").map(Number);
    if (y !== year || m !== month) { alert(`Seleziona una data in ${MONTHS_IT[month - 1]} ${year}`); return; }
    openEdit(newDate, "A", 0, null);
    setNewDate("");
  };

  return (
    <div className="space-y-4">
      <MonthNav year={year} month={month} minYear={cy - 2} maxYear={cy + 2} setYear={setYear} setMonth={setMonth} />
      {error && <p className="text-sm text-red-500">{error}</p>}

      <div className="overflow-x-auto rounded-xl border border-border shadow-sm">
        <table className="border-collapse w-full min-w-[500px]">
          <thead>
            <tr>
              <th colSpan={2} className="bg-yellow-400 text-gray-900 px-4 py-2 text-center font-bold text-sm tracking-wide">
                PLANNING GRUPPI — {MONTHS_IT[month - 1]} {year}
              </th>
            </tr>
            <tr className="bg-gray-900 text-white">
              <th className="sticky left-0 z-20 bg-gray-900 px-3 py-2 min-w-[82px] border-r border-gray-600 font-bold uppercase text-[11px]">DATA</th>
              <th className="px-3 py-2 text-left text-[11px] font-bold text-gray-400">Gruppi assegnati</th>
            </tr>
          </thead>
          <tbody>
            {activeDates.length === 0 ? (
              <tr>
                <td colSpan={2} className="px-4 py-8 text-center text-muted text-sm">
                  Nessuna data. Usa il campo sottostante per aggiungere.
                </td>
              </tr>
            ) : (
              activeDates.flatMap((date, ri) => {
                const dcA = forRow(date, "A");
                const dcB = forRow(date, "B");
                const bg = ri % 2 === 0 ? "bg-white" : "bg-gray-50/50";
                return [
                  // Row A — giallo
                  <tr key={`${date}_A`} className={bg}>
                    <td className="sticky left-0 z-10 bg-yellow-300 text-yellow-900 border-r border-yellow-400 px-2 py-2 min-w-[82px] align-middle">
                      <div className="font-bold text-[13px]">{shortDate(date)}</div>
                    </td>
                    <td className="px-2 py-2 align-middle">
                      <div className="flex flex-wrap gap-1.5 items-center">
                        {dcA.map((cell) => (
                          <button key={cell.id} onClick={() => openEdit(date, "A", cell.col_index, cell)}
                            className={`rounded px-2.5 py-1.5 text-[11px] font-bold min-w-[80px] text-center uppercase leading-tight hover:opacity-80 transition-opacity ${colorTw(cell.bg_color)}`}>
                            {cell.content}
                          </button>
                        ))}
                        <button onClick={() => openEdit(date, "A", maxCol(date, "A") + 1, null)}
                          className="rounded px-2.5 py-1 text-xs border border-dashed border-gray-300 text-muted hover:bg-gray-100 transition-colors" title="Aggiungi gruppo">+</button>
                      </div>
                    </td>
                  </tr>,
                  // Row B — rosso
                  <tr key={`${date}_B`} className={bg}>
                    <td className="sticky left-0 z-10 bg-red-500 text-white border-r border-red-600 px-2 py-2 min-w-[82px] align-middle">
                      <div className="font-bold text-[13px]">{shortDate(date)}</div>
                    </td>
                    <td className="px-2 py-2 align-middle">
                      <div className="flex flex-wrap gap-1.5 items-center">
                        {dcB.map((cell) => (
                          <button key={cell.id} onClick={() => openEdit(date, "B", cell.col_index, cell)}
                            className={`rounded px-2.5 py-1.5 text-[11px] font-bold min-w-[80px] text-center uppercase leading-tight hover:opacity-80 transition-opacity ${colorTw(cell.bg_color)}`}>
                            {cell.content}
                          </button>
                        ))}
                        <button onClick={() => openEdit(date, "B", maxCol(date, "B") + 1, null)}
                          className="rounded px-2.5 py-1 text-xs border border-dashed border-gray-300 text-muted hover:bg-gray-100 transition-colors" title="Aggiungi gruppo">+</button>
                      </div>
                    </td>
                  </tr>,
                  // Spacer
                  <tr key={`${date}_sp`}><td colSpan={2} className="h-2 bg-gray-100/60" /></tr>,
                ];
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="flex gap-2 items-center flex-wrap">
        <input type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)}
          className="input-saas text-sm" min={`${cy - 2}-01-01`} max={`${cy + 2}-12-31`} />
        <button onClick={handleAddDate} className="btn-secondary text-sm" disabled={!newDate}>
          + Aggiungi data
        </button>
      </div>

      {editState && (
        <Modal
          title={`${editState.cellId ? "Modifica" : "Aggiungi"} gruppo — ${shortDate(editState.date)} (${editState.row === "A" ? "Riga gialla" : "Riga rossa"})`}
          onClose={() => setEditState(null)}
        >
          <textarea
            value={editVal}
            onChange={(e) => setEditVal(e.target.value)}
            rows={2}
            className="input-saas w-full text-sm mb-3"
            placeholder="Es. SABBIO 53"
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            onKeyDown={(e) => e.key === "Enter" && e.ctrlKey && void saveCell()}
          />
          <ColorPicker value={editColor} onChange={setEditColor} />
          {editVal.trim() && (
            <div className={`mt-3 rounded px-3 py-2 text-xs font-bold text-center uppercase ${colorTw(editColor)}`}>
              {editVal.trim().toUpperCase()}
            </div>
          )}
          <div className="flex gap-2 mt-4 flex-wrap">
            <button className="btn-primary flex-1 text-sm" onClick={() => void saveCell()} disabled={saving || !editVal.trim()}>
              {saving ? "…" : "Salva"}
            </button>
            {editState.cellId && (
              <button className="btn-secondary text-sm border-red-200 text-red-600 hover:bg-red-50" onClick={() => void deleteCell()} disabled={saving}>
                Elimina
              </button>
            )}
            <button className="btn-secondary text-sm" onClick={() => setEditState(null)}>Annulla</button>
          </div>
          <p className="text-[10px] text-muted mt-2 text-center">Ctrl+Invio per salvare</p>
        </Modal>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// 3. RECUPERO TRATTA — date come righe, slot colorati per direzione
// ═══════════════════════════════════════════════════════════════════════════════

type TrattaEdit = { date: string; colIndex: number; cellId: string | null };

function TrattaPlanning({ token }: { token: string }) {
  const today = new Date();
  const cy = today.getFullYear();
  const [year, setYear] = useState(cy);
  const [month, setMonth] = useState(today.getMonth() + 1);
  const [cells, setCells] = useState<PlanningCell[]>([]);
  const [editState, setEditState] = useState<TrattaEdit | null>(null);
  const [editVal, setEditVal] = useState("");
  const [editColor, setEditColor] = useState("yellow");
  const [saving, setSaving] = useState(false);
  const [newDate, setNewDate] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch(`/api/planning/cells?type=route&year=${year}&month=${month}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error();
      const d = (await r.json()) as { cells: PlanningCell[] };
      setCells(d.cells ?? []);
    } catch { setError("Errore caricamento."); }
  }, [token, year, month]);

  useEffect(() => { void load(); }, [load]);

  const activeDates = [...new Set(cells.map((c) => c.cell_date))].sort();

  const forDate = (date: string) =>
    cells.filter((c) => c.cell_date === date).sort((a, b) => a.col_index - b.col_index);

  const maxCol = (date: string) => {
    const dc = forDate(date);
    return dc.length === 0 ? -1 : Math.max(...dc.map((c) => c.col_index));
  };

  const openEdit = (date: string, colIndex: number, cell: PlanningCell | null) => {
    setEditState({ date, colIndex, cellId: cell?.id ?? null });
    setEditVal(cell?.content ?? "");
    setEditColor(cell?.bg_color ?? "red");
  };

  const saveCell = async () => {
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
      await load();
    } finally { setSaving(false); setEditState(null); }
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
      await load();
    } finally { setSaving(false); setEditState(null); }
  };

  const handleAddDate = () => {
    if (!newDate) return;
    const [y, m] = newDate.split("-").map(Number);
    if (y !== year || m !== month) { alert(`Seleziona una data in ${MONTHS_IT[month - 1]} ${year}`); return; }
    openEdit(newDate, maxCol(newDate) + 1, null);
    setNewDate("");
  };

  return (
    <div className="space-y-4">
      <MonthNav year={year} month={month} minYear={cy - 2} maxYear={cy + 2} setYear={setYear} setMonth={setMonth} />
      {error && <p className="text-sm text-red-500">{error}</p>}

      <div className="overflow-x-auto rounded-xl border border-border shadow-sm">
        <table className="border-collapse w-full min-w-[500px]">
          <thead>
            <tr>
              <th colSpan={2} className="bg-yellow-400 text-gray-900 px-4 py-2 text-center font-bold text-sm tracking-wide">
                PLANNING RECUPERO TRATTA — {MONTHS_IT[month - 1]} {year}
              </th>
            </tr>
            <tr className="bg-gray-900 text-white">
              <th className="sticky left-0 z-20 bg-gray-900 px-3 py-2 min-w-[82px] border-r border-gray-600 font-bold uppercase text-[11px]">DATA</th>
              <th className="px-3 py-2 text-left text-[11px] font-bold text-gray-400">Prenotazioni tratta (clicca per modificare)</th>
            </tr>
          </thead>
          <tbody>
            {activeDates.length === 0 ? (
              <tr>
                <td colSpan={2} className="px-4 py-8 text-center text-muted text-sm">
                  Nessuna data. Usa il campo sottostante per aggiungere.
                </td>
              </tr>
            ) : (
              activeDates.map((date, ri) => {
                const dc = forDate(date);
                return (
                  <tr key={date} className={ri % 2 === 0 ? "bg-white" : "bg-gray-50/60"}>
                    <td className="sticky left-0 z-10 bg-yellow-300 text-yellow-900 border-r border-yellow-400 px-2 py-2 min-w-[82px] align-middle">
                      <div className="font-bold text-[13px]">{shortDate(date)}</div>
                      <div className="text-[10px] opacity-60">{date.slice(0, 4)}</div>
                    </td>
                    <td className="px-2 py-2 align-middle">
                      <div className="flex flex-wrap gap-1.5 items-center">
                        {dc.map((cell) => (
                          <button key={cell.id} onClick={() => openEdit(date, cell.col_index, cell)}
                            className={`rounded px-2.5 py-1.5 text-[11px] font-bold min-w-[90px] text-center uppercase leading-tight hover:opacity-80 transition-opacity ${colorTw(cell.bg_color)}`}>
                            {cell.content}
                          </button>
                        ))}
                        <button onClick={() => openEdit(date, maxCol(date) + 1, null)}
                          className="rounded px-2.5 py-1 text-xs border border-dashed border-gray-300 text-muted hover:bg-gray-100 transition-colors" title="Aggiungi">+</button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="flex gap-2 items-center flex-wrap">
        <input type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)}
          className="input-saas text-sm" min={`${cy - 2}-01-01`} max={`${cy + 2}-12-31`} />
        <button onClick={handleAddDate} className="btn-secondary text-sm" disabled={!newDate}>
          + Aggiungi data
        </button>
      </div>

      {editState && (
        <Modal
          title={`${editState.cellId ? "Modifica" : "Aggiungi"} — ${shortDate(editState.date)} ${editState.date.slice(0, 4)}`}
          onClose={() => setEditState(null)}
        >
          <textarea
            value={editVal}
            onChange={(e) => setEditVal(e.target.value)}
            rows={3}
            className="input-saas w-full text-sm mb-3"
            placeholder="Es. BORTONE DISCESA MILANO"
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            onKeyDown={(e) => e.key === "Enter" && e.ctrlKey && void saveCell()}
          />
          <ColorPicker value={editColor} onChange={setEditColor} />
          {editVal.trim() && (
            <div className={`mt-3 rounded px-3 py-2 text-xs font-bold text-center uppercase ${colorTw(editColor)}`}>
              {editVal.trim().toUpperCase()}
            </div>
          )}
          <div className="flex gap-2 mt-4 flex-wrap">
            <button className="btn-primary flex-1 text-sm" onClick={() => void saveCell()} disabled={saving || !editVal.trim()}>
              {saving ? "…" : "Salva"}
            </button>
            {editState.cellId && (
              <button className="btn-secondary text-sm border-red-200 text-red-600 hover:bg-red-50" onClick={() => void deleteCell()} disabled={saving}>
                Elimina
              </button>
            )}
            <button className="btn-secondary text-sm" onClick={() => setEditState(null)}>Annulla</button>
          </div>
          <p className="text-[10px] text-muted mt-2 text-center">Ctrl+Invio per salvare</p>
        </Modal>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN PAGE
// ═══════════════════════════════════════════════════════════════════════════════

const TABS: { id: PlanningTab; label: string }[] = [
  { id: "bus",    label: "Planning Bus Generali" },
  { id: "gruppi", label: "Planning Gruppi" },
  { id: "route",  label: "Recupero Tratta" },
];

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
        subtitle="Planning Bus Generali · Planning Gruppi · Recupero Tratta"
        breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "Mario Planning" }]}
      />

      {/* Tab bar — scrollabile su mobile */}
      <div className="flex gap-1 border-b border-border pb-0 overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={[
              "px-4 py-2.5 text-sm font-medium rounded-t-lg whitespace-nowrap transition-colors",
              tab === t.id ? "bg-primary text-white" : "text-muted hover:text-text hover:bg-surface",
            ].join(" ")}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "bus"    && <BusGeneralPlanning token={token} />}
      {tab === "gruppi" && <GruppiPlanning     token={token} />}
      {tab === "route"  && <TrattaPlanning     token={token} />}
    </section>
  );
}
