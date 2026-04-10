import type { ReactNode } from "react";

type BreadcrumbItem = {
  label: string;
  href?: string;
};

type PageHeaderProps = {
  title: string;
  subtitle?: string;
  badge?: ReactNode;
  actions?: ReactNode;
  breadcrumbs?: BreadcrumbItem[];
  className?: string;
};

export function PageHeader({ title, subtitle, badge, actions, breadcrumbs, className }: PageHeaderProps) {
  return (
    <header className={`section-head ${className ?? ""}`.trim()}>
      <div className="min-w-0 space-y-1">
        {breadcrumbs && breadcrumbs.length > 0 ? (
          <nav className="flex min-w-0 flex-wrap items-center gap-1 text-xs text-muted" aria-label="Percorso pagina">
            {breadcrumbs.map((item, index) => (
              <span key={`${item.label}-${index}`} className="inline-flex min-w-0 items-center gap-1">
                {index > 0 ? <span className="text-muted/70">/</span> : null}
                {item.href ? (
                  <a href={item.href} className="truncate hover:text-text">
                    {item.label}
                  </a>
                ) : (
                  <span className="truncate">{item.label}</span>
                )}
              </span>
            ))}
          </nav>
        ) : null}
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h1 className="section-title">{title}</h1>
          {badge}
        </div>
        {subtitle ? <p className="section-subtitle">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex w-full flex-wrap gap-2 sm:w-auto sm:justify-end">{actions}</div> : null}
    </header>
  );
}
