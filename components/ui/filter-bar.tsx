import type { ReactNode } from "react";

type FilterBarProps = {
  children: ReactNode;
  colsClassName?: string;
  className?: string;
};

export function FilterBar({ children, colsClassName, className }: FilterBarProps) {
  return <div className={`filters-grid items-end ${colsClassName ?? ""} ${className ?? ""}`.trim()}>{children}</div>;
}
