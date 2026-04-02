"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { isAllowed, isAllowedWithOverrides, type CapabilityOverrides, parseRole } from "@/lib/rbac";
import { getE2ETestSessionOverride } from "@/lib/supabase/client-session";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";
import { needsInboxReview } from "@/lib/inbox-review";
import type { UserRole } from "@/lib/types";

type NavItem = {
  href: string;
  label: string;
  icon: string;
  requiresQuotesAccess?: boolean;
};

type NavGroup = {
  title: string;
  items: NavItem[];
};

// Gruppo collassabile nel main nav (es. Mario Boss)
type NavMainGroup = {
  type: "group";
  key: string;
  label: string;
  icon: string;
  items: NavItem[];
};

function iconWrapClass(active: boolean) {
  return active
    ? "bg-slate-900 text-white shadow-sm"
    : "bg-white text-slate-600 ring-1 ring-slate-200";
}

function renderNavIcon(icon: string) {
  const common = "h-3.5 w-3.5";
  switch (icon) {
    case "D":
      return (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" className={common} aria-hidden="true">
          <path d="M2.5 8h11M8 2.5v11" />
        </svg>
      );
    case "A":
      return (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" className={common} aria-hidden="true">
          <path d="M3 11.5V4.5h10v7M3 8h10" />
        </svg>
      );
    case "P":
      return (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" className={common} aria-hidden="true">
          <path d="M3 4.5h10v7H3zM8 4.5v7" />
        </svg>
      );
    case "I":
      return (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" className={common} aria-hidden="true">
          <path d="M2.5 4.5h11v7h-11zM3 5l5 4 5-4" />
        </svg>
      );
    case "B":
      return (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" className={common} aria-hidden="true">
          <path d="M3.5 4.5h9v5h-9zM5 12.5h0M11 12.5h0M4.5 9.5h7" />
        </svg>
      );
    case "E":
      return (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" className={common} aria-hidden="true">
          <path d="M8 2.5s-4 3-4 6.5a4 4 0 0 0 8 0c0-3.5-4-6.5-4-6.5z" />
          <path d="M8 7v4M6 9l2-2 2 2" />
        </svg>
      );
    case "MARIO":
      return <img src="/mario-icon.png" alt="Mario" className="h-6 w-6 object-contain" aria-hidden="true" />;
    case "KARMEN":
      return <img src="/karmen-peach.png" alt="Karmen" className="h-6 w-6 object-contain" aria-hidden="true" />;
    case "G":
      return (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" className={common} aria-hidden="true">
          <path d="M3 3.5h4v4H3zM9 3.5h4v4H9zM6 8.5h4v4H6z" />
        </svg>
      );
    case "M":
      return (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" className={common} aria-hidden="true">
          <path d="M8 13.5s4-3.2 4-6.5a4 4 0 1 0-8 0c0 3.3 4 6.5 4 6.5Z" />
          <circle cx="8" cy="7" r="1.4" />
        </svg>
      );
    case "R":
      return (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" className={common} aria-hidden="true">
          <circle cx="8" cy="5" r="2.2" />
          <path d="M3.5 13c.7-2.1 2.3-3.2 4.5-3.2S11.8 10.9 12.5 13" />
        </svg>
      );
    case "F":
      return (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" className={common} aria-hidden="true">
          <path d="M3 11.5h10M4.5 11.5V6.2l2-1.7h3l2 1.7v5.3M5.2 7.2h5.6" />
        </svg>
      );
    case "C":
      return (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" className={common} aria-hidden="true">
          <path d="M3.5 12.5V3.5h9v9M6 6.2h4M6 8.5h4M6 10.8h2.5" />
        </svg>
      );
    case "H":
      return (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" className={common} aria-hidden="true">
          <path d="M3.5 12.5V6L8 3.5 12.5 6v6.5M6 12.5V9h4v3.5" />
        </svg>
      );
    case "T":
      return (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" className={common} aria-hidden="true">
          <path d="M3 4.5h10M8 4.5v7" />
        </svg>
      );
    case "W":
      return (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" className={common} aria-hidden="true">
          <path d="M3 4.5 5 11l3-4 3 4 2-6.5" />
        </svg>
      );
    case "L":
      return (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" className={common} aria-hidden="true">
          <path d="M3.5 4.5h9v8h-9zM5.5 2.5v3M10.5 2.5v3M3.5 7.5h9" />
        </svg>
      );
    case "@":
      return (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={common} aria-hidden="true">
          <path d="M11.8 10.6A4.8 4.8 0 1 1 12 5.5v3.7c0 .8.5 1.2 1 1.2.7 0 1.2-.7 1.2-1.8 0-3.4-2.6-6.2-6.2-6.2A6.2 6.2 0 1 0 14 8.7" />
          <circle cx="8" cy="8" r="1.8" />
        </svg>
      );
    case "S":
      return (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" className={common} aria-hidden="true">
          <path d="M4 11.5h8M4 8h8M4 4.5h8" />
        </svg>
      );
    case "%":
      return (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" className={common} aria-hidden="true">
          <path d="m4 12 8-8M5 5h0M11 11h0" />
          <circle cx="5" cy="5" r="1.4" />
          <circle cx="11" cy="11" r="1.4" />
        </svg>
      );
    case "N":
      return (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" className={common} aria-hidden="true">
          <path d="M3.5 8h9M8 3.5v9" />
        </svg>
      );
    case "!":
      return (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" className={common} aria-hidden="true">
          <path d="M8 3.5v5.5" />
          <circle cx="8" cy="11.8" r=".8" fill="currentColor" stroke="none" />
        </svg>
      );
    case "Y":
      return (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" className={common} aria-hidden="true">
          <path d="M3.5 11.5 6.5 8.5 8.7 10.7 12.5 6.5" />
          <path d="M10.5 6.5h2v2" />
        </svg>
      );
    case "X":
      return (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" className={common} aria-hidden="true">
          <path d="M3.5 3.5h9v9h-9zM6 6h4M6 8h4M6 10h2.5" />
        </svg>
      );
    case "E":
      return (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" className={common} aria-hidden="true">
          <path d="M8 3.5v6M5.5 7l2.5 2.5L10.5 7M3.5 12.5h9" />
        </svg>
      );
    case "J":
      return (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" className={common} aria-hidden="true">
          <circle cx="8" cy="8" r="4.5" />
          <path d="M8 5.6V8l1.8 1.4" />
        </svg>
      );
    case "K":
      return (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" className={common} aria-hidden="true">
          <path d="M4 4.5h8M4 8h8M4 11.5h5.5" />
        </svg>
      );
    case "Q":
      return (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" className={common} aria-hidden="true">
          <path d="M4.5 3.5h7v9h-7zM6.5 6.2h3M6.5 8.4h3M6.5 10.6h2" />
        </svg>
      );
    case "O":
      return (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" className={common} aria-hidden="true">
          <circle cx="8" cy="8" r="2.2" />
          <path d="M8 2.5v1.5M8 12v1.5M2.5 8H4M12 8h1.5M4.2 4.2l1 1M10.8 10.8l1 1M11.8 4.2l-1 1M5.2 10.8l-1 1" />
        </svg>
      );
    case "V":
      return (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" className={common} aria-hidden="true">
          <circle cx="8" cy="8" r="2" />
          <path d="M5 5a4.2 4.2 0 0 1 6 0M3.5 3.5a6.4 6.4 0 0 1 9 0M11 11a4.2 4.2 0 0 1-6 0M12.5 12.5a6.4 6.4 0 0 1-9 0" />
        </svg>
      );
    default:
      return <span className="text-[11px] font-semibold">{icon}</span>;
  }
}

function HeaderBellIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-4 w-4" aria-hidden="true">
      <path d="M8 2.5a2.5 2.5 0 0 0-2.5 2.5v1.1c0 .7-.2 1.4-.5 2L4 10.5h8l-1-2.4c-.3-.6-.5-1.3-.5-2V5A2.5 2.5 0 0 0 8 2.5Z" />
      <path d="M6.5 12a1.5 1.5 0 0 0 3 0" />
    </svg>
  );
}

const MAIN_NAV_BY_ROLE: Record<UserRole, NavItem[]> = {
  admin: [],
  operator: [],
  agency: [
    { href: "/agency", label: "Area Agenzia", icon: "A" },
    { href: "/map", label: "Mappa", icon: "M" }
  ],
  driver: [{ href: "/driver", label: "Area Autista", icon: "R" }]
};

const OPERATIONS_MAIN_NAV: NavItem[] = [
  { href: "/dashboard", label: "Cruscotto", icon: "D" },
  { href: "/mappa-live", label: "Control Room", icon: "M" },
  { href: "/arrivals", label: "Arrivi", icon: "A" },
  { href: "/departures", label: "Partenze", icon: "P" },
  { href: "/inbox", label: "Posta in arrivo", icon: "I" },
  { href: "/biglietti-medmar", label: "Biglietti MEDMAR", icon: "⚓" },
  { href: "/dispatch", label: "Assegnazioni", icon: "G" }
];

const MARIO_BOSS_GROUP: NavMainGroup = {
  type: "group",
  key: "mario-boss",
  label: "Mario Boss",
  icon: "MARIO",
  items: [
    { href: "/mario-planning", label: "Planning", icon: "P" },
    { href: "/bus-network", label: "Linea Bus", icon: "B" },
    { href: "/rete-ischia", label: "Transfer Ischia", icon: "O" },
    { href: "/escursioni", label: "Escursioni", icon: "E" },
  ]
};

const KARMEN_PEACH_GROUP: NavMainGroup = {
  type: "group",
  key: "karmen-peach",
  label: "Karmen Peach",
  icon: "KARMEN",
  items: [
    { href: "/liste-bruno", label: "Liste Bruno", icon: "S" },
  ]
};

MAIN_NAV_BY_ROLE.admin = OPERATIONS_MAIN_NAV;
MAIN_NAV_BY_ROLE.operator = OPERATIONS_MAIN_NAV;

const SETTINGS_GROUPS: NavGroup[] = [
  {
    title: "Gestione utenti",
    items: [{ href: "/settings/users", label: "Utenti", icon: "U" }]
  },
  {
    title: "Flotta e mezzi",
    items: [{ href: "/fleet-ops", label: "Flotta e mezzi", icon: "F" }]
  },
  {
    title: "Strutture e anagrafiche",
    items: [
      { href: "/crm-agencies", label: "Agenzie", icon: "C" },
      { href: "/hotels", label: "Hotel", icon: "H" }
    ]
  },
  {
    title: "Business e regole",
    items: [
      { href: "/pricing", label: "Tariffe", icon: "T" },
      { href: "/pricing/margins", label: "Margini", icon: "M" },
      { href: "/ops-rules", label: "Regole operative", icon: "R" },
      { href: "/settings/whatsapp", label: "WhatsApp", icon: "W" }
    ]
  },
  {
    title: "Strumenti operativi avanzati",
    items: [
      { href: "/planning", label: "Pianificazione", icon: "L" },
      { href: "/ops-summary", label: "Riepiloghi", icon: "S" },
      { href: "/arrivals-clock", label: "Arrivi a orario", icon: "@" },
      { href: "/report-center", label: "Centro report", icon: "R" },
      { href: "/bus-tours", label: "Servizi bus", icon: "B" }
    ]
  },
  {
    title: "Preventivi",
    items: [{ href: "/preventivo-ops", label: "Area preventivi", icon: "%", requiresQuotesAccess: true }]
  },
  {
    title: "Tecnico e sistema",
    items: [
      { href: "/services/new", label: "Nuovo servizio", icon: "N" },
      { href: "/notifications", label: "Notifiche", icon: "!" },
      { href: "/analytics", label: "Analisi", icon: "Y" },
      { href: "/excel-workspace", label: "Excel workspace", icon: "X" },
      { href: "/excel-import", label: "Import Excel", icon: "E" },
      { href: "/scheduler", label: "Scheduler", icon: "J" },
      { href: "/service-workflow", label: "Workflow servizi", icon: "K" },
      { href: "/audit", label: "Audit", icon: "Q" }
    ]
  }
];

const ALL_NAV_ITEMS = [...Object.values(MAIN_NAV_BY_ROLE).flat(), ...MARIO_BOSS_GROUP.items, ...KARMEN_PEACH_GROUP.items, ...SETTINGS_GROUPS.flatMap((group) => group.items)];

function matchesPath(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function canSeeNavItem(item: NavItem, role: UserRole | null, quotesAccess: boolean, overrides?: CapabilityOverrides) {
  if (!role) return false;
  if (!isAllowedWithOverrides(item.href, role, overrides)) return false;
  if (item.requiresQuotesAccess && !quotesAccess) return false;
  return true;
}

function uniqueNavItems(items: NavItem[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.href)) return false;
    seen.add(item.href);
    return true;
  });
}

function pageTitle(pathname: string) {
  const match = [...ALL_NAV_ITEMS]
    .sort((left, right) => right.href.length - left.href.length)
    .find((item) => matchesPath(pathname, item.href));
  return match?.label ?? "Area di lavoro";
}

export default function AppShellLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const pathname = usePathname();
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [marioBossOpen, setMarioBossOpen] = useState(true);
  const [karmenPeachOpen, setKarmenPeachOpen] = useState(true);
  const [inboxPendingCount, setInboxPendingCount] = useState(0);
  const [pendingAccessRequestCount, setPendingAccessRequestCount] = useState(0);
  const [liveToastMessage, setLiveToastMessage] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authRole, setAuthRole] = useState<UserRole | null>(null);
  const [authTenantId, setAuthTenantId] = useState<string | null>(null);
  const [agencySetupRequired, setAgencySetupRequired] = useState(false);
  const [capabilityOverrides, setCapabilityOverrides] = useState<CapabilityOverrides>({});
  const [quotesAccess, setQuotesAccess] = useState(false);
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
  const mainNav = useMemo(
    () =>
      authRole
        ? uniqueNavItems(MAIN_NAV_BY_ROLE[authRole].filter((item) => canSeeNavItem(item, authRole, quotesAccess, capabilityOverrides)))
        : [],
    [authRole, capabilityOverrides, quotesAccess]
  );
  const settingsGroups = useMemo(() => {
    if (authRole !== "admin") return [];
    return SETTINGS_GROUPS
      .map((group) => ({
        ...group,
        items: uniqueNavItems(group.items.filter((item) => canSeeNavItem(item, authRole, quotesAccess, capabilityOverrides)))
      }))
      .filter((group) => group.items.length > 0);
  }, [authRole, capabilityOverrides, quotesAccess]);
  const settingsPathActive = useMemo(
    () => settingsGroups.some((group) => group.items.some((item) => matchesPath(pathname, item.href))),
    [pathname, settingsGroups]
  );
  const isSettingsExpanded = settingsPathActive || settingsOpen;

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
        setAgencySetupRequired(false);
        setCapabilityOverrides({});
        setQuotesAccess(e2eOverride.role === "admin" || e2eOverride.role === "operator");
        setAuthLoading(false);
        if (!isAllowedWithOverrides(pathname, e2eOverride.role, {})) {
          hardRedirect(redirectByRole(e2eOverride.role));
        }
        return;
      }

      if (!hasSupabaseEnv || !supabase) {
        if (!active) return;
        setNeedsOnboarding(false);
        setAuthRole(null);
        setAuthTenantId(null);
        setAgencySetupRequired(false);
        setCapabilityOverrides({});
        setQuotesAccess(false);
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
        setAgencySetupRequired(false);
        setCapabilityOverrides({});
        setQuotesAccess(false);
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
        setAgencySetupRequired(false);
        setCapabilityOverrides({});
        setQuotesAccess(false);
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
        | { hasTenant?: boolean; tenant?: { id: string }; role?: string; error?: string; capability_overrides?: CapabilityOverrides }
        | null;
      if (!active) return;

      if (onboardingResponse.status === 403) {
        await supabase.auth.signOut().catch(() => undefined);
        setNeedsOnboarding(false);
        setAuthRole(null);
        setAuthTenantId(null);
        setAgencySetupRequired(false);
        setCapabilityOverrides({});
        setQuotesAccess(false);
        setAuthLoading(false);
        hardRedirect("/login?suspended=1");
        return;
      }

      const resolvedRole = parseRole(onboardingPayload?.role);
      const resolvedTenantId = onboardingPayload?.tenant?.id ?? null;
      const hasTenant = Boolean(onboardingPayload?.hasTenant && resolvedRole && resolvedTenantId);

      if (!hasTenant) {
        setNeedsOnboarding(true);
        setAuthRole(null);
        setAuthTenantId(null);
        setAgencySetupRequired(false);
        setCapabilityOverrides({});
        setQuotesAccess(false);
        setAuthLoading(false);
        if (pathname !== "/onboarding") {
          hardRedirect("/onboarding");
        }
        return;
      }

      setNeedsOnboarding(false);
      setAuthRole(resolvedRole);
      setAuthTenantId(resolvedTenantId);
      setCapabilityOverrides(onboardingPayload?.capability_overrides ?? {});
      let resolvedAgencySetupRequired = false;
      if (resolvedRole === "agency") {
        const agencyProfileResponse = await fetch("/api/agency/profile", {
          headers: {
            Authorization: `Bearer ${accessToken}`
          }
        });
        const agencyProfilePayload = (await agencyProfileResponse.json().catch(() => null)) as
          | { agency?: { setup_required?: boolean } }
          | null;
        if (!active) return;
        resolvedAgencySetupRequired = agencyProfileResponse.ok && agencyProfilePayload?.agency?.setup_required === true;
      }
      setAgencySetupRequired(resolvedAgencySetupRequired);
      if (resolvedRole === "admin") {
        const pendingAccessResponse = await fetch("/api/settings/users", {
          headers: {
            Authorization: `Bearer ${accessToken}`
          }
        });
        const pendingAccessPayload = (await pendingAccessResponse.json().catch(() => null)) as
          | { pending_access_requests?: Array<unknown> }
          | null;
        if (!active) return;
        setPendingAccessRequestCount(pendingAccessResponse.ok ? pendingAccessPayload?.pending_access_requests?.length ?? 0 : 0);
      } else {
        setPendingAccessRequestCount(0);
      }
      let resolvedQuotesAccess = false;
      if (resolvedRole === "admin" || resolvedRole === "operator") {
        const quotesAccessResponse = await fetch("/api/ops/quotes/access", {
          headers: {
            Authorization: `Bearer ${accessToken}`
          }
        });
        const quotesAccessPayload = (await quotesAccessResponse.json().catch(() => null)) as
          | { ok?: boolean; can_access?: boolean }
          | null;
        if (!active) return;
        resolvedQuotesAccess = quotesAccessResponse.ok && quotesAccessPayload?.ok === true && quotesAccessPayload.can_access === true;
      }
      setQuotesAccess(resolvedQuotesAccess);
      setAuthLoading(false);
      if (resolvedRole === "agency" && resolvedAgencySetupRequired && pathname !== "/agency/profile-setup") {
        hardRedirect("/agency/profile-setup");
        return;
      }
      if (resolvedRole === "agency" && !resolvedAgencySetupRequired && pathname === "/agency/profile-setup") {
        hardRedirect("/agency");
        return;
      }
      if (pathname.startsWith("/preventivo-ops") && !resolvedQuotesAccess) {
        hardRedirect(redirectByRole(resolvedRole));
        return;
      }
      if (!isAllowedWithOverrides(pathname, resolvedRole, onboardingPayload?.capability_overrides ?? {})) {
        hardRedirect(redirectByRole(resolvedRole));
      }
    };

    void runAuthCheck();
    return () => {
      active = false;
    };
  }, [pathname, router]);

  useEffect(() => {
    if (!collapsed) return;
    const timeout = window.setTimeout(() => {
      setSettingsOpen(false);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [collapsed]);

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
    void ctx.resume();
    // Annuncio stazione: ding (Sol) → dong (Mi) → dong (Do) → pausa → annuncio
    const tones = [
      { freq: 783.99, start: 0.0, duration: 0.45 },   // Sol5
      { freq: 659.25, start: 0.45, duration: 0.45 },  // Mi5
      { freq: 523.25, start: 0.9, duration: 0.6 },    // Do5
      { freq: 659.25, start: 1.7, duration: 0.35 },   // Mi5
      { freq: 783.99, start: 2.05, duration: 0.35 },  // Sol5
      { freq: 659.25, start: 2.4, duration: 0.55 },   // Mi5
    ];
    for (const tone of tones) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(tone.freq, ctx.currentTime + tone.start);
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + tone.start);
      gain.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + tone.start + 0.03);
      gain.gain.setValueAtTime(0.12, ctx.currentTime + tone.start + tone.duration - 0.08);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + tone.start + tone.duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime + tone.start);
      osc.stop(ctx.currentTime + tone.start + tone.duration);
    }
    window.setTimeout(() => { void ctx.close(); }, 3500);
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

    const refreshPendingAccessRequests = async (tenantId: string) => {
      if (authRole !== "admin") {
        setPendingAccessRequestCount(0);
        return;
      }
      const { count, error } = await client
        .from("tenant_access_requests")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .eq("status", "pending");
      if (!isActive || error) return;
      setPendingAccessRequestCount(count ?? 0);
    };

    const initRealtime = async () => {
      const tenantId = authTenantId;
      await refreshPendingCount(tenantId);
      await refreshPendingAccessRequests(tenantId);

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
        )
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "tenant_access_requests", filter: `tenant_id=eq.${tenantId}` },
          (payload) => {
            const nextStatus = typeof payload.new?.status === "string" ? payload.new.status : null;
            if (nextStatus === "pending") {
              setLiveToastMessage("Nuova richiesta accesso agenzia da approvare.");
            }
            void refreshPendingAccessRequests(tenantId);
          }
        )
        .on(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table: "tenant_access_requests", filter: `tenant_id=eq.${tenantId}` },
          () => {
            void refreshPendingAccessRequests(tenantId);
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
  }, [authRole, authTenantId, inboxSoundEnabled]);

  // Polling automatico email ogni 5 minuti
  useEffect(() => {
    if (!authTenantId || !["admin", "operator"].includes(authRole ?? "")) return;

    const doImport = async () => {
      try {
        const { data: sessionData } = await supabase!.auth.getSession();
        const token = sessionData.session?.access_token;
        if (!token) return;
        await fetch("/api/email/operational-import", {
          method: "POST",
          headers: { authorization: `Bearer ${token}` }
        });
      } catch { /* silenzioso */ }
    };

    doImport(); // prima chiamata subito
    const interval = setInterval(doImport, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [authTenantId, authRole]);

  if (authLoading) {
    return <div className="card p-4 text-sm text-muted">Verifica sessione...</div>;
  }

  if (needsOnboarding && pathname !== "/onboarding") {
    return <div className="card p-4 text-sm text-muted">Reindirizzamento onboarding in corso...</div>;
  }

  if (authRole === "agency" && agencySetupRequired && pathname !== "/agency/profile-setup") {
    return <div className="card p-4 text-sm text-muted">Reindirizzamento al completamento profilo agenzia...</div>;
  }

  if (!needsOnboarding && !isAllowedWithOverrides(pathname, authRole, capabilityOverrides)) {
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
      <aside className={`sticky top-24 hidden h-fit md:block transition-all duration-200 ${collapsed ? "w-[72px]" : "w-[260px]"}`}>
        <div className="overflow-hidden rounded-[28px] border border-slate-200 bg-[linear-gradient(180deg,#ffffff_0%,#f8fafc_100%)] p-3 shadow-[0_18px_50px_rgba(15,23,42,0.08)]">

          {/* Brand + collapse */}
          <div className="mb-3 flex items-center justify-between gap-2 rounded-2xl border border-slate-200 bg-white/90 px-3 py-2.5 shadow-sm">
            {!collapsed ? (
              <div className="min-w-0">
                <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400">Ischia Transfer</p>
                <p className="text-sm font-bold text-slate-900 leading-tight">PMS operativo</p>
              </div>
            ) : (
              <div className="mx-auto flex h-8 w-8 items-center justify-center rounded-xl bg-slate-900 text-[11px] font-bold text-white">IT</div>
            )}
            <button
              type="button"
              onClick={() => setCollapsed((prev) => !prev)}
              className="flex-shrink-0 inline-flex h-8 w-8 items-center justify-center rounded-xl border border-slate-200 bg-slate-50 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
              title={collapsed ? "Espandi menu" : "Comprimi menu"}
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-3.5 w-3.5" aria-hidden="true">
                {collapsed
                  ? <path d="M6 3.5l4 4.5-4 4.5" />
                  : <path d="M10 3.5L6 8l4 4.5" />}
              </svg>
            </button>
          </div>

          {/* Main nav */}
          <nav className="app-sidebar-scroll space-y-0.5 pr-0.5">
            {!collapsed ? (
              <p className="px-3 pb-1.5 pt-0.5 text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400">Operativo</p>
            ) : null}
            {mainNav.map((item) => {
              const active = matchesPath(pathname, item.href);
              const badge = item.href === "/inbox" && inboxPendingCount > 0 ? inboxPendingCount : 0;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  title={collapsed ? item.label : undefined}
                  className={`group relative flex min-w-0 items-center gap-3 rounded-xl border px-2.5 py-2 transition ${
                    active
                      ? "border-slate-200 bg-white text-slate-950 shadow-[0_8px_20px_rgba(15,23,42,0.08)]"
                      : "border-transparent text-slate-500 hover:bg-white/80 hover:text-slate-900"
                  } ${collapsed ? "justify-center" : ""}`}
                >
                  {active ? <span className="absolute bottom-1.5 left-0 top-1.5 w-[3px] rounded-r-full bg-slate-900" /> : null}
                  <span className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl transition ${iconWrapClass(active)}`}>
                    {renderNavIcon(item.icon)}
                  </span>
                  {!collapsed ? (
                    <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium">{item.label}</span>
                      {badge > 0 ? (
                        <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-rose-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                          {badge > 99 ? "99+" : badge}
                        </span>
                      ) : null}
                    </span>
                  ) : badge > 0 ? (
                    <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-rose-600 text-[9px] font-semibold text-white">
                      {badge > 9 ? "9+" : badge}
                    </span>
                  ) : null}
                </Link>
              );
            })}

            {/* Mario Boss — gruppo collassabile */}
            {(() => {
              const groupActive = MARIO_BOSS_GROUP.items.some((i) => matchesPath(pathname, i.href));
              return (
                <div className="mt-0.5">
                  <button
                    type="button"
                    title={collapsed ? MARIO_BOSS_GROUP.label : undefined}
                    onClick={() => { if (!collapsed) setMarioBossOpen((v) => !v); }}
                    className={`group relative flex w-full min-w-0 items-center gap-3 rounded-xl border px-2.5 py-2 text-left transition ${
                      groupActive
                        ? "border-slate-200 bg-white text-slate-950 shadow-[0_8px_20px_rgba(15,23,42,0.08)]"
                        : "border-transparent text-slate-500 hover:bg-white/80 hover:text-slate-900"
                    } ${collapsed ? "justify-center" : ""}`}
                  >
                    {groupActive ? <span className="absolute bottom-1.5 left-0 top-1.5 w-[3px] rounded-r-full bg-red-500" /> : null}
                    <span className={`inline-flex shrink-0 items-center justify-center rounded-2xl transition-all duration-300 ${groupActive ? "bg-red-600 text-white shadow-sm" : "bg-white text-red-500 ring-1 ring-red-200"} ${marioBossOpen ? "h-20 w-20" : "h-8 w-8"}`}>
                      <img src="/mario-icon.png" alt="Mario" className={`object-contain transition-all duration-300 ${marioBossOpen ? "h-16 w-16" : "h-6 w-6"}`} aria-hidden="true" />
                    </span>
                    {!collapsed ? (
                      <span className="flex min-w-0 flex-1 items-center justify-between gap-1">
                        <span className="truncate text-sm font-semibold">{MARIO_BOSS_GROUP.label}</span>
                        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" className={`h-3 w-3 shrink-0 transition-transform ${marioBossOpen ? "rotate-90" : ""}`} aria-hidden="true">
                          <path d="M6 3.5l4 4.5-4 4.5" />
                        </svg>
                      </span>
                    ) : null}
                  </button>
                  {!collapsed && marioBossOpen && (
                    <div className="ml-4 mt-0.5 space-y-0.5 border-l-2 border-red-100 pl-2">
                      {MARIO_BOSS_GROUP.items.map((item) => {
                        const active = matchesPath(pathname, item.href);
                        return (
                          <Link
                            key={item.href}
                            href={item.href}
                            className={`flex min-w-0 items-center gap-2.5 rounded-xl border px-2 py-1.5 text-sm transition ${
                              active
                                ? "border-slate-200 bg-white font-semibold text-slate-950 shadow-sm"
                                : "border-transparent text-slate-500 hover:bg-white/80 hover:text-slate-900"
                            }`}
                          >
                            <span className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-lg transition ${active ? "bg-slate-900 text-white" : "bg-white text-slate-500 ring-1 ring-slate-200"}`}>
                              {renderNavIcon(item.icon)}
                            </span>
                            <span className="truncate">{item.label}</span>
                          </Link>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Karmen Peach — gruppo collassabile */}
            {(() => {
              const groupActive = KARMEN_PEACH_GROUP.items.some((i) => matchesPath(pathname, i.href));
              return (
                <div className="mt-0.5">
                  <button
                    type="button"
                    title={collapsed ? KARMEN_PEACH_GROUP.label : undefined}
                    onClick={() => { if (!collapsed) setKarmenPeachOpen((v) => !v); }}
                    className={`group relative flex w-full min-w-0 items-center gap-3 rounded-xl border px-2.5 py-2 text-left transition ${
                      groupActive
                        ? "border-slate-200 bg-white text-slate-950 shadow-[0_8px_20px_rgba(15,23,42,0.08)]"
                        : "border-transparent text-slate-500 hover:bg-white/80 hover:text-slate-900"
                    } ${collapsed ? "justify-center" : ""}`}
                  >
                    {groupActive ? <span className="absolute bottom-1.5 left-0 top-1.5 w-[3px] rounded-r-full bg-pink-500" /> : null}
                    <span className={`inline-flex shrink-0 items-center justify-center rounded-2xl transition-all duration-300 ${groupActive ? "bg-pink-500 text-white shadow-sm" : "bg-white text-pink-400 ring-1 ring-pink-200"} ${karmenPeachOpen ? "h-20 w-20" : "h-8 w-8"}`}>
                      <img src="/karmen-peach.png" alt="Karmen" className={`object-contain transition-all duration-300 ${karmenPeachOpen ? "h-16 w-16" : "h-6 w-6"}`} aria-hidden="true" />
                    </span>
                    {!collapsed ? (
                      <span className="flex min-w-0 flex-1 items-center justify-between gap-1">
                        <span className="truncate text-sm font-semibold">{KARMEN_PEACH_GROUP.label}</span>
                        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" className={`h-3 w-3 shrink-0 transition-transform ${karmenPeachOpen ? "rotate-90" : ""}`} aria-hidden="true">
                          <path d="M6 3.5l4 4.5-4 4.5" />
                        </svg>
                      </span>
                    ) : null}
                  </button>
                  {!collapsed && karmenPeachOpen && (
                    <div className="ml-4 mt-0.5 space-y-0.5 border-l-2 border-pink-100 pl-2">
                      {KARMEN_PEACH_GROUP.items.map((item) => {
                        const active = matchesPath(pathname, item.href);
                        return (
                          <Link
                            key={item.href}
                            href={item.href}
                            className={`flex min-w-0 items-center gap-2.5 rounded-xl border px-2 py-1.5 text-sm transition ${
                              active
                                ? "border-slate-200 bg-white font-semibold text-slate-950 shadow-sm"
                                : "border-transparent text-slate-500 hover:bg-white/80 hover:text-slate-900"
                            }`}
                          >
                            <span className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-lg transition ${active ? "bg-slate-900 text-white" : "bg-white text-slate-500 ring-1 ring-slate-200"}`}>
                              {renderNavIcon(item.icon)}
                            </span>
                            <span className="truncate">{item.label}</span>
                          </Link>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Impostazioni */}
            {settingsGroups.length > 0 ? (
              <div className="mt-4 border-t border-slate-200 pt-3">
                {!collapsed ? (
                  <p className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400">Impostazioni</p>
                ) : null}
                <button
                  type="button"
                  title={collapsed ? "Impostazioni" : undefined}
                  onClick={() => setSettingsOpen((prev) => !prev)}
                  className={`group relative flex w-full min-w-0 items-center gap-3 rounded-xl border px-2.5 py-2 text-left transition ${
                    isSettingsExpanded
                      ? "border-slate-200 bg-white text-slate-950 shadow-[0_8px_20px_rgba(15,23,42,0.06)]"
                      : "border-transparent text-slate-500 hover:bg-white/80 hover:text-slate-900"
                  } ${collapsed ? "justify-center" : ""}`}
                >
                  {settingsPathActive ? <span className="absolute bottom-1.5 left-0 top-1.5 w-[3px] rounded-r-full bg-slate-400" /> : null}
                  <span className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl transition ${iconWrapClass(isSettingsExpanded)}`}>
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-3.5 w-3.5" aria-hidden="true">
                      <circle cx="8" cy="8" r="2" />
                      <path d="M8 2.5v1.5M8 12v1.5M2.5 8H4M12 8h1.5M4.2 4.2l1 1M10.8 10.8l1 1M11.8 4.2l-1 1M5.2 10.8l-1 1" />
                    </svg>
                  </span>
                  {!collapsed ? (
                    <>
                      <span className="flex-1 truncate text-sm font-medium">Impostazioni</span>
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform duration-200 ${isSettingsExpanded ? "rotate-180" : ""}`} aria-hidden="true">
                        <path d="M3.5 6l4.5 4 4.5-4" />
                      </svg>
                    </>
                  ) : null}
                </button>

                {isSettingsExpanded && !collapsed ? (
                  <div className="mt-2 space-y-2 px-1">
                    {settingsGroups.map((group) => (
                      <div key={group.title} className="space-y-0.5 rounded-2xl border border-slate-200/80 bg-white/80 p-2">
                        <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">{group.title}</p>
                        {group.items.map((item) => {
                          const active = matchesPath(pathname, item.href);
                          return (
                            <Link
                              key={item.href}
                              href={item.href}
                              className={`flex items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-sm transition ${
                                active ? "bg-slate-900 text-white shadow-sm" : "text-slate-500 hover:bg-slate-50 hover:text-slate-900"
                              }`}
                            >
                              <span className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-lg transition ${iconWrapClass(active)}`}>
                                {renderNavIcon(item.icon)}
                              </span>
                              <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
                                <span className="truncate">{item.label}</span>
                                {item.href === "/settings/users" && pendingAccessRequestCount > 0 ? (
                                  <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-amber-500 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                                    {pendingAccessRequestCount > 99 ? "99+" : pendingAccessRequestCount}
                                  </span>
                                ) : null}
                              </span>
                            </Link>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </nav>
        </div>
      </aside>

      <div className="space-y-4">
        <header className="card relative z-30 space-y-4 px-4 py-4 md:px-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-[0.16em] text-slate-400">Vista operativa</p>
            <h2 className="mt-1 line-clamp-2 text-2xl text-slate-950">{title}</h2>
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end sm:gap-3">
            {authRole === "admin" ? (
              <Link
                href="/settings/users"
                className={`inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-medium shadow-sm transition ${
                  pendingAccessRequestCount > 0
                    ? "border-amber-200 bg-amber-50 text-amber-900 hover:bg-amber-100"
                    : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                }`}
                title={
                  pendingAccessRequestCount > 0
                    ? `${pendingAccessRequestCount} richieste accesso da approvare`
                    : "Nessuna nuova richiesta accesso"
                }
              >
                <span className="relative inline-flex">
                  <HeaderBellIcon />
                  {pendingAccessRequestCount > 0 ? (
                    <span className="absolute -right-2 -top-2 inline-flex min-w-5 items-center justify-center rounded-full bg-rose-600 px-1 py-0.5 text-[10px] font-semibold text-white">
                      {pendingAccessRequestCount > 99 ? "99+" : pendingAccessRequestCount}
                    </span>
                  ) : null}
                </span>
                <span className="hidden sm:inline">Richieste agenzia</span>
              </Link>
            ) : null}
            <div className="flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                onClick={toggleTheme}
                className="btn-secondary px-3 py-2 text-xs sm:text-sm"
                title={isDark ? "Passa alla modalità chiara" : "Passa alla modalità scura"}
              >
                <span className="inline-flex items-center gap-2">
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-4 w-4 shrink-0" aria-hidden="true">
                    {isDark
                      ? <path d="M8 3.5a4.5 4.5 0 1 0 4.5 4.5A3.5 3.5 0 0 1 8 3.5Z" />
                      : <><circle cx="8" cy="8" r="2.5" /><path d="M8 2v1.5M8 12.5V14M2 8h1.5M12.5 8H14M3.8 3.8l1 1M11.2 11.2l1 1M11.2 3.8l-1 1M4.8 11.2l-1 1" /></>}
                  </svg>
                  <span className="hidden lg:inline">{isDark ? "Modalità chiara" : "Modalità scura"}</span>
                  <span className="lg:hidden">Tema</span>
                </span>
              </button>
              <button
                type="button"
                onClick={toggleInboxSound}
                className={`inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-xs shadow-sm transition sm:text-sm ${
                  inboxSoundEnabled
                    ? "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                    : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                }`}
                title={`Suono inbox ${inboxSoundEnabled ? "attivo" : "disattivo"}`}
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-4 w-4 shrink-0" aria-hidden="true">
                  <path d="M3.5 6h2l3-3v10l-3-3h-2zM10.5 6.5a2.5 2.5 0 0 1 0 3" />
                </svg>
                <span className="hidden lg:inline">Suono inbox {inboxSoundEnabled ? "ON" : "OFF"}</span>
                <span className="lg:hidden">Inbox {inboxSoundEnabled ? "ON" : "OFF"}</span>
              </button>
              <button
                type="button"
                onClick={handleSignOut}
                className="inline-flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-600 shadow-sm transition hover:bg-rose-100 sm:text-sm"
                title="Esci"
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-4 w-4 shrink-0" aria-hidden="true">
                  <path d="M10.5 5.5 13 8l-2.5 2.5M13 8H6M7 3.5H3.5v9H7" />
                </svg>
                <span>Esci</span>
              </button>
              <div className="inline-flex h-9 min-w-9 items-center justify-center rounded-full border border-slate-200 bg-white px-2 text-sm font-semibold text-slate-700 shadow-sm">
                {(authRole ?? "U").slice(0, 2).toUpperCase()}
              </div>
            </div>
          </div>
          </div>
          <div className="mobile-nav-strip">
            {mainNav.map((item) => {
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
            {settingsGroups.length > 0 ? (
              <button
                type="button"
                onClick={() => setSettingsOpen((prev) => !prev)}
                className={isSettingsExpanded ? "btn-primary px-3 py-1.5 text-xs" : "btn-secondary px-3 py-1.5 text-xs"}
              >
                Impostazioni
              </button>
            ) : null}
          </div>
          {isSettingsExpanded && settingsGroups.length > 0 ? (
            <div className="space-y-3 rounded-2xl border border-slate-200 bg-slate-50 p-3 md:hidden">
              {settingsGroups.map((group) => (
                <div key={`mobile-${group.title}`} className="space-y-2">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">{group.title}</p>
                  <div className="mobile-nav-strip">
                    {group.items.map((item) => {
                      const active = matchesPath(pathname, item.href);
                      return (
                        <Link
                          key={`mobile-settings-${item.href}`}
                          href={item.href}
                          className={active ? "btn-primary px-3 py-1.5 text-xs" : "btn-secondary px-3 py-1.5 text-xs"}
                        >
                          {item.label}
                          {item.href === "/settings/users" && pendingAccessRequestCount > 0 ? ` (${pendingAccessRequestCount > 99 ? "99+" : pendingAccessRequestCount})` : ""}
                        </Link>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
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

