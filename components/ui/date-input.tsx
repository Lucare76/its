"use client";

export function DateInput({
  value,
  onChange,
  className,
  min,
  max,
  disabled,
  title,
  withCalendar: _withCalendar,
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
  return (
    <input
      type="date"
      value={value}
      min={min}
      max={max}
      disabled={disabled}
      title={title}
      onChange={(e) => { if (e.target.value) onChange(e.target.value); }}
      className={className ?? ""}
    />
  );
}
