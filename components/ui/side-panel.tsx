import type { ReactNode } from "react";

type SidePanelProps = {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  widthClassName?: string;
};

export function SidePanel({ open, title, subtitle, onClose, children, widthClassName }: SidePanelProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-end bg-slate-950/35 p-2 sm:items-stretch sm:p-4">
      <aside className={`flex max-h-[94dvh] w-full flex-col ${widthClassName ?? "max-w-2xl"} rounded-2xl border border-border bg-surface shadow-xl sm:max-h-full`}>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 pb-3 pt-4">
          <div className="min-w-0">
            <h2 className="line-clamp-2 text-lg font-semibold">{title}</h2>
            {subtitle ? <p className="mt-0.5 text-sm text-muted">{subtitle}</p> : null}
          </div>
          <button type="button" onClick={onClose} className="btn-secondary px-3 py-1 text-sm">
            Chiudi
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-4">{children}</div>
      </aside>
    </div>
  );
}
