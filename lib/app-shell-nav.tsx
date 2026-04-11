import { isAllowedWithOverrides, type CapabilityOverrides } from "@/lib/rbac";
import type { UserRole } from "@/lib/types";

export type NavItem = {
  href: string;
  label: string;
  icon: string;
  requiresQuotesAccess?: boolean;
  adminOnly?: boolean;
  supervisorOnly?: boolean;
};

export type NavGroup = {
  title: string;
  items: NavItem[];
};

export type NavMainGroup = {
  type: "group";
  key: string;
  label: string;
  icon: string;
  items: NavItem[];
};

export function iconWrapClass(active: boolean) {
  return active
    ? "bg-slate-900 text-white shadow-sm"
    : "bg-white text-slate-600 ring-1 ring-slate-200";
}

export function renderNavIcon(icon: string) {
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
      return <span className="flex h-6 w-6 items-center justify-center text-base" aria-hidden="true">🎮</span>;
    case "KARMEN":
      return <span className="flex h-6 w-6 items-center justify-center text-base" aria-hidden="true">🌸</span>;
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

export function HeaderBellIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-4 w-4" aria-hidden="true">
      <path d="M8 2.5a2.5 2.5 0 0 0-2.5 2.5v1.1c0 .7-.2 1.4-.5 2L4 10.5h8l-1-2.4c-.3-.6-.5-1.3-.5-2V5A2.5 2.5 0 0 0 8 2.5Z" />
      <path d="M6.5 12a1.5 1.5 0 0 0 3 0" />
    </svg>
  );
}

export const MAIN_NAV_BY_ROLE: Record<UserRole, NavItem[]> = {
  admin: [],
  operator: [],
  supervisor: [],
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
  { href: "/inbox", label: "Prenotazioni", icon: "I" },
  { href: "/agency-requests", label: "Richieste Agenzie", icon: "🏨" },
  { href: "/agency-statement", label: "Estratto conto agenzie", icon: "€" },
  { href: "/inbox/agency-reviews", label: "Revisioni agenzie", icon: "✏️" },
  { href: "/inbox/fleet-reports", label: "Segnalazioni veicoli", icon: "🚨" },
  { href: "/biglietti-medmar", label: "Biglietti MEDMAR", icon: "⚓" },
  { href: "/dispatch", label: "Assegnazioni", icon: "G" }
];

export const MARIO_BOSS_GROUP: NavMainGroup = {
  type: "group",
  key: "mario-boss",
  label: "Mario Boss",
  icon: "MARIO",
  items: [
    { href: "/mario-planning", label: "Planning", icon: "P" },
    { href: "/bus-network", label: "Linea Bus", icon: "B" },
    { href: "/rete-ischia", label: "Transfer Ischia", icon: "O" },
    { href: "/escursioni", label: "Escursioni", icon: "E" },
    { href: "/preventivo-ops", label: "Area preventivi", icon: "%", requiresQuotesAccess: true }
  ]
};

export const KARMEN_PEACH_GROUP: NavMainGroup = {
  type: "group",
  key: "karmen-peach",
  label: "Karmen",
  icon: "KARMEN",
  items: [
    { href: "/liste-bruno", label: "Liste Bruno", icon: "S" },
    { href: "/estratto-escursioni", label: "Estratto Escursioni", icon: "S" }
  ]
};

MAIN_NAV_BY_ROLE.admin = OPERATIONS_MAIN_NAV;
MAIN_NAV_BY_ROLE.operator = OPERATIONS_MAIN_NAV;
MAIN_NAV_BY_ROLE.supervisor = OPERATIONS_MAIN_NAV;

export const SETTINGS_GROUPS: NavGroup[] = [
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
      { href: "/settings/agency-rates", label: "Prezzi agenzie", icon: "€" },
      { href: "/settings/agency-margins", label: "Margini", icon: "M", adminOnly: true },
      { href: "/pricing", label: "Tariffe", icon: "T", supervisorOnly: true },
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
    title: "Tecnico e sistema",
    items: [
      { href: "/services/new", label: "Nuovo servizio", icon: "N" },
      { href: "/notifications", label: "Notifiche", icon: "!" },
      { href: "/analytics", label: "Analisi", icon: "Y" },
      { href: "/excel-workspace", label: "Excel workspace", icon: "X" },
      { href: "/excel-import", label: "Import Excel", icon: "E" },
      { href: "/scheduler", label: "Scheduler", icon: "J" },
      { href: "/service-workflow", label: "Workflow servizi", icon: "K" },
      { href: "/audit", label: "Audit", icon: "Q" },
      { href: "/settings/tenant", label: "Profilo azienda", icon: "🏢" },
      { href: "/settings/system", label: "Stato sistema", icon: "⚙" },
      { href: "/settings/email-preview", label: "Anteprima email", icon: "✉" }
    ]
  }
];

const ALL_NAV_ITEMS = [
  ...Object.values(MAIN_NAV_BY_ROLE).flat(),
  ...MARIO_BOSS_GROUP.items,
  ...KARMEN_PEACH_GROUP.items,
  ...SETTINGS_GROUPS.flatMap((group) => group.items)
];

export function matchesPath(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function canSeeNavItem(item: NavItem, role: UserRole | null, quotesAccess: boolean, overrides?: CapabilityOverrides) {
  if (!role) return false;
  if (!isAllowedWithOverrides(item.href, role, overrides)) return false;
  if (item.adminOnly && role !== "admin") return false;
  if (item.supervisorOnly && role !== "admin" && role !== "supervisor") return false;
  if (role !== "admin" && role !== "supervisor" && item.requiresQuotesAccess && !quotesAccess) return false;
  return true;
}

export function uniqueNavItems(items: NavItem[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.href)) return false;
    seen.add(item.href);
    return true;
  });
}

export function pageTitle(pathname: string) {
  const match = [...ALL_NAV_ITEMS]
    .sort((left, right) => right.href.length - left.href.length)
    .find((item) => matchesPath(pathname, item.href));
  return match?.label ?? "Area di lavoro";
}
