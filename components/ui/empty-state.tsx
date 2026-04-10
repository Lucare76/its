import type { ReactNode } from "react";

type EmptyStateProps = {
  title: string;
  description?: string;
  action?: ReactNode;
  compact?: boolean;
  className?: string;
};

export function EmptyState({ title, description, action, compact = false, className }: EmptyStateProps) {
  return (
    <div className={`card ${compact ? "p-4" : "p-5"} ${className ?? ""}`.trim()}>
      <div className="space-y-1">
        <p className="text-sm font-medium text-text">{title}</p>
        {description ? <p className="text-sm text-muted">{description}</p> : null}
      </div>
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}
