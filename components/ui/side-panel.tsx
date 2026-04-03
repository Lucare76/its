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
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/35 px-2 py-2 sm:px-4 sm:py-4">
      <aside className={`h-full w-full ${widthClassName ?? "max-w-2xl"} overflow-y-auto rounded-2xl border border-border bg-surface p-4 shadow-xl`}>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
          <div className="min-w-0">
            <h2 className="line-clamp-2 text-lg font-semibold">{title}</h2>
            {subtitle ? <p className="mt-0.5 text-sm text-muted">{subtitle}</p> : null}
          </div>
          <button type="button" onClick={onClose} className="btn-secondary px-3 py-1 text-sm">
            Chiudi
          </button>
        </div>
        <div className="mt-4">{children}</div>
      </aside>
    </div>
  );
}
