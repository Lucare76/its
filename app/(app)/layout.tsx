"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

const appNav = [
  { href: "/dashboard", label: "Dashboard", icon: "D" },
  { href: "/onboarding", label: "Onboarding", icon: "O" },
  { href: "/analytics", label: "Analytics", icon: "Y" },
  { href: "/services/new", label: "New Service", icon: "N" },
  { href: "/agency", label: "Agency", icon: "A" },
  { href: "/dispatch", label: "Dispatch", icon: "P" },
  { href: "/bus-tours", label: "Bus Tours", icon: "B" },
  { href: "/planning", label: "Planning", icon: "L" },
  { href: "/driver", label: "Driver", icon: "R" },
  { href: "/map", label: "Map", icon: "M" },
  { href: "/inbox", label: "Inbox", icon: "I" },
  { href: "/pricing", label: "Pricing", icon: "T" },
  { href: "/pricing/margins", label: "Margins", icon: "$" },
  { href: "/settings/whatsapp", label: "WA Settings", icon: "W" }
];

function pageTitle(pathname: string) {
  const match = appNav.find((item) => pathname.startsWith(item.href));
  return match?.label ?? "Workspace";
}

export default function AppShellLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [isDark, setIsDark] = useState(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("it-theme") === "dark";
  });
  const title = useMemo(() => pageTitle(pathname), [pathname]);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", isDark);
    root.classList.toggle("light", !isDark);
  }, [isDark]);

  const toggleTheme = () => {
    const nextDark = !isDark;
    setIsDark(nextDark);
    localStorage.setItem("it-theme", nextDark ? "dark" : "light");
    document.documentElement.classList.toggle("dark", nextDark);
    document.documentElement.classList.toggle("light", !nextDark);
  };

  return (
    <section className="grid min-h-[calc(100vh-86px)] grid-cols-1 gap-6 py-6 md:grid-cols-[auto_1fr]">
      <aside className={`card h-fit p-2 ${collapsed ? "w-[84px]" : "w-[248px]"}`}>
        <div className="mb-2 flex items-center justify-between px-1">
          {!collapsed ? <p className="text-xs font-semibold uppercase tracking-[0.15em] text-muted">Workspace</p> : null}
          <button
            type="button"
            onClick={() => setCollapsed((prev) => !prev)}
            className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-border bg-white text-sm text-muted hover:bg-surface-2"
            title="Toggle sidebar"
          >
            {collapsed ? ">" : "<"}
          </button>
        </div>
        <nav className="space-y-1">
          {appNav.map((item) => {
            const active = pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`group relative flex items-center gap-3 rounded-xl border px-3 py-2.5 transition ${
                  active
                    ? "border-blue-200 bg-blue-50/80 text-text shadow-sm"
                    : "border-transparent text-muted hover:bg-slate-50 hover:text-text"
                }`}
              >
                {active ? <span className="absolute bottom-2 left-0 top-2 w-1 rounded-r-full bg-primary" /> : null}
                <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-surface-2 text-xs font-semibold">
                  {item.icon}
                </span>
                {!collapsed ? <span className="text-sm font-medium">{item.label}</span> : null}
              </Link>
            );
          })}
        </nav>
      </aside>

      <div className="space-y-4">
        <header className="card flex items-center justify-between px-5 py-4">
          <div>
            <p className="text-xs uppercase tracking-[0.16em] text-muted">Operations</p>
            <h2 className="mt-1 text-2xl">{title}</h2>
          </div>
          <div className="flex items-center gap-3">
            <button type="button" onClick={toggleTheme} className="btn-secondary px-3 py-2 text-xs">
              {isDark ? "Light mode" : "Dark mode"}
            </button>
            <div className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-border bg-surface-2 text-sm font-semibold shadow-sm">
              OP
            </div>
          </div>
        </header>
        {children}
      </div>
    </section>
  );
}
