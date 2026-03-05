"use client";

import { useEffect, useMemo, useState } from "react";

interface KpiCardProps {
  label: string;
  value: string;
  hint: string;
}

function iconForLabel(label: string) {
  const normalized = label.toLowerCase();
  if (normalized.includes("servizi")) return <path d="M4 8h16M7 5v6m10-6v6M6 11h12l-1 8H7l-1-8z" />;
  if (normalized.includes("assegnare")) return <path d="M12 3l8 14H4L12 3zm0 5v4m0 3h.01" />;
  if (normalized.includes("driver")) return <path d="M6 14h12M7 14l1-5h8l1 5M9 17a1.5 1.5 0 100 3 1.5 1.5 0 000-3zm6 0a1.5 1.5 0 100 3 1.5 1.5 0 000-3z" />;
  if (normalized.includes("pax")) return <path d="M6 8a3 3 0 116 0 3 3 0 01-6 0zm7 1a2.5 2.5 0 115 0 2.5 2.5 0 01-5 0zM3 19a5 5 0 0110 0M13 19a4 4 0 018 0" />;
  return <path d="M5 12h14M12 5v14M4 12a8 8 0 1016 0 8 8 0 10-16 0z" />;
}

export function KpiCard({ label, value, hint }: KpiCardProps) {
  const target = useMemo(() => Number.parseInt(value, 10), [value]);
  const [displayNumber, setDisplayNumber] = useState(0);
  const isNumeric = Number.isFinite(target);

  useEffect(() => {
    if (!isNumeric) return;

    const duration = 700;
    const start = performance.now();

    const tick = (time: number) => {
      const elapsed = time - start;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - (1 - progress) * (1 - progress);
      setDisplayNumber(Math.round(target * eased));
      if (progress < 1) {
        requestAnimationFrame(tick);
      }
    };

    requestAnimationFrame(tick);
  }, [isNumeric, target]);

  const displayValue = isNumeric ? String(displayNumber) : value;

  return (
    <article className="card kpi-card p-4">
      <div className="kpi-top-line" />
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.16em] text-muted">{label}</p>
          <p className="mt-2 text-5xl font-bold tracking-[-0.02em] text-text">{displayValue}</p>
        </div>
        <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-accent/30 bg-accent/10 text-accent">
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            {iconForLabel(label)}
          </svg>
        </span>
      </div>
      <p className="mt-2 text-xs text-slate-500">{hint}</p>
      <div className="mt-3 h-8 overflow-hidden rounded-lg border border-border bg-surface-2/70 px-2 py-2">
        <svg viewBox="0 0 120 24" className="h-full w-full">
          <path
            d="M0 18 L12 15 L24 16 L36 10 L48 12 L60 8 L72 11 L84 7 L96 9 L108 5 L120 6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className="text-accent"
          />
        </svg>
      </div>
    </article>
  );
}
