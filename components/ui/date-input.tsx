"use client";

import { useEffect, useMemo, useRef, useState } from "react";

function isoToDisplay(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return value;
  return `${match[3]}/${match[2]}/${match[1]}`;
}

function dateExists(year: number, month: number, day: number) {
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

function displayToIso(value: string) {
  const trimmed = value.trim();
  const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const year = Number(iso[1]);
    const month = Number(iso[2]);
    const day = Number(iso[3]);
    return dateExists(year, month, day) ? `${iso[1]}-${iso[2]}-${iso[3]}` : null;
  }

  const normalized = trimmed.replace(/[.\-\s]/g, "/");
  const slash = normalized.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  const compact = normalized.match(/^(\d{2})(\d{2})(\d{2}|\d{4})$/);
  const match = slash ?? compact;
  if (!match) return null;

  const day = Number(match[1]);
  const month = Number(match[2]);
  const rawYear = match[3];
  const year = rawYear.length === 2 ? 2000 + Number(rawYear) : Number(rawYear);
  if (!dateExists(year, month, day)) return null;

  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function withinBounds(iso: string, min?: string, max?: string, minYear?: number, maxYear?: number) {
  const year = Number(iso.slice(0, 4));
  if (minYear && year < minYear) return false;
  if (maxYear && year > maxYear) return false;
  if (min && iso < min) return false;
  if (max && iso > max) return false;
  return true;
}

export function DateInput({
  value,
  onChange,
  className,
  min,
  max,
  minYear,
  maxYear,
  disabled,
  title,
  withCalendar = true,
}: {
  value: string;
  onChange: (iso: string) => void;
  className?: string;
  min?: string;
  max?: string;
  minYear?: number;
  maxYear?: number;
  disabled?: boolean;
  title?: string;
  withCalendar?: boolean;
}) {
  const nativeInputRef = useRef<HTMLInputElement | null>(null);
  const [displayValue, setDisplayValue] = useState(() => isoToDisplay(value));
  const fallbackTitle = useMemo(() => title ?? "Formato data: gg/mm/aaaa", [title]);

  useEffect(() => {
    setDisplayValue(isoToDisplay(value));
  }, [value]);

  const commitDisplayValue = (nextDisplayValue: string) => {
    const parsed = displayToIso(nextDisplayValue);
    if (parsed && withinBounds(parsed, min, max, minYear, maxYear)) {
      onChange(parsed);
      setDisplayValue(isoToDisplay(parsed));
      return;
    }
    setDisplayValue(isoToDisplay(value));
  };

  const openCalendar = () => {
    const input = nativeInputRef.current;
    if (!input || disabled) return;
    if (typeof input.showPicker === "function") {
      input.showPicker();
      return;
    }
    input.click();
  };

  return (
    <span className="relative inline-block align-middle">
      <input
        type="text"
        inputMode="numeric"
        value={displayValue}
        disabled={disabled}
        title={fallbackTitle}
        placeholder="gg/mm/aaaa"
        onChange={(event) => setDisplayValue(event.target.value)}
        onBlur={(event) => commitDisplayValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.currentTarget.blur();
          }
        }}
        className={`${className ?? ""} pr-11`}
      />
      {withCalendar ? (
        <>
          <button
            type="button"
            aria-label="Apri calendario"
            disabled={disabled}
            onClick={openCalendar}
            className="absolute right-2 top-1/2 inline-flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-md text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 disabled:pointer-events-none disabled:opacity-50"
          >
            <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4" fill="currentColor">
              <path d="M6 2a1 1 0 0 1 1 1v1h6V3a1 1 0 1 1 2 0v1h1.5A1.5 1.5 0 0 1 18 5.5v10A1.5 1.5 0 0 1 16.5 17h-13A1.5 1.5 0 0 1 2 15.5v-10A1.5 1.5 0 0 1 3.5 4H5V3a1 1 0 0 1 1-1Zm10 7H4v6.5a.5.5 0 0 0 .5.5h11a.5.5 0 0 0 .5-.5V9ZM4.5 6a.5.5 0 0 0-.5.5V7h12v-.5a.5.5 0 0 0-.5-.5h-11Z" />
            </svg>
          </button>
          <input
            ref={nativeInputRef}
            type="date"
            value={value}
            min={min}
            max={max}
            disabled={disabled}
            tabIndex={-1}
            aria-hidden="true"
            onChange={(event) => {
              if (event.target.value) onChange(event.target.value);
            }}
            className="pointer-events-none absolute inset-0 h-px w-px opacity-0"
          />
        </>
      ) : null}
    </span>
  );
}
