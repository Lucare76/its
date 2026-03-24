"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { isAllowed, parseRole } from "@/lib/rbac";
import { getE2ETestSessionOverride } from "@/lib/supabase/client-session";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";
import { needsInboxReview } from "@/lib/inbox-review";
import type { UserRole } from "@/lib/types";

const appNav = [
  { href: "/dashboard", label: "Cruscotto", icon: "D" },
  { href: "/arrivals", label: "Arrivi", icon: "A" },
  { href: "/departures", label: "Partenze", icon: "P" },
  { href: "/notifications", label: "Notifiche", icon: "!" },
  { href: "/onboarding", label: "Configurazione", icon: "O" },
  { href: "/analytics", label: "Analisi", icon: "Y" },
  { href: "/services/new", label: "Nuovo Servizio", icon: "N" },
  { href: "/crm-agencies", label: "CRM Agenzie", icon: "C" },
  { href: "/agency", label: "Agenzia", icon: "A" },
  { href: "/dispatch", label: "Assegnazioni", icon: "P" },
  { href: "/bus-tours", label: "Servizi Bus", icon: "B" },
  { href: "/bus-network", label: "Rete Bus", icon: "Z" },
  { href: "/planning", label: "Pianificazione", icon: "L" },
  { href: "/arrivals-clock", label: "Arrivi Orario", icon: "@" },
  { href: "/ops-summary", label: "Riepiloghi", icon: "S" },
  { href: "/report-center", label: "Centro Report", icon: "H" },
  { href: "/scheduler", label: "Scheduler", icon: "J" },
  { href: "/service-workflow", label: "Workflow Servizi", icon: "K" },
  { href: "/excel-workspace", label: "Excel Workspace", icon: "X" },
  { href: "/excel-import", label: "Import Excel", icon: "E" },
  { href: "/ops-rules", label: "Regole Operative", icon: "G" },
  { href: "/audit", label: "Audit", icon: "Q" },
  { href: "/driver", label: "Autista", icon: "R" },
  { href: "/fleet-ops", label: "Flotta Ops", icon: "V" },
  { href: "/preventivo-ops", label: "Preventivi", icon: "%" },
  { href: "/map", label: "Mappa", icon: "M" },
  { href: "/inbox", label: "Posta in arrivo", icon: "I" },
  { href: "/pdf-imports", label: "Import PDF", icon: "F" },
  { href: "/pricing", label: "Tariffe", icon: "T" },
  { href: "/pricing/margins", label: "Margini", icon: "$" },
  { href: "/settings/users", label: "Utenti", icon: "U" },
  { href: "/settings/whatsapp", label: "Impostazioni WA", icon: "W" }
];

function pageTitle(pathname: string) {
  const match = appNav.find((item) => pathname.startsWith(item.href));
  return match?.label ?? "Area di lavoro";
}

export default function AppShellLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const pathname = usePathname();
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);
  const [inboxPendingCount, setInboxPendingCount] = useState(0);
  const [liveToastMessage, setLiveToastMessage] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authRole, setAuthRole] = useState<UserRole | null>(null);
  const [authTenantId, setAuthTenantId] = useState<string | null>(null);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const [inboxSoundEnabled, setInboxSoundEnabled] = useState(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("it-inbox-sound") === "true";
  });
  const [isDark, setIsDark] = useState(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("it-theme") === "dark";
  });
  const title = useMemo(() => pageTitle(pathname), [pathname]);
  const allowedNav = useMemo(() => appNav.filter((item) => isAllowed(item.href, authRole)), [authRole]);

  const redirectByRole = (role: UserRole | null) => {
    if (!role) return "/login";
    if (role === "admin" || role === "operator") return "/dashboard";
    if (role === "driver") return "/driver";
    return "/agency";
  };

  const hardRedirect = (target: string) => {
    if (typeof window === "undefined") return;
    const current = `${window.location.pathname}${window.location.search}`;
    if (current === target) return;
    window.location.replace(target);
  };

  useEffect(() => {
    let active = true;

    const runAuthCheck = async () => {
      const e2eOverride = getE2ETestSessionOverride();
      if (e2eOverride) {
        if (!active) return;
        setNeedsOnboarding(false);
        setAuthRole(e2eOverride.role);
        setAuthTenantId(e2eOverride.tenantId);
        setAuthLoading(false);
        if (!isAllowed(pathname, e2eOverride.role)) {
          hardRedirect(redirectByRole(e2eOverride.role));
        }
        return;
      }

      if (!hasSupabaseEnv || !supabase) {
        if (!active) return;
        setNeedsOnboarding(false);
        setAuthRole(null);
        setAuthTenantId(null);
        setAuthLoading(false);
        hardRedirect(`/login?redirect=${encodeURIComponent(pathname)}`);
        return;
      }

      const { data: userData, error: userError } = await supabase.auth.getUser();
      if (!active) return;
      if (userError || !userData.user) {
        setNeedsOnboarding(false);
        setAuthRole(null);
        setAuthTenantId(null);
        setAuthLoading(false);
        hardRedirect(`/login?redirect=${encodeURIComponent(pathname)}`);
        return;
      }

      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData.session?.access_token;
      if (!active) return;
      if (!accessToken) {
        setNeedsOnboarding(false);
        setAuthRole(null);
        setAuthTenantId(null);
        setAuthLoading(false);
        hardRedirect(`/login?redirect=${encodeURIComponent(pathname)}`);
        return;
      }

      const onboardingResponse = await fetch("/api/onboarding/tenant", {
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      });
      const onboardingPayload = (await onboardingResponse.json().catch(() => null)) as
        | { hasTenant?: boolean; tenant?: { id: string }; role?: string; error?: string }
        | null;
      if (!active) return;

      const resolvedRole = parseRole(onboardingPayload?.role);
      const resolvedTenantId = onboardingPayload?.tenant?.id ?? null;
      const hasTenant = Boolean(onboardingPayload?.hasTenant && resolvedRole && resolvedTenantId);

      if (!hasTenant) {
        setNeedsOnboarding(true);
        setAuthRole(null);
        setAuthTenantId(null);
        setAuthLoading(false);
        if (pathname !== "/onboarding") {
          hardRedirect("/onboarding");
        }
        return;
      }

      setNeedsOnboarding(false);
      setAuthRole(resolvedRole);
      setAuthTenantId(resolvedTenantId);
      setAuthLoading(false);
      if (!isAllowed(pathname, resolvedRole)) {
        hardRedirect(redirectByRole(resolvedRole));
      }
    };

    void runAuthCheck();
    return () => {
      active = false;
    };
  }, [pathname, router]);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", isDark);
    root.classList.toggle("light", !isDark);
  }, [isDark]);

  useEffect(() => {
    if (!liveToastMessage) return;
    const timeout = window.setTimeout(() => setLiveToastMessage(null), 4200);
    return () => window.clearTimeout(timeout);
  }, [liveToastMessage]);

  const playInboxSound = () => {
    if (typeof window === "undefined") return;
    const AudioCtx = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(880, ctx.currentTime);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.05, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.22);
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start();
    oscillator.stop(ctx.currentTime + 0.24);
    window.setTimeout(() => {
      void ctx.close();
    }, 320);
  };

  useEffect(() => {
    const client = supabase;
    if (!hasSupabaseEnv || !client || !authTenantId) return;

    let isActive = true;

    const refreshPendingCount = async (tenantId: string) => {
      const { data, error } = await client
        .from("inbound_emails")
        .select("id, parsed_json")
        .eq("tenant_id", tenantId)
        .order("created_at", { ascending: false })
        .limit(2000);
      if (!isActive || error) return;
      const rows = (data ?? []) as Array<{ parsed_json: unknown }>;
      setInboxPendingCount(rows.filter((row) => needsInboxReview(row.parsed_json)).length);
    };

    const initRealtime = async () => {
      const tenantId = authTenantId;
      await refreshPendingCount(tenantId);

      const channel = client
        .channel(`layout-inbox-${tenantId}`)
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "inbound_emails", filter: `tenant_id=eq.${tenantId}` },
          () => {
            setLiveToastMessage("Nuova email ricevuta in inbox: da revisionare.");
            if (inboxSoundEnabled) playInboxSound();
            void refreshPendingCount(tenantId);
          }
        )
        .on(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table: "inbound_emails", filter: `tenant_id=eq.${tenantId}` },
          () => {
            void refreshPendingCount(tenantId);
          }
        );

      channel.subscribe();
      return channel;
    };

    let activeChannel: ReturnType<typeof client.channel> | null = null;
    void initRealtime().then((channel) => {
      if (!channel || !isActive) return;
      activeChannel = channel;
    });

    return () => {
      isActive = false;
      if (activeChannel) {
        void client.removeChannel(activeChannel);
      }
    };
  }, [authTenantId, inboxSoundEnabled]);

  if (authLoading) {
    return <div className="card p-4 text-sm text-muted">Verifica sessione...</div>;
  }

  if (needsOnboarding && pathname !== "/onboarding") {
    return <div className="card p-4 text-sm text-muted">Reindirizzamento onboarding in corso...</div>;
  }

  if (!needsOnboarding && !isAllowed(pathname, authRole)) {
    return <div className="card p-4 text-sm text-muted">Reindirizzamento in corso...</div>;
  }

  const toggleTheme = () => {
    const nextDark = !isDark;
    setIsDark(nextDark);
    localStorage.setItem("it-theme", nextDark ? "dark" : "light");
    document.documentElement.classList.toggle("dark", nextDark);
    document.documentElement.classList.toggle("light", !nextDark);
  };

  const toggleInboxSound = () => {
    const next = !inboxSoundEnabled;
    setInboxSoundEnabled(next);
    localStorage.setItem("it-inbox-sound", next ? "true" : "false");
    if (next) playInboxSound();
  };

  const handleSignOut = async () => {
    if (supabase) {
      await supabase.auth.signOut().catch(() => undefined);
    }
    router.replace("/login");
    router.refresh();
  };

  return (
    <section className="grid min-h-[calc(100vh-86px)] grid-cols-1 gap-5 py-4 md:grid-cols-[auto_1fr] md:gap-6 md:py-6">
      <aside className={`card sticky top-24 hidden h-fit p-2 md:block ${collapsed ? "w-[84px]" : "w-[248px]"}`}>
        <div className="mb-2 flex items-center justify-between px-1">
          {!collapsed ? <p className="text-xs font-semibold uppercase tracking-[0.15em] text-muted">Area di lavoro</p> : null}
          <button
            type="button"
            onClick={() => setCollapsed((prev) => !prev)}
            className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-border bg-white text-sm text-muted hover:bg-surface-2"
            title="Mostra/nascondi menu"
          >
            {collapsed ? ">" : "<"}
          </button>
        </div>
        <nav className="app-sidebar-scroll space-y-1 pr-1">
          {allowedNav.map((item) => {
            const active = pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`group relative flex min-w-0 items-center gap-3 rounded-xl border px-3 py-2.5 transition ${
                  active
                    ? "border-blue-200 bg-blue-50/80 text-text shadow-sm"
                    : "border-transparent text-muted hover:bg-slate-50 hover:text-text"
                }`}
              >
                {active ? <span className="absolute bottom-2 left-0 top-2 w-1 rounded-r-full bg-primary" /> : null}
                <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-surface-2 text-xs font-semibold">
                  {item.icon}
                </span>
                {!collapsed ? (
                  <span className="truncate text-sm font-medium">
                    {item.label}
                    {item.href === "/inbox" && inboxPendingCount > 0 ? (
                      <span className="ml-2 inline-flex min-w-5 items-center justify-center rounded-full bg-red-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                        {inboxPendingCount > 99 ? "99+" : inboxPendingCount}
                      </span>
                    ) : null}
                  </span>
                ) : null}
              </Link>
            );
          })}
        </nav>
      </aside>

      <div className="space-y-4">
        <header className="card space-y-3 px-4 py-4 md:px-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-[0.16em] text-muted">Operazioni</p>
            <h2 className="mt-1 line-clamp-2 text-2xl">{title}</h2>
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end sm:gap-3">
            <button type="button" onClick={toggleTheme} className="btn-secondary px-3 py-2 text-xs">
              {isDark ? "Modalita chiara" : "Modalita scura"}
            </button>
            <button type="button" onClick={toggleInboxSound} className="btn-secondary px-3 py-2 text-xs">
              {inboxSoundEnabled ? "Suono inbox ON" : "Suono inbox OFF"}
            </button>
            <button type="button" onClick={handleSignOut} className="btn-secondary px-3 py-2 text-xs">
              Logout
            </button>
            <div className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-border bg-surface-2 text-sm font-semibold shadow-sm">
              {(authRole ?? "U").slice(0, 2).toUpperCase()}
            </div>
          </div>
          </div>
          <div className="mobile-nav-strip">
            {allowedNav.map((item) => {
              const active = pathname.startsWith(item.href);
              return (
                <Link
                  key={`mobile-${item.href}`}
                  href={item.href}
                  className={active ? "btn-primary px-3 py-1.5 text-xs" : "btn-secondary px-3 py-1.5 text-xs"}
                >
                  {item.label}
                  {item.href === "/inbox" && inboxPendingCount > 0 ? ` (${inboxPendingCount > 99 ? "99+" : inboxPendingCount})` : ""}
                </Link>
              );
            })}
          </div>
        </header>
        {children}
      </div>
      {liveToastMessage ? (
        <div className="fixed bottom-4 right-4 z-[70] rounded-lg bg-slate-900 px-4 py-2 text-sm text-white shadow-lg">
          {liveToastMessage}
        </div>
      ) : null}
    </section>
  );
}
