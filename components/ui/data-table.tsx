import type { ReactNode } from "react";

type DataTableProps = {
  children?: ReactNode;
  toolbar?: ReactNode;
  footer?: ReactNode;
  empty?: ReactNode;
  loading?: boolean;
  loadingRows?: number;
  minWidthClassName?: string;
  stickyActions?: ReactNode;
  className?: string;
};

function TableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <tbody>
      {Array.from({ length: rows }).map((_, index) => (
        <tr key={`skeleton-${index}`}>
          <td className="px-3 py-3" colSpan={12}>
            <div className="h-4 w-full animate-pulse rounded bg-slate-200/70" />
          </td>
        </tr>
      ))}
    </tbody>
  );
}

export function DataTable({
  children,
  toolbar,
  footer,
  empty,
  loading = false,
  loadingRows = 6,
  minWidthClassName,
  stickyActions,
  className
}: DataTableProps) {
  return (
    <div className={`premium-table ${className ?? ""}`.trim()}>
      {toolbar ? <div className="border-b border-border px-3 py-3">{toolbar}</div> : null}
      <table className={`${minWidthClassName ?? "min-w-full"} text-sm`}>{loading ? <TableSkeleton rows={loadingRows} /> : children}</table>
      {!loading && !children && empty ? <div className="p-3">{empty}</div> : null}
      {footer ? <div className="border-t border-border px-3 py-3">{footer}</div> : null}
      {stickyActions ? (
        <div className="sticky bottom-0 z-10 border-t border-border bg-surface px-3 py-2 shadow-[0_-4px_20px_rgba(15,23,42,0.06)]">
          {stickyActions}
        </div>
      ) : null}
    </div>
  );
}
