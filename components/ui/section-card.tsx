import type { ReactNode } from "react";

type SectionCardProps = {
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
  children?: ReactNode;
  loading?: boolean;
  loadingLines?: number;
  className?: string;
  bodyClassName?: string;
};

function SectionCardSkeleton({ lines = 4 }: { lines?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: lines }).map((_, index) => (
        <div key={`section-skeleton-${index}`} className="h-4 animate-pulse rounded bg-slate-200/70" />
      ))}
    </div>
  );
}

export function SectionCard({
  title,
  subtitle,
  actions,
  children,
  loading = false,
  loadingLines = 4,
  className,
  bodyClassName
}: SectionCardProps) {
  return (
    <section className={`card p-4 md:p-5 ${className ?? ""}`.trim()}>
      {title || actions || subtitle ? (
        <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            {title ? <h2 className="text-base font-semibold text-text">{title}</h2> : null}
            {subtitle ? <p className="mt-0.5 text-sm text-muted">{subtitle}</p> : null}
          </div>
          {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
        </div>
      ) : null}
      <div className={bodyClassName}>{loading ? <SectionCardSkeleton lines={loadingLines} /> : children}</div>
    </section>
  );
}
