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
  notes: string | null;
  sort_order: number | null;
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

// Calcola Pasqua (algoritmo anonimo gregoriano) → [mese 1-based, giorno]
function easterDate(year: number): [number, number] {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return [month, day];
}

function isItalianHoliday(year: number, month: number, day: number): boolean {
  const fixed: [number, number][] = [
    [1, 1], [1, 6], [4, 25], [5, 1], [6, 2],
    [8, 15], [11, 1], [12, 8], [12, 25], [12, 26],
  ];
  if (fixed.some(([m, d]) => m === month && d === day)) return true;
  // Lunedì di Pasqua
  const [em, ed] = easterDate(year);
  const easter = new Date(year, em - 1, ed);
  easter.setDate(easter.getDate() + 1);
  return easter.getMonth() + 1 === month && easter.getDate() === day;
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
// 1. PLANNING BUS GENERALI — hotel Gantt style (click → modal Dal/Al)
// ═══════════════════════════════════════════════════════════════════════════════

type NewBlock = { unitId: string; startDate: string; endDate: string };
type EditBlock = { cell: PlanningCell; startDate: string; endDate: string };

function BusGeneralPlanning({ token }: { token: string }) {
  const today = new Date();
  const cy = today.getFullYear();
  const [year, setYear] = useState(cy);
  const [month, setMonth] = useState(today.getMonth() + 1);
  const [busUnits, setBusUnits] = useState<BusUnit[]>([]);
  const [cells, setCells] = useState<PlanningCell[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

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

  // gestisci mezzi modal
  const [showManage, setShowManage] = useState(false);
  const [newRowLabel, setNewRowLabel] = useState("");
  const [newRowNotes, setNewRowNotes] = useState("");
  const [savingRow, setSavingRow] = useState(false);

  const loadRows = useCallback(async () => {
    const r = await fetch("/api/planning/bus-rows", { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) {
      const d = await r.json().catch(() => ({})) as { error?: string };
      throw new Error(d.error ?? `HTTP ${r.status}`);
    }
    const d = (await r.json()) as { rows: BusUnit[] };
    setBusUnits(d.rows ?? []);
  }, [token]);

  const loadCells = useCallback(async () => {
    const r = await fetch(`/api/planning/cells?type=bus&year=${year}&month=${month}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return;
    const d = (await r.json()) as { cells: PlanningCell[] };
    setCells(d.cells ?? []);
  }, [token, year, month]);

  const load = useCallback(async () => {
    setError(null);
    try { await Promise.all([loadRows(), loadCells()]); }
    catch (e) { setError(e instanceof Error ? e.message : "Errore caricamento."); }
  }, [loadRows, loadCells]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (newBlock) setTimeout(() => newInputRef.current?.focus(), 30); }, [newBlock]);
  useEffect(() => { if (editBlock) setTimeout(() => editInputRef.current?.focus(), 30); }, [editBlock]);

  const numDays = daysInMonth(year, month);
  const days = Array.from({ length: numDays }, (_, i) => i + 1);
  const monthStart = toDateStr(year, month, 1);
  const monthEnd = toDateStr(year, month, numDays);

  // Click empty cell → open new block modal pre-filled with that date
  const onCellClick = (unitId: string, day: number) => {
    const date = toDateStr(year, month, day);
    setNewBlock({ unitId, startDate: date, endDate: date });
    setNewLabel("");
    setNewColor("yellow");
  };

  // Click existing block → open edit modal
  const openEdit = (cell: PlanningCell) => {
    setEditBlock({
      cell,
      startDate: cell.cell_date,
      endDate: cell.end_date ?? cell.cell_date,
    });
    setEditLabel(cell.content ?? "");
    setEditColor(cell.bg_color ?? "yellow");
  };

  const saveNew = async () => {
    if (!newBlock || !newLabel.trim() || saving) return;
    if (newBlock.endDate < newBlock.startDate) {
      setError("La data 'Al' deve essere uguale o successiva a 'Dal'.");
      return;
    }
    const s = parseInt(newBlock.startDate.slice(8), 10);
    const e = parseInt(newBlock.endDate.slice(8), 10);
    if (hasConflict(cells, newBlock.unitId, s, e)) {
      setError("Intervallo sovrapposto a un blocco esistente.");
      setTimeout(() => setError(null), 3000);
      return;
    }
    setSaving(true);
    try {
      await fetch("/api/planning/cells", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          type: "bus",
          cell_date: newBlock.startDate,
          end_date: newBlock.endDate,
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
    if (editBlock.endDate < editBlock.startDate) {
      setError("La data 'Al' deve essere uguale o successiva a 'Dal'.");
      return;
    }
    setSaving(true);
    try {
      // Delete old record first (key might change if dates changed)
      await fetch("/api/planning/cells", {
        method: "DELETE",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ id: editBlock.cell.id }),
      });
      // Re-insert with new data
      await fetch("/api/planning/cells", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          type: "bus",
          cell_date: editBlock.startDate,
          end_date: editBlock.endDate,
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

  const addRow = async () => {
    if (!newRowLabel.trim() || savingRow) return;
    setSavingRow(true);
    try {
      await fetch("/api/planning/bus-rows", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ label: newRowLabel.trim(), notes: newRowNotes.trim() || null }),
      });
      setNewRowLabel("");
      setNewRowNotes("");
      await loadRows();
    } finally { setSavingRow(false); }
  };

  const deleteRow = async (id: string) => {
    if (!confirm("Eliminare questo mezzo? I blocchi pianificati per questo mezzo rimarranno nel DB ma non saranno visibili.")) return;
    await fetch("/api/planning/bus-rows", {
      method: "DELETE",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ id }),
    });
    await loadRows();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <MonthNav year={year} month={month} minYear={cy - 2} maxYear={cy + 2} setYear={setYear} setMonth={setMonth} />
        <button onClick={() => setShowManage(true)} className="btn-secondary text-sm">⚙ Gestisci mezzi</button>
      </div>
      {error && <p className="text-sm text-red-500">{error}</p>}

      {busUnits.length === 0 ? (
        <div className="card p-8 text-center space-y-2">
          <p className="text-text font-medium">Nessun mezzo configurato</p>
          <p className="text-muted text-sm">Clicca su &quot;Gestisci mezzi&quot; per aggiungere i bus.</p>
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl border border-border shadow-sm select-none">
            <table className="border-collapse" style={{ minWidth: `${150 + numDays * 40}px` }}>
              <thead>
                <tr>
                  <th className="sticky left-0 z-20 bg-green-600 text-white px-3 py-2 text-center min-w-[150px] border-r border-green-700 font-bold uppercase text-[12px] tracking-wider">
                    AUTOBUS
                  </th>
                  {days.map((d) => {
                    const sun = isSunday(year, month, d);
                    const hol = !sun && isItalianHoliday(year, month, d);
                    return (
                      <th
                        key={d}
                        className={[
                          "w-[40px] min-w-[40px] py-2 text-center border-l font-bold text-[11px]",
                          sun ? "bg-red-600 text-white border-red-700" :
                          hol ? "bg-sky-200 text-sky-900 border-sky-300" :
                               "bg-green-600 text-white border-green-700",
                        ].join(" ")}
                      >
                        {d}
                      </th>
                    );
                  })}
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
                            colSpan={Math.min(e, numDays) - s + 1}
                            className={`border border-gray-400 px-1 py-0 cursor-pointer text-center font-bold text-[10px] uppercase leading-tight hover:opacity-80 transition-opacity ${colorTw(block.bg_color)}`}
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
                      const hol = !sun && isItalianHoliday(year, month, d);
                      const rowBg = ri % 2 === 0 ? "#ffffff" : "#f5f5f5";
                      tds.push(
                        <td
                          key={d}
                          className="border border-gray-300 w-[40px] min-w-[40px] h-[38px] hover:bg-blue-50 transition-colors"
                          style={{
                            background: sun ? "#fee2e2" : hol ? "#bae6fd" : rowBg,
                            cursor: "cell",
                          }}
                          onClick={() => onCellClick(unit.id, d)}
                        />
                      );
                      d++;
                    }
                  }
                  return (
                    <tr key={unit.id}>
                      <td
                        className="sticky left-0 z-10 border border-gray-300 px-2 py-1 min-w-[150px]"
                        style={{ background: ri % 2 === 0 ? "white" : "#f5f5f5" }}
                      >
                        <div className="font-bold text-text text-[11px] uppercase leading-tight">{unit.label}</div>
                        {unit.notes && <div className="text-[10px] text-muted leading-tight">{unit.notes}</div>}
                      </td>
                      {tds}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted">
            Clicca su una cella vuota per aggiungere un blocco · Domeniche <span className="text-red-600 font-semibold">rosse</span> · Festività <span className="text-sky-500 font-semibold">azzurre</span>
          </p>
        </>
      )}

      {/* New block modal */}
      {newBlock && (
        <Modal
          title={`Nuovo blocco — ${busUnits.find((u) => u.id === newBlock.unitId)?.label ?? ""}`}
          onClose={() => setNewBlock(null)}
        >
          <div className="grid grid-cols-2 gap-3 mb-3">
            <label className="flex flex-col gap-1 text-xs font-medium text-muted">
              Dal
              <input
                type="date"
                value={newBlock.startDate}
                min={monthStart}
                max={monthEnd}
                onChange={(e) =>
                  setNewBlock((prev) =>
                    prev
                      ? { ...prev, startDate: e.target.value, endDate: e.target.value > prev.endDate ? e.target.value : prev.endDate }
                      : null
                  )
                }
                className="input-saas text-sm"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-muted">
              Al
              <input
                type="date"
                value={newBlock.endDate}
                min={newBlock.startDate}
                max={monthEnd}
                onChange={(e) => setNewBlock((prev) => prev ? { ...prev, endDate: e.target.value } : null)}
                className="input-saas text-sm"
              />
            </label>
          </div>
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

      {/* Gestisci mezzi modal */}
      {showManage && (
        <Modal title="Gestisci mezzi" onClose={() => setShowManage(false)}>
          <div className="space-y-2 max-h-64 overflow-y-auto mb-4">
            {busUnits.length === 0 && <p className="text-sm text-muted text-center py-2">Nessun mezzo aggiunto.</p>}
            {busUnits.map((u) => (
              <div key={u.id} className="flex items-center justify-between gap-2 px-2 py-1.5 rounded bg-gray-50 border border-border">
                <div>
                  <div className="text-sm font-semibold uppercase text-text">{u.label}</div>
                  {u.notes && <div className="text-[11px] text-muted">{u.notes}</div>}
                </div>
                <button
                  onClick={() => void deleteRow(u.id)}
                  className="text-red-500 hover:text-red-700 text-xs px-2 py-1 rounded hover:bg-red-50 transition-colors shrink-0"
                >
                  Elimina
                </button>
              </div>
            ))}
          </div>
          <div className="flex gap-2 mb-2">
            <input
              value={newRowLabel}
              onChange={(e) => setNewRowLabel(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void addRow()}
              className="input-saas flex-1 text-sm uppercase"
              placeholder="Nome mezzo (es. 350 SHD)"
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
            />
            <input
              value={newRowNotes}
              onChange={(e) => setNewRowNotes(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void addRow()}
              className="input-saas w-28 text-sm"
              placeholder="Posti (51+1)"
            />
            <button
              onClick={() => void addRow()}
              disabled={savingRow || !newRowLabel.trim()}
              className="btn-primary text-sm whitespace-nowrap"
            >
              {savingRow ? "…" : "+ Aggiungi"}
            </button>
          </div>
        </Modal>
      )}

      {/* Edit block modal */}
      {editBlock && (
        <Modal
          title={`Modifica — ${busUnits.find((u) => u.id === editBlock.cell.row_key)?.label ?? ""}`}
          onClose={() => setEditBlock(null)}
        >
          <div className="grid grid-cols-2 gap-3 mb-3">
            <label className="flex flex-col gap-1 text-xs font-medium text-muted">
              Dal
              <input
                type="date"
                value={editBlock.startDate}
                min={monthStart}
                max={monthEnd}
                onChange={(e) =>
                  setEditBlock((prev) =>
                    prev
                      ? { ...prev, startDate: e.target.value, endDate: e.target.value > prev.endDate ? e.target.value : prev.endDate }
                      : null
                  )
                }
                className="input-saas text-sm"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-muted">
              Al
              <input
                type="date"
                value={editBlock.endDate}
                min={editBlock.startDate}
                max={monthEnd}
                onChange={(e) => setEditBlock((prev) => prev ? { ...prev, endDate: e.target.value } : null)}
                className="input-saas text-sm"
              />
            </label>
          </div>
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
      <div className="flex gap-0 border-b-2 border-gray-300 overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={[
              "px-5 py-2.5 text-sm font-semibold whitespace-nowrap transition-colors border-b-2 -mb-[2px]",
              tab === t.id
                ? "border-blue-600 text-blue-700 bg-blue-50"
                : "border-transparent text-muted hover:text-text hover:bg-gray-100",
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
