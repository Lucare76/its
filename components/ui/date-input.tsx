"use client";

import { useEffect, useMemo, useState } from "react";

function isoToIt(iso: string): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function itToIso(it: string): string {
  const clean = it.trim();
  const compact = clean.replace(/\D/g, "");
  let day = "";
  let month = "";
  let year = "";

  if (/^\d{4}-\d{2}-\d{2}$/.test(clean)) {
    [year, month, day] = clean.split("-");
  } else if (compact.length === 8) {
    day = compact.slice(0, 2);
    month = compact.slice(2, 4);
    year = compact.slice(4, 8);
  } else if (compact.length === 6) {
    day = compact.slice(0, 2);
    month = compact.slice(2, 4);
    year = `20${compact.slice(4, 6)}`;
  } else {
    const m = clean.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2}|\d{4})$/);
    if (!m) return "";
    day = m[1].padStart(2, "0");
    month = m[2].padStart(2, "0");
    year = m[3].length === 2 ? `20${m[3]}` : m[3];
  }

  const iso = `${year}-${month}-${day}`;
  const parsed = new Date(`${iso}T12:00:00Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getUTCFullYear() !== Number(year) ||
    parsed.getUTCMonth() + 1 !== Number(month) ||
    parsed.getUTCDate() !== Number(day)
  ) {
    return "";
  }
  return iso;
}

function autoFormat(raw: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) return isoToIt(raw.trim());
  const digits = raw.replace(/\D/g, "").slice(0, 8);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
}

const MIN_YEAR = 2018;
const MAX_YEAR = 2099;
const WEEKDAYS = ["L", "M", "M", "G", "V", "S", "D"];

function monthLabel(iso: string): string {
  const date = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("it-IT", { month: "long", year: "numeric" }).format(date);
}

function monthStartIso(iso: string): string {
  const date = new Date(`${iso || new Date().toISOString().slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 7) + "-01";
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

function addMonths(iso: string, months: number): string {
  const date = new Date(`${monthStartIso(iso)}T12:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + months);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

function buildCalendarDays(monthIso: string): Array<{ iso: string; day: number; inMonth: boolean }> {
  const start = new Date(`${monthStartIso(monthIso)}T12:00:00Z`);
  const gridStart = new Date(start);
  const mondayOffset = (start.getUTCDay() + 6) % 7;
  gridStart.setUTCDate(start.getUTCDate() - mondayOffset);
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(gridStart);
    date.setUTCDate(gridStart.getUTCDate() + index);
    return {
      iso: date.toISOString().slice(0, 10),
      day: date.getUTCDate(),
      inMonth: date.getUTCMonth() === start.getUTCMonth(),
    };
  });
}

export function DateInput({
  value,
  onChange,
  className,
  min,
  max,
  minYear = MIN_YEAR,
  maxYear = MAX_YEAR,
  disabled,
  title,
  withCalendar = false,
}: {
  value: string;       // YYYY-MM-DD
  onChange: (iso: string) => void;
  className?: string;
  min?: string;         // YYYY-MM-DD
  max?: string;         // YYYY-MM-DD
  minYear?: number;
  maxYear?: number;
  disabled?: boolean;
  title?: string;
  withCalendar?: boolean;
}) {
  const [display, setDisplay] = useState(() => isoToIt(value));
  const [invalid, setInvalid] = useState(false);
  const [open, setOpen] = useState(false);
  const [visibleMonth, setVisibleMonth] = useState(() => monthStartIso(value));
  const calendarDays = useMemo(() => buildCalendarDays(visibleMonth), [visibleMonth]);

  useEffect(() => {
    // DateInput keeps a masked draft while typing; sync it when callers change the ISO value.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDisplay(isoToIt(value));
    setInvalid(false);
    setVisibleMonth(monthStartIso(value));
  }, [value]);

  function handleChange(raw: string) {
    const formatted = autoFormat(raw);
    setDisplay(formatted);
    const iso = itToIso(formatted);
    if (!iso) { setInvalid(false); return; }
    const year = parseInt(iso.slice(0, 4), 10);
    if (year < minYear || year > maxYear || (min && iso < min) || (max && iso > max)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    onChange(iso);
  }

  const input = (
    <input
      type="text"
      inputMode="numeric"
      className={`${className ?? ""} ${withCalendar ? "pr-10" : ""} ${invalid ? "border-red-400 focus:ring-red-300" : ""}`}
      value={display}
      placeholder="gg/mm/aaaa"
      maxLength={10}
      onChange={(e) => handleChange(e.target.value)}
      onBlur={() => {
        if (!display.length) return;
        const iso = itToIso(display);
        if (!iso) {
          setInvalid(true);
          return;
        }
        setDisplay(isoToIt(iso));
      }}
      disabled={disabled}
      aria-invalid={invalid}
      title={invalid ? `Data non valida${min ? `, min ${isoToIt(min)}` : ""}${max ? `, max ${isoToIt(max)}` : ""}` : title}
    />
  );

  if (!withCalendar) return input;

  return (
    <span className="relative inline-flex">
      {input}
      <button
        type="button"
        className="absolute right-1 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-50"
        onClick={() => setOpen((current) => !current)}
        disabled={disabled}
        aria-label="Apri calendario"
        title="Apri calendario"
      >
        <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.7">
          <rect x="3" y="4" width="14" height="13" rx="2" />
          <path d="M6 2.5v3M14 2.5v3M3 8h14" />
        </svg>
      </button>

      {open && (
        <div className="absolute left-0 top-[calc(100%+6px)] z-50 w-72 rounded border border-slate-200 bg-white p-3 shadow-xl">
          <div className="mb-3 flex items-center justify-between gap-2">
            <button
              type="button"
              className="rounded border border-slate-200 px-2 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50"
              onClick={() => setVisibleMonth((current) => addMonths(current, -1))}
            >
              &lt;
            </button>
            <p className="text-sm font-bold capitalize text-slate-800">{monthLabel(visibleMonth)}</p>
            <button
              type="button"
              className="rounded border border-slate-200 px-2 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50"
              onClick={() => setVisibleMonth((current) => addMonths(current, 1))}
            >
              &gt;
            </button>
          </div>

          <div className="grid grid-cols-7 gap-1 text-center">
            {WEEKDAYS.map((day, index) => (
              <div key={`${day}-${index}`} className="py-1 text-[10px] font-bold uppercase text-slate-400">
                {day}
              </div>
            ))}
            {calendarDays.map((day) => {
              const disabledDay =
                (min ? day.iso < min : false) ||
                (max ? day.iso > max : false) ||
                Number(day.iso.slice(0, 4)) < minYear ||
                Number(day.iso.slice(0, 4)) > maxYear;
              const selected = day.iso === value;
              return (
                <button
                  key={day.iso}
                  type="button"
                  disabled={disabledDay}
                  onClick={() => {
                    onChange(day.iso);
                    setOpen(false);
                  }}
                  className={`h-8 rounded text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-30 ${
                    selected
                      ? "bg-slate-900 text-white"
                      : day.inMonth
                        ? "text-slate-700 hover:bg-slate-100"
                        : "text-slate-300 hover:bg-slate-50"
                  }`}
                >
                  {day.day}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </span>
  );
}
